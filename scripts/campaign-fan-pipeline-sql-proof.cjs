"use strict";
// Current migrations + actual Express job routes + emitted Desktop collector.
// Provider responses and authentication are fixtures; all SQL/lease/coverage
// authorities are production code. Never connects to the caller's database.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const alive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error('SQL_PROOF_DEADLINE'); process.exit(2); }, 300000);
async function main() {
  const { scope } = require('./audit/analytics-traffic/fixture.cjs');
  const { createScaleSqlRuntime } = require('./test-support/scale-sql-runtime.cjs');
  console.log('START current-schema fixture');
  const f = await createScaleSqlRuntime(); let server;
  console.log('PASS current-schema fixture');
  try {
    const { db } = f, s = await scope(db), now = new Date(), run = 'campaign-run';
    require.cache[require.resolve('../src/prisma')] = { exports: db };
    const queue = require('../src/services/campaign-fan-refresh-queue-service');
    const lease = require('../src/services/job-lease-service');
    const { runRootCommit } = require('../src/services/db-commit-kernel');
    const write = work => runRootCommit(db, async ({ tx }) => {
      await require('../src/services/campaign-causal-activation-service').enterCampaignWriterGeneration({ db: tx });
      await require('../src/services/campaign-transaction-lock-service').acquireCampaignTransactionLock(tx, s.creatorId);
      return work(tx);
    }, { profile: 'JOB_CHUNK' });
    const { fanDataPointRefreshHandler: handler } = await import(pathToFileURL(path.join(
      path.resolve(process.env.ONLINOD_DESKTOP_ROOT || '../desktop'),
      'apps/desktop/dist/electron/main/services/backend-jobs/handlers/fan-data-point-refresh-handler.js')));
    const deviceId = 'qa-device', fanIds = Array.from({ length: 14 }, (_, i) => String(1000 + i));
    await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(+now + 86400000) } });
    await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
    await db.deviceCreatorBinding.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, deviceId,
      status: 'ACTIVE', sessionReadReady: true, lastSeenAt: now } });
    const sourceJob = await db.jobInstance.create({ data: { id: 'source-job', ...s, userId: undefined,
      jobKey: 'fetch_campaigns', scope: 'creator', status: 'DONE', params: { campaignFreshnessCoverageVersion: 1, manualCampaignScan: true } } });
    // Fixture starts after the directory publication has committed. This receipt
    // and sourceJobId are mandatory: membership status alone is never publication
    // authority. The full Campaign traversal is outside this FanData proof.
    await db.analyticsPublication.create({ data: { id: 'published-directory', jobId: sourceJob.id,
      agencyId: s.agencyId, creatorId: s.creatorId, userId: s.userId, deviceId, leaseRevision: 1,
      leaseTokenHash: crypto.createHash('sha256').update('fixture').digest('hex'),
      payloadHash: crypto.createHash('sha256').update(JSON.stringify({ scanRunId: run })).digest('hex'),
      payload: { scanRunId: run }, state: 'COMMITTED', stage: 'FINALIZE', completedAt: now } });
    await write(async tx => {
      await tx.creatorCampaignCollectionState.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
        status: 'PARTIAL', mode: 'full', activeGeneration: run, activeRequestedAt: now, sourceJobId: sourceJob.id,
        membershipCoverageStatus: 'COMPLETE', membershipObservedAt: now,
        campaignFrontierFreshnessStatus: 'COMPLETE', campaignFrontierPlanRunId: run } });
      await tx.creatorCampaign.create({ data: { id: 'qa-campaign', agencyId: s.agencyId, creatorId: s.creatorId,
        externalCampaignId: '100', name: 'Fixture' } });
      await tx.creatorFan.createMany({ data: fanIds.map(id => ({ id: `fan-${id}`, agencyId: s.agencyId, creatorId: s.creatorId,
        onlyFansUserId: id, username: `known-${id}` })) });
      await tx.creatorCampaignFan.createMany({ data: fanIds.map(id => ({ id: `membership-${id}`, agencyId: s.agencyId,
        creatorId: s.creatorId, campaignId: 'qa-campaign', fanRecordId: `fan-${id}`, attributedAt: null })) });
      await tx.creatorFanValueCurrent.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, fanRecordId: 'fan-1002',
        platformReportedTotalSpendCents: 9876n, availability: 'AVAILABLE', source: 'USER_PROFILE', valueObservedAt: new Date(+now - 86400000) } });
      await tx.creatorFanValueCurrent.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, fanRecordId: 'fan-1004',
        platformReportedTotalSpendCents: null, availability: 'AVAILABLE', source: 'USER_PROFILE', valueObservedAt: now } });
      await tx.creatorFanRelationshipCurrent.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, fanRecordId: 'fan-1002',
        onlyFansUserId: '1002', observedAt: now, source: 'USER_PROFILE', blocked: true, creatorFollowsFan: true } });
    });
    console.log('PASS scope and canonical fixtures');
    const enqueued = await queue.enqueueUniqueCampaignFanRefreshes({ db, job: sourceJob, scanRunId: run,
      scanStartedAt: now, now, candidates: fanIds.map(onlyFansUserId => ({ onlyFansUserId })) });
    assert.equal(enqueued.queued, 14);
    console.log('PASS enqueue 14 demands');
    const originalRefresh = await db.jobInstance.findFirst({ where: { creatorId: s.creatorId, jobKey: 'fan_data_point_refresh' } });
    assert.ok(originalRefresh);
    // Recreate a prior empty-result completion: no availability fact, quarantined
    // after five attempts. Repair must not start another directory traversal.
    await write(async tx => {
      await tx.jobInstance.update({ where: { id: originalRefresh.id }, data: { status: 'DONE', result: { errors: 14 } } });
      await tx.creatorFanRefreshDemand.updateMany({ where: { creatorId: s.creatorId }, data: {
        status: 'FAILED', activeRefreshJobId: null, activeRefreshRevision: null, retryAttempts: 5,
        quarantinedAt: now, lastFailedAt: now, lastError: 'completed without satisfying requested freshness; errors=14' } });
      await tx.creatorCampaignFanRefreshWork.updateMany({ where: { creatorId: s.creatorId }, data: { status: 'FAILED', refreshJobId: null } });
      await tx.creatorCampaignCollectionState.update({ where: { creatorId: s.creatorId }, data: {
        fanValueFailed: 14, fanValueOutstanding: 0, fanValueFreshnessStatus: 'PARTIAL' } });
    });

    const express = require('express'), app = express(), unhandled = [];
    app.use(express.json());
    app.use(async (req, res, next) => {
      try { req.auth = { userId: s.userId, agencyId: s.agencyId, deviceId,
        membership: await db.agencyMember.findFirst({ where: { agencyId: s.agencyId, userId: s.userId } }) }; next(); }
      catch (error) { next(error); }
    });
    app.use('/api/jobs', require('../src/routes/jobs'));
    app.use('/api/stats', require('../src/routes/stats'));
    app.use((error, req, res, next) => { unhandled.push(error); console.error('PROOF_ROUTE_ERROR', error); res.status(500).json({ message: error.message }); });
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function post(endpoint, input) {
      const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    }
    console.log('PASS quarantine fixture');
    const operation = { family: 'campaign', operation: 'start', input: { intent: 'repair' } };
    const expectedRevision = await write(tx => require('../src/services/operational-command-service').snapshot(tx, s.agencyId, s.creatorId, operation));
    const command = { commandId: crypto.randomUUID(), action: 'operation.control', targetId: s.creatorId, payload: { ...operation, expectedRevision } };
    const actorMember = await db.agencyMember.findFirst({ where: { agencyId: s.agencyId, userId: s.userId } });
    const executeRepair = () => require('../src/services/management-command-service').executeManagementCommand({ db,
      agencyId: s.agencyId, userId: s.userId, deviceId, actorMember, input: command });
    console.log('START durable repair command');
    const repair = await executeRepair();
    console.log('PASS durable repair command');
    assert.equal(repair.ok, true, JSON.stringify(repair));
    assert.equal((await executeRepair()).replayed, true);
    assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: s.creatorId, status: 'QUEUED', quarantinedAt: null, retryAttempts: 0 } }), 14);
    assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId, jobKey: 'fetch_campaigns' } }), 1);
    console.log('START promote repaired demands');
    await queue.promoteQueuedCampaignFanRefreshDemands({ db, creatorId: s.creatorId, now: new Date() });
    console.log('PASS promote repaired demands');
    const { createFanDataBatchCommitter } = await import(pathToFileURL(path.join(
      path.resolve(process.env.ONLINOD_DESKTOP_ROOT || '../desktop'),
      'apps/desktop/dist/electron/main/services/backend-jobs/fan-data-batch-checkpoint.js')));
    const fanAuthority = require('../src/services/fan-data-authority-service');
    await write(tx => fanAuthority.projectFanObservationBatch(tx, { agencyId: s.agencyId, creatorId: s.creatorId,
      items: [{ onlyFansUserId: '1000', value: { source: 'USER_PROFILE', availability: 'AVAILABLE', totalSpentCents: 1234, observedAt: new Date() } }],
      allowedSources: ['USER_PROFILE'], observedAtPolicy: 'TRUSTED_INPUT' }));
    let durable = null, step, saveCalls = 0, tokenCalls = 0, lostAck = false, savePending = false, overlap = false;
    const reads = [], savedReceipts = [];
    for (let restart = 0; restart < 5; restart++) {
      const claimed = await lease.claimJob({ userId: s.userId, deviceId, jobKeys: ['fan_data_point_refresh'] });
      assert.ok(claimed.job, JSON.stringify(claimed));
      const job = claimed.job, auth = { deviceId, leaseToken: job.leaseToken, leaseRevision: job.leaseRevision };
      const jobPost = (endpoint, input = {}) => post(`/api/jobs/${job.id}/${endpoint}`, { ...auth, ...input });
      durable = job.continuation || { driverPhase: 'execute', jobContinuation: null };
      const committer = createFanDataBatchCommitter({ job, workId: `work-${job.id}`, leaseMs: 300000,
        initialContinuation: durable, onCommitted: value => { durable = value; }, client: {
          async progress(_, wire) {
            saveCalls++; savePending = true; savedReceipts.push(JSON.parse(JSON.stringify(wire)));
            const response = await jobPost('progress', wire); savePending = false;
            if (!lostAck) { lostAck = true; throw new Error('fixture lost committed response'); }
            return response;
          },
          renew(_, wire) { return jobPost('lease/renew', wire); },
        } });
      step = await handler.runChunk({ job, creatorId: s.creatorId, continuation: durable.jobContinuation,
        signal: new AbortController().signal, commitFanDataBatch: committer,
        ofApi: { async request({ endpoint }) {
          const id = endpoint.path.split('/').at(-1); reads.push(id); if (savePending) overlap = true;
          if (id === '1002') return reads.filter(value=>value===id).length===1
            ? {ok:true,status:200,data:{id,username:'partial-retained',subscribedOnData:{totalSumm:'malformed',tipsSumm:7}}}
            : { ok: false, status: 503, code: 'OF_HTTP_ERROR' };
          if (id === '1003') return { ok: false, status: 404, code: 'OF_HTTP_ERROR' };
          return { ok: true, status: 200, data: { id, subscribedOnData: { totalSumm: id === '1001' ? 0 : 1 } } };
        } },
        acquireObservationReadLease: input => jobPost('observation-read-lease/acquire', { ...input, requestId: crypto.randomUUID() }),
        releaseObservationReadLease: readLeaseToken => jobPost('observation-read-lease/release', { readLeaseToken }),
        acquireObservationToken: input => { tokenCalls++; return jobPost('observation-token', input); },
      });
      if (restart < 4) {
        assert.equal(step.outcome, 'continue'); assert.equal(durable.jobContinuation.index, 2);
        assert.equal(durable.jobContinuation.retry.attempts, restart + 1);
        const sql = await db.jobInstance.findUnique({ where: { id: job.id } });
        assert.equal(sql.continuation.jobContinuation.index, 2);
        assert.equal(sql.continuation.jobContinuation.retry.attempts, restart + 1);
        if(restart===0){
          const partial=await db.creatorFanValueCurrent.findUnique({where:{creatorId_fanRecordId:{creatorId:s.creatorId,fanRecordId:'fan-1002'}}});
          assert.equal(partial.availability,'MALFORMED');assert.equal(partial.tipsSpentCents,700n);
          assert.equal(partial.platformReportedTotalSpendCents,9876n,'partial facts never replace the last known aggregate');
        }
        await jobPost('release', { workId: `work-${job.id}`, reason: 'fixture process restart', runAfterMs: 1000 });
        await write(tx => tx.jobInstance.update({ where: { id: job.id }, data: { nextRunAt: new Date(0) } }));
      } else {
        assert.equal(step.outcome, 'done');
        await jobPost('progress', { expectedContinuation: durable,
          continuation: { driverPhase: 'complete', result: step.result, progress: step.progress }, progress: step.progress });
        await jobPost('complete', { result: step.result, progress: step.progress });
      }
      console.log('PASS SQL restart checkpoint', restart + 1, durable.jobContinuation.index);
    }
    assert.equal(reads.filter(id => id === '1000').length, 0, 'already satisfied demand is reused before fetch');
    assert.equal(reads.filter(id => id === '1001').length, 1, 'lost save response does not reread successful prefix');
    assert.equal(reads.filter(id => id === '1002').length, 5, 'profile retries persist across five process claims');
    assert.equal(reads.filter(id => id === '1004').length, 1, 'AVAILABLE without a known amount does not satisfy money demand');
    assert.equal(reads.length, 17); assert.equal(overlap, true, 'provider B overlaps A save in actual HTTP pipeline');
    assert.equal(step.result.refreshed, 11); assert.equal(step.result.reused, 1); assert.equal(step.result.errors, 1); assert.equal(step.result.unavailable, 1);
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(state.fanValueOutstanding, 0); assert.equal(state.fanValueFailed, 1); assert.equal(state.fanValueUnavailable, 1);
    assert.equal(state.fanValueSucceeded, 12); assert.equal(state.fanValueFreshnessStatus, 'PARTIAL');
    const failed = await db.creatorFanRefreshDemand.findUnique({ where: { creatorId_onlyFansUserId: { creatorId: s.creatorId, onlyFansUserId: '1002' } } });
    assert.equal(failed.status, 'FAILED'); assert.equal(failed.retryAttempts, 5); assert.ok(failed.quarantinedAt); assert.equal(failed.nextRetryAt, null);
    assert.match(failed.lastError, /503.*1002.*5/);
    const prior = await db.creatorFanValueCurrent.findUnique({ where: { creatorId_fanRecordId: { creatorId: s.creatorId, fanRecordId: 'fan-1002' } } });
    assert.equal(prior.platformReportedTotalSpendCents, 9876n);assert.equal(prior.availability,'MALFORMED');
    assert.equal(prior.tipsSpentCents,700n,'first authorized partial observation survives four later transport failures');
    assert.equal((await db.creatorFan.findUnique({where:{id:'fan-1002'}})).username,'partial-retained');
    const terminal = savedReceipts.find(row => row.chunkResult.terminalFailures.length);
    assert.deepEqual(terminal.chunkResult.terminalFailures.map(row => row.fanId), ['1002']);
    assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: s.creatorId, status: 'QUEUED' } }), 0);
    const derivedWake = await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: {
      creatorId_kind: { creatorId: s.creatorId, kind: 'DERIVED_PLANNING' } } });
    assert.equal(derivedWake.reason, 'CAMPAIGN_FAN_REFRESH_SETTLED', 'delegated terminal FanData wakes independent initial stages');
    await write(tx => require('../src/services/campaign-fan-change-publication').publishCanonicalCampaignChanges({
      db: tx, agencyId: s.agencyId, creatorId: s.creatorId, campaignIds: ['qa-campaign'] }));
    const feed = await db.$queryRawUnsafe('SELECT "entityType","entityId",payload FROM "CreatorEntityCurrent" WHERE "creatorId"=$1', s.creatorId);
    const fanFeed = feed.filter(row => row.entityType === 'FAN');
    assert.equal(fanFeed.length, 14); assert.equal(fanFeed.some(row => row.entityId === '1002'), true,
      'terminal demand failure invalidates the canonical fan status without overwriting prior money');
    assert.ok(feed.some(row => row.entityType === 'CAMPAIGN' && row.entityId === 'qa-campaign'));
    assert.ok(feed.some(row => row.entityType === 'CRM' && row.entityId === '1001'));
    assert.ok(feed.every(row => Object.keys(row.payload).every(key => ['dataVersion','reason','fanOnlyFansUserId','campaignId'].includes(key))));

    // A whole-job failure may leave some fans quarantined and others in demand
    // backoff. Both status changes must be delivered from the same transaction.
    const wholeFailureIds = ['2000','2001'];
    await write(async tx => {
      await tx.creatorFan.createMany({ data: wholeFailureIds.map(id => ({ id: `fan-${id}`, agencyId: s.agencyId,
        creatorId: s.creatorId, onlyFansUserId: id })) });
      await tx.creatorCampaignFan.createMany({ data: wholeFailureIds.map(id => ({ id: `membership-${id}`, agencyId: s.agencyId,
        creatorId: s.creatorId, campaignId: 'qa-campaign', fanRecordId: `fan-${id}` })) });
    });
    const wholeEnqueue = await queue.enqueueUniqueCampaignFanRefreshes({ db, job: sourceJob, scanRunId: run,
      scanStartedAt: now, now: new Date(), candidates: wholeFailureIds.map(onlyFansUserId => ({ onlyFansUserId })) });
    assert.equal(wholeEnqueue.queued, 2);
    const wholeJob = await db.jobInstance.findFirst({ where: { creatorId: s.creatorId, jobKey: 'fan_data_point_refresh', status: 'SCHEDULED' } });
    assert.ok(wholeJob);
    await write(async tx => {
      await tx.jobInstance.update({ where: { id: wholeJob.id }, data: { attempts: 4 } });
      await tx.creatorFanRefreshDemand.update({ where: { creatorId_onlyFansUserId: { creatorId: s.creatorId, onlyFansUserId: '2000' } }, data: { retryAttempts: 4 } });
    });
    const wholeClaim = await lease.claimJob({ userId: s.userId, deviceId, jobKeys: ['fan_data_point_refresh'] });
    assert.equal(wholeClaim.job.id, wholeJob.id);
    const wholeFailed = await post(`/api/jobs/${wholeJob.id}/fail`, { deviceId, leaseToken: wholeClaim.job.leaseToken,
      leaseRevision: wholeClaim.job.leaseRevision, retryable: true, error: 'whole job provider failure' });
    assert.equal(wholeFailed.job.status, 'FAILED');
    const terminalDemands = await db.creatorFanRefreshDemand.findMany({ where: { creatorId: s.creatorId, onlyFansUserId: { in: wholeFailureIds } }, orderBy: { onlyFansUserId: 'asc' } });
    assert.deepEqual(terminalDemands.map(row => [row.onlyFansUserId, row.status, row.retryAttempts, Boolean(row.quarantinedAt)]),
      [['2000','FAILED',5,true],['2001','FAILED',1,false]]);
    const terminalFeed = await db.$queryRawUnsafe(`SELECT "entityType","entityId" FROM "CreatorEntityCurrent"
      WHERE "creatorId"=$1 AND "entityType" IN ('FAN','CRM') AND "entityId"=ANY($2::text[]) ORDER BY "entityType","entityId"`, s.creatorId, wholeFailureIds);
    assert.deepEqual(terminalFeed.map(row => `${row.entityType}:${row.entityId}`), ['CRM:2000','CRM:2001','FAN:2000','FAN:2001']);

    // The same HTTP failure endpoint used by the Desktop segment-recovery path
    // owns retry attempts across fresh claims. A later committed checkpoint must
    // defeat a failure report based on an earlier successful renew.
    const requestedAt = new Date().toISOString(), segmentRun = 'segment-retry-run';
    const segmentState = { collectorVersion: 'campaigns-v13', fairPagesVersion: 1, scanRunId: segmentRun, scanStartedAt: requestedAt,
      phase: 'segment', campaignMode: 'full', offset: 50, page: 1, campaigns: [], segmentCursor: '18', segmentRequestCursor: null,
      segmentHasMore: true, campaignIndex: 0, claimerOffset: 0, claimerPage: 0, claimerRejected: 0,
      directorySourceExhausted: true, campaignPagesComplete: true, truncated: false, totalCampaignCount: 50,
      campaignBatchCount: 1, claimerBatchCount: 17, campaignScannerRejected: 0, claimerScannerRejected: 0,
      quantumLeaseRevision: 1, quantumStartedAt: requestedAt, quantumRequests: 0 };
    let segmentCheckpoint = { driverPhase: 'execute', jobContinuation: segmentState };
    await write(async tx => {
      // This section tests finite Campaign retries after a prior source has
      // failed. It carries no fake financial proof: the normal admission policy
      // must let independent Campaign work proceed after that finite failure.
      await tx.creatorFinancialCollectionState.upsert({where:{creatorId:s.creatorId},
        create:{agencyId:s.agencyId,creatorId:s.creatorId,status:'FAILED',lastErrorCode:'PROVIDER_UNAVAILABLE'},
        update:{status:'FAILED',lastErrorCode:'PROVIDER_UNAVAILABLE'}});
      await require('../src/services/campaign-causal-activation-service').enterCampaignBoundedExecution({ db: tx });
      return tx.jobInstance.create({ data: { id: 'segment-retry-job', agencyId: s.agencyId, creatorId: s.creatorId,
      jobKey: 'fetch_campaigns', scope: 'creator', status: 'SCHEDULED', nextRunAt: new Date(0), continuation: segmentCheckpoint,
      params: { collectionContractVersion: 1, collectionType: 'CAMPAIGNS', collectionMode: 'full',
        collectionGeneration: segmentRun, collectionRequestedAt: requestedAt, collectionReason: 'TEST', manualCampaignScan: true,
        campaignTraversalAuthorityVersion: 1, campaignFairPagesVersion: 1 } } });
    });
    const capabilities = Object.fromEntries(['legacyStorageRetirementV1','creatorEventDrivenSyncV2','campaignCausalObservationV1',
      'campaignServerFanRefreshV1','campaignResumablePaginationV1','campaignFreshnessCoverageV1','campaignOrderIndependentTraversalV1',
      'campaignSegmentedFairTraversalV1','campaignFrontierSchedulingV1','campaignDirectoryReuseV1','campaignBoundedTraversalV1',
      'campaignTraversalAuthorityV1','campaignFairPagesV1'].map(key => [key, true]));
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claim = await post('/api/jobs/claim', { deviceId, jobKeys: ['fetch_campaigns'], capabilities });
      assert.equal(claim.job?.id, 'segment-retry-job', JSON.stringify(claim));
      const active = claim.job, auth = { deviceId, leaseToken: active.leaseToken, leaseRevision: active.leaseRevision };
      const request = (endpoint, body = {}) => post(`/api/jobs/${active.id}/${endpoint}`, { ...auth, ...body });
      assert.equal(active.attempt, attempt, 'claim must retain the preceding process failure count');
      if (attempt === 1) {
        const old = structuredClone(segmentCheckpoint);
        segmentCheckpoint = { ...old, jobContinuation: { ...old.jobContinuation, quantumRequests: 1 } };
        await request('progress', { expectedContinuation: old, continuation: segmentCheckpoint, progress: { current: 18 } });
        const lateFailure = await request('fail', { expectedContinuation: old, retryable: true, error: 'late segment response' });
        assert.equal(lateFailure.job.staleFailure, true);
        const untouched = await db.jobInstance.findUnique({ where: { id: active.id } });
        assert.equal(untouched.attempts, 0); assert.equal(untouched.status, 'CLAIMED');
      }
      const response = await request('fail', { expectedContinuation: segmentCheckpoint, retryable: true, error: 'segment SERVER_ERROR 500' });
      const stored = await db.jobInstance.findUnique({ where: { id: active.id } });
      assert.equal(stored.attempts, attempt); assert.deepEqual(stored.continuation, segmentCheckpoint);
      assert.equal(response.job.status, attempt === 5 ? 'FAILED' : 'SCHEDULED');
      if (attempt < 5) {
        assert.ok(stored.nextRunAt > new Date(), 'server owns a real retry backoff');
        await write(tx => tx.jobInstance.update({ where: { id: active.id }, data: { nextRunAt: new Date(0) } }));
      }
    }
    const retired = await post('/api/jobs/claim', { deviceId, jobKeys: ['fetch_campaigns'], capabilities });
    assert.equal(retired.job, null, 'terminal retry budget cannot reset on another process claim');
    assert.equal(unhandled.length, 0);
    console.log(JSON.stringify({ pass: true, providerCalls: reads.length, saveCalls, tokenCalls, lostAckRecovered: lostAck,
      readSaveOverlap: overlap, restartedClaims: 5, reused: 1, refreshed: 11, unavailable: 1, failed: 1,
      checkpoint: durable.jobContinuation.index, lastKnownValuePreserved: '9876', coverage: state.fanValueFreshnessStatus,
      canonicalFanInvalidations: fanFeed.length, wholeJobTerminalInvalidations: terminalFeed.length,
      derivedWake: true, segmentAttempts: 5, staleFailureFenced: true }));
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(alive); clearTimeout(deadline); });
