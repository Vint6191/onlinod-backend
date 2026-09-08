"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recordCustomDeliverySend, projectCustomDeliveryFromTeamEvent, settleCustomManualDeliveryWriteFromTeamEvent, settleCustomManualDeliveryWithCapability } = require("./custom-content-delivery-tracking-service");

function fixture() {
  const order = {
    id: "custom-1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "777", type: "CONTENT", status: "PENDING",
    priceCents: 6000, paidAmountCents: 4000, fanDeliveredAt: null,
    deliverySentMediaIds: [], deliveryMessageIds: [], deliveryOfferedCents: 0,
    completedAt: null, updatedAt: new Date("2026-08-22T10:00:00.000Z"),
  };
  const submission = {
    id: "sub-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1",
    ofMediaIds: ["9001", "9002"], reviewStatus: "APPROVED", reviewedAt: new Date("2026-08-22T09:00:00.000Z"), customOrder: order,
  };
  const audits = [];
  const receipts = [];
  const db = {
    creatorMediaAsset: {
      findMany: async ({ where }) => (where.mediaId?.in || []).filter((id) => submission.ofMediaIds.includes(String(id))).map((mediaId) => ({ mediaId: String(mediaId), customOrderId: "custom-1" })),
    },
    customContentSubmission: {
      findFirst: async ({ where }) => where.customOrderId === "custom-1" ? submission : null,
      findMany: async () => [submission],
    },
    customOrder: {
      updateMany: async ({ where, data }) => {
        if (where.id !== order.id || Number(where.updatedAt?.getTime?.()) !== Number(order.updatedAt.getTime())) return { count: 0 };
        Object.assign(order, data); order.updatedAt = new Date(order.updatedAt.getTime() + 1); return { count: 1 };
      },
      findFirst: async ({ where }) => where.id === order.id ? order : null,
    },
    agencyMember: { findFirst: async () => ({ userId: "user-1" }) },
    customDeliveryReceipt: {
      findFirst: async ({ where }) => {
        const options = Array.isArray(where?.OR) ? where.OR : [where || {}];
        return receipts.find((row) => options.some((option) => (
          (option.messageId && row.agencyId === option.agencyId && row.creatorId === option.creatorId && row.messageId === option.messageId)
          || (option.writeId && row.writeId === option.writeId && Number(row.writeCommitRevision) === Number(option.writeCommitRevision))
        ))) || null;
      },
      create: async ({ data }) => { const row = { id: `receipt-${receipts.length + 1}`, ...structuredClone(data) }; receipts.push(row); return row; },
    },
    auditLog: { create: async ({ data }) => { audits.push(data); return { id: `audit-${audits.length}`, ...data }; } },
    $executeRawUnsafe: async () => 1,
  };
  return { order, submission, db, audits, receipts };
}

function installManualWrite(db, overrides = {}) {
  let write = {
    id: "write-manual-1", agencyId: "agency-1", creatorId: "creator-1",
    actionType: "CUSTOM_MANUAL_SEND", originKind: "INTERACTIVE",
    idempotencyKey: "custom-manual:custom-1:sub-1:0", targetId: "custom-1",
    status: "COMMITTING", writeCommitRevision: 1, failureCode: null, messageId: null,
    payload: {
      customOrderId: "custom-1", submissionId: "sub-1", creatorId: "creator-1", dialogId: "777",
      attemptedMediaIds: ["9001"], deliveryPhase: 0, expectedPriceCents: 2000, actualPriceCents: 2000,
    },
    result: { programmaticWriteKind: "CUSTOM_MANUAL_SEND", outcomeState: "COMMITTING" },
    ...overrides,
  };
  db.automationDelivery = {
    findUnique: async ({ where }) => where.id === write.id ? write : null,
    updateMany: async ({ where, data }) => {
      if (where.id !== write.id || String(where.status) !== String(write.status) || Number(where.writeCommitRevision) !== Number(write.writeCommitRevision)) return { count: 0 };
      write = { ...write, ...structuredClone(data) };
      return { count: 1 };
    },
  };
  return () => write;
}

function guardedTeamEvent(overrides = {}) {
  return {
    agencyId: "agency-1", memberId: "member-1", userId: "user-1", creatorId: "creator-1", dialogId: "777", messageId: "m-server-bound",
    eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", priceCents: 2000,
    extra: {
      mediaIds: ["9001"],
      metadata: { customDeliveryGuard: {
        authorityVersion: "CUSTOM_MANUAL_V1", writeId: "write-manual-1",
        idempotencyKey: "custom-manual:custom-1:sub-1:0", writeCommitRevision: 1, customOrderId: "custom-1",
      } },
    },
    ts: new Date("2026-08-22T10:20:00Z"),
    ...overrides,
  };
}

test("actual outgoing media advances partial delivery and completes only after all approved media were sent", async () => {
  const { order, db } = fixture();
  const first = await recordCustomDeliverySend({ agencyId: "agency-1", actorMemberId: "member-1", creatorId: "creator-1", dialogId: "777", messageId: "m-1", mediaIds: ["9001"], priceCents: 1500, occurredAt: "2026-08-22T10:10:00Z", enforceAccess: false, db });
  assert.equal(first.complete, false);
  assert.deepEqual(order.deliverySentMediaIds, ["9001"]);
  assert.deepEqual(order.deliveryMessageIds, ["m-1"]);
  assert.equal(order.deliveryOfferedCents, 1500);
  assert.equal(order.fanDeliveredAt, null);
  assert.equal(order.status, "PENDING");

  const second = await recordCustomDeliverySend({ agencyId: "agency-1", actorMemberId: "member-1", creatorId: "creator-1", dialogId: "777", messageId: "m-2", mediaIds: ["9002"], priceCents: 500, occurredAt: "2026-08-22T10:12:00Z", enforceAccess: false, db });
  assert.equal(second.complete, true);
  assert.deepEqual(order.deliverySentMediaIds, ["9001", "9002"]);
  assert.equal(order.deliveryOfferedCents, 2000);
  assert.equal(order.status, "COMPLETED");
  assert.equal(order.fanDeliveredAt.toISOString(), "2026-08-22T10:12:00.000Z");
  assert.equal(order.completedAt.toISOString(), "2026-08-22T10:12:00.000Z");
});

test("message replay is idempotent and does not double-count offered price", async () => {
  const { order, db } = fixture();
  const input = { agencyId: "agency-1", creatorId: "creator-1", dialogId: "777", messageId: "m-1", mediaIds: ["9001"], priceCents: 2000, occurredAt: "2026-08-22T10:10:00Z", enforceAccess: false, db };
  await recordCustomDeliverySend(input);
  const replay = await recordCustomDeliverySend(input);
  assert.equal(replay.idempotent, true);
  assert.equal(order.deliveryOfferedCents, 2000);
  assert.deepEqual(order.deliveryMessageIds, ["m-1"]);
});

test("idempotent replay projects original typed receipt facts instead of recomputing from a later aggregate", async () => {
  const { order, db } = fixture();
  const first = await recordCustomDeliverySend({ agencyId: "agency-1", creatorId: "creator-1", dialogId: "777", messageId: "m-stable-1", mediaIds: ["9001"], priceCents: 1500, occurredAt: "2026-08-22T10:10:00Z", enforceAccess: false, db });
  assert.equal(first.complete, false);
  assert.equal(first.expectedPriceCents, 2000);
  assert.equal(first.actualPriceCents, 1500);
  await recordCustomDeliverySend({ agencyId: "agency-1", creatorId: "creator-1", dialogId: "777", messageId: "m-stable-2", mediaIds: ["9002"], priceCents: 500, occurredAt: "2026-08-22T10:12:00Z", enforceAccess: false, db });
  assert.equal(order.status, "COMPLETED");

  const replay = await recordCustomDeliverySend({ agencyId: "agency-1", creatorId: "creator-1", dialogId: "777", messageId: "m-stable-1", mediaIds: ["9001"], priceCents: 9999, occurredAt: "2026-08-22T10:30:00Z", enforceAccess: false, db });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.receiptId, "receipt-1");
  assert.equal(replay.expectedPriceCents, 2000);
  assert.equal(replay.actualPriceCents, 1500);
  assert.equal(replay.paymentMismatch, "UNDERCHARGE");
  assert.deepEqual(replay.newlyDeliveredMediaIds, ["9001"]);
  assert.deepEqual(replay.deliveredMediaIds, ["9001"], "replay must return the exact aggregate media snapshot after the original provider message");
  assert.deepEqual(replay.duplicateMediaIds, []);
  assert.equal(replay.complete, false, "later aggregate completion must not rewrite the original send receipt");
  assert.equal(replay.fanDeliveredAt, null);
});

test("typed delivery receipt is durable business history even when best-effort AuditLog fails", async () => {
  const { order, db, receipts } = fixture();
  db.auditLog.create = async () => { throw new Error("audit table unavailable"); };
  const result = await recordCustomDeliverySend({
    agencyId: "agency-1", actorMemberId: "member-1", creatorId: "creator-1", dialogId: "777",
    messageId: "m-receipt", mediaIds: ["9001"], priceCents: 1500, occurredAt: "2026-08-22T10:10:00Z", enforceAccess: false, db,
  });
  assert.equal(result.matched, true);
  assert.equal(order.deliveryOfferedCents, 1500);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].messageId, "m-receipt");
  assert.deepEqual(receipts[0].newlyDeliveredMediaIds, ["9001"]);
  assert.deepEqual(receipts[0].deliveredMediaIdsAfter, ["9001"]);
  assert.equal(receipts[0].expectedPriceCents, 2000);
  assert.equal(receipts[0].actualPriceCents, 1500);
  assert.equal(receipts[0].paymentMismatch, "UNDERCHARGE");
});

test("receipt failure rolls back the Custom aggregate when a real transaction boundary is available", async () => {
  const { order, db, receipts } = fixture();
  const before = structuredClone(order);
  const originalReceiptCreate = db.customDeliveryReceipt.create;
  db.customDeliveryReceipt.create = async () => { throw Object.assign(new Error("receipt storage down"), { code: "P5000" }); };
  db.$transaction = async (fn) => {
    const orderSnapshot = structuredClone(order);
    const receiptSnapshot = structuredClone(receipts);
    const tx = { ...db };
    delete tx.$transaction;
    try { return await fn(tx); }
    catch (error) {
      for (const key of Object.keys(order)) delete order[key];
      Object.assign(order, orderSnapshot);
      receipts.splice(0, receipts.length, ...receiptSnapshot);
      throw error;
    }
  };
  await assert.rejects(() => recordCustomDeliverySend({
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "777", messageId: "m-rollback",
    mediaIds: ["9001"], priceCents: 2000, occurredAt: "2026-08-22T10:10:00Z", enforceAccess: false, db,
  }), /receipt storage down/);
  assert.deepEqual(order.deliverySentMediaIds, before.deliverySentMediaIds);
  assert.deepEqual(order.deliveryMessageIds, before.deliveryMessageIds);
  assert.equal(order.deliveryOfferedCents, before.deliveryOfferedCents);
  assert.equal(order.fanDeliveredAt, before.fanDeliveredAt);
  assert.equal(receipts.length, 0);
  db.customDeliveryReceipt.create = originalReceiptCreate;
});

test("provider replay creates exactly one typed receipt", async () => {
  const { db, receipts } = fixture();
  const input = { agencyId: "agency-1", creatorId: "creator-1", dialogId: "777", messageId: "m-one-receipt", mediaIds: ["9001"], priceCents: 2000, occurredAt: "2026-08-22T10:10:00Z", enforceAccess: false, db };
  await recordCustomDeliverySend(input);
  await recordCustomDeliverySend({ ...input, occurredAt: "2026-08-22T10:11:00Z" });
  assert.equal(receipts.length, 1);
});

test("overcharge and duplicate sends emit management audit signals only after a real confirmed outgoing", async () => {
  const { order, db, audits } = fixture();
  order.paidAmountCents = 6000;
  await recordCustomDeliverySend({ agencyId: "agency-1", actorMemberId: "member-1", creatorId: "creator-1", dialogId: "777", messageId: "m-1", mediaIds: ["9001"], priceCents: 3000, overrideReason: "fan wanted extra paid version", enforceAccess: false, db });
  assert.ok(audits.some((row) => row.action === "CUSTOM_PAYMENT_OVERRIDE"));
  assert.equal(audits.find((row) => row.action === "CUSTOM_PAYMENT_OVERRIDE").metadata.reason, "fan wanted extra paid version");

  await recordCustomDeliverySend({ agencyId: "agency-1", actorMemberId: "member-1", customOrderId: "custom-1", creatorId: "creator-1", dialogId: "777", messageId: "m-2", mediaIds: ["9001"], priceCents: 0, duplicateOverride: true, enforceAccess: false, db });
  assert.ok(audits.some((row) => row.action === "CUSTOM_DELIVERY_DUPLICATE_ATTEMPT"));
});

test("telemetry fallback can recover delivery progress without a local prepared-draft context", async () => {
  const { order, db } = fixture();
  db.customContentSubmission.findMany = async () => { throw new Error("review history scan must not run on typed CUSTOM fast path"); };
  const result = await projectCustomDeliveryFromTeamEvent({
    agencyId: "agency-1", memberId: "member-1", userId: "user-1", creatorId: "creator-1", dialogId: "777", messageId: "m-1",
    eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", priceCents: 2000,
    extra: { mediaIds: ["9001", "9002"] }, ts: new Date("2026-08-22T10:20:00Z"),
  }, { db });
  assert.equal(result.complete, true);
  assert.equal(order.status, "COMPLETED");
});

test("telemetry discovery keeps already fan-delivered customs visible for post-delivery duplicate signals", async () => {
  const { order, submission, db, audits } = fixture();
  let assetWhere = null;
  db.creatorMediaAsset.findMany = async ({ where }) => {
    assetWhere = where;
    return (where.mediaId?.in || []).filter((id) => submission.ofMediaIds.includes(String(id))).map((mediaId) => ({ mediaId: String(mediaId), customOrderId: "custom-1" }));
  };
  await projectCustomDeliveryFromTeamEvent({
    agencyId: "agency-1", memberId: "member-1", userId: "user-1", creatorId: "creator-1", dialogId: "777", messageId: "m-full",
    eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", priceCents: 2000,
    extra: { mediaIds: ["9001", "9002"] }, ts: new Date("2026-08-22T10:20:00Z"),
  }, { db });
  assert.equal(order.status, "COMPLETED");
  assert.ok(order.fanDeliveredAt);

  await projectCustomDeliveryFromTeamEvent({
    agencyId: "agency-1", memberId: "member-1", userId: "user-1", creatorId: "creator-1", dialogId: "777", messageId: "m-duplicate",
    eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", priceCents: 0,
    extra: { mediaIds: ["9001"] }, ts: new Date("2026-08-22T10:25:00Z"),
  }, { db });
  assert.equal(assetWhere.source, "CUSTOM");
  assert.equal(assetWhere.creatorId, "creator-1");
  assert.deepEqual(assetWhere.mediaId.in, ["9001"]);
  assert.ok(audits.some((row) => row.action === "CUSTOM_DELIVERY_DUPLICATE_ATTEMPT"));
  const originalDeliveredAt = order.fanDeliveredAt.toISOString();
  const duplicateReplay = await projectCustomDeliveryFromTeamEvent({
    agencyId: "agency-1", memberId: "member-1", userId: "user-1", creatorId: "creator-1", dialogId: "777", messageId: "m-duplicate-2",
    eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", priceCents: 0,
    extra: { mediaIds: ["9002"] }, ts: new Date("2026-08-22T10:30:00Z"),
  }, { db });
  assert.equal(duplicateReplay.fanDeliveredAt, originalDeliveredAt, "duplicate sends must not move the original fan-delivery timestamp");
});



test("confirmed fan-send survives a concurrent CANCEL without resurrecting the Custom", async () => {
  const { order, db } = fixture();
  const originalUpdateMany = db.customOrder.updateMany;
  let injectCancel = true;
  db.customOrder.updateMany = async (input) => {
    if (injectCancel) {
      injectCancel = false;
      order.status = "CANCELLED";
      order.cancelledAt = new Date("2026-08-22T10:19:59.000Z");
      order.updatedAt = new Date(order.updatedAt.getTime() + 1);
      return { count: 0 };
    }
    return originalUpdateMany(input);
  };

  const event = {
    agencyId: "agency-1", memberId: "member-1", userId: "user-1", creatorId: "creator-1", dialogId: "777", messageId: "m-race",
    eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", priceCents: 2000,
    extra: { mediaIds: ["9001", "9002"] }, ts: new Date("2026-08-22T10:20:00Z"),
  };

  await assert.rejects(
    () => projectCustomDeliveryFromTeamEvent(event, { db }),
    (error) => error?.code === "CUSTOM_DELIVERY_CONFLICT" && error?.status === 409,
  );
  assert.equal(order.status, "CANCELLED");
  assert.equal(order.fanDeliveredAt, null, "the stale projector must lose the cancellation CAS");

  const retry = await projectCustomDeliveryFromTeamEvent(event, { db });
  assert.equal(retry.complete, true);
  assert.equal(order.status, "CANCELLED", "durable external fact must not resurrect a cancelled Custom");
  assert.equal(order.fanDeliveredAt.toISOString(), "2026-08-22T10:20:00.000Z");
  assert.deepEqual(order.deliverySentMediaIds, ["9001", "9002"]);
  assert.deepEqual(order.deliveryMessageIds, ["m-race"]);
});

test("unconfirmed or non-manual events cannot establish the Custom fan-delivery fact", async () => {
  const { order, db } = fixture();
  const baseline = { status: order.status, sent: [...order.deliverySentMediaIds], messages: [...order.deliveryMessageIds], offered: order.deliveryOfferedCents, deliveredAt: order.fanDeliveredAt };
  const common = { agencyId: "agency-1", memberId: "member-1", userId: "user-1", creatorId: "creator-1", dialogId: "777", messageId: "fake-1", priceCents: 6000, extra: { mediaIds: ["9001", "9002"] }, ts: new Date("2026-08-22T10:20:00Z") };
  assert.equal(await projectCustomDeliveryFromTeamEvent({ ...common, eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "ATTEMPTED" }, { db }), null);
  assert.equal(await projectCustomDeliveryFromTeamEvent({ ...common, eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "AUTOMATION", lifecycle: "CONFIRMED" }, { db }), null);
  assert.equal(await projectCustomDeliveryFromTeamEvent({ ...common, eventKind: "MESSAGE_SEND_ATTEMPTED", actionSource: "MANUAL", lifecycle: "CONFIRMED" }, { db }), null);
  assert.equal(order.status, baseline.status);
  assert.deepEqual(order.deliverySentMediaIds, baseline.sent);
  assert.deepEqual(order.deliveryMessageIds, baseline.messages);
  assert.equal(order.deliveryOfferedCents, baseline.offered);
  assert.equal(order.fanDeliveredAt, baseline.deliveredAt);
});



test("CUSTOM_MANUAL_V2 capability settles exact success without current membership/auth", async () => {
  const crypto = require("node:crypto");
  const { order, db, receipts } = fixture();
  let transactionActive = false;
  let auditInsideTransaction = false;
  const originalAuditCreate = db.auditLog.create;
  db.auditLog.create = async (input) => { if (transactionActive) auditInsideTransaction = true; return originalAuditCreate(input); };
  db.$transaction = async (fn) => {
    transactionActive = true;
    const tx = { ...db }; delete tx.$transaction;
    try { return await fn(tx); } finally { transactionActive = false; }
  };
  const token = "custom-v2-success-token";
  const getWrite = installManualWrite(db, {
    sourceDeviceId: "device-a", leaseMemberId: "member-old", createdByUserId: "user-old",
    writeCommitAt: new Date("2026-09-07T10:00:00Z"),
    result: { programmaticWriteKind: "CUSTOM_MANUAL_SEND", outcomeState: "COMMITTING", customManualSettlementTokenHashes: [crypto.createHash("sha256").update(token).digest("hex")] },
    payload: { customOrderId: "custom-1", submissionId: "sub-1", creatorId: "creator-1", dialogId: "777", attemptedMediaIds: ["9001"], deliveryPhase: 0, expectedPriceCents: 2000, actualPriceCents: 2000, networkRequestId: "net-v2-success", actorMemberId: "member-old", actorUserId: "user-old" },
  });
  // No requireCreatorAccess/current membership is consulted by the settlement-only capability.
  const settled = await settleCustomManualDeliveryWithCapability({
    writeId: "write-manual-1", settlementToken: token, deviceId: "device-a", networkRequestId: "net-v2-success",
    writeCommitRevision: 1, outcome: "PROVEN_SUCCESS", providerStatus: 200, messageId: "m-v2-success", occurredAt: "2026-09-07T10:00:01Z",
  }, { db });
  assert.equal(settled.provenSuccess, true);
  assert.equal(getWrite().status, "COMPLETED");
  assert.equal(getWrite().messageId, "m-v2-success");
  assert.deepEqual(order.deliverySentMediaIds, ["9001"]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].writeId, "write-manual-1");
  assert.equal(receipts[0].writeCommitRevision, 1);
  assert.equal(auditInsideTransaction, false, "best-effort AuditLog must run only after the V2 business transaction commits");
});

test("CUSTOM_MANUAL_V2 exact provider rejection returns the same logical phase to retryable precommit", async () => {
  const crypto = require("node:crypto");
  const { order, db } = fixture();
  const token = "custom-v2-reject-token";
  const getWrite = installManualWrite(db, {
    sourceDeviceId: "device-a", writeCommitAt: new Date("2026-09-07T10:00:00Z"),
    result: { programmaticWriteKind: "CUSTOM_MANUAL_SEND", outcomeState: "COMMITTING", customManualSettlementTokenHashes: [crypto.createHash("sha256").update(token).digest("hex")] },
    payload: { customOrderId: "custom-1", submissionId: "sub-1", creatorId: "creator-1", dialogId: "777", attemptedMediaIds: ["9001"], deliveryPhase: 0, expectedPriceCents: 2000, actualPriceCents: 2000, networkRequestId: "net-v2-reject" },
  });
  const settled = await settleCustomManualDeliveryWithCapability({
    writeId: "write-manual-1", settlementToken: token, deviceId: "device-a", networkRequestId: "net-v2-reject",
    writeCommitRevision: 1, outcome: "PROVEN_NO_EFFECT", providerStatus: 422,
  }, { db });
  assert.equal(settled.provenNoEffect, true);
  assert.equal(getWrite().status, "RETRY_SCHEDULED");
  assert.equal(getWrite().failureCode, "provider_rejected_no_effect");
  assert.equal(getWrite().writeCommitAt, null);
  assert.deepEqual(order.deliverySentMediaIds, [], "provider rejection must not project fan delivery");
});



test("CUSTOM_MANUAL_V2 rejection settlement is replay-idempotent after writeCommitAt is cleared", async () => {
  const crypto = require("node:crypto");
  const { db } = fixture();
  const token = "custom-v2-reject-replay-token";
  const getWrite = installManualWrite(db, {
    sourceDeviceId: "device-a", writeCommitAt: new Date("2026-09-07T10:00:00Z"),
    result: { programmaticWriteKind: "CUSTOM_MANUAL_SEND", outcomeState: "COMMITTING", customManualSettlementTokenHashes: [crypto.createHash("sha256").update(token).digest("hex")] },
    payload: { customOrderId: "custom-1", submissionId: "sub-1", creatorId: "creator-1", dialogId: "777", attemptedMediaIds: ["9001"], deliveryPhase: 0, expectedPriceCents: 2000, actualPriceCents: 2000, networkRequestId: "net-v2-replay" },
  });
  const input = { writeId: "write-manual-1", settlementToken: token, deviceId: "device-a", networkRequestId: "net-v2-replay", writeCommitRevision: 1, outcome: "PROVEN_NO_EFFECT", providerStatus: 422 };
  await settleCustomManualDeliveryWithCapability(input, { db });
  assert.equal(getWrite().writeCommitAt, null);
  const replay = await settleCustomManualDeliveryWithCapability(input, { db });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.provenNoEffect, true);
});


test("CUSTOM_MANUAL_V2 settlement capability is bound to exact device/request/revision and cannot cross a retry generation", async () => {
  const crypto = require("node:crypto");
  const { db } = fixture();
  const oldToken = "custom-v2-bound-old-token";
  const oldHash = crypto.createHash("sha256").update(oldToken).digest("hex");
  const getWrite = installManualWrite(db, {
    sourceDeviceId: "device-a", writeCommitAt: new Date("2026-09-07T10:00:00Z"), writeCommitRevision: 1,
    result: { programmaticWriteKind: "CUSTOM_MANUAL_SEND", outcomeState: "COMMITTING", customManualSettlementTokenHashes: [oldHash] },
    payload: { customOrderId: "custom-1", submissionId: "sub-1", creatorId: "creator-1", dialogId: "777", attemptedMediaIds: ["9001"], deliveryPhase: 0, expectedPriceCents: 2000, actualPriceCents: 2000, networkRequestId: "net-v2-bound" },
  });
  const base = { writeId: "write-manual-1", settlementToken: oldToken, deviceId: "device-a", networkRequestId: "net-v2-bound", writeCommitRevision: 1, outcome: "PROVEN_NO_EFFECT", providerStatus: 422 };
  await assert.rejects(() => settleCustomManualDeliveryWithCapability({ ...base, deviceId: "device-b" }, { db }), (error) => error?.code === "CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH");
  await assert.rejects(() => settleCustomManualDeliveryWithCapability({ ...base, networkRequestId: "net-v2-other" }, { db }), (error) => error?.code === "CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH");
  await assert.rejects(() => settleCustomManualDeliveryWithCapability({ ...base, writeCommitRevision: 2 }, { db }), (error) => error?.code === "CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH");
  await assert.rejects(() => settleCustomManualDeliveryWithCapability({ ...base, settlementToken: "wrong-token" }, { db }), (error) => error?.code === "CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH");

  const row = getWrite();
  const newToken = "custom-v2-bound-new-token";
  row.writeCommitRevision = 2;
  row.writeCommitAt = new Date("2026-09-07T10:01:00Z");
  row.status = "COMMITTING";
  row.failureCode = null;
  row.result = { ...row.result, outcomeState: "COMMITTING", customManualSettlementTokenHashes: [crypto.createHash("sha256").update(newToken).digest("hex")] };
  row.payload = { ...row.payload, networkRequestId: "net-v2-next" };
  await assert.rejects(() => settleCustomManualDeliveryWithCapability(base, { db }), (error) => error?.code === "CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH");
});

test("CUSTOM_MANUAL_V2 capability rejects ambiguous provider outcomes instead of fabricating terminal proof", async () => {
  const crypto = require("node:crypto");
  const { db } = fixture();
  const token = "custom-v2-ambiguous-token";
  installManualWrite(db, {
    sourceDeviceId: "device-a", writeCommitAt: new Date("2026-09-07T10:00:00Z"),
    result: { programmaticWriteKind: "CUSTOM_MANUAL_SEND", outcomeState: "COMMITTING", customManualSettlementTokenHashes: [crypto.createHash("sha256").update(token).digest("hex")] },
    payload: { customOrderId: "custom-1", submissionId: "sub-1", creatorId: "creator-1", dialogId: "777", attemptedMediaIds: ["9001"], deliveryPhase: 0, expectedPriceCents: 2000, actualPriceCents: 2000, networkRequestId: "net-v2-ambiguous" },
  });
  const base = { writeId: "write-manual-1", settlementToken: token, deviceId: "device-a", networkRequestId: "net-v2-ambiguous", writeCommitRevision: 1 };
  await assert.rejects(() => settleCustomManualDeliveryWithCapability({ ...base, outcome: "PROVEN_NO_EFFECT", providerStatus: 409 }, { db }), (error) => error?.code === "CUSTOM_DELIVERY_SETTLEMENT_STATUS_AMBIGUOUS");
  await assert.rejects(() => settleCustomManualDeliveryWithCapability({ ...base, outcome: "PROVEN_NO_EFFECT", providerStatus: 408 }, { db }), (error) => error?.code === "CUSTOM_DELIVERY_SETTLEMENT_STATUS_AMBIGUOUS");
  await assert.rejects(() => settleCustomManualDeliveryWithCapability({ ...base, outcome: "PROVEN_SUCCESS", providerStatus: 500, messageId: "fake" }, { db }), (error) => error?.code === "CUSTOM_DELIVERY_SETTLEMENT_STATUS_INVALID");
});

test("V20.7 schema/migration separates Telegram task deliveredAt from durable fan delivery progress", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "..", "..");
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma", "migrations", "20260822110500_custom_actual_delivery_tracking", "migration.sql"), "utf8");
  assert.match(schema, /deliveredAt\s+DateTime\?[\s\S]*fanDeliveredAt\s+DateTime\?/);
  assert.match(schema, /deliverySentMediaIds\s+String\[\]\s+@default\(\[\]\)/);
  assert.match(schema, /deliveryMessageIds\s+String\[\]\s+@default\(\[\]\)/);
  assert.match(schema, /deliveryOfferedCents\s+Int\s+@default\(0\)/);
  assert.match(migration, /ADD COLUMN "fanDeliveredAt"/);
  assert.doesNotMatch(migration, /DROP COLUMN "deliveredAt"|RENAME COLUMN "deliveredAt"/);
});


test("Custom delivery receipt schema is a typed durable business-history authority", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "..", "..");
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma", "migrations", "20260908013000_custom_delivery_business_receipts", "migration.sql"), "utf8");
  const replaySnapshotMigration = fs.readFileSync(path.join(root, "prisma", "migrations", "20260908043000_custom_delivery_receipt_replay_snapshot", "migration.sql"), "utf8");
  assert.match(schema, /model CustomDeliveryReceipt[\s\S]*deliveredMediaIdsAfter\s+String\[\][\s\S]*duplicateMediaIds\s+String\[\][\s\S]*expectedPriceCents\s+Int[\s\S]*actualPriceCents\s+Int/);
  assert.match(schema, /@@unique\(\[agencyId, creatorId, messageId\]/);
  assert.match(schema, /@@unique\(\[writeId, writeCommitRevision\]/);
  assert.match(migration, /CREATE TABLE "CustomDeliveryReceipt"/);
  assert.match(migration, /CustomDeliveryReceipt_provider_message_key/);
  assert.match(replaySnapshotMigration, /ADD COLUMN "deliveredMediaIdsAfter" TEXT\[\]/);
  assert.doesNotMatch(migration, /INSERT INTO "CustomDeliveryReceipt"[\s\S]*AuditLog/i, "migration must not synthesize incomplete receipts from best-effort audit history");
});

test("durable MESSAGE_SEND_CONFIRMED carries request-bound Custom override audit metadata without choosing delivery authority", async () => {
  const { order, db, audits } = fixture();
  order.paidAmountCents = 6000;
  const result = await projectCustomDeliveryFromTeamEvent({
    agencyId: "agency-1", memberId: "member-1", userId: "user-1", creatorId: "creator-1", dialogId: "777", messageId: "m-guarded",
    eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", priceCents: 3000,
    extra: { mediaIds: ["9001"], metadata: { customDeliveryGuard: { customOrderId: "custom-1", overrideReason: "fan requested paid resend", duplicateOverride: false } } },
    ts: new Date("2026-08-22T10:20:00Z"),
  }, { db });
  assert.equal(result.matched, true);
  assert.equal(audits.find((row) => row.action === "CUSTOM_PAYMENT_OVERRIDE")?.metadata?.reason, "fan requested paid resend");

  const { db: otherDb, audits: otherAudits, order: otherOrder } = fixture();
  otherOrder.paidAmountCents = 6000;
  await projectCustomDeliveryFromTeamEvent({
    agencyId: "agency-1", memberId: "member-1", userId: "user-1", creatorId: "creator-1", dialogId: "777", messageId: "m-mismatch",
    eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", priceCents: 3000,
    extra: { mediaIds: ["9001"], metadata: { customDeliveryGuard: { customOrderId: "other-order", overrideReason: "must not attach", duplicateOverride: true } } },
    ts: new Date("2026-08-22T10:21:00Z"),
  }, { db: otherDb });
  assert.equal(otherAudits.find((row) => row.action === "CUSTOM_PAYMENT_OVERRIDE")?.metadata?.reason, null);
  assert.equal(otherAudits.find((row) => row.action === "CUSTOM_DELIVERY_DUPLICATE_ATTEMPT")?.metadata?.overrideConfirmed ?? false, false);
});


test("CUSTOM_MANUAL_V1 Team proof atomically settles the server-visible physical write authority", async () => {
  const { order, db } = fixture();
  const getWrite = installManualWrite(db);
  const result = await projectCustomDeliveryFromTeamEvent(guardedTeamEvent(), { db });
  assert.equal(result.matched, true);
  assert.deepEqual(order.deliverySentMediaIds, ["9001"]);
  const write = getWrite();
  assert.equal(write.status, "COMPLETED");
  assert.equal(write.messageId, "m-server-bound");
  assert.equal(write.result.messageId, "m-server-bound");
  assert.equal(write.result.outcomeState, "PROVEN_SUCCESS");
  assert.deepEqual(write.result.mediaIds, ["9001"]);
});

test("late canonical Team proof may settle a no-retry unresolved CUSTOM_MANUAL_SEND without minting another commit", async () => {
  const { db } = fixture();
  const getWrite = installManualWrite(db, {
    status: "FAILED", failureCode: "outcome_unresolved_do_not_retry",
    result: { programmaticWriteKind: "CUSTOM_MANUAL_SEND", outcomeState: "UNRESOLVED_NO_RETRY" },
  });
  const settled = await settleCustomManualDeliveryWriteFromTeamEvent({
    client: db,
    row: guardedTeamEvent({ messageId: "m-late-proof" }),
    projection: { matched: true, customOrderId: "custom-1", submissionId: "sub-1" },
  });
  assert.equal(settled.settled, true);
  assert.equal(getWrite().status, "COMPLETED");
  assert.equal(getWrite().messageId, "m-late-proof");
});

test("CUSTOM_MANUAL_V1 settlement rejects a Team proof that is not exactly bound to the reserved media/revision", async () => {
  const { db } = fixture();
  installManualWrite(db);
  await assert.rejects(
    () => settleCustomManualDeliveryWriteFromTeamEvent({
      client: db,
      row: guardedTeamEvent({ extra: { mediaIds: ["9002"], metadata: { customDeliveryGuard: { authorityVersion: "CUSTOM_MANUAL_V1", writeId: "write-manual-1", idempotencyKey: "custom-manual:custom-1:sub-1:0", writeCommitRevision: 1, customOrderId: "custom-1" } } } }),
      projection: { matched: true, customOrderId: "custom-1", submissionId: "sub-1" },
    }),
    (error) => error?.code === "CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH" && error?.status === 409,
  );
});

test("replayed CUSTOM_MANUAL_V1 Team proof is idempotent only for the same remote message", async () => {
  const { db } = fixture();
  const getWrite = installManualWrite(db);
  await settleCustomManualDeliveryWriteFromTeamEvent({
    client: db, row: guardedTeamEvent(), projection: { matched: true, customOrderId: "custom-1", submissionId: "sub-1" },
  });
  const replay = await settleCustomManualDeliveryWriteFromTeamEvent({
    client: db, row: guardedTeamEvent(), projection: { matched: true, customOrderId: "custom-1", submissionId: "sub-1" },
  });
  assert.equal(replay.idempotent, true);
  assert.equal(getWrite().status, "COMPLETED");
  await assert.rejects(
    () => settleCustomManualDeliveryWriteFromTeamEvent({
      client: db, row: guardedTeamEvent({ messageId: "m-other" }), projection: { matched: true, customOrderId: "custom-1", submissionId: "sub-1" },
    }),
    (error) => error?.code === "CUSTOM_DELIVERY_WRITE_RESULT_CONFLICT",
  );
});
