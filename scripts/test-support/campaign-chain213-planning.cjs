'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

async function scopedSignal(h, scope) {
  const row = await h.db.subscriberDirectoryMaintenanceSignal.findUnique({
    where: { creatorId_kind: { creatorId: scope.creatorId, kind: 'DERIVED_PLANNING' } },
  });
  assert.ok(row, 'The next initial stage requires a durable planning signal');
  const signals = h.load('./src/services/subscriber-directory-maintenance-signal-service');
  const claimed = await h.db.$transaction(async tx => {
    // Other synthetic scopes are not part of this case. The current consumer
    // still performs its real SKIP LOCKED claim on a distinct connection.
    await tx.$queryRawUnsafe('SELECT "id" FROM "SubscriberDirectoryMaintenanceSignal" WHERE "id"<>$1 FOR UPDATE', row.id);
    return signals.claimSubscriberDirectoryMaintenanceSignal({ db: h.db });
  });
  assert.equal(claimed?.id, row.id);
  return claimed;
}

async function claimPlanner(h, scope) {
  const owner = h.load('./src/services/domain-work-authority-service');
  const claim = await owner.claimDomainWorkBatch({ db: h.db, agencyId: scope.agencyId,
    creatorIds: [scope.creatorId], workClass: 'CREATOR_RECURRING_PLANNING', limit: 1 });
  assert.equal(claim.items.length, 1, 'The scoped recurring planner must be claimable');
  return { owner, claim, item: claim.items[0] };
}

async function prepareEmptyCampaign(h, scope, expectedId) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign213-initial-'));
  try {
    const bundle = path.join(temp, 'campaign.cjs');
    const desktopLoad = createRequire(path.join(h.desktopRoot, 'package.json'));
    await desktopLoad('esbuild').build({
      entryPoints: [path.join(h.desktopRoot, 'apps/desktop/electron/main/services/backend-jobs/handlers/campaigns-handler.ts')],
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      alias: { '@nod/shared': path.join(h.desktopRoot, 'packages/shared/src/index.ts') },
    });
    const capabilities = Object.fromEntries(['creatorEventDrivenSyncV2', 'campaignCausalObservationV1',
      'campaignServerFanRefreshV1', 'campaignResumablePaginationV1', 'campaignFreshnessCoverageV1',
      'campaignOrderIndependentTraversalV1', 'campaignSegmentedFairTraversalV1', 'campaignFrontierSchedulingV1',
      'campaignDirectoryReuseV1', 'campaignBoundedTraversalV1', 'campaignTraversalAuthorityV1', 'campaignFairPagesV1', 'campaignSourceValidationV1'].map(k => [k, true]));
    const claimed = await h.lease.claimJob({ userId: scope.userId, deviceId: scope.deviceId, jobKeys: ['fetch_campaigns'], capabilities });
    assert.equal(claimed.job?.id, expectedId, JSON.stringify(claimed));
    const job = claimed.job, credentials = { jobId: job.id, userId: scope.userId, deviceId: scope.deviceId,
      leaseToken: job.leaseToken, leaseRevision: job.leaseRevision };
    let checkpoint = job.continuation, providerCalls = 0;
    for (let i = 0; i < 12 && checkpoint?.driverPhase !== 'complete'; i++) {
      const step = await require(bundle).campaignsHandler.runChunk({ job, creatorId: scope.creatorId,
        continuation: checkpoint?.jobContinuation, signal: new AbortController().signal,
        ofApi: { request: async request => {
          assert.equal(request.source, 'backend.readonly.fetch_campaigns.list'); providerCalls++;
          return { ok: true, status: 200, data: { list: [], hasMore: false } };
        } } });
      const continuation = step.outcome === 'done' ? { driverPhase: 'complete', result: step.result, progress: step.progress }
        : { driverPhase: 'execute', jobContinuation: step.continuation };
      checkpoint = (await h.lease.progressJob({ ...credentials, expectedContinuation: checkpoint, continuation,
        progress: step.progress, chunkResult: step.chunkResult })).continuation;
    }
    assert.equal(checkpoint?.driverPhase, 'complete'); assert.equal(providerCalls, 1);
    const accepted = await h.lease.completeJob({ ...credentials, result: checkpoint.result, progress: checkpoint.progress });
    const publisher = h.load('./src/services/analytics-publication-service');
    for (let i = 0; i < 30; i++) {
      const row = await h.db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } });
      if (row.stage === 'FINALIZE') return { accepted, credentials, checkpoint, providerCalls, publisher };
      await h.db.analyticsPublication.update({ where: { id: row.id }, data: { availableAt: new Date(0) } });
      await publisher.runAnalyticsPublicationUnit({ db: h.db, publicationId: row.id });
    }
    throw Error('Campaign publication did not reach its final commit');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function resumeInNewProcess(scope) {
  assert.equal(process.env.ONLINOD_POSTGRES_INTEGRATION, '1');
  const root = process.env.ONLINOD_CAMPAIGN_BACKEND_ROOT || path.resolve(__dirname, '../..');
  const h = await require(path.join(root, 'scripts/test-support/earnings-chain210-fixture.cjs')).openEarningsChainFixture();
  try {
    const parked = await h.db.domainWorkItem.findFirst({ where: { creatorId: scope.creatorId, workClass: 'CREATOR_RECURRING_PLANNING' } });
    assert.ok(+parked.availableAt > Date.now() + 3000000, 'A fresh process observes the parked planner');
    const owner = h.load('./src/services/domain-work-authority-service');
    await owner.publishDomainWork({ db: h.db, agencyId: scope.agencyId, creatorId: scope.creatorId,
      workClass: 'CREATOR_RECURRING_PLANNING', objectType: 'CreatorAccount', objectId: scope.creatorId, partitionKey: scope.creatorId });
    const competing = await claimPlanner(h, scope);
    const signal = await scopedSignal(h, scope);
    assert.equal(signal.reason, 'INITIAL_CAMPAIGN_PUBLISHED');
    const dispatch = h.load('./src/services/subscriber-directory-maintenance-service')._test.dispatchSubscriberDerivedPlanning;
    await dispatch({ db: h.db, signal });
    const newer = await h.db.domainWorkItem.findUnique({ where: { id: parked.id } });
    assert.ok(newer.requestedRevision > competing.item.claimedRevision);
    await owner.yieldDomainWorkClaim({ db: h.db, item: competing.item, ownerToken: competing.claim.ownerToken,
      availableAt: parked.availableAt, preserveProgressOnNewerRevision: true });
    const woken = await h.db.domainWorkItem.findUnique({ where: { id: parked.id } });
    assert.ok(+woken.availableAt <= Date.now(), 'Stale planner yield must not postpone a newer signal');
    await assert.rejects(dispatch({ db: h.db, signal }), e => e.code === 'SUBSCRIBER_MAINTENANCE_CLAIM_STALE');
    assert.deepEqual(await h.db.domainWorkItem.findUnique({ where: { id: parked.id } }), woken);
    const current = await claimPlanner(h, scope);
    const plan = await h.load('./src/services/analytics-recurring-planning-service').planRecurringCreatorAnalytics({
      db: h.db, item: current.item, ownerToken: current.claim.ownerToken });
    assert.equal(plan.initial.stage, 'notifications'); assert.equal(plan.initial.created, true);
    const job = await h.db.jobInstance.findUnique({ where: { id: plan.initial.jobId } });
    assert.equal(job.jobKey, 'catchup_notifications_scan'); assert.equal(job.creatorId, scope.creatorId);
    assert.equal(job.status, 'SCHEDULED');
    await owner.yieldDomainWorkClaim({ db: h.db, item: current.item, ownerToken: current.claim.ownerToken,
      availableAt: new Date(Date.now() + 3600000), preserveProgressOnNewerRevision: true });
    return { freshProcess: true, stalePlannerYieldPreservedWake: true, staleSignalReplayRolledBack: true,
      notificationScheduledWithoutManualRefresh: true };
  } finally { await h.close(); }
}

async function runCampaignPlanningCases(h, check) {
  await check('empty initial Campaign publication wakes Notifications after an hourly planner yield', async () => {
    const scope = await h.scope('campaign213_initial_wake');
    const orchestrator = h.load('./src/services/creator-analytics-sync-orchestrator');
    const initial = await orchestrator.ensureInitialCreatorAnalyticsSync({ db: h.db, creatorId: scope.creatorId, agencyId: scope.agencyId });
    assert.equal(initial.stage, 'financial'); assert.equal(initial.created, true);
    const fin = await h.claim(scope, initial.jobId);
    await h.page(fin, []); await h.charts(fin, []); await h.finish(fin);
    const financialSignal = await scopedSignal(h, scope);
    await h.load('./src/services/subscriber-directory-maintenance-service')._test.dispatchSubscriberDerivedPlanning({ db: h.db, signal: financialSignal });
    const prior = await claimPlanner(h, scope);
    const plan = await h.load('./src/services/analytics-recurring-planning-service').planRecurringCreatorAnalytics({
      db: h.db, item: prior.item, ownerToken: prior.claim.ownerToken });
    assert.equal(plan.initial.stage, 'campaigns'); assert.equal(plan.initial.created, true);
    const nextAt = new Date(+prior.claim.authorityNow + 3600000);
    await prior.owner.yieldDomainWorkClaim({ db: h.db, item: prior.item, ownerToken: prior.claim.ownerToken,
      availableAt: nextAt, preserveProgressOnNewerRevision: true,
      progressCursor: { lastFullPlanningAt: prior.claim.authorityNow.toISOString(),
        lastPlanningCycleAt: prior.claim.authorityNow.toISOString(), nextPlanningCycleAt: nextAt.toISOString() } });
    assert.equal(await h.db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: 'catchup_notifications_scan' } }), 0);
    const run = await prepareEmptyCampaign(h, scope, plan.initial.jobId);
    await h.db.analyticsPublication.update({ where: { id: run.accepted.publicationId }, data: { availableAt: new Date(0) } });
    const snapshot = async () => ({ job: await h.db.jobInstance.findUnique({ where: { id: plan.initial.jobId } }),
      publication: await h.db.analyticsPublication.findUnique({ where: { id: run.accepted.publicationId } }),
      state: await h.db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } }),
      signal: await h.db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { creatorId_kind: { creatorId: scope.creatorId, kind: 'DERIVED_PLANNING' } } }) });
    const before = await snapshot();
    const faultDb = new Proxy(h.db, { get(target, key) {
      if (key === '$transaction') return (work, options) => target.$transaction(async tx => {
        await work(tx); throw Error('CONTROLLED_CAMPAIGN_COMMIT_ROLLBACK');
      }, options);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(run.publisher.runAnalyticsPublicationUnit({ db: faultDb, publicationId: run.accepted.publicationId }), /CONTROLLED_CAMPAIGN_COMMIT_ROLLBACK/);
    assert.deepEqual(await snapshot(), before, 'Membership proof, terminal job and signal must roll back atomically');
    const result = await run.publisher.runAnalyticsPublicationUnit({ db: h.db, publicationId: run.accepted.publicationId });
    assert.equal(result.job?.status, 'DONE'); assert.equal(result.sideEffect.completion.membershipComplete, true);
    const complete = await snapshot();
    console.log(JSON.stringify({ stage: 'campaign213-initial-wake', membershipComplete: true,
      parkedUntil: nextAt, signalReason: complete.signal?.reason || null, providerCalls: run.providerCalls }));
    assert.ok(complete.signal, 'Successful initial Campaign publication must durably wake the next stage even with zero fans');
    assert.equal(complete.signal.reason, 'INITIAL_CAMPAIGN_PUBLISHED');
    await run.publisher.runAnalyticsPublicationUnit({ db: h.db, publicationId: run.accepted.publicationId });
    await h.lease.completeJob({ ...run.credentials, result: run.checkpoint.result, progress: run.checkpoint.progress });
    assert.deepEqual(await snapshot(), complete, 'Publication and lost completion-response replay must preserve the signal');
    const child = spawnSync(process.execPath, [__filename, '--resume', JSON.stringify({ agencyId: scope.agencyId, creatorId: scope.creatorId })],
      { env: { ...process.env, ONLINOD_CAMPAIGN_BACKEND_ROOT: h.backendRoot }, encoding: 'utf8', timeout: 45000 });
    assert.equal(child.status, 0, child.stdout + '\n' + child.stderr);
    const resumed = JSON.parse(child.stdout.split('\n').find(line => line.startsWith('CAMPAIGN_PLANNING_RESUME:')).slice('CAMPAIGN_PLANNING_RESUME:'.length));
    return { realFinancialProof: true, actualDesktopCampaignHandler: true, realCampaignPublication: true,
      noEnrichmentJobsRequired: true, atomicRollback: true, completionReplayStable: true, ...resumed };
  });
}

module.exports = { runCampaignPlanningCases };
if (require.main === module) {
  if (process.argv[2] === '--resume') {
    resumeInNewProcess(JSON.parse(process.argv[3])).then(r => console.log('CAMPAIGN_PLANNING_RESUME:' + JSON.stringify(r)), e => { console.error(e); process.exitCode = 1; });
  } else (async () => {
    const root = process.env.ONLINOD_CAMPAIGN_BACKEND_ROOT || path.resolve(__dirname, '../..');
    const h = await require(path.join(root, 'scripts/test-support/earnings-chain210-fixture.cjs')).openEarningsChainFixture();
    try { await runCampaignPlanningCases(h, async (name, fn) => console.log(JSON.stringify({ name, ok: true, ...await fn() }))); }
    finally { await h.close(); }
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
