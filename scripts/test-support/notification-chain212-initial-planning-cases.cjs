'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { createEarningsHarness } = require('./earnings-chain210-fixture.cjs');

async function claimPlanning(h, scope) {
  const owner = h.load('./src/services/domain-work-authority-service');
  const claim = await owner.claimDomainWorkBatch({ db: h.db, agencyId: scope.agencyId,
    creatorIds: [scope.creatorId], workClass: 'CREATOR_RECURRING_PLANNING', limit: 1 });
  assert.equal(claim.items.length, 1, `Scoped planner claim: ${claim.reason || 'no reason'}`);
  return { owner, claim, item: claim.items[0] };
}

async function resumePlanningInNewProcess(scope) {
  const url = new URL(process.env.ONLINOD_NATIVE_TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && /^(?:onlinod_test_|onlinod_fixture_|audit[0-9]+_)[a-z0-9_]+$/.test(decodeURIComponent(url.pathname.slice(1))),
  'Restart consumer requires the same isolated local PostgreSQL fixture');
  assert.ok(String(scope.creatorId).startsWith('notif212_'));
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: process.env.ONLINOD_NATIVE_TEST_DATABASE_URL } } });
  const load = createRequire(path.resolve(__dirname, '../../package.json'));
  require.cache[load.resolve('./src/prisma')] = { exports: db };
  const h = { db, load };
  try {
    const parked = await db.domainWorkItem.findFirst({ where: { creatorId: scope.creatorId, workClass: 'CREATOR_RECURRING_PLANNING' } });
    assert.ok(+parked.availableAt > Date.now() + 3000000, 'Restart observes the previously parked durable planner');
    const saved = await db.subscriberDirectoryMaintenanceSignal.findUnique({
      where: { creatorId_kind: { creatorId: scope.creatorId, kind: 'DERIVED_PLANNING' } } });
    assert.equal(saved.reason, 'INITIAL_FINANCIAL_PUBLISHED');

    // Deterministic concurrent-owner interleaving: another legitimate wake has
    // claimed the planner before this persisted outbox is dispatched. Its later
    // stale yield must not replace our newer wake with the old hourly deadline.
    const owner = load('./src/services/domain-work-authority-service');
    await owner.publishDomainWork({ db, agencyId: scope.agencyId, creatorId: scope.creatorId,
      workClass: 'CREATOR_RECURRING_PLANNING', objectType: 'CreatorAccount', objectId: scope.creatorId, partitionKey: scope.creatorId });
    const competing = await claimPlanning(h, scope);
    const signals = load('./src/services/subscriber-directory-maintenance-signal-service');
    const signal = await db.$transaction(async tx => {
      // Isolate this fixture's normal SKIP LOCKED claim without modifying or
      // consuming any unrelated synthetic scope's pending maintenance signals.
      await tx.$queryRawUnsafe('SELECT "id" FROM "SubscriberDirectoryMaintenanceSignal" WHERE "id"<>$1 FOR UPDATE', saved.id);
      return signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    });
    assert.equal(signal.id, saved.id);
    const dispatch = load('./src/services/subscriber-directory-maintenance-service')._test.dispatchSubscriberDerivedPlanning;
    await dispatch({ db, signal });
    const newer = await db.domainWorkItem.findUnique({ where: { id: parked.id } });
    assert.ok(newer.requestedRevision > competing.item.claimedRevision);
    await competing.owner.yieldDomainWorkClaim({ db, item: competing.item, ownerToken: competing.claim.ownerToken,
      availableAt: parked.availableAt, preserveProgressOnNewerRevision: true });
    const woken = await db.domainWorkItem.findUnique({ where: { id: parked.id } });
    assert.ok(+woken.availableAt <= Date.now(), 'Stale planner yield cannot postpone a newer durable publication wake');
    await assert.rejects(dispatch({ db, signal }), error => error.code === 'SUBSCRIBER_MAINTENANCE_CLAIM_STALE');
    assert.deepEqual(await db.domainWorkItem.findUnique({ where: { id: parked.id } }), woken,
      'Replaying an acknowledged signal rolls back the attempted DWI change');
    const current = await claimPlanning(h, scope);
    const plan = await load('./src/services/analytics-recurring-planning-service').planRecurringCreatorAnalytics({
      db, item: current.item, ownerToken: current.claim.ownerToken });
    assert.equal(plan.initial.stage, 'campaigns'); assert.equal(plan.initial.created, true);
    const campaign = await db.jobInstance.findUnique({ where: { id: plan.initial.jobId } });
    assert.equal(campaign.creatorId, scope.creatorId); assert.equal(campaign.status, 'SCHEDULED');
    await current.owner.yieldDomainWorkClaim({ db, item: current.item, ownerToken: current.claim.ownerToken,
      availableAt: new Date(Date.now() + 3600000), preserveProgressOnNewerRevision: true });
    return { freshProcess: true, stalePlannerYieldPreservedWake: true, staleOutboxReplayRolledBack: true,
      campaignJobId: campaign.id };
  } finally { await db.$disconnect(); }
}

async function finishEmptyCampaign(h, scope, expectedId) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-initial-campaign-'));
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
      // Campaign authority owns even provider-free terminal advancement through
      // progress; the shared worker uses its dedicated Campaign checkpoint path.
      checkpoint = (await h.lease.progressJob({ ...credentials, expectedContinuation: checkpoint, continuation,
        progress: step.progress, chunkResult: step.chunkResult })).continuation;
    }
    assert.equal(checkpoint?.driverPhase, 'complete'); assert.equal(providerCalls, 1);
    const accepted = await h.lease.completeJob({ ...credentials, result: checkpoint.result, progress: checkpoint.progress });
    const publisher = h.load('./src/services/analytics-publication-service');
    let result;
    for (let i = 0; i < 30; i++) {
      await h.db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { availableAt: new Date(0) } });
      result = await publisher.runAnalyticsPublicationUnit({ db: h.db, publicationId: accepted.publicationId });
      if (!result.publicationPending) break;
    }
    assert.equal(result.job?.status, 'DONE', JSON.stringify(result));
    assert.equal(result.sideEffect.completion.membershipComplete, true);
    return { emptyCampaignProviderCalls: providerCalls, actualCampaignPublication: true };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function runInitialPlanningCases(h, check) {
  const earnings = await createEarningsHarness({ db: h.db, desktopRoot: h.desktopRoot });
  try {
    await check('initial Financial publication durably wakes Campaign planning after the planner has yielded for an hour', async () => {
      const scope = await h.scope('initial_financial_wake', { releasePredecessors: false });
      const planned = await h.load('./src/services/creator-analytics-sync-orchestrator').ensureInitialCreatorAnalyticsSync({
        db: h.db, creatorId: scope.creatorId, agencyId: scope.agencyId });
      assert.equal(planned.stage, 'financial'); assert.equal(planned.created, true);
      const scheduledNotification = await h.schedule(scope, { forceFull: true });
      const prior = await claimPlanning(h, scope);
      const initialPlan = await h.load('./src/services/analytics-recurring-planning-service').planRecurringCreatorAnalytics({
        db: h.db, item: prior.item, ownerToken: prior.claim.ownerToken });
      assert.equal(initialPlan.initial.stage, 'financial');
      const nextAt = new Date(+prior.claim.authorityNow + 3600000);
      await prior.owner.yieldDomainWorkClaim({ db: h.db, item: prior.item, ownerToken: prior.claim.ownerToken,
        availableAt: nextAt, preserveProgressOnNewerRevision: true,
        progressCursor: { lastFullPlanningAt: prior.claim.authorityNow.toISOString(),
          lastPlanningCycleAt: prior.claim.authorityNow.toISOString(), nextPlanningCycleAt: nextAt.toISOString() } });
      const parked = await h.db.domainWorkItem.findUnique({ where: { id: prior.item.id } });
      assert.ok(+parked.availableAt > Date.now() + 3500000, 'The real planner has yielded before Financial proof');
      assert.equal(await h.db.creatorEarningsLedgerProof.count({ where: { creatorId: scope.creatorId } }), 0);
      assert.equal(await h.db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: 'fetch_campaigns' } }), 0);

      const run = await earnings.claim(scope, planned.jobId);
      await earnings.page(run, []); await earnings.charts(run, []);
      const publisher = h.load('./src/services/analytics-publication-service');
      const accepted = await earnings.lease.completeJob({ ...run.credentials, result: run.checkpoint.result, progress: run.checkpoint.progress });
      for (let i = 0; i < 30; i++) {
        const row = await h.db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } });
        if (row.stage === 'FINALIZE') break;
        await h.db.analyticsPublication.update({ where: { id: row.id }, data: { availableAt: new Date(0) } });
        await publisher.runAnalyticsPublicationUnit({ db: h.db, publicationId: row.id });
      }
      await h.db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { availableAt: new Date(0) } });
      const financialSnapshot = async () => ({
        job: await h.db.jobInstance.findUnique({ where: { id: run.job.id } }),
        publication: await h.db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } }),
        state: await h.db.creatorFinancialCollectionState.findUnique({ where: { creatorId: scope.creatorId } }),
        proof: await h.db.creatorEarningsLedgerProof.findUnique({ where: { creatorId: scope.creatorId } }),
        signal: await h.db.subscriberDirectoryMaintenanceSignal.findUnique({
          where: { creatorId_kind: { creatorId: scope.creatorId, kind: 'DERIVED_PLANNING' } } }),
      });
      const beforeCommit = await financialSnapshot();
      const faultDb = new Proxy(h.db, { get(target, key) {
        if (key === '$transaction') return (work, options) => target.$transaction(async tx => {
          await work(tx); throw new Error('CONTROLLED_INITIAL_FINANCIAL_COMMIT_ROLLBACK');
        }, options);
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(publisher.runAnalyticsPublicationUnit({ db: faultDb, publicationId: accepted.publicationId }),
        /CONTROLLED_INITIAL_FINANCIAL_COMMIT_ROLLBACK/);
      assert.deepEqual(await financialSnapshot(), beforeCommit, 'Proof, terminal Job and planning signal roll back together');
      const completed = { accepted, result: await publisher.runAnalyticsPublicationUnit({ db: h.db, publicationId: accepted.publicationId }),
        ...await financialSnapshot() };
      assert.equal(completed.result.sideEffect.complete, true);
      assert.equal(completed.result.sideEffect.published, true);
      assert.ok(+completed.state.baselineVerifiedAt > +prior.claim.authorityNow);
      const signal = await h.db.subscriberDirectoryMaintenanceSignal.findUnique({
        where: { creatorId_kind: { creatorId: scope.creatorId, kind: 'DERIVED_PLANNING' } } });
      console.log(JSON.stringify({ stage: 'initial-wake-evidence', creatorId: scope.creatorId,
        plannerAt: prior.claim.authorityNow, parkedUntil: parked.availableAt,
        financialVerifiedAt: completed.state.baselineVerifiedAt, financialPublished: completed.result.sideEffect.published,
        campaignJobs: await h.db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: 'fetch_campaigns' } }),
        durablePlanningSignal: signal?.reason || null }));
      assert.ok(signal, 'Successful initial Financial publication must commit a durable next-stage planning signal');
      assert.equal(signal.reason, 'INITIAL_FINANCIAL_PUBLISHED');
      assert.ok(+signal.dueAt <= Date.now());
      await publisher.runAnalyticsPublicationUnit({ db: h.db, publicationId: completed.accepted.publicationId });
      await earnings.lease.completeJob({ ...run.credentials, result: run.checkpoint.result, progress: run.checkpoint.progress });
      assert.deepEqual(await h.db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { id: signal.id } }), signal,
        'Lost-response replay must neither duplicate nor replace the committed signal');
      const child = spawnSync(process.execPath, [__filename, '--resume', JSON.stringify({ agencyId: scope.agencyId,
        creatorId: scope.creatorId })], { env: process.env, encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      const resumed = JSON.parse(child.stdout.split('\n').find(line => line.startsWith('INITIAL_PLANNING_RESUME:')).slice('INITIAL_PLANNING_RESUME:'.length));
      assert.deepEqual(await h.db.creatorEarningsLedgerProof.findUnique({ where: { creatorId: scope.creatorId } }), completed.proof,
        'Planning wake does not alter the published Financial proof');
      const campaign = await finishEmptyCampaign(h, scope, resumed.campaignJobId);
      const ready = h.load('./src/services/initial-collection-readiness-service');
      const admission = await ready.loadInitialCollectionAdmission({ db: h.db, creatorIds: [scope.creatorId] });
      assert.equal(admission.get(scope.creatorId).financialReady, true);
      assert.equal(admission.get(scope.creatorId).membershipReady, true);
      assert.equal(ready.initialCollectionAdmission({ jobKey: 'catchup_notifications_scan' }, admission.get(scope.creatorId)).admitted, true);
      const notification = await h.claim(scope, scheduledNotification.job.id);
      for (let i = 0; i < 6; i++) await h.page(notification, []);
      const terminal = await h.produce(notification, () => { throw new Error('EXHAUSTED_SOURCE_READ'); });
      notification.checkpoint = (await h.lease.renewLease({ ...notification.credentials, continuation: {
        driverPhase: 'complete', result: terminal.result, progress: terminal.progress }, progress: terminal.progress })).continuation;
      assert.equal((await h.finish(notification)).job.status, 'DONE');
      return { plannerBeforeProof: true, durableSignal: true, publicationReplayStable: true, atomicRollback: true,
        ...resumed, ...campaign, notificationsAdmittedAndEmptyComplete: true,
        creatorId: scope.creatorId, notificationJobId: scheduledNotification.job.id };
    });
  } finally { await earnings.close(); }
}

if (require.main === module && process.argv[2] === '--resume') {
  assert.equal(process.env.ONLINOD_POSTGRES_INTEGRATION, '1');
  resumePlanningInNewProcess(JSON.parse(process.argv[3])).then(result => console.log('INITIAL_PLANNING_RESUME:' + JSON.stringify(result)),
    error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { runInitialPlanningCases, claimPlanning };
