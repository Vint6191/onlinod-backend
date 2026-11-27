'use strict';

// Run only through the explicitly supplied disposable PostgreSQL harness.
// These cases cross collector leases, source receipts, canonical projection,
// publication, and retention; no application URL or provider session is read.
const assert = require('node:assert/strict');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runMutationCases(h) {
  const checks = [];
  const check = async (name, work) => {
    const details = await work();
    const item = { name, ok: true, ...(details || {}) };
    checks.push(item); console.log(JSON.stringify(item));
  };
  const row = (id, extra = {}) => ({ id, username: 'fan_' + id, name: 'Fan ' + id,
    lastSeen: '2026-01-01T00:00:00.000Z', subscribedOn: true,
    subscribedOnData: { isActive: true, type: 'FREE' }, canReceiveChatMessage: true, ...extra });
  const runRow = run => h.db.subscriberScanRun.findUnique({ where: { id: run.job.params.scanRunId } });
  const state = scope => h.db.subscriberDirectoryState.findUnique({ where: { creatorId: scope.creatorId } });
  const cleanup = (scope, options = {}) => h.subs.cleanupSubscriberScanHistory({
    db: h.db, agencyId: scope.agencyId, creatorId: scope.creatorId, keep: 0, maxRuns: 2, ...options,
  });

  await check('Server identity rejection rolls back page, token, canonical facts and checkpoint', async () => {
    const scope = await h.scope('intake_atomicity');
    const run = await h.start(scope);
    const step = await h.produce(run, { list: [row('101')], hasMore: false });
    const original = structuredClone(run.checkpoint);
    const invalidIds = [{ bad: true }, false, ['101'], 1.5, -1, Number.MAX_SAFE_INTEGER + 1, 'x'.repeat(181), 'bad\nidentity', ''];
    for (const fanId of invalidIds) {
      const invalid = structuredClone(step);
      invalid.chunkResult.items[0].fanId = fanId;
      await assert.rejects(h.progress(run, invalid, original), error => error.code === 'SUBSCRIBER_SCAN_FAN_ID_REQUIRED');
    }
    for (const dialogId of [{ bad: true }, true, 'x'.repeat(181), 'bad\0dialog']) {
      const invalid = structuredClone(step);
      invalid.chunkResult.items[0].dialogId = dialogId;
      await assert.rejects(h.progress(run, invalid, original), error => error.code === 'SUBSCRIBER_SCAN_DIALOG_ID_INVALID');
    }
    assert.equal(await h.db.subscriberScanPage.count({ where: { runId: run.job.params.scanRunId } }), 0);
    assert.equal(await h.db.subscriberScanItem.count({ where: { creatorId: scope.creatorId } }), 0);
    assert.equal(await h.db.creatorFan.count({ where: { creatorId: scope.creatorId } }), 0);
    assert.equal(await h.db.fanObservationToken.count({ where: { jobId: run.job.id } }), 1);
    assert.equal((await runRow(run)).nextOffset, 0);
    assert.deepEqual((await h.db.jobInstance.findUnique({ where: { id: run.job.id } })).continuation, original);
    // Every invalid transaction left the exact valid token usable once.
    await h.progress(run, step, original);
    await h.finish(run);
    assert.equal(await h.db.fanObservationToken.count({ where: { jobId: run.job.id } }), 0);
    assert.equal((await state(scope)).totalCount, 1);
    return { rejectedFanIds: invalidIds.length, rejectedDialogIds: 4, acceptedValidPage: 1 };
  });

  await check('Malformed optional fields preserve current facts while explicit null keeps the canonical contract', async () => {
    const scope = await h.scope('optional_field_authority');
    const identity = { username: 'known_user', name: 'Known Name', avatarUrl: 'https://example.test/known.png' };
    const relationship = { subscriptionType: 'FREE', canReceiveChatMessage: true,
      fanSubscribesToCreator: true, fanSubscriptionActive: true, creatorFollowsFan: false,
      fanSubscriptionExpiresAt: '2027-01-01T00:00:00.000Z', creatorFollowExpiresAt: '2027-02-01T00:00:00.000Z',
      blocked: false, restricted: false, performer: false, lastSeenAt: '2026-01-01T00:00:00.000Z', subscribePriceCents: 500 };
    const read = async () => {
      const [current] = await h.load('./src/services/fan-data-authority-service').readFanCurrent(h.db, {
        agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserIds: ['151'],
      });
      return {
        username: current.platformIdentity.username, name: current.platformIdentity.platformDisplayName,
        avatarUrl: current.platformIdentity.avatarUrl,
        ...Object.fromEntries(Object.keys(relationship).map(key => [key,
          current.relationship[key === 'subscriptionType' ? 'fanSubscriptionType' : key]])),
      };
    };
    let run = await h.start(scope);
    await h.acceptPage(run, [{ fanId: '151', ...identity, ...relationship }]); await h.finish(run);
    const original = await read();
    run = await h.start(scope);
    await h.acceptPage(run, [{ fanId: '151', username: { broken: true }, name: false, avatarUrl: [],
      subscriptionType: {}, canReceiveChatMessage: 'yes', fanSubscribesToCreator: 'true', fanSubscriptionActive: 'false',
      creatorFollowsFan: {}, fanSubscriptionExpiresAt: 'invalid-date', creatorFollowExpiresAt: ['invalid-date'],
      blocked: 1, restricted: 'false', performer: [], lastSeenAt: 'invalid-date', subscribePriceCents: '999',
    }]); await h.finish(run);
    assert.deepEqual(await read(), original);
    run = await h.start(scope);
    const cleared = Object.fromEntries(Object.keys(original).map(key => [key, null]));
    await h.acceptPage(run, [{ fanId: '151', ...cleared, lastSeenIsNull: true }]); await h.finish(run);
    // Canonical identity intentionally ignores absent/null fields; explicit
    // relationship null is a newer clear. Do not change either owner contract.
    assert.deepEqual(await read(), { ...cleared, ...identity });
    return { malformedFactsIgnored: Object.keys(original).length,
      explicitNullRelationshipsCleared: Object.keys(relationship).length, nullIdentityPreserved: Object.keys(identity).length };
  });

  await check('Concurrent requests and worker restart preserve one run, cursor and retry budget', async () => {
    const scope = await h.scope('restart_concurrency');
    const run = await h.start(scope);
    const peers = await Promise.all([true, false, true].map(manual => h.subs.scheduleSubscriberScan({
      db: h.db, agencyId: scope.agencyId, creatorId: scope.creatorId, manual, force: manual,
    })));
    assert.ok(peers.every(result => !result.created && result.reason === 'already_in_flight' && result.run.id === run.job.params.scanRunId));
    await h.page(run, [row('201'), row('202')], { hasMore: true });
    const accepted = structuredClone(run.checkpoint);
    const attempts = (await h.db.jobInstance.findUnique({ where: { id: run.job.id } })).attempts;
    const released = await h.lease.releaseJob({ ...run.credentials, reason: 'fixture_worker_restart', runAfterMs: 1000 });
    await cleanup(scope);
    assert.equal(await h.db.subscriberScanItem.count({ where: { runId: run.job.params.scanRunId } }), 2);
    await wait(Math.max(0, +new Date(released.retryAt) - Date.now()) + 20);
    const resumed = await h.claim(scope, run.job.id);
    assert.deepEqual(resumed.checkpoint, accepted);
    assert.equal((await h.db.jobInstance.findUnique({ where: { id: resumed.job.id } })).attempts, attempts);
    await assert.rejects(h.lease.releaseJob({ ...run.credentials, reason: 'stale_worker', runAfterMs: 1000 }), error => /LEASE/.test(error.code || ''));
    await h.page(resumed, [row('203')]);
    await h.finish(resumed);
    assert.equal((await state(scope)).totalCount, 3);
    assert.equal((await runRow(resumed)).pageCount, 2);
    return { concurrentRequests: peers.length, sourcePages: 2, totalCount: 3 };
  });

  await check('Subscriber rate-limit waits use bounded provider duration and keep the finite failure budget', async () => {
    const hints = [
      { retryAfterMs: 120000, status: 429, expected: 120000 },
      { retryAfterMs: 1, status: 429, expected: 60000 },
      { retryAfterMs: 3600000, status: 429, expected: 900000 },
      { retryAfterMs: '120000', status: 429, expected: 60000 },
      { retryAfterMs: 120000.5, status: 429, expected: 60000 },
      { retryAfterMs: -120000, status: 429, expected: 60000 },
      { retryAfterMs: Number.MAX_SAFE_INTEGER + 1, status: 429, expected: 60000 },
      { retryAfterMs: 120000, status: 503, expected: 60000 },
    ];
    const recordFailure = (run, failure) => h.lease.failJob({ ...run.credentials,
      expectedContinuation: run.checkpoint, error: 'SYNTHETIC_RATE_LIMIT', retryable: true, result: { failure },
    });
    for (const [index, hint] of hints.entries()) {
      const scope = await h.scope('rate_hint_' + index), run = await h.start(scope);
      const [before] = await h.db.$queryRawUnsafe('SELECT clock_timestamp() AS at');
      const result = await recordFailure(run, { status: hint.status, retryAfterMs: hint.retryAfterMs, retryable: true });
      const [after] = await h.db.$queryRawUnsafe('SELECT clock_timestamp() AS at');
      assert.equal(result.status, 'SCHEDULED');
      assert.ok(+result.retryAt >= +before.at + hint.expected - 5, JSON.stringify({ hint, before, result }));
      assert.ok(+result.retryAt <= +after.at + hint.expected + 5, JSON.stringify({ hint, after, result }));
      const job = await h.db.jobInstance.findUnique({ where: { id: run.job.id } });
      assert.equal(job.attempts, 1); assert.equal(+job.nextRunAt, +result.retryAt);
    }
    const scope = await h.scope('rate_finite_budget');
    let run = await h.start(scope);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await recordFailure(run, { status: 429, retryAfterMs: 120000, retryable: true });
      const job = await h.db.jobInstance.findUnique({ where: { id: run.job.id } });
      assert.equal(job.attempts, attempt);
      if (attempt === 5) {
        assert.equal(result.status, 'FAILED'); assert.equal(result.terminal, true); assert.equal(result.retryAt, null);
      } else {
        assert.equal(result.status, 'SCHEDULED');
        // Advance only this fixture's eligibility time instead of waiting for
        // minutes. Attempts, continuation, and every lease transition are real.
        await h.db.jobInstance.update({ where: { id: run.job.id }, data: { nextRunAt: new Date(0) } });
        run = await h.claim(scope, run.job.id);
      }
    }
    const stopped = await h.subs.ensureSubscriberScanDue({ db: h.db, agencyId: scope.agencyId, creatorId: scope.creatorId });
    assert.equal(stopped.reason, 'failed_terminal'); assert.equal(stopped.created, false);
    return { validatedHints: hints.length, maximumProviderWaitMs: 900000, terminalAttempt: 5 };
  });

  await check('Stopped partial generations age out while latest stop, active snapshot and other creator survive', async () => {
    const scope = await h.scope('retention_failed');
    const sibling = await h.scope('retention_sibling');
    const baseline = await h.start(scope);
    await h.page(baseline, [row('301', { lastSeen: null })]); await h.finish(baseline);
    const siblingRun = await h.start(sibling);
    await h.page(siblingRun, [row('399')], { hasMore: true }); await h.fail(siblingRun);
    const failures = [];
    for (let index = 0; index < 6; index++) {
      const failed = await h.start(scope);
      await h.page(failed, [row(String(310 + index))], { hasMore: true });
      await h.fail(failed); failures.push(failed);
    }
    assert.ok(await h.db.subscriberDirectoryMaintenanceSignal.findUnique({ where: {
      creatorId_kind: { creatorId: scope.creatorId, kind: 'RETENTION' },
    } }));
    const latest = failures.at(-1), latestId = latest.job.params.scanRunId;
    const first = await cleanup(scope, { keep: 2 });
    assert.equal(first.deletedRuns, 2); assert.equal(first.hasMore, true);
    let deleted = first.deletedRuns;
    for (let turn = 0; turn < 5; turn++) {
      const result = await cleanup(scope);
      assert.ok(result.deletedRuns <= 2); deleted += result.deletedRuns;
      if (!result.hasMore) break;
    }
    const remaining = await h.db.subscriberScanRun.findMany({ where: { creatorId: scope.creatorId } });
    assert.deepEqual(remaining.map(run => run.id).sort(), [baseline.job.params.scanRunId, latestId].sort());
    assert.equal(await h.db.subscriberScanPage.count({ where: { run: { creatorId: scope.creatorId } } }), 2);
    assert.equal(await h.db.subscriberScanItem.count({ where: { creatorId: scope.creatorId } }), 2);
    assert.equal((await state(scope)).currentRunId, baseline.job.params.scanRunId);
    assert.equal((await state(scope)).totalCount, 1);
    assert.equal(await h.db.subscriberScanItem.count({ where: { creatorId: sibling.creatorId } }), 1);
    const stopped = await h.subs.scheduleSubscriberScan({ db: h.db, agencyId: scope.agencyId, creatorId: scope.creatorId });
    assert.equal(stopped.reason, 'failed_terminal'); assert.equal(stopped.created, false);
    assert.equal(stopped.job.id, latest.job.id);
    const next = await h.start(scope);
    assert.ok(next.run.publicationGeneration > latest.run.publicationGeneration);
    await h.page(next, [row('302')]); await h.finish(next);
    await cleanup(scope, { maxRuns: 50 });
    const published = await state(scope);
    assert.equal(published.currentRunId, next.job.params.scanRunId);
    assert.equal(published.previousRunId, baseline.job.params.scanRunId);
    assert.equal(await h.db.subscriberScanRun.count({ where: { creatorId: scope.creatorId } }), 2);
    assert.equal(await h.db.subscriberScanRun.count({ where: { creatorId: sibling.creatorId } }), 1);
    return { terminalPartialRuns: failures.length, deletedBeforeManualRetry: deleted,
      protectedCurrentAndPrevious: 2, automaticRetryStopped: true };
  });

  await check('Retention preserves a recoverable job and rejects stale maintenance ownership', async () => {
    const scope = await h.scope('retention_ownership');
    const old = await h.start(scope);
    await h.page(old, [row('401')], { hasMore: true }); await h.fail(old);
    const newer = await h.start(scope);
    await h.page(newer, [row('402')]); await h.finish(newer);
    // A legacy/recovery history may have FAILED source status while its job is
    // already scheduled again. Retention must consult both durable authorities.
    await h.db.jobInstance.update({ where: { id: old.job.id }, data: { status: 'SCHEDULED' } });
    assert.equal((await cleanup(scope, { maxRuns: 50 })).deletedRuns, 0);
    assert.ok(await runRow(old));
    await h.db.jobInstance.update({ where: { id: old.job.id }, data: { status: 'FAILED' } });
    const signal = await h.db.subscriberDirectoryMaintenanceSignal.findUnique({ where: {
      creatorId_kind: { creatorId: scope.creatorId, kind: 'RETENTION' },
    } });
    await assert.rejects(cleanup(scope, { maintenanceSignal: { ...signal, claimToken: 'stale-fixture-owner' } }),
      error => error.code === 'SUBSCRIBER_MAINTENANCE_CLAIM_STALE');
    assert.ok(await runRow(old));
    assert.equal((await cleanup(scope, { maxRuns: 50 })).deletedRuns, 1);
    assert.equal(await runRow(old), null);
    return { recoverableJobPreserved: true, staleMaintenanceRejected: true, deletedAfterTerminal: 1 };
  });

  await check('Publication resumes every durable phase across 500-row boundaries without replacing the pointer early', async () => {
    const scope = await h.scope('publication_boundaries');
    const first = await h.start(scope);
    const fans = Array.from({ length: 501 }, (_, index) => row(String(30000 + index), index === 0 ? { lastSeen: null } : {}));
    for (let offset = 0; offset < fans.length; offset += 20) {
      await h.page(first, fans.slice(offset, offset + 20), { hasMore: offset + 20 < fans.length });
    }
    assert.equal((await runRow(first)).fanProjectionStatus, 'COMPLETE');
    const phases = [];
    const publishOne = async run => {
      // Discard the service module between bounded units: only saved phase,
      // cursor, generation, and rows survive to the next owner invocation.
      const id = h.load.resolve('./src/services/subscriber-directory-service');
      delete require.cache[id];
      const service = h.load('./src/services/subscriber-directory-service');
      return service._test.publishRun(h.db, await runRow(run), { jobId: run.job.id, maxSteps: 1 });
    };
    const resume = async (run, oldPointer) => {
      for (let turn = 0; turn < 12; turn++) {
        const result = await publishOne(run), current = await runRow(run);
        phases.push({ generation: current.publicationGeneration, phase: current.publicationStatus,
          added: current.publicationAddedCount, disappeared: current.publicationDisappearedCount });
        const directory = await state(scope);
        assert.equal(directory.currentRunId, result.complete ? current.id : oldPointer);
        if (result.complete) return current;
      }
      throw new Error('BOUNDED_PUBLICATION_DID_NOT_CONVERGE');
    };
    const beforePublish = await h.subs.scheduleSubscriberScan({ db: h.db, agencyId: scope.agencyId, creatorId: scope.creatorId, manual: true });
    assert.equal(beforePublish.reason, 'publication_recovery_in_progress');
    assert.equal((await cleanup(scope)).blockedByPublicationDebt, true);
    const completedFirst = await resume(first, null);
    assert.equal(completedFirst.publicationAddedCount, 501);
    assert.ok(phases.some(phase => phase.phase === 'CURRENT' && phase.added === 500));
    assert.equal((await h.db.jobInstance.findUnique({ where: { id: first.job.id } })).status, 'CLAIMED');
    const recoveredWhileClaimed = await h.subs.recoverSubscriberPublicationDebt({ db: h.db,
      agencyId: scope.agencyId, creatorId: scope.creatorId, maxRuns: 1, maxStepsPerRun: 1, maxRuntimeMs: 1000 });
    assert.equal((await h.db.jobInstance.findUnique({ where: { id: first.job.id } })).status, 'CLAIMED');
    assert.equal((await runRow(first)).publicationJobReconciledAt, null);
    assert.equal((await cleanup(scope)).blockedByPublicationDebt, true);
    // Worker shutdown after FINALIZE must retain publication and let maintenance
    // reconcile the now unowned descriptor without asking the provider again.
    await h.lease.releaseJob({ ...first.credentials, reason: 'fixture_after_finalize_restart', runAfterMs: 1000 });
    await h.subs.recoverSubscriberPublicationDebt({ db: h.db, agencyId: scope.agencyId,
      creatorId: scope.creatorId, maxRuns: 2, maxStepsPerRun: 4, maxRuntimeMs: 30000 });
    assert.equal((await h.db.jobInstance.findUnique({ where: { id: first.job.id } })).status, 'DONE');
    assert.ok((await runRow(first)).publicationJobReconciledAt);
    const second = await h.start(scope);
    await h.page(second, [row('30000', { name: 'Changed' }), row('40000', { lastSeen: null })]);
    const completedSecond = await resume(second, first.job.params.scanRunId);
    assert.equal(completedSecond.publicationAddedCount, 1);
    assert.equal(completedSecond.publicationChangedCount, 1);
    assert.equal(completedSecond.publicationDisappearedCount, 500);
    assert.ok(phases.some(phase => phase.generation === 2 && phase.phase === 'PREVIOUS' && phase.disappeared > 0));
    await h.finish(second);
    const final = await state(scope);
    assert.equal(final.totalCount, 2); assert.equal(final.hiddenCount, 1);
    assert.equal(final.currentRunId, second.job.params.scanRunId); assert.equal(final.previousRunId, first.job.params.scanRunId);
    const stable = structuredClone(final);
    await publishOne(first); await publishOne(second);
    assert.deepEqual(await state(scope), stable);
    assert.equal(await h.db.subscriberDirectoryMaintenanceSignal.count({ where: { creatorId: scope.creatorId, kind: 'DERIVED_PLANNING' } }), 1);
    assert.equal((await cleanup(scope, { maxRuns: 50 })).deletedRuns, 0);
    return { providerRows: 503, sourcePages: 27, phases, activeOwnerPreserved: true,
      recoveryReason: recoveredWhileClaimed.reason, added: 1, changed: 1, disappeared: 500, finalCount: 2 };
  });

  return checks;
}
module.exports = { runMutationCases };
