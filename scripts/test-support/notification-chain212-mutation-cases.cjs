'use strict';

// All mutations enter the current lease/page/completion owners in disposable
// PostgreSQL. Only lease timing and a legacy checkpoint upgrade are arranged
// directly; source pages and canonical facts always use the Desktop producer.
const assert = require('node:assert/strict');
const TYPES = ['purchases', 'tips', 'subscriptions', 'likes', 'comments'];

async function runMutationCases(h, check) {
  const state = scope => h.db.creatorNotificationSyncState.findUnique({ where: { creatorId: scope.creatorId } });
  const receipts = run => h.db.analyticsIngestBatch.count({ where: { sourceJobId: run.job.id, dataType: 'NOTIFICATIONS' } });
  const tip = (id, extra = {}) => ({ id, type: 'tip', createdAt: new Date(Date.now() - 600000).toISOString(),
    amount: '2.50', currency: 'USD', user: { id: '991201' }, ...extra });
  const finishEmpty = async run => {
    for (let turn = 0; turn < 8 && run.checkpoint?.driverPhase !== 'complete'; turn++) {
      await h.progress(run, await h.produce(run, { list: [], hasMore: false }));
    }
    return h.finish(run);
  };
  const finalDescriptor = async run => {
    const domain = { ...run.checkpoint?.jobContinuation, sourceExhausted: true,
      allSourceExhausted: run.job.params.notificationMode === 'full', stopReason: 'source_exhausted',
      typeSourceExhausted: Object.fromEntries(TYPES.map(type => [type, true])) };
    return h.produce(run, () => { throw Error('TERMINAL_DESCRIPTOR_MUST_NOT_READ_PROVIDER'); },
      { driverPhase: 'execute', jobContinuation: domain });
  };
  const makeDue = run => h.db.jobInstance.update({ where: { id: run.job.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });

  await check('Missing history and proven empty history remain different durable states', async () => {
    const scope = await h.scope('missing_and_empty');
    assert.equal(await state(scope), null);
    const run = await h.start(scope);
    assert.equal(run.job.params.notificationMode, 'full');
    const done = await finishEmpty(run);
    assert.equal(done.job.status, 'DONE'); assert.equal(done.accepted.sideEffect.verified, true);
    assert.equal(done.state.status, 'COMPLETE'); assert.ok(done.state.fullBackfillVerifiedAt);
    assert.equal(done.events.length, 0); assert.equal(done.frontiers.length, 6);
    assert.equal(done.state.frontierReceipt.sourcePhase, 'all_reconciliation');
    const catchup = await h.start(scope);
    assert.equal(catchup.job.params.notificationMode, 'catchup');
    await h.page(catchup, []);
    const completed = await h.finish(catchup);
    assert.equal(completed.state.status, 'COMPLETE'); assert.ok(completed.state.lastCatchupVerifiedAt);
    return { fullEmptySourcePages: 6, catchupEmptySourcePages: 1, zeroCanonicalFacts: true };
  });

  for (const withBaseline of [false, true]) {
    await check(`Forced FULL STOP then ordinary START resumes its exact checkpoint (baseline=${withBaseline})`, async () => {
      const scope = await h.scope('forced_resume_' + withBaseline);
      if (withBaseline) await h.full(scope);
      const run = await h.start(scope, { forceFull: true });
      await h.page(run, []);
      const checkpoint = structuredClone(run.checkpoint), before = await h.jobRow(run), count = await receipts(run);
      await h.stop(scope);
      const scheduled = await h.schedule(scope);
      assert.equal(scheduled.action, 'resumed'); assert.equal(scheduled.job.id, run.job.id);
      assert.equal(scheduled.job.status, 'SCHEDULED');
      const resumed = await h.claim(scope, run.job.id);
      assert.deepEqual(resumed.checkpoint, checkpoint);
      assert.equal(resumed.job.params.notificationMode, 'full');
      assert.equal(resumed.job.params.forceNotificationFullRebuild, true);
      assert.equal((await h.jobRow(run)).attempts, before.attempts); assert.equal(await receipts(run), count);
      await assert.rejects(h.lease.renewLease({ ...run.credentials }), error => /LEASE/.test(error.code || ''));
      const done = await finishEmpty(resumed);
      assert.equal(done.job.status, 'DONE'); assert.equal(done.state.status, 'COMPLETE');
      return { sameGeneration: true, staleLeaseRejected: true, resumedPage: checkpoint.jobContinuation.page };
    });
  }

  await check('Paused legacy forced FULL upgrades to a new forced generation without narrowing to catch-up', async () => {
    const scope = await h.scope('forced_legacy_upgrade'); await h.full(scope);
    const run = await h.start(scope, { forceFull: true }); await h.page(run, []); await h.stop(scope);
    await h.db.jobInstance.update({ where: { id: run.job.id }, data: {
      continuation: { driverPhase: 'execute', jobContinuation: { schemaVersion: 8, scanRunId: run.job.params.collectionGeneration, page: 1 } },
    } });
    const scheduled = await h.schedule(scope);
    assert.notEqual(scheduled.job.id, run.job.id); assert.equal(scheduled.job.params.notificationMode, 'full');
    assert.equal(scheduled.job.params.forceNotificationFullRebuild, true);
    assert.notEqual(scheduled.job.params.collectionGeneration, run.job.params.collectionGeneration);
    assert.equal((await h.jobRow(run)).status, 'CANCELLED');
    return { newGeneration: true, forcedFullPreserved: true };
  });

  for (const mode of ['full', 'catchup']) {
    await check(`${mode} cannot accept a terminal descriptor or report verified before its durable source frontier`, async () => {
      const scope = await h.scope('premature_' + mode);
      if (mode === 'catchup') await h.full(scope);
      const run = await h.start(scope, { forceFull: mode === 'full' });
      if (mode === 'full') await h.page(run, []);
      else await h.page(run, [tip('991301')], { hasMore: true });
      const before = await h.jobRow(run), count = await receipts(run);
      const terminal = await finalDescriptor(run);
      await assert.rejects(h.progress(run, terminal), { code: 'NOTIFICATION_FRONTIER_COMPLETION_INVALID' });
      await assert.rejects(h.lease.renewLease({ ...run.credentials, progress: terminal.progress,
        continuation: { driverPhase: 'complete', result: terminal.result, progress: terminal.progress } }),
      { code: 'NOTIFICATION_FRONTIER_COMPLETION_INVALID' });
      const unchanged = await h.jobRow(run);
      assert.deepEqual(unchanged.continuation, before.continuation); assert.equal(unchanged.attempts, before.attempts);
      assert.equal(await receipts(run), count); assert.equal((await state(scope)).frontierReceipt.phase, 'SEEK');
      // A direct completion from an older/corrupt client is a finite failure;
      // it must neither create current coverage nor strand accepted completion.
      const done = await h.complete(run, terminal.result);
      assert.equal(done.job.status, 'FAILED'); assert.equal(done.sideEffect.verified, false);
      assert.equal(done.sideEffect.sourceTraversalComplete, false);
      const sync = await state(scope);
      assert.equal(sync.status, 'FAILED'); assert.equal(sync.lastCatchupVerifiedAt, null);
      if (mode === 'full') assert.equal(sync.fullBackfillVerifiedAt, null);
      assert.equal(await h.db.analyticsCoverage.count({ where: { creatorId: scope.creatorId, status: 'COMPLETE',
        ingestBatch: { sourceJobId: run.job.id } } }), 0);
      return { unprovenCheckpointRolledBack: true, directCompletion: done.job.status, sourceBoundaryPromoted: false };
    });
  }

  await check('A no-source progress turn cannot replace a notification cursor', async () => {
    const scope = await h.scope('checkpoint_needs_receipt'); const run = await h.start(scope);
    await h.page(run, [tip('991401')], { hasMore: true });
    const before = structuredClone(run.checkpoint), count = await receipts(run);
    const changed = { outcome: 'continue', continuation: { ...before.jobContinuation, fromId: 'foreign-cursor', page: 99 }, progress: { current: 99 } };
    await assert.rejects(h.progress(run, changed), { code: 'NOTIFICATION_PAGE_RECEIPT_REQUIRED' });
    assert.deepEqual((await h.jobRow(run)).continuation, before); assert.equal(await receipts(run), count);
    const heartbeat = await h.lease.progressJob({ ...run.credentials, expectedContinuation: before, progress: { current: 1 } });
    assert.deepEqual(heartbeat.continuation, before);
    return { receiptRequiredForCursor: true, unchangedHeartbeatAllowed: true };
  });

  await check('A stale lease renewal cannot rewind a committed notification page or invent a new cursor', async () => {
    const scope = await h.scope('renewal_checkpoint_fence'), run = await h.start(scope);
    const beforePage = structuredClone(run.checkpoint);
    await h.page(run, [tip('991451')], { hasMore: true });
    const committed = structuredClone(run.checkpoint), count = await receipts(run);
    const invented = { ...committed, jobContinuation: { ...committed.jobContinuation, fromId: 'invented', page: 77 } };
    for (const continuation of [beforePage, invented]) {
      await assert.rejects(h.lease.renewLease({ ...run.credentials, continuation }),
        { code: 'NOTIFICATION_PROGRESS_ENDPOINT_REQUIRED' });
      assert.deepEqual((await h.jobRow(run)).continuation, committed);
    }
    const heartbeat = await h.lease.renewLease({ ...run.credentials });
    assert.deepEqual(heartbeat.continuation, committed);
    const unchanged = await h.lease.renewLease({ ...run.credentials, continuation: committed });
    assert.deepEqual(unchanged.continuation, committed);
    assert.equal(await receipts(run), count);
    const done = await finishEmpty(run); assert.equal(done.job.status, 'DONE');
    return { staleRenewalRejected: true, inventedCursorRejected: true, heartbeatRetainsCurrentCheckpoint: true };
  });

  await check('A proven FULL accepts only immutable metadata through terminal renew, progress and direct completion', async () => {
    const scope = await h.scope('terminal_admission'), run = await h.start(scope, { forceFull: true });
    for (let phase = 0; phase < 6; phase++) await h.page(run, []);
    assert.equal(run.checkpoint.driverPhase, 'execute'); assert.equal((await state(scope)).frontierReceipt.phase, 'DONE');
    const terminal = await h.produce(run, () => { throw Error('TERMINAL_MUST_NOT_READ_PROVIDER'); });
    assert.equal(terminal.outcome, 'done'); assert.equal(terminal.chunkResult, undefined);
    const original = structuredClone(terminal.result), before = await h.jobRow(run), count = await receipts(run);
    const injected = { eventType: 'tip', notificationId: 'terminal-injected-tip', fanId: '991499',
      amountCents: 777, currency: 'USD', occurredAt: new Date(Date.now() - 60000).toISOString() };
    const variants = [
      ['events', { events: [injected] }, 'NOTIFICATION_COMPLETION_EVENTS_FORBIDDEN'],
      ['fallback events', { events: null, items: [injected] }, 'NOTIFICATION_COMPLETION_EVENTS_FORBIDDEN'],
      ['run', { scanRunId: 'foreign-generation' }, 'ANALYTICS_COLLECTION_GENERATION_MISMATCH'],
      ['mode', { notificationMode: 'catchup' }, 'ANALYTICS_COLLECTION_MODE_MISMATCH'],
      ['schema', { schemaVersion: 5 }, 'NOTIFICATION_COMPLETION_METADATA_INVALID'],
      ['normalizer', { normalizerVersion: 'notification-source-v2' }, 'NOTIFICATION_COMPLETION_METADATA_INVALID'],
      ['collector', { collectorVersion: 'notifications-history-v8-known-boundary' }, 'NOTIFICATION_COMPLETION_METADATA_INVALID'],
      ['batch', { batchKey: 'run:foreign-generation:completion' }, 'NOTIFICATION_COMPLETION_METADATA_INVALID'],
      ['finalize', { finalizeCoverage: false }, 'NOTIFICATION_COMPLETION_METADATA_INVALID'],
      ['timezone', { sourceTimezone: 'Invalid/Timezone' }, 'NOTIFICATION_COMPLETION_METADATA_INVALID'],
      ['range', { from: 'not-a-date' }, 'NOTIFICATION_COMPLETION_METADATA_INVALID'],
      ['count', { totalPages: -1 }, 'NOTIFICATION_COMPLETION_METADATA_INVALID'],
      ['coverage', { coverage: {} }, 'NOTIFICATION_COVERAGE_METADATA_INVALID'],
    ];
    for (const [name, change, code] of variants) {
      const result = { ...structuredClone(original), ...change };
      for (const entry of ['renew', 'progress', 'complete']) {
        const operation = entry === 'renew' ? () => h.lease.renewLease({ ...run.credentials,
          continuation: { driverPhase: 'complete', result, progress: terminal.progress }, progress: terminal.progress })
          : entry === 'progress' ? () => h.progress(run, { ...terminal, result }) : () => h.complete(run, result);
        await assert.rejects(operation, { code }, `${entry} must reject ${name} without accepting completion`);
        const current = await h.jobRow(run);
        assert.deepEqual(current.continuation, before.continuation); assert.equal(current.status, 'CLAIMED');
        assert.equal(current.attempts, before.attempts); assert.equal(await receipts(run), count);
      }
    }
    assert.equal(await h.db.creatorTip.count({ where: { creatorId: scope.creatorId } }), 0);
    const accepted = await h.lease.renewLease({ ...run.credentials, progress: terminal.progress,
      continuation: { driverPhase: 'complete', result: original, progress: terminal.progress } });
    run.checkpoint = accepted.continuation;
    assert.deepEqual(run.checkpoint.result, original);
    const stale = await h.lease.renewLease({ ...run.credentials, continuation: before.continuation });
    assert.deepEqual(stale.continuation, accepted.continuation);
    await assert.rejects(h.complete(run, { ...original, totalPages: original.totalPages + 1 }),
      { code: 'JOB_COMPLETION_RESULT_CONFLICT' });
    const done = await h.finish(run);
    assert.equal(done.job.status, 'DONE'); assert.equal(done.accepted.sideEffect.verified, true);
    assert.equal(done.events.length, 0); assert.equal(done.frontiers.length, 6);
    return { rejectedMalformedRequests: variants.length * 3, terminalRenewAccepted: true,
      lateKeepaliveCannotRewind: true, sourceFactsInjected: 0, verified: true };
  });

  await check('A catch-up terminal source page rolls back malformed completion before accepting its receipts', async () => {
    const scope = await h.scope('terminal_catchup_admission'); await h.full(scope);
    const run = await h.start(scope), before = await h.jobRow(run), prior = await state(scope);
    const terminal = await h.produce(run, { list: [tip('991498')], hasMore: false });
    assert.equal(terminal.outcome, 'done'); assert.equal(terminal.chunkResult.kind, 'notification_facts_page_all');
    for (const [change, code] of [
      [{ events: [{ eventType: 'tip' }] }, 'NOTIFICATION_COMPLETION_EVENTS_FORBIDDEN'],
      [{ scanRunId: 'wrong-current-generation' }, 'ANALYTICS_COLLECTION_GENERATION_MISMATCH'],
      [{ notificationMode: 'full' }, 'ANALYTICS_COLLECTION_MODE_MISMATCH'],
      [{ coverage: {} }, 'NOTIFICATION_COVERAGE_METADATA_INVALID'],
    ]) {
      await assert.rejects(h.progress(run, { ...terminal, result: { ...terminal.result, ...change } }), { code });
      assert.deepEqual((await h.jobRow(run)).continuation, before.continuation);
      assert.deepEqual((await state(scope)).frontierReceipt, prior.frontierReceipt);
      assert.equal(await receipts(run), 0);
      assert.equal(await h.db.creatorTip.count({ where: { creatorId: scope.creatorId } }), 0);
    }
    await h.progress(run, terminal);
    const done = await h.finish(run);
    assert.equal(done.job.status, 'DONE'); assert.equal(done.accepted.sideEffect.verified, true);
    assert.equal(await h.db.creatorTip.count({ where: { creatorId: scope.creatorId } }), 1);
    return { malformedTerminalPageRolledBack: true, validTerminalPageVerified: true, canonicalFacts: 1 };
  });

  for (const entry of ['direct', 'management']) await check(`Force FULL and an in-flight catch-up page survive an actual collector-job lock cycle atomically (${entry})`, async () => {
    const scope = await h.scope('force_full_progress_lock'); await h.full(scope);
    const management = entry === 'management'
      ? await require('./notification-chain212-management-fixture.cjs').openNotificationManagementFixture(h, scope) : null;
    try {
    const run = await h.start(scope);
    assert.equal(run.job.params.notificationMode, 'catchup');
    await h.page(run, [tip('991471')], { hasMore: true });
    const committed = structuredClone(run.checkpoint), priorReceipts = await receipts(run);
    const step = await h.produce(run, { list: [tip('991472')], hasMore: true });
    const settle = operation => operation.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    const waitFor = async (read, description) => {
      const deadline = Date.now() + 3500;
      do {
        const value = await read(); if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      throw new Error('Native lock overlap was not observed: ' + description);
    };
    const blockedBy = pid => waitFor(async () => {
      const rows = await h.db.$queryRawUnsafe(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid)) ORDER BY pid LIMIT 1`, pid);
      return rows[0]?.pid || null;
    }, 'session blocked by ' + pid);
    let releaseBarrier, barrierReady;
    const released = new Promise(resolve => { releaseBarrier = resolve; });
    const ready = new Promise(resolve => { barrierReady = resolve; });
    // Delay the real progress owner after its Job row lock, then let the real
    // Force FULL command own Collector before it waits for that same Job.
    // All transaction retries, facts, checkpoints and command CAS remain real.
    const barrier = settle(h.write(async tx => {
      await h.load('./src/services/creator-fact-write-authority').lockCreatorFacts(tx, scope.agencyId, scope.creatorId);
      const [row] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
      barrierReady(row.pid); await released;
    }));
    let progress, forced, cycleObserved = false;
    try {
      const barrierPid = await ready;
      progress = settle(h.progress(run, step));
      const progressPid = await blockedBy(barrierPid);
      forced = settle(management ? management.forceFull() : h.schedule(scope, { forceFull: true }));
      const forcedPid = await blockedBy(progressPid);
      releaseBarrier();
      const barrierResult = await barrier; if (!barrierResult.ok) throw barrierResult.error;
      cycleObserved = await waitFor(async () => {
        const [row] = await h.db.$queryRawUnsafe(`SELECT
          $1::integer=ANY(pg_blocking_pids($2::integer))
            AND $2::integer=ANY(pg_blocking_pids($1::integer)) AS cycle`, progressPid, forcedPid);
        return row?.cycle;
      }, 'Collector -> Job -> Collector');
    } finally {
      releaseBarrier(); await barrier;
    }
    const [progressResult, forcedResult] = await Promise.all([progress, forced]);
    assert.equal(forcedResult.ok, true, forcedResult.error?.code || forcedResult.error?.message);
    if (!progressResult.ok) assert.ok(['JOB_NOT_CLAIMED', 'JOB_LEASE_STALE', 'JOB_LEASE_REVISION_STALE'].includes(progressResult.error.code),
      'Only the now-obsolete lease may reject progress; raw database conflicts must be retried');
    const cancelled = await h.jobRow(run), next = forcedResult.value.job;
    assert.equal(cancelled.status, 'CANCELLED'); assert.notEqual(next.id, run.job.id);
    assert.equal(next.params.notificationMode, 'full'); assert.equal(next.params.forceNotificationFullRebuild, true);
    assert.deepEqual(cancelled.continuation, progressResult.ok ? run.checkpoint : committed);
    assert.equal(await receipts(run), priorReceipts + Number(progressResult.ok) * 2,
      'One source receipt and one nonempty tip batch commit together');
    assert.equal(await h.db.creatorTip.count({ where: { creatorId: scope.creatorId, externalNotificationId: '991471' } }), 1);
    assert.equal(await h.db.creatorTip.count({ where: { creatorId: scope.creatorId, externalNotificationId: '991472' } }), Number(progressResult.ok));
    assert.notEqual((await state(scope)).activeGeneration, next.params.collectionGeneration,
      'Scheduling a replacement cannot publish its historical proof');
    if (management) {
      const where = { agencyId: scope.agencyId, userId: scope.userId, action: 'operation.control', targetId: scope.creatorId };
      assert.equal(await h.db.managementCommandReceipt.count({ where: { ...where, status: 'COMMITTED' } }), 1);
      assert.equal(await h.db.managementCommandReceipt.count({ where }), 1);
      assert.deepEqual(management.commands.listPending().map(row => row.received), [true]);
      management.restart();
      const replay = await management.commands.retry(forcedResult.value.commandId);
      assert.equal(replay.replayed, true); assert.equal(replay.result.job.id, next.id);
      assert.equal(await h.db.managementCommandReceipt.count({ where }), 1);
      const sent = management.requests.filter(row => row.url === '/api/management/commands/v1');
      assert.equal(sent.length, 2); assert.deepEqual(sent[0].input, sent[1].input);
      assert.equal((await h.db.operationalControlState.findFirst({ where: { creatorId: scope.creatorId, family: 'notification' } })).revision, 1);
      management.commands.acknowledge(forcedResult.value.commandId);
      assert.equal(management.commands.listPending().length, 0);
    }
    const replacement = await h.claim(scope, next.id), done = await finishEmpty(replacement);
    assert.equal(done.job.status, 'DONE'); assert.equal(done.state.status, 'COMPLETE');
    assert.equal(done.state.frontierReceipt.generation, replacement.job.params.collectionGeneration);
    return { entry, nativeLockCycleObserved: cycleObserved, rawDatabaseConflictReturned: false,
      progressCommittedBeforeCancel: progressResult.ok, existingCheckpointRetained: true, replacementFullVerified: true,
      ...(management ? { immutableCommandReplayed: true, managementReceipts: 1, controlRevision: 1 } : {}) };
    } finally { management?.close(); }
  });

  await check('Wrong phase or cursor rolls back facts, receipts and continuation before a valid page is retried', async () => {
    const scope = await h.scope('phase_cursor_atomicity'); const run = await h.start(scope);
    const step = await h.produce(run, { list: [tip('991501')], hasMore: true });
    for (const patch of [{ sourcePhase: 'tips' }, { cursorStart: 'uncommitted-cursor' }]) {
      const wrong = structuredClone(step); Object.assign(wrong.chunkResult, patch);
      await assert.rejects(h.progress(run, wrong), error => /NOTIFICATION_FRONTIER_(?:PHASE|CURSOR)_MISMATCH/.test(error.code || ''));
      assert.equal(await receipts(run), 0); assert.equal((await h.scopeState(scope)).events.length, 0);
      assert.deepEqual((await h.jobRow(run)).continuation, run.checkpoint);
    }
    await h.progress(run, step); assert.equal((await h.scopeState(scope)).events.length, 1);
    return { rolledBackInvalidPages: 2, validRetryAccepted: true };
  });

  await check('Lost page ACK and changed provider replay cannot rewind or duplicate the committed page', async () => {
    const scope = await h.scope('lost_ack'); const run = await h.start(scope);
    const expected = structuredClone(run.checkpoint);
    const step = await h.produce(run, { list: [tip('991601')], hasMore: true }, expected);
    await h.progress(run, step, expected);
    const committed = structuredClone(run.checkpoint), count = await receipts(run);
    const replay = await h.progress(run, step, expected);
    assert.equal(replay.sideEffect.staleProgress, true); assert.deepEqual(replay.continuation, committed);
    const changed = await h.produce(run, { list: [tip('991601', { amount: '999.00' })], hasMore: true }, expected);
    const stale = await h.progress(run, changed, expected);
    assert.equal(stale.sideEffect.staleProgress, true); assert.equal(await receipts(run), count);
    const facts = await h.db.creatorTip.findMany({ where: { creatorId: scope.creatorId } });
    assert.equal(facts.length, 1); assert.equal(facts[0].amountCents, 250);
    return { immutablePageCount: 1, staleChangedPayloadIgnored: true, duplicateFacts: 0 };
  });

  await check('Provider cursor cycle cannot commit a third page or restore an earlier continuation', async () => {
    const scope = await h.scope('cursor_cycle'); const run = await h.start(scope);
    const a = tip('991701'), b = tip('991702');
    await h.page(run, [a], { hasMore: true }); await h.page(run, [b], { hasMore: true });
    const before = structuredClone(run.checkpoint), count = await receipts(run);
    await assert.rejects(h.page(run, [a], { hasMore: true }), { code: 'NOTIFICATION_FRONTIER_CURSOR_CYCLE' });
    assert.deepEqual((await h.jobRow(run)).continuation, before); assert.equal(await receipts(run), count);
    assert.equal((await h.scopeState(scope)).frontiers.length, 2);
    return { persistedCursorPages: 2, cycleRolledBack: true };
  });

  await check('Lease loss and reclaim retain accepted source progress and reject the prior worker', async () => {
    const scope = await h.scope('lease_reclaim'); const run = await h.start(scope);
    await h.page(run, []); const checkpoint = structuredClone(run.checkpoint), count = await receipts(run);
    await h.db.jobInstance.update({ where: { id: run.job.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    await h.lease.sweepExpiredLeases(null, { agencyId: scope.agencyId });
    await makeDue(run);
    const resumed = await h.claim(scope, run.job.id);
    assert.deepEqual(resumed.checkpoint, checkpoint); assert.ok(resumed.job.leaseRevision > run.job.leaseRevision);
    await assert.rejects(h.progress(run, await h.produce(run, { list: [], hasMore: false })), error => /LEASE/.test(error.code || ''));
    assert.equal(await receipts(run), count);
    const done = await finishEmpty(resumed); assert.equal(done.state.status, 'COMPLETE');
    return { resumedFromPage: checkpoint.jobContinuation.page, completedWithoutRestart: true };
  });

  await check('Accepted completion survives late failure, worker release and restart without another provider read', async () => {
    const scope = await h.scope('completion_reclaim'); const run = await h.start(scope);
    for (let i = 0; i < 7 && run.checkpoint?.driverPhase !== 'complete'; i++) await h.progress(run, await h.produce(run, { list: [], hasMore: false }));
    const checkpoint = structuredClone(run.checkpoint), before = await h.jobRow(run), count = await receipts(run);
    assert.equal(checkpoint.driverPhase, 'complete');
    await assert.rejects(h.complete(run, { ...checkpoint.result, totalObservedRows: 999 }), { code: 'JOB_COMPLETION_RESULT_CONFLICT' });
    const late = await h.lease.failJob({ ...run.credentials, expectedContinuation: checkpoint, retryable: false, error: 'LATE_ACK_FAILURE' });
    assert.equal(late.staleFailure, true); assert.equal(late.completionRequired, true);
    await h.lease.releaseJob({ ...run.credentials, reason: 'fixture_process_restart', runAfterMs: 1000 });
    await makeDue(run); const resumed = await h.claim(scope, run.job.id);
    assert.deepEqual(resumed.checkpoint, checkpoint); assert.equal((await h.jobRow(run)).attempts, before.attempts);
    const done = await h.finish(resumed); assert.equal(done.job.status, 'DONE'); assert.equal(done.state.status, 'COMPLETE');
    assert.equal(resumed.calls.length, 0);
    assert.equal(await receipts(run), count + 1, 'Only the final coverage receipt is new; source pages are retained');
    return { lateFailureIgnored: true, descriptorConflictRejected: true, restartedProviderReads: 0 };
  });

  await check('Notification retry budget resets only after a new source page and terminates a stalled segment', async () => {
    const scope = await h.scope('bounded_failures'); let run = await h.start(scope);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const failure = await h.lease.failJob({ ...run.credentials, expectedContinuation: run.checkpoint, error: 'PROVIDER_UNAVAILABLE', retryable: true });
      assert.equal(failure.status, 'SCHEDULED'); assert.equal((await h.jobRow(run)).attempts, attempt);
      await makeDue(run); run = await h.claim(scope, run.job.id);
    }
    await h.page(run, []); assert.equal((await h.jobRow(run)).attempts, 0);
    const checkpoint = structuredClone(run.checkpoint);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const failure = await h.lease.failJob({ ...run.credentials, expectedContinuation: run.checkpoint, error: 'PROVIDER_UNAVAILABLE', retryable: true });
      assert.equal((await h.jobRow(run)).attempts, attempt);
      assert.equal(failure.status, attempt === 5 ? 'FAILED' : 'SCHEDULED');
      if (attempt < 5) { await makeDue(run); run = await h.claim(scope, run.job.id); assert.deepEqual(run.checkpoint, checkpoint); }
    }
    assert.equal((await state(scope)).status, 'FAILED');
    const jobs = await h.db.jobInstance.findMany({ where: { creatorId: scope.creatorId, jobKey: 'catchup_notifications_scan' } });
    assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'FAILED');
    return { firstSegmentFailures: 4, resetAfterAcceptedPage: true, terminalSegmentFailures: 5, hiddenNewGenerations: 0 };
  });

  await check('Rejected facts at a proven manual FULL boundary remain visible partial and preserve prior verified history', async () => {
    const scope = await h.scope('manual_partial_baseline'); await h.full(scope);
    const prior = await state(scope), row = tip('991801', { amount: 'unparseable-money' });
    const done = await h.full(scope, { tips: [row], all_reconciliation: [row] });
    assert.equal(done.job.status, 'DONE'); assert.equal(done.job.lastError, 'notification_scan_partial');
    assert.equal(done.accepted.sideEffect.verified, false); assert.equal(done.accepted.sideEffect.sourceTraversalComplete, true);
    assert.equal(done.state.status, 'PARTIAL'); assert.equal(+done.state.fullBackfillVerifiedAt, +prior.fullBackfillVerifiedAt);
    assert.equal(done.state.frontierReceipt.phase, 'DONE'); assert.ok(done.audits.some(item => item.outcome === 'REJECTED'));
    const scheduled = await h.schedule(scope); assert.equal(scheduled.job.params.notificationMode, 'catchup');
    return { manualPartialVisible: true, priorBaselineRetained: true, repeatedFullAutomaticallyStarted: false };
  });
}

module.exports = { runMutationCases };
