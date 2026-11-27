"use strict";
// Run against an explicitly selected disposable native PostgreSQL schema:
// ONLINOD_POSTGRES_INTEGRATION=1 ONLINOD_NATIVE_TEST_DATABASE_URL=...
// ONLINOD_DESKTOP_ROOT=/path/to/desktop node scripts/audit/earnings-chain210-proof.cjs
// Only provider GET responses and HTTP transport are synthetic. The Desktop
// handler/worker/client, lease owner, receipts, verification and publisher are real.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openEarningsChainFixture, loadDesktopReadonlyWorker } = require('../test-support/earnings-chain210-fixture.cjs');
const report = { ok: false, nativePostgres: true, actualWorkerAndClient: true, physicalHttpTransport: false, cases: [] };
const day = 86400000;
let h;
async function check(name, work) {
  await work(); report.cases.push({ name, ok: true }); console.log('PASS', name);
}

async function ingestion() {
  const { db } = h;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const ago = days => new Date(+now - days * day);
  const money = (id, type, amount, days, status = 'done') => ({ id, descriptionDetails: { type }, amount, net: amount * 0.8,
    fee: amount * 0.2, currency: 'USD', status, createdAt: ago(days).toISOString(), user: { id: 'fan' } });
  const s = await h.scope('all_categories');
  const records = [money('message', 'message', 10, 1), money('tip', 'tip', 5, 2, 'loading'), money('sub', 'subscribes', 3, 3),
    money('post', 'post', 4, 4), money('stream', 'stream', 6, 5), money('undone', 'message', 8, 6, 'undo')];
  let first;
  await check('real manual start, handler pages, stale reply replay, six charts and publication preserve exact category money', async () => {
    first = await h.start(s);
    const page1 = await h.page(first, records.slice(0, 3), { hasMore: true, nextMarker: 'page-two' });
    const replay = await h.progress(first, page1.step, page1.expected);
    assert.equal(replay.sideEffect.staleProgress, true);
    assert.equal(await db.financialPageReceipt.count({ where: { runId: h.receipts.runId(first.job) } }), 1);
    await h.page(first, [records[2], ...records.slice(3)]);
    await h.charts(first, records);
    const done = await h.finish(first);
    assert.equal(done.run.proof.windows[0].count, 6);
    assert.equal(done.run.proof.complete, true);
    assert.equal(done.state.status, 'COMPLETE');
    const summary = await h.summary(s, ago(7), now);
    assert.equal(summary.ready, true);
    assert.equal(summary.finance.netCents, 2240);
    assert.equal(summary.finance.grossCents, 2800);
    assert.equal((await h.gen.activeEntry(db, s.creatorId, 'undone')).status, 'undo');
    report.ingestionSummary = summary;
  });
  await check('pause revokes old lease; resume keeps same command, receipt cursor and frozen source interval', async () => {
    const run = await h.start(s);
    await h.page(run, records.slice(0, 3), { hasMore: true, nextMarker: 'resume-from-two' });
    const before = structuredClone(run.checkpoint);
    assert.equal((await h.manual.stopManualFinancialTransactionScan({ db, creatorId: s.creatorId })).action, 'paused');
    const step = await h.produce(run, { list: records.slice(3), hasMore: false });
    await assert.rejects(() => h.progress(run, step), error => error?.status === 409);
    const resumed = await h.start(s);
    assert.equal(resumed.job.id, run.job.id);
    assert.equal(resumed.job.params.collectionGeneration, run.job.params.collectionGeneration);
    assert.deepEqual(resumed.job.params.financialWindows, run.job.params.financialWindows);
    assert.deepEqual(resumed.checkpoint, before);
    await h.page(resumed, records.slice(3)); await h.charts(resumed, records); await h.finish(resumed);
    assert.equal((await h.summary(s, ago(7), now)).finance.netCents, 2240);
  });
  await check('mismatched replacement is terminal and preserves prior published money', async () => {
    const prior = await db.creatorEarningsLedgerProof.findUnique({ where: { creatorId: s.creatorId } });
    const run = await h.start(s);
    await h.page(run, [money('message', 'message', 99, 1)]);
    await h.charts(run, [money('message', 'message', 10, 1)]);
    const done = await h.finish(run, 'FAILED');
    assert.equal(done.run.proof.complete, false);
    assert.equal(done.job.result.completionSideEffect.verification, 'MISMATCH');
    assert.equal(done.proof.activeGeneration, prior.activeGeneration);
    assert.equal((await h.summary(s, ago(7), now)).finance.netCents, 2240);
  });
  await check('rejected source rows cannot certify completeness even when chart total matches accepted rows', async () => {
    const s2 = await h.scope('rejected'); const run = await h.start(s2);
    const row = money('valid', 'tip', 10, 1);
    await h.page(run, [row, { ...money('invalid', 'tip', 5, 2), net: [] }]);
    await h.charts(run, [row]);
    const done = await h.finish(run, 'FAILED');
    assert.equal(done.run.proof.windows[0].rejected, 1); assert.equal(done.run.proof.complete, false);
    assert.equal(done.proof, null); assert.equal((await h.summary(s2, ago(7), now)).ready, false);
  });
  await check('empty creator proves actual zero using explicit exhaustion and all six empty charts', async () => {
    const empty = await h.scope('empty'); const run = await h.start(empty);
    await h.page(run, []); await h.charts(run, []); const done = await h.finish(run);
    assert.equal(done.run.proof.historyRead, true); assert.equal(done.run.proof.complete, true);
    const summary = await h.summary(empty, ago(7), now); assert.equal(summary.ready, true); assert.equal(summary.finance.netCents, 0);
  });
  await check('frontier catchup crosses last proof and two overlap pages; corrections outside chart window update exactly once', async () => {
    const f = await h.scope('frontier');
    const old = [money('old-a', 'message', 10, 4), money('old-b', 'tip', 5, 5), money('old-c', 'post', 4, 6), money('old-d', 'stream', 6, 7)];
    const base = await h.start(f, { endAt: ago(3) }); await h.page(base, old); await h.charts(base, old); await h.finish(base);
    const fresh = money('new', 'tip', 7, 1), reversed = { ...old[1], status: 'undo' };
    const run = await h.start(f, { mode: 'catchup' });
    await h.page(run, [fresh, old[0]], { hasMore: true, nextMarker: 'first-overlap' });
    assert.equal(run.checkpoint.jobContinuation.frontierPhase, 'SEEK');
    await h.page(run, [reversed], { hasMore: true, nextMarker: 'second-overlap' });
    assert.equal(run.checkpoint.jobContinuation.frontierPhase, 'OVERLAP');
    await h.page(run, [old[2]], { hasMore: true, nextMarker: 'third-overlap' });
    assert.equal(run.checkpoint.jobContinuation.phase, 'transactions');
    await h.page(run, [old[3]], { hasMore: true, nextMarker: 'should-not-fetch' });
    assert.equal(run.checkpoint.jobContinuation.phase, 'charts');
    assert.equal(run.checkpoint.jobContinuation.sourceBoundaryReached, false);
    await h.charts(run, [fresh]); const done = await h.finish(run);
    assert.equal(done.state.coverageThrough.toISOString(), run.job.params.financialWindows[0].to);
    const summary = await h.summary(f, ago(10), now); assert.equal(summary.finance.netCents, 2160);
    assert.equal((await h.gen.activeEntry(db, f.creatorId, 'old-b')).status, 'undo');
    assert.equal(run.calls.some(call => call.path.includes('should-not-fetch')), false);
  });
  await check('same transaction ID on another creator remains separately scoped', async () => {
    const other = await h.scope('separate'); const row = money('message', 'message', 2, 1); const run = await h.start(other);
    await h.page(run, [row]); await h.charts(run, [row]); await h.finish(run);
    assert.equal((await h.summary(other, ago(7), now)).finance.netCents, 160);
    assert.equal((await h.summary(s, ago(7), now)).finance.netCents, 2240);
  });
}

async function workerRecovery() {
  const { db } = h;
  const compiled = await loadDesktopReadonlyWorker(h.desktopRoot);
  try {
  const s = await h.scope('worker_recovery'), current = Date.now();
  const records = Array.from({ length: 22 }, (_, i) => ({ id: 'payment-' + i, type: 'tip', amount: 1, net: 0.8,
    status: 'done', currency: 'USD', createdAt: new Date(current - (i + 1) * 60000).toISOString(), user: { id: 'fan' } }));
  const provider = [], wire = [], errors = [];
  let loseProgress = 'after', lostReplies = 0, completeAccepted = null;
  const run = await h.start(s);
  function worker() {
    const log = Object.fromEntries(['info', 'warn', 'debug', 'error'].map(level => [level, (...args) => { if (level === 'error') errors.push(args); }]));
    const instance = new compiled.Worker({ log,
      authStore: { getAuthorizationScopeIncarnation: () => 'same-login', getDeviceId: () => s.deviceId }, authService: {},
      creatorRuntime: { getVerifiedIdentity: () => ({ platformUserId: s.creator.remoteId }) },
      creatorService: {}, accessRuntime: {}, capabilities: {}, apiRuntime: {}, backgroundRuntime: {}, coordinator: {}, sessionReconcile: {},
      events: { emit() {} }, ofApi: { async request(input) {
        assert.equal(input.jobLease.jobId, run.job.id); assert.equal(input.endpoint.method, 'GET');
        provider.push(input.endpoint.path);
        const url = new URL(input.endpoint.path, 'https://fixture.invalid');
        if (input.source.endsWith('.payouts')) {
          const marker = url.searchParams.get('marker'), i = marker?.startsWith('m') ? Number(marker.slice(1)) : 0;
          return { ok: true, data: { list: [records[i]], hasMore: i < records.length - 1, nextMarker: 'm' + (i + 1) } };
        }
        const cat = input.source.split('.').at(-1), key = cat === 'messages' ? 'chat_messages' : cat;
        const matching = cat === 'total' || cat === 'tips';
        return { ok: true, data: { [key]: { gross: matching ? records.length : 0,
          total: matching ? records.length * 0.8 : 0, count: matching ? records.length : 0 } } };
      } } });
    instance.scheduleImmediateClaim = () => {};
    // Keep the real BackendJobClient's per-job wire queue and retry behaviour;
    // only its HTTP boundary is replaced with the actual server lease methods.
    instance.client.api.request = async (url, options) => {
      const operation = url.split('/').at(-1), input = { ...options.body, userId: s.userId, jobId: run.job.id };
      wire.push(operation);
      if (operation === 'renew') {
        return { lease: await h.lease.renewLease(input) };
      }
      if (operation === 'progress') {
        if (loseProgress === 'before') { loseProgress = null; lostReplies++; throw Object.assign(Error('progress interrupted before commit'), { status: 503 }); }
        const response = await h.lease.progressJob(input);
        if (loseProgress === 'after') { loseProgress = null; lostReplies++; throw Object.assign(Error('progress reply lost after commit'), { status: 503 }); }
        return { lease: response };
      }
      if (operation === 'complete') { completeAccepted = await h.lease.completeJob(input); return completeAccepted; }
      if (operation === 'release') return h.lease.releaseJob(input);
      if (operation === 'fail') return h.lease.failJob(input);
      throw Error('Unexpected worker wire ' + operation);
    };
    return instance;
  }
  let w = worker(), continuation = structuredClone(run.checkpoint);
  const execute = () => w.runChunk({ job: run.job }, continuation, 'work-' + run.job.id, new AbortController().signal, () => {});
  await check('lost committed page reply is recovered by real worker/client renewal without a second provider read', async () => {
    const step = await execute(); assert.equal(step.outcome, 'continue'); assert.equal(step.continuation.jobContinuation.page, 1);
    assert.equal(provider.length, 1); assert.equal(lostReplies, 1); continuation = step.continuation;
    assert.equal(await db.financialPageReceipt.count({ where: { runId: h.receipts.runId(run.job) } }), 1);
  });
  await check('process replacement with stale local continuation adopts backend checkpoint before the next provider page', async () => {
    w = worker(); continuation = structuredClone(run.checkpoint); // page zero is deliberately stale
    const step = await execute(); assert.equal(step.continuation.jobContinuation.page, 2);
    assert.ok(provider.at(-1).includes('marker=m1')); continuation = step.continuation;
  });
  await check('pre-commit transport failure preserves last checkpoint and does not fabricate an accepted page', async () => {
    loseProgress = 'before'; const before = structuredClone(continuation);
    await assert.rejects(execute, /progress interrupted before commit/);
    assert.deepEqual((await h.lease.renewLease(run.credentials)).continuation, before);
    assert.equal(await db.financialPageReceipt.count({ where: { runId: h.receipts.runId(run.job) } }), 2);
    const step = await execute(); assert.equal(step.continuation.jobContinuation.page, 3); continuation = step.continuation;
  });
  await check('twentieth page yields cooperatively; fresh lease resumes page 21 with unchanged generation and no retry penalty', async () => {
    for (let page = 4; page <= 20; page++) {
      const step = await execute();
      if (page < 20) { assert.equal(step.outcome, 'continue'); continuation = step.continuation; }
      else assert.equal(step.result.cooperativeYield, true);
    }
    const yielded = await db.jobInstance.findUnique({ where: { id: run.job.id } });
    assert.equal(yielded.status, 'SCHEDULED'); assert.equal(yielded.continuation.jobContinuation.page, 20); assert.equal(yielded.attempts, 0);
    await db.jobInstance.update({ where: { id: run.job.id }, data: { nextRunAt: new Date(0) } });
    const resumed = await h.claim(s, run.job.id); assert.equal(resumed.job.params.collectionGeneration, run.job.params.collectionGeneration);
    Object.assign(run, resumed); continuation = resumed.checkpoint; w = worker();
    const step = await execute(); assert.equal(step.continuation.jobContinuation.page, 21); continuation = step.continuation;
    assert.ok(provider.at(-1).includes('marker=m20'));
  });
  await check('worker finishes six exact charts and accepted publication makes all 22 payments available once', async () => {
    for (let turn = 0; turn < 9; turn++) {
      const step = await execute(); if (step.outcome === 'complete') break; continuation = step.continuation;
    }
    assert.ok(completeAccepted?.publicationId);
    for (let turn = 0; turn < 30; turn++) {
      await db.analyticsPublication.update({ where: { id: completeAccepted.publicationId }, data: { availableAt: new Date(0) } });
      const result = await h.load('./src/services/analytics-publication-service').runAnalyticsPublicationUnit({ db, publicationId: completeAccepted.publicationId });
      if (!result.publicationPending) { assert.equal(result.job.status, 'DONE'); break; }
    }
    const result = await h.summary(s, new Date(current - 86400000), new Date());
    assert.equal(result.finance.netCents, 1760); assert.equal(result.finance.transactions, 22);
    assert.equal((await db.jobInstance.findUnique({ where: { id: run.job.id } })).attempts, 0);
    report.workerSummary = result;
  });
  assert.deepEqual(errors, []);
  report.workerProviderCalls = provider.length; report.workerWireCalls = wire.length;
  } finally { compiled.close(); }
}

async function refreshLifecycle() {
  const { db } = h;
  const s = await h.scope('overview_refresh');
  const operation = h.load('./src/services/operational-command-service');
  const management = h.load('./src/services/management-command-service');
  const orchestrator = h.load('./src/services/creator-analytics-sync-orchestrator');
  const planner = h.load('./src/services/analytics-collection-planner');
  const now = new Date(), from = new Date(+now - 7 * day);
  const row = { id: 'refresh-payment', type: 'tip', amount: 10, net: 8, fee: 2,
    currency: 'USD', status: 'done', createdAt: new Date(+now - day).toISOString(), user: { id: 'fan' } };
  const command = async (input = null, client = db, rangeKey = '7d') => {
    if (!input) {
      const payload = { family: 'analytics_refresh', operation: 'refresh', input: { rangeKey } };
      payload.expectedRevision = await operation.snapshot(db, s.agencyId, s.creatorId, payload);
      input = { commandId: crypto.randomUUID(), action: 'operation.control', targetId: s.creatorId, payload };
    }
    const result = await management.executeManagementCommand({ db: client, agencyId: s.agencyId,
      userId: s.userId, actorMember: s.member, deviceId: s.deviceId, input });
    assert.equal(result.ok, true);
    return { input, result };
  };
  const home = () => planner.ensureAnalyticsFreshness({ db, agencyId: s.agencyId, creatorId: s.creatorId,
    rangeKey: '7d', reason: 'HOME_INTERACTIVE_REFRESH' });
  const overview = () => orchestrator.refreshCreatorAnalytics({ db, agencyId: s.agencyId, creatorId: s.creatorId,
    requestedByUserId: s.userId, rangeKey: '7d' });
  const active = () => db.jobInstance.findMany({ where: { creatorId: s.creatorId,
    jobKey: 'financial_transactions_scan', status: { in: ['SCHEDULED', 'CLAIMED', 'PAUSED', 'PUBLISHING'] } } });
  let firstJob, prior, correction;

  await check('actual management refresh without a proof starts one financial bootstrap and command replay is idempotent', async () => {
    assert.equal((await h.summary(s, from, now)).ready, false);
    const first = await command();
    const replay = await command(first.input);
    assert.equal(replay.result.replayed, true);
    const jobs = await active(); assert.equal(jobs.length, 1); firstJob = jobs[0];
    assert.equal(firstJob.params.collectionMode, 'full');
    assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId, jobKey: 'fetch_earnings' } }), 0);
  });
  await check('all five Overview ranges and concurrent Overview/Home refreshes coalesce onto the same queued scan', async () => {
    for (const rangeKey of ['7d', '30d', '90d', '180d', '365d']) {
      const accepted = await command(null, db, rangeKey);
      assert.equal(accepted.result.result.rangeKey, rangeKey);
    }
    const requests = await Promise.all([overview(), home(), overview(), home()]);
    for (const result of requests) assert.equal((result.earnings || result).jobs[0].id, firstJob.id);
    const jobs = await active(); assert.equal(jobs.length, 1); assert.equal(jobs[0].id, firstJob.id);
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: s.creatorId } }), 1);
    const run = await h.claim(s, firstJob.id);
    await h.page(run, [row]); await h.charts(run, [row]); await h.finish(run);
    prior = await h.summary(s, from, new Date());
    assert.equal(prior.finance.netCents, 800);
  });
  await check('Overview refresh with an existing ledger and no recovery debt requests the same money owner as Home', async () => {
    assert.equal(await db.creatorRecoveryIntent.count({ where: { creatorId: s.creatorId,
      stream: 'financial', status: { not: 'COMPLETE' } } }), 0);
    await command();
    const jobs = await active(); assert.equal(jobs.length, 1);
    assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId, jobKey: 'fetch_earnings' } }), 0);
    correction = await h.claim(s, jobs[0].id);
    const shared = await Promise.all([overview(), home()]);
    for (const result of shared) assert.equal((result.earnings || result).jobs[0].id, correction.job.id);
    assert.equal((await h.summary(s, from, new Date())).finance.netCents, 800);
    const renewed = await h.lease.renewLease(correction.credentials);
    assert.deepEqual(renewed.continuation, correction.checkpoint);
  });
  const corrected = { ...row, amount: 20, net: 16, fee: 4 };
  await check('actual Overview refresh resumes a paused scan with its exact generation, source window and cursor', async () => {
    await h.page(correction, [corrected], { hasMore: true, nextMarker: 'after-corrected-payment' });
    const before = structuredClone(correction.checkpoint);
    await h.manual.stopManualFinancialTransactionScan({ db, creatorId: s.creatorId });
    await command();
    const resumed = await h.claim(s, correction.job.id);
    assert.equal(resumed.job.params.collectionGeneration, correction.job.params.collectionGeneration);
    assert.deepEqual(resumed.job.params.financialWindows, correction.job.params.financialWindows);
    assert.deepEqual(resumed.checkpoint, before);
    correction = resumed;
    await h.page(correction, []); await h.charts(correction, [corrected]);
  });
  await check('refreshes during publication retain the single publisher and expose corrected money only after verification', async () => {
    const accepted = await h.lease.completeJob({ ...correction.credentials,
      result: correction.checkpoint.result, progress: correction.checkpoint.progress });
    assert.ok(accepted.publicationId);
    assert.equal((await db.jobInstance.findUnique({ where: { id: correction.job.id } })).status, 'PUBLISHING');
    await command();
    assert.equal((await home()).jobs[0].id, correction.job.id);
    assert.equal((await active()).length, 1);
    assert.equal((await h.summary(s, from, new Date())).finance.netCents, 800);
    let published;
    for (let turn = 0; turn < 100; turn++) {
      await db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { availableAt: new Date(0) } });
      published = await h.load('./src/services/analytics-publication-service').runAnalyticsPublicationUnit({ db,
        publicationId: accepted.publicationId });
      if (!published.publicationPending) break;
    }
    assert.equal(published.job?.status, 'DONE');
    const after = await h.summary(s, from, new Date());
    assert.equal(after.finance.netCents, 1600); assert.notEqual(after.generation, prior.generation);
    assert.equal((await active()).length, 0); report.refreshedSummary = after;
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 6000);
    })]);
  } finally { clearTimeout(timer); }
}

async function holdManagementCreator(s, family) {
  const { db } = h;
  const payload = { family, operation: family === 'financial' ? 'start' : 'refresh',
    input: family === 'financial' ? {} : { rangeKey: '7d' } };
  payload.expectedRevision = await h.load('./src/services/operational-command-service').snapshot(db, s.agencyId, s.creatorId, payload);
  const reached = deferred(), release = deferred();
  let gated = false;
  // Instrument timing only: every query, lock, transaction option, permission,
  // receipt and command mutation remains the production implementation.
  const client = new Proxy(db, { get(target, key) {
    if (key === '$transaction') return (callback, options) => target.$transaction(tx => callback(new Proxy(tx, {
      get(t, k) {
        if (k === '$queryRawUnsafe') return async (query, ...args) => {
          const result = await t.$queryRawUnsafe(query, ...args);
          if (!gated && /SELECT "id" FROM "CreatorAccount".*FOR (?:(?:NO KEY )?UPDATE|SHARE)/.test(query) && args[0] === s.creatorId) {
            gated = true; reached.resolve(); await release.promise;
          }
          return result;
        };
        const value = t[k]; return typeof value === 'function' ? value.bind(t) : value;
      },
    })), options);
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const completed = h.load('./src/services/management-command-service').executeManagementCommand({ db: client,
    agencyId: s.agencyId, userId: s.userId, actorMember: s.member, deviceId: s.deviceId,
    input: { commandId: crypto.randomUUID(), action: 'operation.control', targetId: s.creatorId, payload },
  }).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  try {
    await bounded(Promise.race([reached.promise, completed.then(result => {
      throw new Error('Management command ended before its Creator lock: ' + (result.error?.message || JSON.stringify(result.value)));
    })]), 'management Creator lock');
  } catch (error) { release.resolve(); await completed; throw error; }
  return { release: () => release.resolve(), completed };
}

async function managementOverlap() {
  const { db } = h;
  for (const family of ['analytics_refresh', 'financial']) {
    await check('actual ' + family + ' command overlaps Home without surfacing a database conflict or duplicating traversal', async () => {
      const s = await h.scope(family + '_home_overlap');
      const held = await holdManagementCreator(s, family);
      let homeSettled = false;
      const home = h.load('./src/services/analytics-collection-planner').ensureAnalyticsFreshness({ db,
        agencyId: s.agencyId, creatorId: s.creatorId, rangeKey: '7d', reason: 'HOME_INTERACTIVE_REFRESH',
      }).then(value => { homeSettled = true; return { ok: true, value }; },
        error => { homeSettled = true; return { ok: false, error }; });
      let observationError;
      try {
        let observed = false;
        for (let i = 0; i < 100; i++) {
          const waits = await db.$queryRawUnsafe("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' LIMIT 1");
          if (waits.length || homeSettled) { observed = true; break; }
          await sleep(10);
        }
        assert.equal(observed, true, 'Home must execute while the command owns its Creator row lock');
      } catch (error) { observationError = error; } finally { held.release(); }
      const [command, refreshed] = await bounded(Promise.all([held.completed, home]), 'concurrent refresh settlement');
      if (observationError) throw observationError;
      assert.equal(refreshed.ok, true, refreshed.error?.message);
      if (family === 'financial' && !command.ok) {
        // Financial start carries the latest JobInstance in its optimistic
        // revision. A competing Home start may validly invalidate that intent.
        assert.equal(command.error.code, 'OPERATION_VERSION_CONFLICT', command.error.message);
        assert.equal(command.error.status, 409);
      } else assert.equal(command.ok, true, command.error?.message);
      const jobs = await db.jobInstance.findMany({ where: { creatorId: s.creatorId, jobKey: 'financial_transactions_scan' } });
      assert.equal(jobs.length, 1); assert.equal(jobs[0].id, refreshed.value.jobs[0].id);
      if (command.ok) assert.equal(command.value.replayed, false);
    });
  }
  await check('the refresh Creator lifecycle lock still excludes a concurrent non-key row mutation', async () => {
    const s = await h.scope('refresh_creator_mutation');
    const held = await holdManagementCreator(s, 'analytics_refresh');
    let settled = false;
    // Retirement and metadata setters update non-key Creator columns. Exercise
    // the real guarded row write against the weaker compatible-FK lock.
    const mutation = h.write(async tx => {
      await h.load('./src/services/database-write-contract-service').authorizeCreatorAccountWrite(tx);
      return tx.creatorAccount.update({ where: { id: s.creatorId }, data: { displayName: 'after refresh' } });
    }).then(value => { settled = true; return { ok: true, value }; },
      error => { settled = true; return { ok: false, error }; });
    let observationError;
    try {
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const waits = await db.$queryRawUnsafe("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%UPDATE%CreatorAccount%' LIMIT 1");
        if (waits.length) { observed = true; break; }
        if (settled) break;
        await sleep(10);
      }
      assert.equal(observed, true, 'The concurrent Creator mutation must wait for the management command');
      assert.equal(settled, false);
    } catch (error) { observationError = error; } finally { held.release(); }
    const [command, changed] = await bounded(Promise.all([held.completed, mutation]), 'Creator mutation settlement');
    if (observationError) throw observationError;
    assert.equal(command.ok, true, command.error?.message); assert.equal(changed.ok, true, changed.error?.message);
    assert.equal((await db.creatorAccount.findUnique({ where: { id: s.creatorId } })).displayName, 'after refresh');
  });
}

async function manualRefreshPriority() {
  const { db } = h;
  const orchestrator = h.load('./src/services/creator-analytics-sync-orchestrator');
  const planner = h.load('./src/services/analytics-collection-planner');
  async function stale(name) {
    const s = await h.scope(name), now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const old = new Date(+now - 3 * day);
    const row = { id: 'historical-payment', type: 'tip', amount: 10, net: 8, fee: 2, status: 'done', currency: 'USD',
      createdAt: new Date(+old - day).toISOString(), user: { id: 'fan' } };
    const run = await h.start(s, { endAt: old });
    await h.page(run, [row]); await h.charts(run, [row]); await h.finish(run);
    const intent = await db.creatorRecoveryIntent.create({ data: { id: crypto.randomUUID(), agencyId: s.agencyId,
      creatorId: s.creatorId, stream: 'financial', reason: 'OFFLINE_GAP', gapFrom: old,
      targetAt: new Date(+now - 60_000), policyVersion: 2 } });
    return { s, row, intent, now };
  }
  async function refresh(s) {
    const payload = { family: 'analytics_refresh', operation: 'refresh', input: { rangeKey: '7d' } };
    payload.expectedRevision = await h.load('./src/services/operational-command-service').snapshot(db, s.agencyId, s.creatorId, payload);
    const result = await h.load('./src/services/management-command-service').executeManagementCommand({ db,
      agencyId: s.agencyId, userId: s.userId, actorMember: s.member, deviceId: s.deviceId,
      input: { commandId: crypto.randomUUID(), action: 'operation.control', targetId: s.creatorId, payload } });
    assert.equal(result.ok, true);
  }
  await check('idle Overview refresh reserves a full history pass before recurring recovery can allocate a catchup', async () => {
    const { s, row, intent, now } = await stale('manual_full_priority');
    await refresh(s);
    const jobs = await db.jobInstance.findMany({ where: { creatorId: s.creatorId,
      jobKey: 'financial_transactions_scan', status: 'SCHEDULED' } });
    assert.equal(jobs.length, 1); assert.equal(jobs[0].params.collectionMode, 'full');
    assert.equal(jobs[0].params.manualFinancialTransactionScan, true);
    const home = await planner.ensureAnalyticsFreshness({ db, agencyId: s.agencyId, creatorId: s.creatorId,
      rangeKey: '7d', reason: 'HOME_INTERACTIVE_REFRESH' });
    assert.equal(home.jobs[0].id, jobs[0].id);
    const changed = { ...row, amount: 20, net: 16, fee: 4 };
    const run = await h.claim(s, jobs[0].id);
    await h.page(run, [changed]); await h.charts(run, [changed]); await h.finish(run);
    assert.equal((await h.summary(s, new Date(+now - 7 * day), new Date())).finance.netCents, 1600);
    assert.equal((await db.creatorRecoveryIntent.findUnique({ where: { id: intent.id } })).status, 'COMPLETE');
  });
  await check('Overview and Home reuse an already claimed recovery catchup without replacing its generation or lease', async () => {
    const { s, row, intent, now } = await stale('existing_catchup');
    await orchestrator.ensureRecurringCreatorAnalyticsCatchups({ db, agencyId: s.agencyId, creatorId: s.creatorId });
    const queued = await db.jobInstance.findFirst({ where: { creatorId: s.creatorId,
      jobKey: 'financial_transactions_scan', status: 'SCHEDULED' } });
    assert.equal(queued.params.collectionMode, 'catchup');
    const run = await h.claim(s, queued.id);
    const fresh = { ...row, id: 'new-payment', amount: 5, net: 4, fee: 1,
      createdAt: new Date(+now - day).toISOString() };
    await h.page(run, [fresh], { hasMore: true, nextMarker: 'known-history' });
    const cursor = structuredClone(run.checkpoint);
    await refresh(s);
    const home = await planner.ensureAnalyticsFreshness({ db, agencyId: s.agencyId, creatorId: s.creatorId,
      rangeKey: '7d', reason: 'HOME_INTERACTIVE_REFRESH' });
    assert.equal(home.jobs[0].id, run.job.id);
    assert.equal(home.jobs[0].params.collectionGeneration, run.job.params.collectionGeneration);
    assert.deepEqual((await h.lease.renewLease(run.credentials)).continuation, cursor);
    assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId, jobKey: 'financial_transactions_scan',
      status: { in: ['SCHEDULED', 'CLAIMED', 'PAUSED', 'PUBLISHING'] } } }), 1);
    await h.page(run, [row]); await h.charts(run, [fresh]); await h.finish(run);
    assert.equal((await h.summary(s, new Date(+now - 7 * day), new Date())).finance.netCents, 1200);
    assert.equal((await db.creatorRecoveryIntent.findUnique({ where: { id: intent.id } })).status, 'COMPLETE');
  });
}

(async () => {
  h = await openEarningsChainFixture();
  await ingestion();
  await workerRecovery();
  await refreshLifecycle();
  await managementOverlap();
  await manualRefreshPriority();
  await require('../test-support/analytics-refresh-overlap210.cjs').runAnalyticsRefreshOverlapCases({ h, check });
  report.ok = true;
  console.log(JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await h?.close(); });
