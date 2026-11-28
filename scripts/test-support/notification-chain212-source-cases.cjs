'use strict';
const assert = require('node:assert/strict');
const { loadNotificationWorker } = require('./notification-chain212-fixture.cjs');

function workerSession(h, desktop, run, source) {
  const s = run.scope, provider = [], wire = [], errors = [], faults = {};
  let instance, continuation = structuredClone(run.checkpoint);
  function replace() {
    const log = Object.fromEntries(['info', 'warn', 'debug', 'error'].map(level => [level, (...args) => {
      if (level === 'error') errors.push(args);
    }]));
    instance = new desktop.Worker({ log,
      authStore: { getAuthorizationScopeIncarnation: () => 'notification-fixture-login', getDeviceId: () => s.deviceId }, authService: {},
      creatorRuntime: { getVerifiedIdentity: () => ({ platformUserId: s.creator.remoteId }) },
      creatorService: {}, accessRuntime: {}, capabilities: {}, apiRuntime: {}, backgroundRuntime: {}, coordinator: {}, sessionReconcile: {},
      events: { emit() {} }, ofApi: { async request(input) {
        assert.equal(input.jobLease.jobId, run.job.id); assert.equal(input.endpoint.method, 'GET');
        const url = new URL(input.endpoint.path, 'https://notification.fixture');
        const fromId = url.searchParams.get('fromId'), type = url.searchParams.get('type');
        assert.equal(Number(url.searchParams.get('limit')), 10);
        provider.push({ fromId, type, path: input.endpoint.path, source: input.source });
        const response = await source({ input, fromId, type, faults, provider });
        return response && Object.hasOwn(response, 'ok') ? response : { ok: true, status: 200, data: response };
      } } });
    instance.scheduleImmediateClaim = () => {};
    // Preserve the production BackendJobClient, renewal queue and recovery
    // policy. Replace only HTTP transport with the real PostgreSQL services.
    instance.client.api.request = async (url, options) => {
      const operation = url.split('/').at(-1), input = { ...options.body, userId: s.userId, jobId: run.job.id };
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
        if (operation === 'release') return await h.lease.releaseJob(input);
        if (operation === 'fail') return await h.lease.failJob(input);
        throw new Error('UNEXPECTED_NOTIFICATION_WORKER_OPERATION ' + operation);
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
      const step = await instance.runChunk({ job: run.job }, continuation, 'notification-work-' + run.job.id, signal, () => {});
      if (step.continuation) continuation = step.continuation;
      return step;
    } };
}

async function runSourceCases(h, check) {
  const { db } = h, desktop = await loadNotificationWorker(h.desktopRoot);
  const at = () => new Date(Date.now() - 60000).toISOString();
  const tip = (id, extra = {}) => ({ id, type: 'tip', amount: 5, createdAt: at(), user: { id: '123' }, ...extra });
  const pageCount = run => db.creatorNotificationFrontierPage.count({ where: { creatorId: run.scope.creatorId, generation: run.job.params.collectionGeneration } });
  try {
    await check('a complete six-source empty notification history is distinct from an unread source', async () => {
      const s = await h.scope('empty'); assert.equal((await h.scopeState(s)).state, null);
      const done = await h.full(s); assert.equal(done.job.status, 'DONE'); assert.equal(done.state.status, 'COMPLETE');
      assert.equal(done.state.normalizerVersion, 'notification-source-v3'); assert.ok(done.state.fullBackfillVerifiedAt);
      assert.equal(done.events.length, 0); assert.equal(done.frontiers.length, 6); assert.equal(done.run.calls.length, 6);
      assert.deepEqual(done.run.calls.map(call => new URL(call.path, 'https://fixture.invalid').searchParams.get('type')),
        ['subscribed', 'purchases', 'tip', 'commented', 'favorited', null]);
    });

    await check('the actual typed and ALL collectors persist exact source amounts, unknown subscription prices and unsupported notices', async () => {
      const s = await h.scope('source_semantics');
      const unknown = { ...tip('unknown'), type: 'subscribed', amount: undefined, price: null };
      const free = { ...tip('free'), type: 'subscribed', amount: 0 };
      const paid = { ...tip('paid'), type: 'subscribed', amountCents: '', amount: 5 };
      const sourceTip = tip('tip', { amountCents: '', amount: undefined, text: 'Sent you $5' });
      const notice = tip('notice', { type: 'post_removed' });
      const nul = tip('nul', { text: 'Tip\u0000', user: { id: '123', name: 'Name\u0000suffix' } });
      const rows = [unknown, free, paid, sourceTip, notice, nul];
      const done = await h.full(s, { subscriptions: [unknown, free, paid], tips: [sourceTip, notice, nul], all_reconciliation: rows });
      assert.equal(done.job.status, 'DONE'); assert.equal(done.state.status, 'COMPLETE'); assert.equal(done.events.length, 6);
      const tips = await db.creatorTip.findMany({ where: { creatorId: s.creatorId } });
      assert.equal(tips.length, 2); assert.ok(tips.every(row => row.amountCents === 500));
      const subs = await db.creatorSubscriptionEvent.findMany({ where: { creatorId: s.creatorId } });
      assert.deepEqual(subs.map(row => [row.externalNotificationId, row.observedPriceCents]).sort(), [['free', 0], ['paid', 500], ['unknown', null]]);
      assert.equal(done.events.find(row => row.notificationId === 'notice').disposition, 'IGNORED');
      assert.equal(done.events.find(row => row.notificationId === 'nul').fanDisplayNameAtEvent, null);
      assert.equal(done.events.find(row => row.notificationId === 'nul').sourceEvidence.text, 'Tip\\u0000');
      assert.equal(done.audits.length, 12); assert.equal(done.audits.filter(row => row.outcome === 'REJECTED').length, 0);
    });

    await check('source currency spacing and decimal precision cannot corrupt persisted notification money', async () => {
      const s = await h.scope('source_precision');
      const grouped = tip('narrow-spaced', { amount: undefined, text: 'Sent you $1\u202f234.56' });
      const equivalent = tip('equivalent-text', { amount: undefined, title: 'Tip $5', text: 'Sent you $5.00' });
      const fractional = tip('fractional-cent', { type: 'subscribed', amount: 0.001 });
      const done = await h.full(s, { subscriptions: [fractional], tips: [grouped, equivalent],
        all_reconciliation: [grouped, equivalent, fractional] });
      const tips = await db.creatorTip.findMany({ where: { creatorId: s.creatorId } });
      assert.deepEqual(tips.map(row => row.amountCents).sort((a, b) => a - b), [500, 123456]);
      assert.equal(await db.creatorSubscriptionEvent.count({ where: { creatorId: s.creatorId } }), 0);
      const rejected = done.events.find(row => row.notificationId === 'fractional-cent');
      assert.equal(rejected.disposition, 'REJECTED'); assert.equal(rejected.reasonCode, 'INVALID_AMOUNT');
      assert.equal(rejected.amountCents, null); assert.equal(done.state.fullBackfillVerifiedAt, null);
      assert.notEqual(done.state.status, 'COMPLETE');
    });

    await check('valid long emoji text and malformed UTF-16 diagnostics cannot poison PostgreSQL source pages', async () => {
      const s = await h.scope('source_unicode');
      const long = tip('long-emoji', { text: 'x'.repeat(1199) + '😀', user: { id: '123', name: 'x'.repeat(499) + '😀' } });
      const malformed = tip('malformed-text', { text: 'bad\ud800text', user: { id: '123', name: 'bad\udc00name' } });
      const done = await h.full(s, { tips: [long, malformed], all_reconciliation: [long, malformed] });
      assert.equal(done.state.status, 'COMPLETE'); assert.equal(done.events.length, 2);
      assert.equal(done.events.find(row => row.notificationId === 'long-emoji').fanDisplayNameAtEvent, 'x'.repeat(499));
      assert.equal(done.events.find(row => row.notificationId === 'malformed-text').sourceEvidence.text, 'bad\\ud800text');
      assert.equal(await db.creatorTip.count({ where: { creatorId: s.creatorId } }), 2);
    });

    const s = await h.scope('worker_recovery'); await h.full(s);
    const run = await h.start(s), initial = structuredClone(run.checkpoint);
    const n1 = { ...tip('n1'), type: 'subscribed', amount: undefined }, n2 = tip('n2', { amountCents: '' });
    const n3 = { ...tip('n3'), type: 'favorited', amount: undefined, postId: 'post' };
    const n4 = { ...tip('n4'), type: 'commented', amount: undefined, postId: 'post', commentId: 'comment' };
    const n5 = { ...tip('n5'), type: 'post_removed' }, n6 = tip('n6', { type: 'purchase', messageId: 'message' });
    const n7 = { ...tip('n7'), type: 'subscribed', amount: 0 };
    const worker = workerSession(h, desktop, run, async ({ fromId, faults }) => {
      if (faults.rateLimit) { delete faults.rateLimit; return { ok: false, status: 429, code: 'OF_RATE_LIMITED', error: 'Synthetic rate limit', debug: { retryAfterMs: 120000 } }; }
      if (!fromId) return { list: [n1, n2, n3], hasMore: true };
      if (fromId === 'n3') return { list: [n3, n4, n5], hasMore: true };
      if (fromId === 'n5') return { list: [n6, n7], hasMore: true };
      if (fromId === 'n7') return { list: [], hasMore: false };
      throw new Error('UNEXPECTED_NOTIFICATION_CURSOR ' + fromId);
    });
    await check('lost notification progress acknowledgement recovers the committed cursor without repeating the source request', async () => {
      worker.faults.progress = 'after'; const step = await worker.execute();
      assert.equal(step.outcome, 'continue'); assert.equal(step.continuation.jobContinuation.fromId, 'n3');
      assert.equal(worker.provider.length, 1); assert.equal(await pageCount(run), 1);
      assert.equal(await db.creatorTip.count({ where: { creatorId: s.creatorId } }), 1);
    });
    await check('a new worker adopts the server checkpoint and overlapping history identities cannot multiply facts', async () => {
      worker.replace(initial); const step = await worker.execute();
      assert.equal(worker.provider.at(-1).fromId, 'n3'); assert.equal(step.continuation.jobContinuation.fromId, 'n5');
      assert.equal(await pageCount(run), 2); assert.equal(await db.creatorPostLike.count({ where: { creatorId: s.creatorId } }), 1);
    });
    await check('a transport failure before progress commit preserves the prior cursor and accepts exactly one replay', async () => {
      worker.faults.progress = 'before'; const before = structuredClone(worker.continuation);
      await assert.rejects(worker.execute(), /interrupted before commit/);
      assert.deepEqual((await h.lease.renewLease(run.credentials)).continuation, before);
      assert.equal(await pageCount(run), 2); assert.equal(await db.creatorSale.count({ where: { creatorId: s.creatorId } }), 0);
      const step = await worker.execute(); assert.equal(step.continuation.jobContinuation.fromId, 'n7');
      assert.equal(await pageCount(run), 3); assert.equal(await db.creatorSale.count({ where: { creatorId: s.creatorId } }), 1);
    });
    await check('provider HTTP429 keeps notification progress and schedules its bounded retry without losing accepted facts', async () => {
      worker.faults.rateLimit = true; const before = structuredClone(worker.continuation), now = Date.now();
      const step = await worker.execute(); assert.equal(step.result.reportedFailure, true); assert.equal(step.result.retryable, true);
      const job = await h.jobRow(run); assert.equal(job.status, 'SCHEDULED'); assert.equal(job.attempts, 1);
      assert.deepEqual(job.continuation, before); assert.ok(+job.nextRunAt >= now + 119000);
      assert.ok(+job.nextRunAt < now + 125000); assert.equal(await pageCount(run), 3);
      await db.jobInstance.update({ where: { id: run.job.id }, data: { nextRunAt: new Date(0) } });
      Object.assign(run, await h.claim(s, run.job.id)); worker.replace(run.checkpoint);
    });
    await check('lost terminal acknowledgement cannot repeat notification facts, source requests or completion', async () => {
      worker.faults.complete = 'after'; const step = await worker.execute();
      assert.equal(step.outcome, 'complete'); assert.equal((await h.jobRow(run)).status, 'DONE');
      assert.equal((await h.scopeState(s)).state.status, 'COMPLETE'); assert.equal(await pageCount(run), 4);
      assert.equal(await db.creatorNotificationEvent.count({ where: { creatorId: s.creatorId } }), 7);
      assert.deepEqual(worker.provider.map(call => call.fromId), [null, 'n3', 'n5', 'n5', 'n7', 'n7']);
      const replay = await worker.execute(); assert.equal(replay.result.staleLease, true); assert.equal(worker.provider.length, 6);
      assert.deepEqual(worker.errors, []);
    });

    await check('ambiguous empty-page proof stops the real worker without source receipts or a verified baseline', async () => {
      const scope = await h.scope('ambiguous_page'), scan = await h.start(scope, { forceFull: true });
      const session = workerSession(h, desktop, scan, async () => ({ list: [], hasMore: false, more: true }));
      const step = await session.execute(); assert.equal(step.result.reportedFailure, true); assert.equal(step.result.retryable, false);
      assert.equal((await h.jobRow(scan)).status, 'FAILED'); assert.equal(await pageCount(scan), 0);
      assert.equal((await h.scopeState(scope)).state?.fullBackfillVerifiedAt ?? null, null);
    });

    await check('cancelling an in-flight source read and resuming preserves its exact page and does not charge a failed attempt', async () => {
      const scope = await h.scope('cancelled_read'); await h.full(scope); const scan = await h.start(scope);
      await h.page(scan, [tip('before')], { hasMore: true });
      const checkpoint = structuredClone(scan.checkpoint), attempts = (await h.jobRow(scan)).attempts;
      let entered, hold = true;
      const started = new Promise(resolve => { entered = resolve; });
      const session = workerSession(h, desktop, scan, async ({ input, fromId }) => {
        assert.equal(fromId, 'before');
        if (hold) { entered(); return new Promise((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('fixture source aborted'), { code: 'ABORT_ERR' }));
          if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, { once: true });
        }); }
        return { list: [tip('after')], hasMore: false };
      });
      const controller = new AbortController(), executing = session.execute(controller.signal);
      await Promise.race([started, executing.then(() => { throw new Error('NOTIFICATION_FIXTURE_EXPECTED_IN_FLIGHT_READ'); })]);
      await h.stop(scope); controller.abort(); await assert.rejects(executing, /aborted/);
      assert.equal((await h.jobRow(scan)).status, 'PAUSED'); assert.deepEqual((await h.jobRow(scan)).continuation, checkpoint);
      assert.equal(await pageCount(scan), 1);
      Object.assign(scan, await h.resume(scope)); hold = false; session.replace(scan.checkpoint);
      assert.equal((await session.execute()).outcome, 'complete'); assert.equal((await h.jobRow(scan)).attempts, attempts);
      assert.equal(await db.creatorTip.count({ where: { creatorId: scope.creatorId } }), 2);
      assert.deepEqual(session.provider.map(call => call.fromId), ['before', 'before']);
    });

    await check('repeated nonterminal cursor cycles stop without certifying the incomplete typed history', async () => {
      const scope = await h.scope('cursor_cycle'), scan = await h.start(scope, { forceFull: true });
      const session = workerSession(h, desktop, scan, async ({ fromId }) => ({ list: [tip(fromId === 'A' ? 'B' : 'A', { type: 'subscribed' })], hasMore: true }));
      let step;
      for (let turn = 0; turn < 5; turn++) { step = await session.execute(); if (step.result?.reportedFailure) break; }
      assert.equal(step.result?.reportedFailure, true); assert.equal(step.result.retryable, false);
      assert.equal((await h.jobRow(scan)).status, 'FAILED'); assert.ok(await pageCount(scan) <= 3);
      assert.equal((await h.scopeState(scope)).state?.fullBackfillVerifiedAt ?? null, null);
    });
  } finally { desktop.close(); }
}
module.exports = { runSourceCases, workerSession };
