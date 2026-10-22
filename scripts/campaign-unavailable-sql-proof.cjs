"use strict";
// Current migrations + actual Express job routes + emitted Desktop collector.
// Provider responses and authentication are fixtures; all SQL/lease/coverage
// authorities are production code. Never connects to the caller's database.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const alive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error('SQL_PROOF_DEADLINE'); process.exit(2); }, 300000);
async function main() {
  const { fixture, scope } = require('./audit/analytics-traffic/fixture.cjs');
  console.log('START current-schema fixture');
  const f = await fixture(); let server;
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
    const claimed = await lease.claimJob({ userId: s.userId, deviceId, jobKeys: ['fan_data_point_refresh'] });
    assert.ok(claimed.job, JSON.stringify(claimed));
    console.log('PASS claim refresh job');
    const job = claimed.job, auth = { deviceId, leaseToken: job.leaseToken, leaseRevision: job.leaseRevision };
    const jobPost = (endpoint, input = {}) => post(`/api/jobs/${job.id}/${endpoint}`, { ...auth, ...input });
    const envelope = state => ({ driverPhase: 'execute', jobContinuation: state });
    let continuation = null, step, chunks = 0, calls = 0;
    do {
      step = await handler.runChunk({ job, creatorId: s.creatorId, continuation, signal: new AbortController().signal,
        ofApi: { async request({ endpoint }) {
          calls++; const id = endpoint.path.split('/').at(-1);
          if (id === '1000') return { ok: true, status: 200, data: { id, subscribedOnData: { totalSumm: 12.34 } } };
          if (id === '1001') return { ok: true, status: 200, data: { id, subscribedOnData: { totalSumm: 0 } } };
          return { ok: false, status: Number(id) % 2 ? 410 : 404, code: 'OF_HTTP_ERROR' };
        } },
        acquireObservationReadLease: input => jobPost('observation-read-lease/acquire', { ...input, requestId: crypto.randomUUID() }),
        releaseObservationReadLease: readLeaseToken => jobPost('observation-read-lease/release', { readLeaseToken }),
        acquireObservationToken: input => jobPost('observation-token', input),
      });
      assert.equal(step.chunkResult.items.length, step.chunkResult.attempted);
      const wire = { workId: `work-${job.id}`, progress: step.progress, chunkResult: step.chunkResult,
        expectedContinuation: envelope(continuation), continuation: step.outcome === 'done'
          ? { driverPhase: 'complete', result: step.result, progress: step.progress } : envelope(step.continuation) };
      await jobPost('progress', wire);
      await jobPost('progress', wire); // lost-ACK retry must not double-count coverage or reuse a consumed token
      chunks++; continuation = step.continuation;
      console.log('PASS progress replay', chunks);
    } while (step.outcome !== 'done');
    await jobPost('complete', { result: step.result, progress: step.progress });
    assert.equal((await db.jobInstance.findUnique({ where: { id: job.id } })).status, 'DONE');
    assert.equal(chunks, 2); assert.equal(calls, 14); assert.equal(step.result.unavailable, 12); assert.equal(step.result.errors, 0);
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(state.status, 'PARTIAL'); assert.equal(state.fanValueFreshnessStatus, 'PARTIAL');
    assert.equal(state.fanValueSucceeded, 2); assert.equal(state.fanValueUnavailable, 12);
    assert.equal(state.fanValueOutstanding, 0); assert.equal(state.fanValueFailed, 0);
    const demands = await db.creatorFanRefreshDemand.findMany({ where: { creatorId: s.creatorId } });
    assert.equal(demands.filter(row => row.status === 'UNAVAILABLE').length, 12);
    assert.ok(demands.every(row => row.quarantinedAt == null && row.retryAttempts === 0 && row.satisfiedRevision === row.requestedRevision));
    const value = id => db.creatorFanValueCurrent.findUnique({ where: { creatorId_fanRecordId: { creatorId: s.creatorId, fanRecordId: `fan-${id}` } } });
    assert.equal((await value('1000')).platformReportedTotalSpendCents, 1234n);
    assert.equal((await value('1001')).platformReportedTotalSpendCents, 0n);
    assert.equal((await value('1002')).availability, 'UNAVAILABLE');
    assert.equal((await value('1002')).platformReportedTotalSpendCents, 9876n, 'last known money is preserved');
    assert.equal((await value('1003')).platformReportedTotalSpendCents, null, 'unknown is not zero');
    assert.equal((await db.creatorFan.findUnique({ where: { id: 'fan-1002' } })).username, 'known-1002');
    const relation = await db.creatorFanRelationshipCurrent.findUnique({ where: { creatorId_fanRecordId: { creatorId: s.creatorId, fanRecordId: 'fan-1002' } } });
    assert.equal(relation.blocked, true); assert.equal(relation.creatorFollowsFan, true);
    assert.equal(await db.creatorCampaignFan.count({ where: { creatorId: s.creatorId, attributedAt: null } }), 14);
    // Exercise the same persisted read model used by the Campaigns screen.
    const projection = require('../src/services/campaign-read-projection-service');
    const repository = require('../src/services/campaign-read-repository');
    let ready = false;
    for (let sweep = 0; sweep < 40; sweep++) {
      const result = await projection.runCampaignProjectionSweep({ db, limit: 8 });
      assert.equal(result.ok, true, JSON.stringify(result));
      if ((await repository.readiness(db, s.creatorId, new Date())).ready) { ready = true; break; }
    }
    assert.equal(ready, true, 'Campaign read projection converges');
    const viewResponse = await fetch(`${base}/api/stats/creators/${s.creatorId}/campaign-scan?campaignReadVersion=1`);
    const view = await viewResponse.json(); assert.equal(viewResponse.status, 200, JSON.stringify(view));
    assert.equal(view.fanValuesOutstanding, 0); assert.equal(view.fanValuesFailed, 0);
    assert.equal(view.refreshRecoveryAvailable, false);
    assert.equal(view.campaignPage.sourceCoverage.fanValues.status, 'PARTIAL');
    assert.equal(view.campaignPage.sourceCoverage.fanValues.unknownFans, 12);
    assert.equal(view.campaignPage.totals.ofValueKnownFans, 2);
    assert.equal(view.campaignPage.totals.ofValueUnknownFans, 12);
    assert.equal(view.campaignPage.totals.platformReportedFanSpendCents, null);
    assert.equal(unhandled.length, 0);
    console.log('PASS campaign quarantine -> explicit repair -> real read lease/token -> emitted Desktop -> HTTP progress replay -> SQL coverage PARTIAL');
    console.log(JSON.stringify({ chunks, providerCalls: calls, succeeded: state.fanValueSucceeded, unavailable: state.fanValueUnavailable,
      outstanding: state.fanValueOutstanding, failed: state.fanValueFailed, preservedPriorCents: '9876', missingArrivalDates: 14,
      campaignViewFanStatus: view.campaignPage.sourceCoverage.fanValues.status, recoveryAvailable: view.refreshRecoveryAvailable }));
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(alive); clearTimeout(deadline); });
