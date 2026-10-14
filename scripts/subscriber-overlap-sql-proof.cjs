"use strict";
// Current migrations, real Express routes, and emitted Desktop handler.
// Authentication/provider pages and deliberate failure triggers are fixtures.
// The SQL runtime always creates an isolated database, never the caller's DB.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const alive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error('SQL_PROOF_DEADLINE'); process.exit(2); }, 300000);
async function main() {
  const { fixture, scope } = require('./audit/analytics-traffic/fixture.cjs');
  console.log('START current-schema fixture');
  const f = await fixture(); let server;
  try {
    const { db } = f, s = await scope(db), now = new Date(), deviceId = 'qa-subscriber-device';
    require.cache[require.resolve('../src/prisma')] = { exports: db };
    const directory = require('../src/services/subscriber-directory-service');
    const lease = require('../src/services/job-lease-service');
    const { subscriberDirectoryHandler: handler } = await import(pathToFileURL(path.join(
      path.resolve(process.env.ONLINOD_DESKTOP_ROOT || '../desktop'),
      'apps/desktop/dist/electron/main/services/backend-jobs/handlers/subscriber-directory-handler.js')));
    await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(+now + 86400000) } });
    await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
    await db.deviceCreatorBinding.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, deviceId,
      status: 'ACTIVE', sessionReadReady: true, lastSeenAt: now } });
    const express = require('express'), app = express(), unhandled = [];
    app.use(express.json());
    app.use(async (req, res, next) => {
      try { req.auth = { userId: s.userId, agencyId: s.agencyId, deviceId,
        membership: await db.agencyMember.findFirst({ where: { agencyId: s.agencyId, userId: s.userId } }) }; next(); }
      catch (error) { next(error); }
    });
    app.use('/api/jobs', require('../src/routes/jobs'));
    app.use((error, req, res, next) => { unhandled.push(error); res.status(500).json({ code: error.code, message: error.message }); });
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function post(job, endpoint, input = {}, expectedStatus = 200) {
      const response = await fetch(`${base}/api/jobs/${job.id}/${endpoint}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId,
          leaseToken: job.leaseToken, leaseRevision: job.leaseRevision, ...input }) });
      const result = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(result)); return result;
    }
    async function start() {
      const scheduled = await directory.scheduleSubscriberScan({ db, ...s, manual: true, force: true, pageLimit: 20 });
      assert.equal(scheduled.created, true, JSON.stringify(scheduled));
      const claimed = await lease.claimJob({ userId: s.userId, deviceId, jobKeys: ['subscriber_directory_scan'] });
      assert.ok(claimed.job, JSON.stringify(claimed)); return claimed.job;
    }
    const envelope = state => ({ driverPhase: 'execute', jobContinuation: state });
    const job = await start(), runId = job.params.scanRunId;
    console.log('PASS scheduled and claimed subscriber scan');

    // A PostgreSQL error aborts the transaction. The waiting result is permitted
    // only after rollback; this reproduces the exact production trigger signal.
    await db.$executeRawUnsafe(`CREATE FUNCTION qa_subscriber_busy() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'PHASE2_CREATOR_LIFECYCLE_BUSY creator fixture'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER qa_subscriber_busy BEFORE INSERT ON "FanObservationReadLease"
      FOR EACH ROW EXECUTE FUNCTION qa_subscriber_busy()`);
    const waiting = await post(job, 'observation-read-lease/acquire', { requestId: crypto.randomUUID(), purpose: 'subscriber_directory_page' });
    assert.equal(waiting.acquired, false); assert.equal(waiting.reason, 'creator_lifecycle_contended');
    assert.equal(await db.fanObservationReadLease.count(), 0);
    assert.equal((await db.jobInstance.findUnique({ where: { id: job.id } })).status, 'CLAIMED');
    const denied = await post(job, 'observation-read-lease/acquire', { leaseToken: 'wrong-token-with-sufficient-length',
      requestId: crypto.randomUUID(), purpose: 'subscriber_directory_page' }, 409);
    assert.ok(denied.code); // Contention must not bypass authorization.
    await db.$executeRawUnsafe(`DROP TRIGGER qa_subscriber_busy ON "FanObservationReadLease"`);
    await db.$executeRawUnsafe(`DROP FUNCTION qa_subscriber_busy()`);
    console.log('PASS lifecycle contention waits after rollback; wrong lease still rejected');

    const two = { id: 1002, username: 'two', lastSeen: null, subscribedOnData: { totalSumm: 20 } };
    const pages = new Map([
      [0, { list: [{ id: 1001, username: 'one', subscribedOnData: { totalSumm: 10 } }, two, two,
        { id: 1003, username: 'three', subscribedOnData: { totalSumm: 5 } }], hasMore: true }],
      [4, { list: [{ id: 1001 }, { id: 1002, username: 'two-updated', lastSeen: now.toISOString(), subscribedOnData: { totalSumm: 0 } },
        { id: 1004, lastSeen: null }], hasMore: true }],
      [7, { list: [{ id: 1004, lastSeen: null }, { id: 1005 }], hasMore: false }],
    ]);
    let providerCalls = 0;
    async function read(activeJob, continuation, source) {
      return handler.runChunk({ job: activeJob, creatorId: s.creatorId, continuation,
        signal: new AbortController().signal,
        ofApi: { async request({ endpoint }) {
          providerCalls++; const offset = Number(new URL(endpoint.path, 'https://fixture.invalid').searchParams.get('offset'));
          const data = source(offset); assert.ok(data, `unexpected provider offset ${offset}`); return { ok: true, status: 200, data };
        } },
        acquireObservationReadLease: input => post(activeJob, 'observation-read-lease/acquire', { ...input, requestId: crypto.randomUUID() }),
        releaseObservationReadLease: readLeaseToken => post(activeJob, 'observation-read-lease/release', { readLeaseToken }),
        acquireObservationToken: input => post(activeJob, 'observation-token', input),
      });
    }
    function wireFor(activeJob, before, step) {
      return { workId: `work-${activeJob.id}`, progress: step.progress, chunkResult: step.chunkResult,
        expectedContinuation: envelope(before), continuation: step.outcome === 'done'
          ? { driverPhase: 'complete', result: step.result, progress: step.progress } : envelope(step.continuation) };
    }
    const fanValue = async id => {
      const fan = await db.creatorFan.findFirst({ where: { creatorId: s.creatorId, onlyFansUserId: String(id) } });
      return fan && db.creatorFanValueCurrent.findUnique({ where: { creatorId_fanRecordId: { creatorId: s.creatorId, fanRecordId: fan.id } } });
    };
    let continuation = null, durable, firstWire, pageNumber = 0;
    do {
      const step = await read(job, continuation, offset => pages.get(offset));
      const wire = wireFor(job, continuation, step); if (!firstWire) firstWire = wire;
      if (pageNumber === 1) {
        // Fail after snapshot/projection/token writes, before the cursor commit.
        await db.$executeRawUnsafe(`CREATE FUNCTION qa_subscriber_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF OLD."nextOffset" = 4 AND NEW."nextOffset" = 7 THEN
            RAISE EXCEPTION 'QA_SUBSCRIBER_ATOMIC_ROLLBACK'; END IF; RETURN NEW; END $$`);
        await db.$executeRawUnsafe(`CREATE TRIGGER qa_subscriber_rollback BEFORE UPDATE ON "SubscriberScanRun"
          FOR EACH ROW EXECUTE FUNCTION qa_subscriber_rollback()`);
        await post(job, 'progress', wire, 500);
        assert.match(unhandled.at(-1).message, /QA_SUBSCRIBER_ATOMIC_ROLLBACK/);
        const rolledBack = await db.subscriberScanRun.findUnique({ where: { id: runId } });
        assert.equal(rolledBack.nextOffset, 4); assert.equal(rolledBack.scannedCount, 3); assert.equal(rolledBack.hiddenCount, 1);
        assert.equal(await db.subscriberScanPage.count({ where: { runId } }), 1);
        assert.equal(await db.subscriberScanItem.count({ where: { runId } }), 3);
        assert.equal((await fanValue(1002)).platformReportedTotalSpendCents, 2000n);
        const token = await db.fanObservationToken.findUnique({ where: { token: step.chunkResult.observationToken } });
        assert.equal(token.consumedAt, null);
        await db.$executeRawUnsafe(`DROP TRIGGER qa_subscriber_rollback ON "SubscriberScanRun"`);
        await db.$executeRawUnsafe(`DROP FUNCTION qa_subscriber_rollback()`);
        console.log('PASS atomic rollback of page, snapshot, FanData, token and cursor');
      }
      durable = (await post(job, 'progress', wire)).lease;
      const replay = (await post(job, 'progress', wire)).lease;
      assert.deepEqual(replay.continuation, durable.continuation);
      if (pageNumber === 1) {
        const legacyWire = { ...firstWire }; delete legacyWire.expectedContinuation;
        const legacy = (await post(job, 'progress', legacyWire)).lease;
        assert.deepEqual(legacy.continuation, durable.continuation, 'old page must not rewind the cursor');
      }
      pageNumber++; continuation = durable.continuation.jobContinuation;
      console.log('PASS page commit and replay', pageNumber);
    } while (durable.continuation.driverPhase !== 'complete');
    assert.equal(durable.progress.current, 5); assert.equal(durable.progress.percent, 99);
    await post(job, 'complete', { result: durable.continuation.result, progress: durable.progress });
    const completedJob = await db.jobInstance.findUnique({ where: { id: job.id } });
    const published = await db.subscriberScanRun.findUnique({ where: { id: runId } });
    const state = await db.subscriberDirectoryState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(completedJob.status, 'DONE'); assert.equal(published.status, 'PUBLISHED');
    assert.equal(state.currentRunId, runId); assert.equal(state.totalCount, 5); assert.equal(state.hiddenCount, 1);
    assert.equal(published.nextOffset, 9); assert.equal(published.scannedCount, 5); assert.equal(published.pageCount, 3);
    assert.equal(published.summary.traversal.duplicateRows, 4);
    const receipts = await db.subscriberScanPage.findMany({ where: { runId } });
    assert.equal(receipts.reduce((sum, row) => sum + row.itemCount, 0), 9);
    assert.equal(await db.subscriberScanItem.count({ where: { runId } }), 5);
    assert.equal((await fanValue(1001)).platformReportedTotalSpendCents, 1000n, 'missing money preserves last known value');
    assert.equal((await fanValue(1002)).platformReportedTotalSpendCents, 0n, 'explicit zero is current evidence');
    for (const id of [1004, 1005]) assert.equal((await fanValue(id))?.platformReportedTotalSpendCents ?? null, null);
    assert.equal((await db.subscriberScanItem.findUnique({ where: { runId_fanId: { runId, fanId: '1002' } } })).username, 'two-updated');
    console.log('PASS published 9 provider rows as 5 unique fans, latest hidden count and money semantics');

    const stalledJob = await start(); continuation = null;
    for (let page = 0; page < 7; page++) {
      const step = await read(stalledJob, continuation, () => ({ list: [{ id: 2001 }], hasMore: true }));
      const wire = wireFor(stalledJob, continuation, step);
      if (page < 6) continuation = (await post(stalledJob, 'progress', wire)).lease.continuation.jobContinuation;
      else {
        const failure = await post(stalledJob, 'progress', wire, 422);
        assert.equal(failure.code, 'SUBSCRIBER_SCAN_NON_ADVANCING_SOURCE');
        await post(stalledJob, 'fail', { error: failure.code, retryable: false });
      }
    }
    assert.equal((await db.jobInstance.findUnique({ where: { id: stalledJob.id } })).status, 'FAILED');
    const failedRun = await db.subscriberScanRun.findUnique({ where: { id: stalledJob.params.scanRunId } });
    assert.equal(failedRun.status, 'FAILED'); assert.equal(failedRun.nextOffset, 6); assert.equal(failedRun.scannedCount, 1);
    const retained = await db.subscriberDirectoryState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(retained.currentRunId, runId); assert.equal(retained.totalCount, 5); assert.equal(retained.hiddenCount, 1);
    assert.equal(unhandled.length, 1, 'only the deliberate atomic rollback may reach error middleware');
    console.log('PASS bounded stalled source failure preserves the previous published snapshot');
    console.log(JSON.stringify({ providerCalls, rows: 9, uniqueFans: 5, hiddenFans: 1, duplicates: 4,
      pageCount: 3, replaySafe: true, atomicRollback: true, contentionWait: true, stalledSourceStatus: 422 }));
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(alive); clearTimeout(deadline); });
