"use strict";
const assert = require("node:assert/strict");
module.exports = async function billingWriteCases({ db, check, member }) {
  const admission = require("../../src/services/billing-write-admission-service");
  const actor = { agencyId: "a", userId: "owner", memberId: member.id, accessEpoch: member.accessEpoch, deviceId: "device" };
  const future = () => new Date(Date.now() + 86400000), past = () => new Date(Date.now() - 1000);
  for (const id of ["write-paid", "write-unpaid", "write-programmatic"]) {
    await db.creatorAccount.create({ data: { id, agencyId: "a", displayName: id, status: "READY" } });
    await db.deviceCreatorBinding.create({ data: { agencyId: "a", creatorId: id, deviceId: "device", status: "ACTIVE", sessionWriteReady: true, sessionReadReady: true, lastSeenAt: new Date() } });
  }
  for (const creatorId of ["write-paid", "write-programmatic"]) await db.creatorBillingEntitlement.create({ data: { creatorId, agencyId: "a", coreValidFrom: past(), coreValidUntil: future() } });
  await db.workerDevice.update({ where: { id: "device" }, data: { lastSeenAt: new Date() } });
  const pay = (creatorId, active) => db.creatorBillingEntitlement.update({ where: { creatorId }, data: { coreValidFrom: past(), coreValidUntil: active ? future() : past() } });
  const hold = enabled => db.agency.update({ where: { id: "a" }, data: { billingSupportHold: enabled } });

  await check("write admission rolls back all transaction effects when billing denies; storage failure never grants", async () => {
    await assert.rejects(db.$transaction(async tx => {
      await admission.lockBillingWriteAdmission({ db: tx, agencyId: "a" });
      await tx.creatorAccount.update({ where: { id: "write-unpaid" }, data: { displayName: "must rollback" } });
      await admission.assertBillingWriteAdmission({ db: tx, agencyId: "a", creatorId: "write-unpaid" });
    }), { code: "CREATOR_SUBSCRIPTION_REQUIRED" });
    assert.equal((await db.creatorAccount.findUnique({ where: { id: "write-unpaid" } })).displayName, "write-unpaid");
    await assert.rejects(admission.assertBillingWriteAdmission({ db: { $queryRawUnsafe: async () => { throw new Error("storage unavailable"); } }, agencyId: "a", creatorId: "write-paid" }), /storage unavailable/);
  });

  const writes = require("../../src/services/programmatic-of-write-authority-service");
  const input = { ...actor, creatorId: "write-programmatic", kind: "VAULT_CREATE_LIST", idempotencyKey: "vault-create-list:write-programmatic:billing-proof", payloadFingerprint: "billing-proof" };
  let reserved, leased;
  await check("programmatic reserve rejects unpaid/future/held state before creating a durable new write", async () => {
    await pay(input.creatorId, false);
    await assert.rejects(writes.reserveProgrammaticWrite(input), { code: "CREATOR_SUBSCRIPTION_REQUIRED" });
    assert.equal(await db.automationDelivery.count({ where: { idempotencyKey: input.idempotencyKey } }), 0);
    await pay(input.creatorId, true); await hold(true);
    await assert.rejects(writes.reserveProgrammaticWrite(input), { code: "BILLING_ACCESS_HELD" });
    await hold(false);
    reserved = await writes.reserveProgrammaticWrite(input);
    leased = { ...input, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision };
  });
  await check("programmatic expiry between reserve/start and start/commit leaves no commit permit", async () => {
    await pay(input.creatorId, false);
    await assert.rejects(writes.startProgrammaticWrite(leased), { code: "CREATOR_SUBSCRIPTION_REQUIRED" });
    await pay(input.creatorId, true); await writes.startProgrammaticWrite(leased);
    await pay(input.creatorId, false);
    await assert.rejects(writes.prepareProgrammaticWrite(leased), { code: "CREATOR_SUBSCRIPTION_REQUIRED" });
    const row = await db.automationDelivery.findUnique({ where: { id: leased.writeId } });
    assert.equal(row.status, "RUNNING"); assert.equal(row.writeCommitRevision, 0); assert.equal(row.writeCommitAt, null);
  });
  await check("programmatic committed replay and receipt survive hold without a second commit revision", async () => {
    await pay(input.creatorId, true);
    const prepared = await writes.prepareProgrammaticWrite(leased);
    await hold(true);
    const replay = await writes.prepareProgrammaticWrite(leased);
    assert.equal(replay.duplicate, true); assert.equal(replay.writeCommitRevision, prepared.writeCommitRevision);
    const receipt = await writes.completeProgrammaticWrite({ ...leased, result: { folderId: "folder-proof" } });
    assert.equal(receipt.delivery.status, "COMPLETED");
    await hold(false);
  });
  await check("lost programmatic commit recovers after expiry and can only reconcile, not obtain another send", async () => {
    const retry = { ...input, idempotencyKey: `${input.idempotencyKey}-lost` };
    const r = await writes.reserveProgrammaticWrite(retry), l = { ...retry, writeId: r.delivery.id, leaseToken: r.lease.token, leaseRevision: r.lease.revision };
    await writes.startProgrammaticWrite(l); await writes.prepareProgrammaticWrite(l);
    await db.automationDelivery.update({ where: { id: l.writeId }, data: { claimUntil: past() } });
    await pay(input.creatorId, false);
    const recovered = await writes.reserveProgrammaticWrite(retry);
    assert.equal(recovered.reconciliationRequired, true);
    const newer = { ...l, leaseToken: recovered.lease.token, leaseRevision: recovered.lease.revision };
    await assert.rejects(writes.prepareProgrammaticWrite(newer), { code: "PROGRAMMATIC_WRITE_RECONCILIATION_REQUIRED" });
    await assert.rejects(writes.completeProgrammaticWrite({ ...l, result: { folderId: "stale" } }), { code: "PROGRAMMATIC_WRITE_LEASE_STALE" });
    const settled = await writes.reconcileProgrammaticWrite({ ...newer, outcome: "MATCHED", result: { folderId: "folder-recovered" } });
    assert.equal(settled.delivery.status, "COMPLETED");
  });

  // Isolate unrelated consumer policy/pacing. Actor, billing, SQL/CAS, delivery,
  // lease ownership, transaction rollback and settlement below are real services.
  const controlId = require.resolve("../../src/services/automation-control-service"), control = require(controlId);
  const pacingId = require.resolve("../../src/services/automation-pacing-service"), pacing = require(pacingId);
  require.cache[controlId].exports = { ...control, assertAutomationEnabled: async () => ({ effective: {}, workspace: { settings: {} }, modules: {} }) };
  require.cache[pacingId].exports = { ...pacing, claimPacingRetryAt: async () => null };
  const actionId = require.resolve("../../src/services/automation-action-delivery-service"); delete require.cache[actionId];
  const actions = require(actionId);
  let claim;
  const claimNext = () => actions.claimActionDelivery({ userId: actor.userId, deviceId: actor.deviceId, actionTypes: ["BILLING_PROOF"] });
  const actionLease = () => ({ deliveryId: claim.id, userId: actor.userId, deviceId: actor.deviceId, leaseToken: claim.leaseToken, leaseRevision: claim.leaseRevision });
  try {
    await db.automationDelivery.createMany({ data: Array.from({ length: 110 }, (_, n) => ({ id: `billing-unpaid-${n}`, agencyId: "a", creatorId: "write-unpaid", originKind: "AUTOMATION", moduleKey: "billing_proof", actionType: "BILLING_PROOF", status: "QUEUED", priority: 999, notBefore: past() })) });
    await db.automationDelivery.create({ data: { id: "billing-paid", agencyId: "a", creatorId: "write-paid", originKind: "AUTOMATION", moduleKey: "billing_proof", actionType: "BILLING_PROOF", status: "QUEUED", notBefore: past() } });
    await check("110 higher-priority unpaid automation rows cannot hide paid work behind candidate LIMIT", async () => {
      claim = (await claimNext()).delivery; assert.equal(claim?.id, "billing-paid");
    });
    await check("expiry before automation start parks the same action without burning an attempt", async () => {
      await pay("write-paid", false);
      await assert.rejects(actions.startActionDelivery(actionLease()), { code: "CREATOR_SUBSCRIPTION_REQUIRED" });
      const released = await actions.releaseActionDelivery({ ...actionLease(), reason: "CREATOR_SUBSCRIPTION_REQUIRED" });
      assert.equal(released.delivery.status, "QUEUED"); assert.equal(released.delivery.attempts, 0);
      assert.equal((await claimNext()).delivery, null);
    });
    await check("payment resumes the same automation; hold before COMMITTING denies without losing the action", async () => {
      await pay("write-paid", true); claim = (await claimNext()).delivery;
      assert.equal(claim.id, "billing-paid"); await actions.startActionDelivery(actionLease());
      await hold(true);
      await assert.rejects(actions.prepareWriteActionDelivery(actionLease()), { code: "BILLING_ACCESS_HELD" });
      const row = await db.automationDelivery.findUnique({ where: { id: claim.id } });
      assert.equal(row.status, "RUNNING"); assert.equal(row.writeCommitRevision, 0);
      await hold(false);
    });
    await check("automation post-commit receipt and duplicate prepare stay usable after hold", async () => {
      await actions.prepareWriteActionDelivery(actionLease()); await hold(true);
      const replay = await actions.prepareWriteActionDelivery(actionLease());
      assert.equal(replay.duplicate, true); assert.equal(replay.writeCommitRevision, 1);
      const settled = await actions.completeActionDelivery({ ...actionLease(), result: { code: "billing-proof-observed" } });
      assert.equal(settled.delivery.status, "COMPLETED"); await hold(false);
    });
    await check("unpaid automation with an unknown historical outcome retains reconciliation claim and no new permit", async () => {
      await db.automationDelivery.update({ where: { id: "billing-unpaid-0" }, data: { failureCategory: "OUTCOME_UNKNOWN_RECONCILE", status: "RETRY_SCHEDULED", result: { outcomeState: "RECONCILE_REQUIRED" } } });
      claim = (await claimNext()).delivery; assert.equal(claim.id, "billing-unpaid-0"); assert.equal(claim.reconciliationRequired, true);
      await actions.startActionDelivery(actionLease());
      await assert.rejects(actions.prepareWriteActionDelivery(actionLease()), { code: "DELIVERY_RECONCILIATION_REQUIRED" });
      await actions.releaseActionDelivery({ ...actionLease(), reason: "billing-drain-proof" });
    });
  } finally { require.cache[controlId].exports = control; require.cache[pacingId].exports = pacing; delete require.cache[actionId]; }

  await check("Telegram discovery skips more than a full unpaid page, respects tenant/member scope and excludes future grants", async () => {
    await db.telegramDeliveryIntent.createMany({ data: [
      ...Array.from({ length: 210 }, (_, n) => ({ id: `tg-unpaid-${n}`, agencyId: "a", creatorId: "write-unpaid", customOrderId: `proof-order-${n}`, accountId: "proof-account", kind: "TASK", logicalKey: `tg-unpaid-${n}`, payloadFingerprint: "p", createdAt: new Date(Date.now() - 86400000) })),
      { id: "tg-paid", agencyId: "a", creatorId: "write-paid", customOrderId: "proof-order-paid", accountId: "proof-account", kind: "TASK", logicalKey: "tg-paid", payloadFingerprint: "p" },
      { id: "tg-future", agencyId: "a", creatorId: "future", customOrderId: "proof-order-future", accountId: "proof-account", kind: "TASK", logicalKey: "tg-future", payloadFingerprint: "p" },
    ] });
    const list = scope => admission.selectBillableTelegramWorkIds({ db, agencyId: "a", scope, take: 25 });
    assert.deepEqual(await list({ broad: true }), ["tg-paid"]);
    assert.deepEqual(await list({ broad: false, creatorIds: ["write-unpaid"] }), []);
    assert.deepEqual(await admission.selectBillableTelegramWorkIds({ db, agencyId: "b", scope: { broad: true }, take: 25 }), []);
    await hold(true); assert.deepEqual(await list({ broad: true }), []); await hold(false);
    await db.agency.update({ where: { id: "a" }, data: { trialEndsAt: future() } });
    assert.equal((await list({ broad: true })).length, 25);
    await db.agency.update({ where: { id: "a" }, data: { trialEndsAt: past() } });
  });
};
