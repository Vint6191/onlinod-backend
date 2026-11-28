'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

async function runUpgradeCases(h, check) {
  const planner = h.load('./src/services/creator-analytics-sync-orchestrator');
  const process = h.load('./src/services/data-change-processor-service').processLiveNotificationBatch;
  const state = s => h.db.creatorNotificationSyncState.findUnique({ where: { creatorId: s.creatorId } });
  const countJobs = s => h.db.jobInstance.count({ where: { creatorId: s.creatorId, jobKey: 'catchup_notifications_scan' } });
  const plan = s => planner.ensureRecurringCreatorAnalyticsCatchups({ db: h.db, agencyId: s.agencyId, creatorId: s.creatorId });
  const finishEmpty = async run => {
    for (let turn = 0; turn < 8 && run.checkpoint?.driverPhase !== 'complete'; turn++) await h.progress(run, await h.produce(run, { list: [], hasMore: false }));
    return h.finish(run);
  };
  const historical = id => ({ id, type: 'tip', amount: 5, user: { id: '991901' }, createdAt: new Date(Date.now() - 600000).toISOString() });
  const legacy = (s, id) => {
    const value = h.live(s, historical(id)).canonical;
    value.normalizerVersion = 'notification-source-v2';
    value.notificationObservation.normalizerVersion = 'notification-source-v2';
    value.notificationFact.normalizerVersion = 'notification-source-v2';
    return value;
  };
  const deliver = (s, input) => h.write(tx => process({ db: tx, creator: s.creator, member: s.member, device: s.device, input }));
  const input = (events, sessionId, firstSeq, capturedAt) => ({ batchId: 'upgrade_' + crypto.randomUUID(), observedAt: capturedAt,
    sourceTimezone: 'UTC', normalizerUpgradeProtocol: 1, events, delivery: { version: 1, sessionId, entries: events.map((_, index) => ({ seq: firstSeq + index, capturedAt })) } });

  await check('Persisted v2 baseline receives one automatic v3 FULL proof and then returns to catch-up without deleting facts', async () => {
    const s = await h.scope('versioned_baseline');
    const row = historical('v2-baseline-fact');
    const before = await h.full(s, { tips: [row], all_reconciliation: [row] });
    const fact = await h.db.creatorTip.findFirst({ where: { creatorId: s.creatorId } });
    // Explicit rollout precondition: a persisted proof from the prior parser.
    // Source/canonical rows were created by the real owner and remain intact.
    const oldFrontier = { ...before.state.frontierReceipt };
    delete oldFrontier.baselineProof; delete oldFrontier.attemptedNormalizerVersion;
    await h.db.creatorNotificationSyncState.update({ where: { creatorId: s.creatorId }, data: {
      normalizerVersion: 'notification-source-v2', frontierReceipt: oldFrontier,
    } });
    await h.db.jobInstance.update({ where: { id: before.job.id }, data: {
      params: { ...before.job.params, notificationNormalizerVersion: 'notification-source-v2' },
    } });
    const scheduled = await plan(s);
    assert.equal(scheduled.initial.stage, 'notifications'); assert.equal(scheduled.initial.created, true);
    const run = await h.claim(s, scheduled.initial.jobId);
    assert.equal(run.job.params.notificationMode, 'full'); assert.equal(run.job.params.notificationNormalizerVersion, 'notification-source-v3');
    assert.notEqual(run.job.params.collectionGeneration, before.run.job.params.collectionGeneration);
    assert.equal((await h.db.creatorTip.findUnique({ where: { id: fact.id } })).amountCents, 500);
    const count = await countJobs(s); await plan(s); assert.equal(await countJobs(s), count, 'Concurrent planning reuses the active upgrade');
    const done = await finishEmpty(run); assert.equal(done.state.status, 'COMPLETE');
    assert.equal(done.state.normalizerVersion, 'notification-source-v3'); assert.ok(done.state.frontierReceipt.baselineProof.throughAt);
    assert.equal(await h.db.creatorTip.count({ where: { creatorId: s.creatorId } }), 1);
    const next = await h.schedule(s); assert.equal(next.job.params.notificationMode, 'catchup');
    return { oldCanonicalFactRetained: true, automaticUpgradeFullPasses: 1, subsequentMode: 'catchup' };
  });

  for (const status of ['PARTIAL', 'FAILED']) {
    await check(`A stopped v2 baseline permits one new parser attempt but a failed v3 upgrade cannot loop (${status})`, async () => {
      const s = await h.scope('bounded_version_' + status); const old = await h.full(s);
      const frontier = { ...old.state.frontierReceipt }; delete frontier.baselineProof; delete frontier.attemptedNormalizerVersion;
      await h.db.creatorNotificationSyncState.update({ where: { creatorId: s.creatorId }, data: {
        status, normalizerVersion: 'notification-source-v2', frontierReceipt: frontier,
        retryAfterAt: null, lastErrorCode: 'OLD_PARSER_RESULT',
      } });
      const planned = await plan(s); assert.equal(planned.initial.created, true);
      const run = await h.claim(s, planned.initial.jobId);
      await h.fail(run, 'CURRENT_PARSER_PROVIDER_FAILED');
      assert.equal((await state(s)).frontierReceipt.attemptedNormalizerVersion, 'notification-source-v3');
      const count = await countJobs(s);
      for (let turn = 0; turn < 3; turn++) await plan(s);
      assert.equal(await countJobs(s), count);
      assert.equal((await h.jobRow(run)).status, 'FAILED');
      return { boundedUpgradeAttempt: 1, planningSweepsWithoutNewJob: 3 };
    });
  }

  await check('Legacy delivery upgrade receipts survive batch repartition and retention without repeating already covered notification repair', async () => {
    const s = await h.scope('upgrade_repartition'); const sessionId = crypto.randomUUID(), capturedAt = new Date(Date.now() - 5000).toISOString();
    const first = legacy(s, 'legacy-seq-1'), second = legacy(s, 'legacy-seq-2');
    const original = input([first, second], sessionId, 1, capturedAt);
    const accepted = await deliver(s, original); assert.equal(accepted.deliveryAck.throughSeq, 2);
    assert.equal(accepted.normalizerUpgrade.status, 'REPAIR_QUEUED');
    const count = () => h.db.creatorRecoveryIntent.count({ where: { creatorId: s.creatorId } });
    assert.equal(await count(), 4);
    const receiver = await h.db.creatorRealtimeSession.findFirst({ where: { creatorId: s.creatorId } });
    assert.equal(receiver.loss, true); assert.equal(receiver.lossRevision, 1);
    for (const [event, seq] of [[first, 1], [second, 2]]) {
      const replay = await deliver(s, input([event], sessionId, seq, capturedAt));
      assert.equal(replay.deliveryAck.throughSeq, 2); assert.equal(await count(), 4);
    }
    assert.equal((await h.db.creatorRealtimeSession.findUnique({ where: { id: receiver.id } })).lossRevision, 1);
    assert.equal(await h.db.creatorTip.count({ where: { creatorId: s.creatorId } }), 0, 'Quarantine never ingests old facts');
    await h.full(s);
    const notificationReceipts = await h.db.creatorRecoveryIntent.findMany({ where: { creatorId: s.creatorId, stream: 'notifications' } });
    assert.equal(notificationReceipts.length, 2); assert.ok(notificationReceipts.every(row => row.status === 'COMPLETE'));
    assert.equal(await h.db.creatorRecoveryIntent.count({ where: { creatorId: s.creatorId, stream: 'financial', status: 'PENDING' } }), 2);
    // Historical intent metadata arranges the real retention boundary. Upgrade
    // receipts remain durable after ordinary completed history is compacted.
    const old = new Date(Date.now() - 31 * 86400000), ordinaryId = 'ordinary_' + crypto.randomUUID();
    const financialReceiptId = 'notifupgrade_financial_retention_' + crypto.randomUUID();
    await h.db.creatorRecoveryIntent.updateMany({ where: { creatorId: s.creatorId, stream: 'notifications', status: 'COMPLETE' }, data: { completedAt: old } });
    await h.db.creatorRecoveryIntent.createMany({ data: [
      { id: ordinaryId, stream: 'notifications', reason: 'OFFLINE_GAP' },
      { id: financialReceiptId, stream: 'financial', reason: 'FINANCIAL_PROOF_ADOPTION_FULL' },
    ].map(row => ({ ...row, agencyId: s.agencyId, creatorId: s.creatorId, gapFrom: new Date(0), targetAt: old,
      policyVersion: 2, status: 'COMPLETE', completedAt: old })) });
    const retention = h.load('./src/services/live-sync-retention-service');
    const drained = await retention.runSweep({ db: h.db, kind: 'intents', maxPages: 2 }); assert.equal(drained.ok, true);
    assert.equal(await h.db.creatorRecoveryIntent.findUnique({ where: { id: ordinaryId } }), null);
    assert.ok(await h.db.creatorRecoveryIntent.findUnique({ where: { id: financialReceiptId } }));
    assert.equal(await h.db.creatorRecoveryIntent.count({ where: { creatorId: s.creatorId, stream: 'notifications', status: 'COMPLETE' } }), 2);
    assert.equal((await retention.runSweep({ db: h.db, kind: 'intents', maxPages: 2 })).processed, 0);
    const jobs = await countJobs(s); await deliver(s, input([first], sessionId, 1, capturedAt));
    assert.equal(await countJobs(s), jobs);
    assert.equal(await h.db.creatorRecoveryIntent.count({ where: { creatorId: s.creatorId, stream: 'notifications', status: 'PENDING' } }), 0);
    assert.equal((await h.db.creatorRealtimeSession.findUnique({ where: { id: receiver.id } })).lossRevision, 1);
    return { immutableSequences: 2, receiptsBeforeRepartition: 4, repeatedNotificationRepair: false, financialProofStillRequired: true };
  });

  await check('Already acknowledged legacy delivery still queues repair when its old response was lost', async () => {
    const s = await h.scope('old_protocol_lost_ack'), sessionId = crypto.randomUUID(), capturedAt = new Date(Date.now() - 5000).toISOString();
    const payload = input([legacy(s, 'old-delivery-replay')], sessionId, 1, capturedAt);
    // Prior deployment transport receipt: canonical data is deliberately not
    // fabricated here; this arranges only the old committed delivery cursor.
    await h.write(tx => h.load('./src/services/creator-live-sync-service').acceptDelivery({ db: tx,
      agencyId: s.agencyId, creatorId: s.creatorId, deviceId: s.deviceId, memberId: s.member.id, accessEpoch: s.member.accessEpoch,
      delivery: payload.delivery, events: payload.events, now: new Date(), ingest: async () => [] }));
    assert.equal(await h.db.creatorRecoveryIntent.count({ where: { creatorId: s.creatorId } }), 0);
    const replay = await deliver(s, payload); assert.equal(replay.deliveryAck.throughSeq, 1);
    assert.equal(replay.normalizerUpgrade.status, 'REPAIR_QUEUED');
    assert.equal(await h.db.creatorRecoveryIntent.count({ where: { creatorId: s.creatorId, status: 'PENDING' } }), 2);
    return { priorAcknowledgement: 1, upgradeReceiptOnReplay: true };
  });

  await check('FULL proof never covers a later legacy capture merely because a legacy request allowed a future upper bound', async () => {
    const s = await h.scope('future_full_bound'), run = await h.start(s);
    const current = await h.jobRow(run), futureTo = new Date(Date.now() + 5 * 60000).toISOString();
    // Arrange the historical tolerance-bearing command; all provider pages
    // still pass through current source receipts and the real completion owner.
    const params = { ...current.params, to: futureTo };
    await h.db.jobInstance.update({ where: { id: run.job.id }, data: { params } }); run.job.params = params;
    const done = await finishEmpty(run), baseline = done.state.frontierReceipt.baselineProof;
    assert.equal(baseline.throughAt, params.analyticsObservationStartedAt);
    assert.ok(+new Date(baseline.throughAt) < +new Date(futureTo));
    const laterCapture = new Date().toISOString();
    assert.ok(+new Date(laterCapture) > +new Date(baseline.throughAt));
    const accepted = await deliver(s, input([legacy(s, 'late-after-full')], crypto.randomUUID(), 1, laterCapture));
    assert.equal(accepted.normalizerUpgrade.status, 'REPAIR_QUEUED');
    assert.equal(await h.db.creatorRecoveryIntent.count({ where: { creatorId: s.creatorId,
      stream: 'notifications', status: 'PENDING' } }), 1);
    const catchup = await h.start(s); await h.page(catchup, []); await h.finish(catchup);
    assert.deepEqual((await state(s)).frontierReceipt.baselineProof, baseline);
    assert.equal(await h.db.creatorRecoveryIntent.count({ where: { creatorId: s.creatorId,
      stream: 'notifications', status: 'PENDING' } }), 1, 'Catch-up cannot discharge a semantic FULL repair');
    return { futureToleranceMs: 300000, proofBound: 'physical observation start', laterCaptureRequiresFull: true };
  });

  await check('An in-flight FULL with a future request bound cannot discharge legacy delivery accepted after its observation started', async () => {
    const s = await h.scope('inflight_upgrade_bound'), run = await h.start(s);
    const current = await h.jobRow(run);
    const params = { ...current.params, to: new Date(Date.now() + 5 * 60000).toISOString() };
    await h.db.jobInstance.update({ where: { id: run.job.id }, data: { params } }); run.job.params = params;
    // A legacy repaired job may carry the historical five-minute tolerance.
    // Its future event filter is not proof of observations arriving during it.
    await h.page(run, []);
    const accepted = await deliver(s, input([legacy(s, 'legacy-during-full')], crypto.randomUUID(), 1, new Date().toISOString()));
    assert.equal(accepted.normalizerUpgrade.status, 'REPAIR_QUEUED');
    const obligation = await h.db.creatorRecoveryIntent.findFirst({ where: { creatorId: s.creatorId, stream: 'notifications' } });
    assert.ok(+obligation.targetAt > +new Date(params.analyticsObservationStartedAt));
    assert.ok(+obligation.targetAt < +new Date(params.to));
    const done = await finishEmpty(run);
    assert.equal(done.state.status, 'COMPLETE');
    assert.equal(done.state.frontierReceipt.baselineProof.throughAt, params.analyticsObservationStartedAt);
    assert.equal((await h.db.creatorRecoveryIntent.findUnique({ where: { id: obligation.id } })).status, 'PENDING',
      'A successful traversal must leave the later semantic repair obligation pending');
    await plan(s);
    const followup = await h.claim(s);
    assert.equal(followup.job.params.notificationMode, 'full');
    assert.equal(followup.job.params.recoveryIntentId, obligation.id);
    await finishEmpty(followup);
    assert.equal((await h.db.creatorRecoveryIntent.findUnique({ where: { id: obligation.id } })).status, 'COMPLETE');
    return { earlierFullPreservesLaterDebt: true, followupFullRequired: true, obligationCompletedByFollowup: true };
  });

  await check('One bound FULL settles every legacy delivery accepted before its physical observation started', async () => {
    const s = await h.scope('upgrade_coalesced_full'); await h.full(s);
    const sessionId = crypto.randomUUID();
    for (let seq = 1; seq <= 3; seq++) {
      await deliver(s, input([legacy(s, 'legacy-before-full-' + seq)], sessionId, seq, new Date().toISOString()));
    }
    const obligations = await h.db.creatorRecoveryIntent.findMany({ where: { creatorId: s.creatorId,
      stream: 'notifications', status: 'PENDING' }, orderBy: [{ targetAt: 'asc' }, { id: 'asc' }] });
    assert.equal(obligations.length, 3); assert.ok(+obligations[2].targetAt > +obligations[0].targetAt);
    await plan(s);
    const run = await h.claim(s);
    assert.equal(run.job.params.recoveryIntentId, obligations[0].id);
    assert.equal(run.job.params.notificationMode, 'full');
    assert.ok(obligations.every(row => +row.targetAt <= +new Date(run.job.params.analyticsObservationStartedAt)));
    const done = await finishEmpty(run);
    assert.equal(done.state.status, 'COMPLETE');
    const receipts = await h.db.creatorRecoveryIntent.findMany({ where: { creatorId: s.creatorId, stream: 'notifications' } });
    assert.ok(receipts.every(row => row.status === 'COMPLETE'),
      'The oldest bound intent must not truncate the proven FULL observation window for later already accepted deliveries');
    const jobs = await countJobs(s);
    await plan(s); assert.equal(await countJobs(s), jobs, 'No redundant FULL is required for the same proven window');
    return { deliveryBatchesBeforeScan: 3, requiredFullPasses: 1, allCoveredObligationsComplete: true };
  });

  await check('Normalizer repair remains FULL-only even with a current baseline and stops after a bounded failed episode', async () => {
    const s = await h.scope('upgrade_full_only'); await h.full(s);
    const late = new Date().toISOString(), sessionId = crypto.randomUUID();
    await deliver(s, input([legacy(s, 'late-legacy')], sessionId, 1, late));
    await plan(s);
    const run = await h.claim(s);
    assert.equal(run.job.params.notificationMode, 'full'); assert.equal(run.job.params.forceNotificationFullRebuild, true);
    assert.equal(run.job.params.collectionReason, 'NOTIFICATION_NORMALIZER_UPGRADE');
    assert.ok(run.job.params.recoveryIntentId); assert.equal(run.job.params.recoveryTargetAt, undefined);
    await h.fail(run, 'UPGRADE_SOURCE_FAILED');
    const episode = await h.db.creatorRecoveryIntent.findUnique({ where: { id: run.job.params.recoveryIntentId } });
    assert.equal(episode.status, 'STOPPED');
    const jobs = await countJobs(s);
    await deliver(s, input([legacy(s, 'another-old-queue-row')], sessionId, 2, new Date().toISOString()));
    for (let turn = 0; turn < 3; turn++) await plan(s);
    assert.equal(await countJobs(s), jobs);
    return { automaticMode: 'full', terminalEpisode: 'STOPPED', laterLegacyQueueCannotResetBudget: true };
  });

  await check('Notification Retry-After is bounded and malformed hints cannot change its retry budget', async () => {
    const hints = [
      { value: 120000, status: 429, expected: 120000 }, { value: 3600000, status: 429, expected: 900000 },
      { value: 1, status: 429, expected: 60000 }, { value: '120000', status: 429, expected: 60000 },
      { value: -1, status: 429, expected: 60000 }, { value: 120000.5, status: 429, expected: 60000 },
      { value: Number.MAX_SAFE_INTEGER + 1, status: 429, expected: 60000 }, { value: 120000, status: 503, expected: 60000 },
    ];
    for (const [index, hint] of hints.entries()) {
      const s = await h.scope('retry_after_' + index), run = await h.start(s), before = Date.now();
      const response = await h.lease.failJob({ ...run.credentials, expectedContinuation: run.checkpoint,
        error: 'RATE_LIMITED', retryable: true, result: { failure: { status: hint.status, retryAfterMs: hint.value } } });
      const after = Date.now(), row = await h.jobRow(run);
      assert.equal(response.status, 'SCHEDULED'); assert.equal(row.attempts, 1); assert.deepEqual(row.continuation, run.checkpoint);
      assert.ok(+row.nextRunAt >= before + hint.expected - 500 && +row.nextRunAt <= after + hint.expected + 500);
    }
    return { providerHintCases: hints.length, maximumProviderDelayMs: 900000, attemptsPerCase: 1 };
  });
}
module.exports = { runUpgradeCases };
