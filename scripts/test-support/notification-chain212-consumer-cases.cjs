'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function sourceWriter(h, scope) {
  const scanRunId = crypto.randomUUID();
  const job = { id: `live_${scanRunId}`, sourceJobId: null, agencyId: scope.agencyId, creatorId: scope.creatorId,
    params: { from: '1970-01-01T00:00:00.000Z', to: new Date(Date.now() + 60000).toISOString(),
      notificationMode: 'catchup', types: ['subscriptions', 'purchases', 'tips', 'likes', 'comments'] } };
  let page = 0;
  const input = raw => {
    page++;
    const { event, ...observation } = h.desktop.normalizeNotificationSource(raw, scope.creatorId);
    return { schemaVersion: 6, normalizerVersion: h.sourceLedger.VERSION, collectorVersion: 'notifications-history-v9-source-ledger',
      scanRunId, page, observations: [observation], processedRows: 1,
      batches: event ? [{ notificationType: observation.category, batchKey: `run:${scanRunId}:page:${observation.category}:${page}`, events: [event] }] : [] };
  };
  const apply = (chunk, db) => h.sourceLedger.ingestNotificationSourcePage({ db, job, deviceId: scope.deviceId, live: true, chunk });
  return { job, input, apply, write: raw => { const chunk = input(raw); return h.write(db => apply(chunk, db)); } };
}

async function drainReceipts(h, scope, jobId) {
  const work = h.load('./src/services/domain-work-authority-service');
  const consumer = h.load('./src/services/notification-fact-receipt-service');
  for (let pass = 0; pass < 10; pass++) {
    if (!await h.db.notificationFactReceipt.count({ where: { creatorId: scope.creatorId, jobId } })) return;
    const claim = await work.claimDomainWorkBatch({ db: h.db, workClass: consumer.WORK_CLASS, agencyId: scope.agencyId,
      creatorIds: [scope.creatorId], objectType: 'JobInstance', objectIds: [jobId], limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1 });
    assert.ok(claim.items?.length, JSON.stringify({ reason: claim.reason }));
    await consumer.processPage({ db: h.db, item: claim.items[0], ownerToken: claim.ownerToken });
  }
  assert.fail('Notification receipt consumer did not settle');
}

async function drainTraffic(h, scope) {
  const work = h.load('./src/services/domain-work-authority-service');
  const traffic = h.load('./src/services/traffic-projection-service');
  const classes = ['TRAFFIC_FACT', 'TRAFFIC_FAN', 'TRAFFIC_BACKFILL'];
  for (let pass = 0; pass < 30; pass++) {
    if (!await h.db.domainWorkItem.count({ where: { creatorId: scope.creatorId, workClass: { in: classes }, isOutstanding: true } })) return;
    let processed = 0;
    for (const workClass of classes) {
      const claim = await work.claimDomainWorkBatch({ db: h.db, workClass, agencyId: scope.agencyId, creatorIds: [scope.creatorId],
        limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1 });
      for (const item of claim.items || []) {
        await traffic.runTrafficProjectionUnit({ db: h.db, item, ownerToken: claim.ownerToken });
        processed++;
      }
    }
    assert.ok(processed, 'Scoped Traffic work must be claimable');
  }
  assert.fail('Traffic projection did not settle');
}

async function runConsumerCases(h, check) {
  const receipts = h.load('./src/services/subscription-receipt-projection-service');
  const projection = h.load('./src/services/team-observation-service').projectSubscriptionProjectionFact;
  const current = scope => h.db.creatorSubscriptionEvent.findFirst({ where: { creatorId: scope.creatorId }, include: { fan: true } });
  const ledger = scope => h.db.creatorSubscriptionLedger.findMany({ where: { creatorId: scope.creatorId }, orderBy: { id: 'asc' } });
  const sourceTime = new Date(Date.now() - 60000).toISOString();

  await check('history receipt survives replay and projects Traffic without historical sends', async () => {
    const scope = await h.scope('history_consequences');
    const raw = { id: 'history_subscription', type: 'subscribed', amount: 5, user: { id: '212810' }, createdAt: sourceTime };
    for (let turn = 0; turn < 2; turn++) {
      const full = await h.full(scope, { subscriptions: [raw], all_reconciliation: [raw] });
      assert.equal(full.job.status, 'DONE');
      await drainReceipts(h, scope, full.run.job.id);
      await drainTraffic(h, scope);
      assert.equal((await ledger(scope)).length, 1);
      assert.equal(await h.db.automationDelivery.count({ where: { creatorId: scope.creatorId } }), 0);
      assert.equal(await h.db.automationBumpFanState.count({ where: { creatorId: scope.creatorId } }), 0);
    }
    const view = await h.load('./src/services/traffic-read-service').getTrafficOverview({ db: h.db,
      userId: scope.userId, creatorId: scope.creatorId, rangeKey: 'all' });
    assert.equal(view.totals.paidSubscriptions, 1);
    assert.equal(view.totals.subscriptionRevenueCents, 500);
    return { paidSubscriptions: 1, revenueCents: 500, automaticDeliveries: 0, realReceiptAndTrafficWorkers: true };
  });

  await check('subscription correction uses one canonical identity and invalidates both fan scopes', async () => {
    const scope = await h.scope('receipt_corrections'), writer = sourceWriter(h, scope);
    const raw = { id: 'corrected_subscription', type: 'subscription_renewed', amount: 10, user: { id: '212820' }, createdAt: sourceTime };
    await writer.write(raw);
    const first = await current(scope), staleProjection = projection(first);
    const project = async () => receipts.projectCanonicalSubscriptionReceipt({ db: h.db, job: writer.job, fact: projection(await current(scope)) });
    await project();
    const initial = (await ledger(scope))[0];
    assert.equal(initial.eventHash, receipts.canonicalReceiptIdentity(scope.agencyId, scope.creatorId, first.id));
    const head = await h.db.creatorEntityChangeHead.findUnique({ where: { creatorId: scope.creatorId } });
    await writer.write({ ...raw, amount: 25, currency: 'EUR', user: { id: '212821' }, createdAt: new Date(+new Date(sourceTime) + 1000).toISOString() });
    await project();
    let rows = await ledger(scope);
    assert.equal(rows.length, 1); assert.equal(rows[0].id, initial.id); assert.equal(rows[0].amountCents, 2500);
    assert.equal(rows[0].currency, 'EUR'); assert.equal(rows[0].fanId, '212821');
    const changes = await h.db.creatorEntityChange.findMany({ where: { creatorId: scope.creatorId, revision: { gt: head.lastRevision }, entityType: { in: ['FAN','CRM'] } } });
    for (const type of ['FAN','CRM']) assert.deepEqual([...new Set(changes.filter(row => row.entityType === type).map(row => row.entityId))].sort(), ['212820','212821']);
    // A queued caller with an old projection cannot restore its old fan/price.
    await receipts.projectCanonicalSubscriptionReceipt({ db: h.db, job: writer.job, fact: staleProjection });
    assert.equal((await ledger(scope))[0].amountCents, 2500);
    const strengthened = { ...raw, amount: 25, user: { id: '212821' }, transactionId: 'subscription_transaction_212' };
    await writer.write(strengthened); await project(); await writer.write(strengthened); await project();
    assert.equal((await current(scope)).id, first.id); assert.equal((await ledger(scope)).length, 1);
    assert.equal((await ledger(scope))[0].id, initial.id);
    await writer.write({ ...strengthened, amount: null }); await project();
    assert.equal((await ledger(scope)).length, 0);
    assert.equal(await h.db.creatorPaidSubscription.count({ where: { creatorId: scope.creatorId } }), 0);
    return { stableCanonicalEvent: true, correctedFanScopes: 2, duplicatePayments: 0, unknownPriceRemovesMoney: true };
  });

  await check('legacy duplicate receipts adopt into one scoped canonical receipt', async () => {
    const scope = await h.scope('legacy_receipt_adoption'), writer = sourceWriter(h, scope);
    const raw = { id: 'legacy_subscription', type: 'subscription_renewed', amount: 10, user: { id: '212830' }, createdAt: sourceTime };
    await writer.write(raw);
    const former = await current(scope);
    const legacy = projection(former); delete legacy.canonicalEventId;
    await writer.write({ ...raw, transactionId: 'legacy_transaction_212', amount: 20 });
    const strengthened = projection(await current(scope)); delete strengthened.canonicalEventId;
    // Replace the current receipt with the two exact old-format rows in this
    // upgrade fixture. Their facts still come from the real source producer.
    await h.write(tx => tx.creatorSubscriptionLedger.deleteMany({ where: { creatorId: scope.creatorId, source: 'canonical_subscription_fact' } }));
    await receipts.projectCanonicalSubscriptionReceipt({ db: h.db, job: writer.job, fact: legacy });
    await receipts.projectCanonicalSubscriptionReceipt({ db: h.db, job: writer.job, fact: strengthened });
    assert.equal((await ledger(scope)).length, 2, 'The fixture represents two old mutable-fingerprint receipts');
    await receipts.projectCanonicalSubscriptionReceipt({ db: h.db, job: writer.job, fact: projection(await current(scope)) });
    const adopted = await ledger(scope);
    assert.equal(adopted.length, 1); assert.equal(adopted[0].amountCents, 2000);
    assert.equal(adopted[0].eventHash, receipts.canonicalReceiptIdentity(scope.agencyId, scope.creatorId, former.id));
    await drainTraffic(h, scope);
    const view = await h.load('./src/services/traffic-read-service').getTrafficOverview({ db: h.db,
      userId: scope.userId, creatorId: scope.creatorId, rangeKey: 'all' });
    assert.equal(view.totals.paidSubscriptions, 1); assert.equal(view.totals.subscriptionRevenueCents, 2000);
    return { legacyReceipts: 2, canonicalReceipts: 1, trafficRevenueCents: 2000 };
  });

  await check('withdrawal retains independent purchases and repairs an already-deleted legacy fact', async () => {
    const scope = await h.scope('purchase_withdrawal'), writer = sourceWriter(h, scope);
    const raw = { id: 'withdraw_purchase_a', type: 'paided_message', subType: 'subscriber_pay_for_chat_message',
      amount: 5, messageId: '2128401', user: { id: '212840' }, createdAt: sourceTime };
    await writer.write(raw); await writer.write({ ...raw, id: 'withdraw_purchase_b', amount: 7 });
    const state = async () => (await h.db.$queryRawUnsafe('SELECT "proofActive" FROM "CreatorMediaMessageFinancialState" WHERE "creatorId"=$1 AND "messageId"=$2', scope.creatorId, raw.messageId))[0];
    const notice = { ...raw, type: 'price_changed', subType: 'price_changed_from_free' };
    await writer.write(notice);
    assert.equal(await h.db.creatorSale.count({ where: { creatorId: scope.creatorId } }), 1);
    assert.equal((await state()).proofActive, true);
    // Native old-version fixture: its correction audit was durable, its fact
    // was deleted, but the media proof was never withdrawn.
    const remaining = await h.db.creatorSale.findFirst({ where: { creatorId: scope.creatorId } });
    await h.write(async tx => {
      await tx.creatorNotificationCorrection.create({ data: { agencyId: scope.agencyId, creatorId: scope.creatorId,
        notificationId: remaining.externalNotificationId, formerModel: 'creatorSale', formerFactId: remaining.id,
        newEventType: 'PRICE_CHANGED', reasonCode: 'SOURCE_RECLASSIFIED', priorEvidence: JSON.parse(JSON.stringify(remaining)), normalizerVersion: 'notification-source-v2' } });
      await tx.creatorSale.delete({ where: { id: remaining.id } });
    });
    assert.equal((await state()).proofActive, true);
    const chunk = writer.input({ ...notice, id: 'withdraw_purchase_b' });
    await assert.rejects(h.write(async tx => { await writer.apply(chunk, tx); throw new Error('SYNTHETIC_AFTER_WITHDRAWAL_ROLLBACK'); }), /SYNTHETIC_AFTER_WITHDRAWAL_ROLLBACK/);
    assert.equal((await state()).proofActive, true, 'Rollback must retain the prior media state');
    await h.write(tx => writer.apply(chunk, tx));
    assert.equal((await state()).proofActive, false);
    const reverse = await h.db.creatorEntityCurrent.findUnique({ where: { creatorId_entityType_entityId: {
      creatorId: scope.creatorId, entityType: 'MESSAGE_PURCHASE', entityId: '212840:2128401' } } });
    assert.equal(reverse.tombstone, true);
    assert.equal((await h.write(tx => writer.apply(chunk, tx))).replayed, true);
    assert.equal((await state()).proofActive, false);
    return { independentProofPreserved: true, oldOrphanRepaired: true, atomicRollback: true, reverseTombstone: true };
  });

  await check('a retired subscription loses its compatibility receipt without crossing creator scope', async () => {
    const scope = await h.scope('retired_subscription'), foreign = await h.scope('foreign_subscription'), writer = sourceWriter(h, scope);
    const raw = { id: 'retired_subscription', type: 'subscribed', amount: 5, user: { id: '212850' }, createdAt: sourceTime };
    await writer.write(raw);
    const event = await current(scope), fact = projection(event);
    await assert.rejects(receipts.projectCanonicalSubscriptionReceipt({ db: h.db,
      job: { ...writer.job, agencyId: foreign.agencyId, creatorId: foreign.creatorId }, fact }), { code: 'NOTIFICATION_FACT_SCOPE_MISMATCH' });
    await receipts.projectCanonicalSubscriptionReceipt({ db: h.db, job: writer.job, fact });
    assert.equal((await ledger(scope)).length, 1); assert.equal((await ledger(foreign)).length, 0);
    await writer.write({ ...raw, type: 'price_changed', subType: 'price_changed_from_free' });
    assert.equal(await current(scope), null); assert.equal((await ledger(scope)).length, 0);
    await writer.write({ ...raw, type: 'price_changed', subType: 'price_changed_from_free' });
    assert.equal((await ledger(scope)).length, 0);
    return { foreignScopeRejected: true, canonicalEvents: 0, compatibilityReceipts: 0 };
  });

  await check('compact malformed identities and mismatched source evidence cannot publish fake fans', async () => {
    const scope = await h.scope('strict_compact_boundary'), writer = sourceWriter(h, scope);
    const invalid = [ { fanId: { id: '42' } }, { fanId: -12 }, { fanId: 'bad\u0000id' },
      { fanName: { value: 'not a name' } }, { creatorId: 'another-creator' } ];
    for (let index = 0; index < invalid.length; index++) {
      const response = await h.write(db => h.facts.ingestNotificationFacts({ db, job: writer.job, deviceId: scope.deviceId,
        result: { events: [{ type: 'tip_received', notificationId: `bad_${index}`, fanId: '212860', amountCents: 500,
          currency: 'USD', occurredAt: sourceTime, ...invalid[index] }], notificationType: 'tips',
          batchKey: `run:strict212boundary:page:tips:${index}`, scanRunId: 'strict212boundary', sourceTimezone: 'UTC',
          schemaVersion: 4, collectorVersion: 'notifications-all-v5', finalizeCoverage: false } }));
      assert.equal(response.rejected, 1); assert.equal(response.inserted, 0);
    }
    const chunk = writer.input({ id: 'valid_compact', type: 'tip', amount: 5, user: { id: '212860' }, createdAt: sourceTime });
    chunk.batches[0].events[0].transactionId = 'not_in_source_observation';
    await assert.rejects(h.write(tx => writer.apply(chunk, tx)), { code: 'NOTIFICATION_FACT_OBSERVATION_MISMATCH' });
    assert.equal(await h.db.creatorTip.count({ where: { creatorId: scope.creatorId } }), 0);
    assert.equal(await h.db.creatorFan.count({ where: { creatorId: scope.creatorId } }), 0);
    return { rejectedMalformedRows: invalid.length, mismatchedSourceRejected: true, fakeFans: 0 };
  });

  await check('live WS receipt, corrections and Traffic read commit before any catchup, with atomic failure and replay', async () => {
    const scope = await h.scope('live_traffic_atomic'), sessionId = crypto.randomUUID();
    const processor = h.load('./src/services/data-change-processor-service');
    const raw = { id: 'live_paid_subscription', type: 'subscription_renewed', amount: 5,
      user: { id: '212870' }, createdAt: sourceTime };
    const input = (raws, firstSeq) => ({ deviceId: scope.deviceId, batchId: crypto.randomUUID(), observedAt: new Date().toISOString(),
      sourceTimezone: 'UTC', events: raws.map(row => h.live(scope, row).canonical), delivery: {
        version: 1, sessionId, entries: raws.map((row, index) => ({ seq: firstSeq + index, capturedAt: new Date().toISOString() })) } });
    const accept = body => h.write(db => processor.processLiveNotificationBatch({ db, creator: scope.creator,
      member: scope.member, device: scope.device, input: body }));
    const first = input([raw], 1), constraint = `fixture_notification212_${crypto.randomBytes(6).toString('hex')}`;
    assert.match(scope.creatorId, /^[a-zA-Z0-9_]+$/);
    // A native PostgreSQL failure at the derived receipt proves the ACK cannot
    // commit just the source/canonical half. Remove only this fixture constraint.
    await h.db.$executeRawUnsafe(`ALTER TABLE "CreatorSubscriptionLedger" ADD CONSTRAINT "${constraint}" CHECK ("creatorId"<>'${scope.creatorId}')`);
    try {
      await assert.rejects(accept(first), /constraint|check|fixture_notification212/i);
      for (const model of ['creatorSubscriptionEvent','creatorPaidSubscription','creatorNotificationEvent','creatorSubscriptionLedger','creatorRealtimeSession']) {
        assert.equal(await h.db[model].count({ where: { creatorId: scope.creatorId } }), 0, model);
      }
    } finally { await h.db.$executeRawUnsafe(`ALTER TABLE "CreatorSubscriptionLedger" DROP CONSTRAINT "${constraint}"`); }
    assert.equal((await accept(first)).deliveryAck.throughSeq, 1);
    const receiptId = (await ledger(scope))[0].id;
    assert.equal((await accept(first)).deliveryAck.throughSeq, 1);
    assert.equal((await ledger(scope)).length, 1);
    const correction = input([{ ...raw, amount: 9, user: { id: '212871' } }], 2);
    assert.equal((await accept(correction)).deliveryAck.throughSeq, 2);
    assert.equal((await ledger(scope))[0].id, receiptId);
    assert.equal((await ledger(scope))[0].amountCents, 900); assert.equal((await ledger(scope))[0].fanId, '212871');
    const other = input([{ id: 'live_tip', type: 'tip', amount: 3, user: { id: '212871' }, createdAt: sourceTime },
      { id: 'live_purchase', type: 'paided_message', amount: 5, messageId: '2128701', user: { id: '212871' }, createdAt: sourceTime }], 3);
    assert.equal((await accept(other)).deliveryAck.throughSeq, 4);
    assert.equal(await h.db.trafficFanSignal.count({ where: { creatorId: scope.creatorId, fanId: '212871' } }), 1);
    assert.equal(await h.db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: 'catchup_notifications_scan' } }), 0);
    await drainTraffic(h, scope);
    const view = await h.load('./src/services/traffic-read-service').getTrafficOverview({ db: h.db,
      userId: scope.userId, creatorId: scope.creatorId, rangeKey: 'all' });
    assert.equal(view.totals.paidSubscriptions, 1); assert.equal(view.totals.subscriptionRevenueCents, 900);
    assert.equal(await h.db.automationDelivery.count({ where: { creatorId: scope.creatorId } }), 0);
    return { ackThroughSeq: 4, subscriptionReceipts: 1, trafficRevenueCents: 900, catchupJobs: 0,
      nativeDerivedFailureRollsBackSourceAndAck: true, liveTipAndPurchaseInvalidateTraffic: true };
  });

  await runCorrectionCases(h, check);
  await runTeamRetirementCases(h, check);
}

async function runCorrectionCases(h, check) {
  const sourceTime = new Date(Date.now() - 60000).toISOString();
  await check('purchase target corrections replace message/post ownership without losing independent purchases or tenant scope', async () => {
    const scope = await h.scope('purchase_target_correction'), foreign = await h.scope('purchase_target_foreign');
    const writer = sourceWriter(h, scope), foreignWriter = sourceWriter(h, foreign);
    const raw = { id: 'target_correction', type: 'paided_message', subType: 'subscriber_pay_for_chat_message',
      amount: 5, messageId: '2128801', user: { id: '212880' }, createdAt: sourceTime };
    await writer.write(raw);
    await writer.write({ ...raw, id: 'independent_same_message', amount: 3 });
    await foreignWriter.write(raw);
    const current = () => h.db.creatorSale.findUnique({ where: { creatorId_externalNotificationId: {
      creatorId: scope.creatorId, externalNotificationId: raw.id } } });
    const original = await current();
    const state = async (messageId, creatorId = scope.creatorId) => (await h.db.$queryRawUnsafe(
      'SELECT "proofActive" FROM "CreatorMediaMessageFinancialState" WHERE "creatorId"=$1 AND "messageId"=$2', creatorId, messageId))[0];
    const post = { ...raw, type: 'purchase', subType: 'subscriber_pay_for_post', messageId: null, postId: '2128802', amount: 7 };
    await writer.write(post);
    const correctedPost = await current();
    assert.equal(correctedPost.id, original.id); assert.equal(correctedPost.saleType, 'POST');
    assert.equal(correctedPost.messageId, null); assert.equal(correctedPost.postId, '2128802');
    assert.equal(correctedPost.amountCents, 700);
    assert.equal((await state(raw.messageId)).proofActive, true, 'Independent current purchase still proves the former message');
    await writer.write({ ...raw, id: 'independent_same_message', type: 'price_changed', subType: 'price_changed_from_free' });
    assert.equal((await state(raw.messageId)).proofActive, false);
    const head = await h.db.creatorEntityChangeHead.findUnique({ where: { creatorId: scope.creatorId } });
    const message = { ...raw, messageId: '2128803', user: { id: '212881' }, amount: 9 };
    const chunk = writer.input(message);
    await assert.rejects(h.write(async tx => { await writer.apply(chunk, tx); throw new Error('SYNTHETIC_TARGET_CORRECTION_ROLLBACK'); }), /SYNTHETIC_TARGET_CORRECTION_ROLLBACK/);
    assert.equal((await current()).saleType, 'POST'); assert.equal(await state(message.messageId), undefined);
    await h.write(tx => writer.apply(chunk, tx));
    const correctedMessage = await current();
    assert.equal(correctedMessage.id, original.id); assert.equal(correctedMessage.saleType, 'MESSAGE');
    assert.equal(correctedMessage.messageId, message.messageId); assert.equal(correctedMessage.postId, null);
    assert.equal(correctedMessage.amountCents, 900); assert.equal(correctedMessage.fanOnlyFansUserIdAtEvent, '212881');
    assert.equal((await state(raw.messageId)).proofActive, false); assert.equal((await state(message.messageId)).proofActive, true);
    const changes = await h.db.creatorEntityChange.findMany({ where: { creatorId: scope.creatorId,
      revision: { gt: head.lastRevision }, entityType: { in: ['CRM', 'MEDIA', 'FAN'] } } });
    for (const type of ['CRM', 'MEDIA', 'FAN']) assert.deepEqual([...new Set(changes.filter(row => row.entityType === type).map(row => row.entityId))].sort(), ['212880', '212881']);
    assert.equal((await h.write(tx => writer.apply(chunk, tx))).replayed, true);
    assert.equal(await h.db.creatorSale.count({ where: { creatorId: scope.creatorId } }), 1);
    const foreignSale = await h.db.creatorSale.findFirst({ where: { creatorId: foreign.creatorId } });
    assert.equal(foreignSale.messageId, raw.messageId); assert.equal(foreignSale.amountCents, 500);
    assert.equal((await state(raw.messageId, foreign.creatorId)).proofActive, true);
    return { stableCanonicalId: true, targetChanges: ['MESSAGE_TO_POST', 'POST_TO_MESSAGE'],
      independentPurchasePreserved: true, atomicRollback: true, bothFanScopesInvalidated: true, foreignCreatorUnchanged: true };
  });

  await check('subscription fan corrections isolate profile snapshots and sparse replays retain the proven fan relation', async () => {
    const scope = await h.scope('subscription_sparse_identity'), writer = sourceWriter(h, scope);
    const raw = { id: 'subscription_sparse_identity', type: 'subscription_renewed', amount: 5,
      user: { id: '212890', username: 'previous_fan', name: 'Previous Fan', avatar: 'https://example.test/previous.png' }, createdAt: sourceTime };
    await writer.write(raw);
    const current = () => h.db.creatorSubscriptionEvent.findFirst({ where: { creatorId: scope.creatorId } });
    const original = await current();
    await writer.write({ ...raw, amount: 7, user: { id: '212891' } });
    const moved = await current();
    assert.equal(moved.id, original.id); assert.equal(moved.fanOnlyFansUserIdAtEvent, '212891');
    assert.notEqual(moved.fanRecordId, original.fanRecordId);
    for (const field of ['fanUsernameAtEvent', 'fanDisplayNameAtEvent', 'fanAvatarUrlAtEvent']) assert.equal(moved[field], null, field);
    const payment = await h.db.creatorPaidSubscription.findFirst({ where: { creatorId: scope.creatorId } });
    assert.equal(payment.fanRecordId, moved.fanRecordId); assert.equal(payment.fanUsernameAtEvent, null);
    assert.equal(await h.db.creatorSubscriptionState.count({ where: { creatorId: scope.creatorId, fanRecordId: original.fanRecordId } }), 0);
    await writer.write({ ...raw, amount: 9, user: null });
    const sparse = await current();
    assert.equal(sparse.fanRecordId, moved.fanRecordId, 'A missing provider profile cannot detach a previously proven event owner');
    assert.equal(sparse.fanOnlyFansUserIdAtEvent, '212891'); assert.equal(sparse.observedPriceCents, 900);
    assert.equal(await h.db.creatorSubscriptionState.count({ where: { creatorId: scope.creatorId, fanRecordId: moved.fanRecordId, status: 'ACTIVE' } }), 1);
    const receipt = await h.db.creatorSubscriptionLedger.findFirst({ where: { creatorId: scope.creatorId } });
    assert.equal(receipt.fanId, '212891'); assert.equal(receipt.amountCents, 900);
    assert.equal(await h.db.creatorSubscriptionLedger.count({ where: { creatorId: scope.creatorId } }), 1);
    await drainTraffic(h, scope);
    const view = await h.load('./src/services/traffic-read-service').getTrafficOverview({ db: h.db,
      userId: scope.userId, creatorId: scope.creatorId, rangeKey: 'all' });
    assert.equal(view.totals.paidSubscriptions, 1); assert.equal(view.totals.subscriptionRevenueCents, 900);
    return { formerProfileNotCopied: true, missingProfilePreservesFanRelation: true, onePayment: true, trafficRevenueCents: 900 };
  });

  await check('sparse purchase and tip corrections preserve proven fan ownership and the Vault purchase proof', async () => {
    const scope = await h.scope('money_sparse_identity'), writer = sourceWriter(h, scope);
    const fan = { id: '212892', username: 'known_buyer', name: 'Known Buyer' };
    const purchase = { id: 'sparse_purchase', type: 'paided_message', subType: 'subscriber_pay_for_chat_message',
      amount: 5, messageId: '2128921', user: fan, createdAt: sourceTime };
    const tip = { id: 'sparse_tip', type: 'tip', amount: 3, user: fan, createdAt: sourceTime };
    await writer.write(purchase); await writer.write(tip);
    const originalSale = await h.db.creatorSale.findFirst({ where: { creatorId: scope.creatorId } });
    const originalTip = await h.db.creatorTip.findFirst({ where: { creatorId: scope.creatorId } });
    await writer.write({ ...purchase, amount: 7, user: null });
    await writer.write({ ...tip, amount: 4, user: null });
    const sale = await h.db.creatorSale.findFirst({ where: { creatorId: scope.creatorId } });
    const updatedTip = await h.db.creatorTip.findFirst({ where: { creatorId: scope.creatorId } });
    for (const [before, after] of [[originalSale, sale], [originalTip, updatedTip]]) {
      assert.equal(after.id, before.id); assert.equal(after.fanRecordId, before.fanRecordId);
      assert.equal(after.fanOnlyFansUserIdAtEvent, fan.id); assert.equal(after.fanUsernameAtEvent, fan.username);
    }
    assert.equal(sale.amountCents, 700); assert.equal(updatedTip.amountCents, 400);
    const [state] = await h.db.$queryRawUnsafe('SELECT "proofActive" FROM "CreatorMediaMessageFinancialState" WHERE "creatorId"=$1 AND "messageId"=$2', scope.creatorId, purchase.messageId);
    assert.equal(state.proofActive, true);
    const purchaseEntity = await h.db.creatorEntityCurrent.findUnique({ where: { creatorId_entityType_entityId: {
      creatorId: scope.creatorId, entityType: 'MESSAGE_PURCHASE', entityId: `${fan.id}:${purchase.messageId}` } } });
    assert.equal(purchaseEntity.tombstone, false); assert.equal(purchaseEntity.payload.opened, true);
    return { correctedPurchaseCents: 700, correctedTipCents: 400, fanRelationsRetained: 2, vaultProofRetained: true };
  });

  await check('notification target and fan corrections cannot demote the independent payout authority', async () => {
    const scope = await h.scope('notification_payout_authority'), writer = sourceWriter(h, scope);
    const raw = { id: 'payout_owned_purchase', transactionId: 'payout_owned_transaction',
      type: 'paided_message', subType: 'subscriber_pay_for_chat_message', amount: 5,
      messageId: '2128931', user: { id: '212893' }, createdAt: sourceTime };
    await writer.write(raw);
    const original = await h.db.creatorSale.findFirst({ where: { creatorId: scope.creatorId } });
    const now = new Date();
    await h.write(db => h.load('./src/services/financial-transactions-service').ingestExactLiveTransaction({
      db, agencyId: scope.agencyId, creatorId: scope.creatorId, deviceId: scope.deviceId,
      observedAt: now, now, money: { transactionId: raw.transactionId, transactionType: 'message',
        amountCents: 1000, netCents: 800, currency: 'USD', status: 'done', occurredAt: sourceTime,
        fanOnlyFansUserId: raw.user.id } }));
    await writer.write({ ...raw, type: 'purchase', subType: 'subscriber_pay_for_post',
      messageId: null, postId: '2128932', amount: 99, user: { id: '212894' } });
    const current = await h.db.creatorSale.findFirst({ where: { creatorId: scope.creatorId } });
    assert.equal(current.id, original.id); assert.equal(current.source, 'ONLYFANS_API');
    assert.equal(current.amountCents, 1000); assert.equal(current.netCents, 800);
    assert.equal(current.fanOnlyFansUserIdAtEvent, raw.user.id); assert.equal(current.saleType, 'MESSAGE');
    assert.equal(current.messageId, raw.messageId); assert.equal(current.postId, null);
    const reclassification = await writer.write({ ...raw, type: 'price_changed', subType: 'price_changed_from_free' });
    assert.equal(reclassification.status, 'PARTIAL');
    assert.equal(await h.db.creatorSale.count({ where: { creatorId: scope.creatorId } }), 1);
    const [media] = await h.db.$queryRawUnsafe('SELECT "proofActive","netCents" FROM "CreatorMediaMessageFinancialState" WHERE "creatorId"=$1 AND "messageId"=$2', scope.creatorId, raw.messageId);
    assert.equal(media.proofActive, true); assert.equal(Number(media.netCents), 800);
    return { independentPayoutRetained: true, sourceGrossCents: 1000, sourceNetCents: 800,
      sourceFanAndMessageRetained: true, conflictingReclassification: 'PARTIAL' };
  });

  await check('a physically blocked stale receipt consumer observes the committed correction under the creator fact lock', async () => {
    const scope = await h.scope('receipt_physical_contention'), writer = sourceWriter(h, scope);
    const raw = { id: 'receipt_physical_contention', type: 'subscription_renewed', amount: 5,
      user: { id: '212895' }, createdAt: sourceTime };
    await writer.write(raw);
    const event = await h.db.creatorSubscriptionEvent.findFirst({ where: { creatorId: scope.creatorId } });
    const stale = h.load('./src/services/team-observation-service').projectSubscriptionProjectionFact(event);
    const chunk = writer.input({ ...raw, amount: 11, user: { id: '212896' } });
    let entered, release, heldPid;
    const held = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const correction = h.write(async db => {
      await writer.apply(chunk, db);
      heldPid = (await db.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
      entered(); await gate;
    });
    // Prevent an unhandled rejection while the other root transaction waits.
    correction.catch(() => {});
    await Promise.race([held, correction.then(() => assert.fail('Correction did not enter the hold'))]);
    const consumer = h.load('./src/services/subscription-receipt-projection-service').projectCanonicalSubscriptionReceipt({
      db: h.db, job: writer.job, fact: stale });
    consumer.catch(() => {});
    const key = crypto.createHash('sha256').update(`notification-facts:${scope.agencyId}:${scope.creatorId}`).digest().readBigUInt64BE(0);
    let blocked = null;
    try {
      for (let pass = 0; pass < 120 && !blocked; pass++) {
        [blocked] = await h.db.$queryRawUnsafe(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid::bigint=$1::bigint AND objid::bigint=$2::bigint AND objsubid=1 LIMIT 1`,
        (key >> 32n).toString(), (key & 0xffffffffn).toString());
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(blocked, 'The consumer must physically wait on the producer fact lock');
      assert.notEqual(blocked.pid, heldPid);
    } finally { release(); await Promise.all([correction, consumer]); }
    const rows = await h.db.creatorSubscriptionLedger.findMany({ where: { creatorId: scope.creatorId } });
    assert.equal(rows.length, 1); assert.equal(rows[0].amountCents, 1100); assert.equal(rows[0].fanId, '212896');
    await drainTraffic(h, scope);
    const view = await h.load('./src/services/traffic-read-service').getTrafficOverview({ db: h.db,
      userId: scope.userId, creatorId: scope.creatorId, rangeKey: 'all' });
    assert.equal(view.totals.paidSubscriptions, 1); assert.equal(view.totals.subscriptionRevenueCents, 1100);
    return { physicalPostgresLockWait: true, distinctConnections: true, staleReceiptCannotRestorePriorFanOrPrice: true,
      subscriptionReceipts: 1, trafficRevenueCents: 1100 };
  });
}

async function runTeamRetirementCases(h, check) {
  const sourceTime = new Date(Date.now() - 60000).toISOString();
  const team = h.load('./src/services/team-money-reconciliation-service');
  const prepare = async (kind, suffix) => {
    const scope = await h.scope('team_retirement_' + kind + '_' + suffix), writer = sourceWriter(h, scope);
    const raw = { id: 'team_retirement_' + kind, type: kind === 'sale' ? 'paided_message' : 'tip',
      ...(kind === 'sale' ? { subType: 'subscriber_pay_for_chat_message', messageId: '2128971' } : {}),
      amount: 5, user: { id: '212897' }, createdAt: sourceTime };
    await writer.write(raw);
    const model = kind === 'sale' ? 'creatorSale' : 'creatorTip', delegate = kind === 'sale' ? 'teamPpvPurchaseLedger' : 'teamTipLedger';
    const fact = await h.db[model].findFirst({ where: { creatorId: scope.creatorId } });
    const result = kind === 'sale' ? await team.reconcileCreatorSaleToTeam({ db: h.db, saleId: fact.id })
      : await team.reconcileCreatorTipToTeam({ db: h.db, tipId: fact.id });
    const root = result.purchase || result.attribution;
    assert.equal(root.status, 'unresolved'); assert.equal(root.attributedMemberId, null);
    return { scope, writer, raw, model, delegate, fact, root };
  };
  await check('informational corrections retire only automatic unresolved Team projections with rollback and Vault withdrawal', async () => {
    for (const kind of ['sale', 'tip']) {
      const { scope, writer, raw, model, delegate, fact, root } = await prepare(kind, 'automatic');
      const chunk = writer.input({ ...raw, type: 'price_changed', subType: 'price_changed_from_free' });
      const media = async () => (await h.db.$queryRawUnsafe('SELECT "proofActive" FROM "CreatorMediaMessageFinancialState" WHERE "creatorId"=$1 AND "messageId"=$2', scope.creatorId, raw.messageId || 'none'))[0];
      await assert.rejects(h.write(async db => { await writer.apply(chunk, db); throw new Error('SYNTHETIC_TEAM_RETIREMENT_ROLLBACK'); }), /SYNTHETIC_TEAM_RETIREMENT_ROLLBACK/);
      assert.equal(await h.db[model].count({ where: { creatorId: scope.creatorId } }), 1);
      assert.equal((await h.db[delegate].findUnique({ where: { id: root.id } })).financialStatus, root.financialStatus);
      if (kind === 'sale') assert.equal((await media()).proofActive, true);
      assert.equal((await h.write(db => writer.apply(chunk, db))).status, 'COMMITTED');
      assert.equal(await h.db[model].count({ where: { creatorId: scope.creatorId } }), 0);
      const retained = await h.db[delegate].findUnique({ where: { id: root.id } });
      assert.ok(retained); assert.equal(retained.financialStatus, 'superseded');
      assert.equal(retained[kind === 'sale' ? 'creatorSaleId' : 'creatorTipId'], null);
      assert.equal(retained.amountCents, 500, 'Retained evidence keeps the original amount');
      const attribution = await h.db.teamMoneyAttributionFact.findFirst({ where: { rootId: root.id } });
      assert.equal(attribution.financialStatus, 'superseded'); assert.equal(attribution.attributionActive, false);
      if (kind === 'sale') {
        assert.equal((await media()).proofActive, false);
        const resolver = await h.db.teamPpvResolveJob.findFirst({ where: { agencyId: scope.agencyId, purchaseId: root.purchaseId } });
        assert.equal(resolver.status, 'expired');
        assert.equal(resolver.result.financialClosureReason, 'NOTIFICATION_SOURCE_RECLASSIFIED');
        assert.ok(await h.db.teamPpvPurchaseAlias.count({ where: { rootId: root.id } }));
      }
      const replay = await team.repairTeamMoneyReconciliationWorkItem({ db: h.db, agencyId: scope.agencyId,
        objectType: kind === 'sale' ? 'CreatorSale' : 'CreatorTip', objectId: fact.id });
      assert.equal(replay.obsolete, true); assert.equal((await h.write(db => writer.apply(chunk, db))).replayed, true);
      assert.equal((await h.db[delegate].findUnique({ where: { id: root.id } })).financialStatus, 'superseded');
    }
    return { retiredAutomaticRoots: 2, rootsAndAuditEvidenceRetained: true, claimsClosed: true,
      vaultWithdrawn: true, atomicRollback: true, staleTeamWorkObsolete: true };
  });

  await check('notification reclassification preserves earned, manually claimed and historical Team authority', async () => {
    for (const kind of ['sale', 'tip']) for (const protection of ['claimed', 'historical_manual', 'compacted', 'manual_result']) {
      const { scope, writer, raw, model, delegate, root } = await prepare(kind, protection);
      // Arrange retained employee decisions, historical audits and compacted
      // records as upgrade fixtures; the source correction itself stays real.
      await h.write(async db => {
        if (protection === 'claimed') await db[delegate].update({ where: { id: root.id }, data: {
          status: kind === 'sale' ? 'attributed' : 'claimed', attributedMemberId: scope.member.id,
          attributedUserId: scope.userId, resolvedAt: new Date(sourceTime),
          resolvedSource: kind === 'sale' ? 'manual_claim_assign' : 'manual_chatter_claim',
        } });
        else if (protection === 'compacted') await db[delegate].update({ where: { id: root.id }, data: { compactedAt: new Date() } });
        else if (protection === 'manual_result' && kind === 'sale') {
          const resolver = await db.teamPpvResolveJob.findFirst({ where: { agencyId: scope.agencyId, purchaseId: root.purchaseId } });
          await db.teamPpvResolveJob.update({ where: { id: resolver.id }, data: { result: { ...resolver.result,
            manualResolutions: [{ manualResolution: true, action: 'release', resolvedByMemberId: scope.member.id }] } } });
        } else if (protection === 'manual_result') await db[delegate].update({ where: { id: root.id }, data: {
          result: { ...root.result, manualResolution: { manualResolution: true, action: 'release', resolvedByMemberId: scope.member.id } },
        } });
        else if (kind === 'sale') await db.teamPpvClaimAudit.create({ data: { agencyId: scope.agencyId,
          purchaseId: root.purchaseId, action: 'release', actorMemberId: scope.member.id } });
        else await db[delegate].update({ where: { id: root.id }, data: { history: [...root.history, {
          action: 'release', byMemberId: scope.member.id, prevOwner: null, nextOwner: null, source: 'manual_chatter_release',
        }] } });
      });
      const before = await h.db[delegate].findUnique({ where: { id: root.id } });
      const response = await writer.write({ ...raw, type: 'price_changed', subType: 'price_changed_from_free' });
      assert.equal(response.status, 'PARTIAL');
      assert.equal(await h.db[model].count({ where: { creatorId: scope.creatorId } }), 1);
      assert.deepEqual(await h.db[delegate].findUnique({ where: { id: root.id } }), before);
      assert.equal(await h.db.creatorNotificationCorrection.count({ where: { creatorId: scope.creatorId } }), 0);
      assert.equal(response.rejected, 1);
      const rejection = await h.db.analyticsIngestBatch.findUnique({ where: { id: response.batchId } });
      assert.equal(rejection.rejectedRows, 1);
      const acceptedSource = await h.db.creatorNotificationEvent.findFirst({ where: { creatorId: scope.creatorId } });
      assert.equal(acceptedSource.persistenceStatus, 'FACT_COMMITTED');
    }
    return { protectedSourceCorrections: 8, employeeDecisionsUnchanged: true,
      historicalManualEvidenceRetained: true, compactedRootsRetained: true };
  });
}

module.exports = { runConsumerCases, runCorrectionCases, runTeamRetirementCases, sourceWriter, drainReceipts, drainTraffic };
