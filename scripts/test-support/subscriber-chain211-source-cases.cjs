'use strict';
const assert = require('node:assert/strict');
const { loadSubscriberWorker } = require('./subscriber-chain211-fixture.cjs');

function workerSession(h, desktop, run, source) {
  const s = run.scope, provider = [], wire = [], errors = [], faults = {};
  let instance, continuation = structuredClone(run.checkpoint);
  function replace() {
    const log = Object.fromEntries(['info', 'warn', 'debug', 'error'].map(level => [level, (...args) => {
      if (level === 'error') errors.push(args);
    }]));
    instance = new desktop.Worker({ log,
      authStore: { getAuthorizationScopeIncarnation: () => 'subscriber-fixture-login', getDeviceId: () => s.deviceId }, authService: {},
      creatorRuntime: { getVerifiedIdentity: () => ({ platformUserId: s.creator.remoteId }) },
      creatorService: {}, accessRuntime: {}, capabilities: {}, apiRuntime: {}, backgroundRuntime: {}, coordinator: {}, sessionReconcile: {},
      events: { emit() {} }, ofApi: { async request(input) {
        assert.equal(input.jobLease.jobId, run.job.id); assert.equal(input.endpoint.method, 'GET');
        const url = new URL(input.endpoint.path, 'https://subscriber.fixture');
        const offset = Number(url.searchParams.get('offset'));
        assert.equal(Number(url.searchParams.get('limit')), 20);
        provider.push({ offset, path: input.endpoint.path });
        const response = await source({ input, offset, faults, provider });
        return response && Object.hasOwn(response, 'ok') ? response : { ok: true, status: 200, data: response };
      } } });
    instance.scheduleImmediateClaim = () => {};
    // Keep the actual BackendJobClient wire queue, retry policy, and error class.
    // Only its HTTP boundary is replaced by real server operations on PostgreSQL.
    instance.client.api.request = async (url, options) => {
      const operation = url.includes('/observation-read-lease/') ? 'read-' + url.split('/').at(-1) : url.split('/').at(-1);
      const input = { ...options.body, userId: s.userId, jobId: run.job.id };
      wire.push(operation);
      try {
        if (operation === 'renew') return { lease: await h.lease.renewLease(input) };
        if (operation === 'progress') {
          if (faults.progress === 'before') { delete faults.progress; throw Object.assign(Error('fixture progress interrupted before commit'), { status: 503 }); }
          const result = await h.lease.progressJob(input);
          if (faults.progress === 'after') { delete faults.progress; throw Object.assign(Error('fixture progress reply lost after commit'), { status: 503 }); }
          return { lease: result };
        }
        if (operation === 'complete') {
          const result = await h.lease.completeJob(input);
          if (faults.complete === 'after') { delete faults.complete; throw Object.assign(Error('fixture completion reply lost after commit'), { status: 503 }); }
          return result;
        }
        if (operation === 'read-acquire') return await h.lease.acquireJobFanObservationReadLease(input);
        if (operation === 'read-release') return await h.lease.releaseJobObservationReadLease(input);
        if (operation === 'observation-token') return await h.lease.issueFanObservationToken(input);
        if (operation === 'release') return await h.lease.releaseJob(input);
        if (operation === 'fail') return await h.lease.failJob(input);
        throw new Error('UNEXPECTED_SUBSCRIBER_WORKER_OPERATION ' + operation);
      } catch (error) {
        if (error instanceof desktop.BackendRequestError) throw error;
        throw new desktop.BackendRequestError(error.status || 500, error.code || 'FIXTURE_TRANSPORT_INTERRUPTED', error.message,
          { code: error.code, message: error.message, ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}) });
      }
    };
  }
  replace();
  return { provider, wire, errors, faults,
    replace: (stale = null) => { replace(); if (stale !== null) continuation = structuredClone(stale); },
    get continuation() { return continuation; },
    async execute(signal = new AbortController().signal) {
      const step = await instance.runChunk({ job: run.job }, continuation, 'subscriber-work-' + run.job.id, signal, () => {});
      if (step.continuation) continuation = step.continuation;
      return step;
    } };
}

async function runSourceCases(h, check) {
  const { db } = h, desktop = await loadSubscriberWorker(h.desktopRoot);
  const relationship = (s, fanId) => db.creatorFanRelationshipCurrent.findFirst({ where: { creatorId: s.creatorId, onlyFansUserId: fanId } });
  const jobRow = run => db.jobInstance.findUnique({ where: { id: run.job.id } });
  const pageCount = run => db.subscriberScanPage.count({ where: { runId: run.job.params.scanRunId } });
  try {
    await check('a verified empty snapshot is distinct from a source that has never been read', async () => {
      const s = await h.scope('source_empty'), unknown = await h.subs.getSubscriberDirectoryStatus(s);
      assert.equal(unknown.state, null); assert.equal(unknown.fresh, false);
      const run = await h.start(s); await h.page(run, []); const published = await h.finish(run);
      assert.equal(published.state.totalCount, 0); assert.equal(published.state.publishedGeneration, 1);
      assert.ok(published.state.publishedAt); assert.equal((await h.subs.getSubscriberDirectoryStatus(s)).fresh, true);
      assert.equal(await db.fanObservationToken.count({ where: { jobId: run.job.id } }), 0);
      assert.equal(await pageCount(run), 1);
    });

    await check('invalid optional activity dates preserve known facts while explicit null clears them and qualifies the hidden cohort', async () => {
      const s = await h.scope('source_activity'), at = '2026-11-01T01:02:03.000Z';
      const first = await h.start(s); await h.page(first, [{ id: '123', lastSeen: at }]); await h.finish(first);
      const before = await relationship(s, '123');
      const second = await h.start(s); const malformed = await h.page(second, [{ id: '123', lastSeen: 'not-a-date' }]); await h.finish(second);
      assert.equal(Object.hasOwn(malformed.step.chunkResult.items[0], 'lastSeenAt'), false);
      const preserved = await relationship(s, '123');
      assert.equal(preserved.lastSeenAt.toISOString(), at);
      assert.equal(preserved.lastSeenAtAuthorityVersion, before.lastSeenAtAuthorityVersion);
      assert.equal((await h.subs.listHiddenOnline({ ...s, status: 'all' })).count, 0);
      const third = await h.start(s); await h.page(third, [{ id: '123', lastSeen: null }]); await h.finish(third);
      assert.equal((await relationship(s, '123')).lastSeenAt, null);
      const hidden = await h.subs.listHiddenOnline({ ...s, status: 'all' });
      assert.equal(hidden.count, 1); assert.equal(hidden.items[0].fanId, '123');
    });

    await check('malformed optional provider labels, relationship fields, and spend preserve known facts while valid updates and explicit zero still apply', async () => {
      const scope = await h.scope('source_optional_types'), first = await h.start(scope);
      await h.page(first, [{ id: '123', username: 'known', name: 'Known Name', avatar: 'https://fixture.invalid/known.png',
        subscribedOnData: { type: 'FREE', isActive: true }, canReceiveChatMessage: true, totalSpentCents: 500 }]); await h.finish(first);
      const second = await h.start(scope);
      const accepted = await h.page(second, [{ id: '123', username: {}, name: {}, avatar: {},
        subscribedOnData: { type: {}, isActive: 'bad' }, canReceiveChatMessage: 'bad', totalSpentCents: 'not-money' }]); await h.finish(second);
      for (const field of ['username', 'name', 'avatarUrl', 'subscriptionType', 'fanSubscriptionActive', 'canReceiveChatMessage']) {
        assert.equal(Object.hasOwn(accepted.chunk.items[0], field), false);
      }
      const identity = await db.creatorFan.findFirst({ where: { creatorId: scope.creatorId } });
      assert.equal(identity.username, 'known'); assert.equal(identity.displayName, 'Known Name'); assert.equal(identity.avatarUrl, 'https://fixture.invalid/known.png');
      const relation = await relationship(scope, '123'); assert.equal(relation.fanSubscriptionType, 'FREE');
      assert.equal(relation.fanSubscriptionActive, true); assert.equal(relation.canReceiveChatMessage, true);
      assert.equal((await db.creatorFanValueCurrent.findFirst({ where: { creatorId: scope.creatorId } })).platformReportedTotalSpendCents, 500n);
      const third = await h.start(scope);
      await h.page(third, [{ id: '123', userName: 'updated', displayName: 'Updated Name', avatarThumbs: { c144: 'https://fixture.invalid/updated.png' },
        subscriptionType: null, totalSpentCents: 0 }]); await h.finish(third);
      assert.equal((await db.creatorFan.findFirst({ where: { creatorId: scope.creatorId } })).username, 'updated');
      assert.equal((await relationship(scope, '123')).fanSubscriptionType, null);
      const value = await db.creatorFanValueCurrent.findFirst({ where: { creatorId: scope.creatorId } });
      assert.equal(value.platformReportedTotalSpendCents, 0n); assert.equal(value.availability, 'AVAILABLE');
    });

    await check('malformed provider identity stops the real worker without receipts or phantom fans and keeps the prior publication', async () => {
      const s = await h.scope('source_invalid_identity');
      const first = await h.start(s); await h.page(first, [{ id: 'safe', lastSeen: null }]); const prior = await h.finish(first);
      const run = await h.start(s), worker = workerSession(h, desktop, run, async () => ({ list: [{ id: { malformed: true } }], hasMore: false }));
      const step = await worker.execute();
      assert.equal(step.result.reportedFailure, true); assert.equal(step.result.retryable, false);
      assert.equal((await jobRow(run)).status, 'FAILED'); assert.equal(await pageCount(run), 0);
      assert.equal(await db.fanObservationToken.count({ where: { jobId: run.job.id } }), 0);
      assert.equal(await db.fanObservationReadLease.count({ where: { jobId: run.job.id } }), 0);
      assert.equal(await db.creatorFan.count({ where: { creatorId: s.creatorId } }), 1);
      const current = await h.scopeState(s); assert.equal(current.state.currentRunId, prior.state.currentRunId);
      assert.equal((await h.subs.listHiddenOnline({ ...s, status: 'all' })).count, 1);
    });

    await check('180-character canonical identities survive provider normalization, token scope, canonical projection, and public list targets unchanged', async () => {
      const s = await h.scope('source_full_identity'), id = '7'.repeat(180), run = await h.start(s);
      const accepted = await h.page(run, [{ id, lastSeen: null, totalSpentCents: 123 }]); await h.finish(run);
      assert.equal(accepted.chunk.items[0].fanId, id); assert.equal(accepted.chunk.items[0].dialogId, id);
      const list = await h.subs.listHiddenOnline({ ...s, status: 'all' });
      assert.equal(list.count, 1); assert.equal(list.items[0].fanId, id); assert.equal(list.items[0].dialogId, id);
      assert.equal(list.items[0].totalSpentCents, 123);
      assert.equal((await relationship(s, id)).onlyFansUserId, id);
    });

    await check('missing provider exhaustion proof cannot replace an existing populated publication with an empty result', async () => {
      const s = await h.scope('source_unknown_end'), first = await h.start(s);
      await h.page(first, [{ id: 'existing', lastSeen: null }]); const prior = await h.finish(first);
      const run = await h.start(s), worker = workerSession(h, desktop, run, async () => ({ list: [] }));
      const step = await worker.execute(); assert.equal(step.result.retryable, false);
      assert.equal((await jobRow(run)).status, 'FAILED'); assert.equal(await pageCount(run), 0);
      assert.equal((await h.scopeState(s)).state.currentRunId, prior.state.currentRunId);
    });

    await check('a 21-row provider response cannot overrun the twenty-position source window or consume chronology', async () => {
      const s = await h.scope('source_page_bound'), run = await h.start(s);
      await assert.rejects(h.page(run, Array.from({ length: 21 }, (_, id) => ({ id }))), error => error.code === 'SUBSCRIBER_PAGE_SIZE_INVALID');
      assert.equal(await pageCount(run), 0); assert.equal(await db.fanObservationToken.count({ where: { jobId: run.job.id } }), 0);
      assert.equal(await db.creatorFan.count({ where: { creatorId: s.creatorId } }), 0);
      await h.fail(run);
    });

    const s = await h.scope('worker_recovery'), run = await h.start(s), initial = structuredClone(run.checkpoint);
    const firstFan = { id: '1', lastSeen: null, totalSpentCents: 100 };
    const worker = workerSession(h, desktop, run, async ({ offset, faults }) => {
      if (faults.rateLimit) { delete faults.rateLimit; return { ok: false, status: 429, code: 'OF_RATE_LIMITED', error: 'Synthetic rate limit', debug: { retryAfterMs: 120000 } }; }
      if (offset === 0) return { list: [firstFan, firstFan, { id: '2', lastSeen: '2026-11-01T00:00:00.000Z' }], hasMore: true };
      if (offset === 20) return { list: [{ id: '2', lastSeen: null }, { id: '3' }], hasMore: true };
      if (offset === 40) return { list: [{ id: '4' }], hasMore: true };
      if (offset === 60) return { list: [], hasMore: false };
      throw new Error('UNEXPECTED_PROVIDER_OFFSET ' + offset);
    });
    await check('lost progress acknowledgement recovers the committed unique count and offset without a second provider read', async () => {
      worker.faults.progress = 'after'; const step = await worker.execute();
      assert.equal(step.outcome, 'continue'); assert.equal(step.continuation.jobContinuation.offset, 20);
      assert.equal(step.continuation.jobContinuation.scanned, 2); assert.equal(step.progress.current, 2);
      assert.equal(worker.provider.length, 1); assert.equal(await pageCount(run), 1);
    });
    await check('a replacement worker discards stale local continuation and overlapping pages update facts without inflating the directory', async () => {
      worker.replace(initial); const step = await worker.execute();
      assert.equal(worker.provider.at(-1).offset, 20); assert.equal(step.continuation.jobContinuation.offset, 40);
      assert.equal(step.continuation.jobContinuation.scanned, 3); assert.equal(await pageCount(run), 2);
      assert.equal((await relationship(s, '2')).lastSeenAt, null);
    });
    await check('pre-commit transport loss preserves the durable checkpoint and accepts one subsequent retry', async () => {
      worker.faults.progress = 'before'; const before = structuredClone(worker.continuation);
      await assert.rejects(() => worker.execute(), /interrupted before commit/);
      assert.deepEqual((await h.lease.renewLease(run.credentials)).continuation, before);
      assert.equal(await pageCount(run), 2); assert.equal(await relationship(s, '4'), null);
      const step = await worker.execute(); assert.equal(step.continuation.jobContinuation.offset, 60);
      assert.equal(step.continuation.jobContinuation.scanned, 4); assert.equal(await pageCount(run), 3);
    });
    await check('provider HTTP429 retains the accepted cursor, releases the read lease, and respects its bounded retry delay', async () => {
      worker.faults.rateLimit = true; const before = structuredClone(worker.continuation), now = Date.now();
      const step = await worker.execute(); assert.equal(step.result.reportedFailure, true); assert.equal(step.result.retryable, true);
      const job = await jobRow(run); assert.equal(job.status, 'SCHEDULED'); assert.equal(job.attempts, 1);
      assert.deepEqual(job.continuation, before); assert.ok(+job.nextRunAt >= now + 119000);
      assert.ok(+job.nextRunAt < now + 125000); assert.equal(job.result.failure.retryAfterMs, 120000);
      assert.equal(await db.fanObservationReadLease.count({ where: { jobId: run.job.id } }), 0);
      assert.equal(await pageCount(run), 3);
      // The scheduler clock is advanced only for this disposable fixture row.
      await db.jobInstance.update({ where: { id: run.job.id }, data: { nextRunAt: new Date(0) } });
      Object.assign(run, await h.claim(s, run.job.id)); worker.replace(run.checkpoint);
    });
    await check('lost completion acknowledgement cannot repeat source reads or publication and settles the exact unique snapshot', async () => {
      worker.faults.complete = 'after'; const step = await worker.execute();
      assert.equal(step.outcome, 'complete'); assert.equal((await jobRow(run)).status, 'DONE');
      const state = await h.scopeState(s); assert.equal(state.state.totalCount, 4); assert.equal(state.state.hiddenCount, 2);
      assert.equal(state.state.publishedGeneration, 1); assert.equal(await pageCount(run), 4);
      assert.deepEqual(worker.provider.map(row => row.offset), [0, 20, 40, 40, 60, 60]);
      assert.equal((await jobRow(run)).attempts, 0); assert.deepEqual(worker.errors, []);
      const after = await worker.execute(); assert.equal(after.result.staleLease, true);
      assert.equal(worker.provider.length, 6);
    });

    await check('filtered empty windows advance source positions and an explicit terminal window publishes all collected unique fans', async () => {
      const scope = await h.scope('source_filtered'), scan = await h.start(scope);
      await h.page(scan, [], { hasMore: true }); await h.page(scan, [{ id: 'present' }], { hasMore: true }); await h.page(scan, []);
      const result = await h.finish(scan); assert.equal(result.state.totalCount, 1);
      assert.deepEqual(scan.calls.map(call => Number(new URL(call.path, 'https://fixture.invalid').searchParams.get('offset'))), [0, 20, 40]);
      assert.equal(result.runs[0].nextOffset, 40); assert.equal(result.runs[0].pageCount, 3);
    });

    await check('a competing observation read blocks the worker before any provider request and resumes after exact-owner release', async () => {
      const scope = await h.scope('source_read_contention'), scan = await h.start(scope);
      const held = await h.lease.acquireJobFanObservationReadLease({ ...scan.credentials,
        purpose: 'subscriber_directory_page', requestId: 'other-logical-reader' });
      assert.equal(held.acquired, true);
      const session = workerSession(h, desktop, scan, async () => ({ list: [{ id: 'after-release' }], hasMore: false }));
      const waiting = await session.execute(); assert.equal(waiting.outcome, 'continue');
      assert.equal(session.provider.length, 0); assert.equal(await pageCount(scan), 0);
      assert.equal(await db.fanObservationToken.count({ where: { jobId: scan.job.id } }), 0);
      await h.lease.releaseJobObservationReadLease({ ...scan.credentials, readLeaseToken: held.token });
      assert.equal((await session.execute()).outcome, 'complete'); assert.equal(session.provider.length, 1);
      assert.equal((await h.scopeState(scope)).state.totalCount, 1);
    });

    await check('aborting an in-flight source read releases its observation fence and pause/resume keeps the last accepted page without a failed attempt', async () => {
      const scope = await h.scope('source_cancelled_read'), scan = await h.start(scope);
      await h.page(scan, [{ id: 'before-pause' }], { hasMore: true });
      const checkpoint = structuredClone(scan.checkpoint), attempts = (await jobRow(scan)).attempts;
      let entered, hold = true;
      const started = new Promise(resolve => { entered = resolve; });
      const session = workerSession(h, desktop, scan, async ({ input }) => {
        if (hold) {
          entered();
          return new Promise((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('fixture source aborted'), { code: 'ABORT_ERR' }));
            if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, { once: true });
          });
        }
        return { list: [{ id: 'after-pause' }], hasMore: false };
      });
      const controller = new AbortController(), executing = session.execute(controller.signal);
      await Promise.race([started, executing.then(() => { throw new Error('SUBSCRIBER_FIXTURE_EXPECTED_IN_FLIGHT_READ'); })]);
      controller.abort(); await assert.rejects(executing, /aborted/);
      assert.equal(await db.fanObservationReadLease.count({ where: { jobId: scan.job.id } }), 0);
      assert.equal(await pageCount(scan), 1); assert.deepEqual((await jobRow(scan)).continuation, checkpoint);
      await h.lease.releaseJob({ ...scan.credentials, reason: 'fixture deliberate pause', runAfterMs: 1000 });
      await db.jobInstance.update({ where: { id: scan.job.id }, data: { nextRunAt: new Date(0) } });
      Object.assign(scan, await h.claim(scope, scan.job.id)); hold = false; session.replace(checkpoint);
      assert.equal((await session.execute()).outcome, 'complete'); assert.equal((await jobRow(scan)).attempts, attempts);
      assert.equal((await h.scopeState(scope)).state.totalCount, 2);
      assert.deepEqual(session.provider.map(call => call.offset), [20, 20]);
    });

    await check('conflicting duplicates in one response roll back the entire page and leave the token unconsumed', async () => {
      const scope = await h.scope('source_conflicting'), scan = await h.start(scope);
      const step = await h.produce(scan, { list: [{ id: 'same', lastSeen: null }, { id: 'same', lastSeen: '2026-11-01T00:00:00.000Z' }], hasMore: false });
      await assert.rejects(h.progress(scan, step), error => error.code === 'SUBSCRIBER_SCAN_CONFLICTING_FAN_IN_PAGE');
      assert.equal(await pageCount(scan), 0); assert.equal(await db.creatorFan.count({ where: { creatorId: scope.creatorId } }), 0);
      const token = await db.fanObservationToken.findUnique({ where: { token: step.chunkResult.observationToken } }); assert.equal(token.consumedAt, null);
      await h.fail(scan);
    });

    await check('duplicate-only nonterminal source loops stop after the finite window budget without certifying completion', async () => {
      const scope = await h.scope('source_duplicate_loop'), scan = await h.start(scope);
      await h.page(scan, [{ id: 'same' }], { hasMore: true });
      for (let i = 0; i < 5; i++) await h.page(scan, [{ id: 'same' }], { hasMore: true });
      await assert.rejects(h.page(scan, [{ id: 'same' }], { hasMore: true }), error => error.code === 'SUBSCRIBER_SCAN_NON_ADVANCING_SOURCE');
      assert.equal(await pageCount(scan), 6); assert.equal((await h.scopeState(scope)).state.publishedAt, null);
      await h.fail(scan);
    });

    await check('fifty empty advancing windows remain incomplete and the next empty page stops the actual worker instead of publishing false zero', async () => {
      const scope = await h.scope('source_empty_loop'), scan = await h.start(scope);
      const session = workerSession(h, desktop, scan, async () => ({ list: [], hasMore: true }));
      for (let index = 0; index < 50; index++) {
        const step = await session.execute(); assert.equal(step.outcome, 'continue');
        assert.equal(step.continuation.jobContinuation.offset, (index + 1) * 20);
      }
      const stopped = await session.execute(); assert.equal(stopped.result.reportedFailure, true); assert.equal(stopped.result.retryable, false);
      assert.equal((await jobRow(scan)).status, 'FAILED'); assert.equal(await pageCount(scan), 50);
      const state = await h.scopeState(scope); assert.equal(state.state.publishedAt, null); assert.equal(state.state.currentRunId, null);
      assert.equal(await db.fanObservationToken.count({ where: { jobId: scan.job.id } }), 0);
      assert.equal(await db.fanObservationReadLease.count({ where: { jobId: scan.job.id } }), 0);
    });

    await check('an accepted terminal page survives process stop and maintenance publishes it without another source request', async () => {
      const scope = await h.scope('source_publication_recovery'), scan = await h.start(scope);
      await h.page(scan, [{ id: 'accepted', lastSeen: null }]);
      const before = await h.scopeState(scope); assert.equal(before.state.publishedAt, null);
      assert.equal(scan.checkpoint.driverPhase, 'complete'); assert.ok(before.signals.some(signal => signal.kind === 'RECOVERY'));
      await h.lease.releaseJob({ ...scan.credentials, reason: 'fixture process stopped after accepted final page', runAfterMs: 1000 });
      await h.subs.recoverSubscriberPublicationDebt({ db, ...scope, maxRuns: 4, maxStepsPerRun: 20, maxRuntimeMs: 30000 });
      assert.equal((await jobRow(scan)).status, 'DONE'); const state = await h.scopeState(scope);
      assert.equal(state.state.totalCount, 1); assert.equal(state.state.currentRunId, scan.job.params.scanRunId); assert.equal(scan.calls.length, 1);
      assert.equal((await h.subs.listHiddenOnline({ ...scope, status: 'all' })).count, 1);
    });
  } finally { desktop.close(); }
}
module.exports = { runSourceCases, workerSession };
