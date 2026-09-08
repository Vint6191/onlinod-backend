"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCustomDeliveryReceipt, normalizeReceiptData, receiptSignalRows } = require("./custom-delivery-receipt-authority-service");

function base(overrides = {}) {
  return {
    agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1", submissionId: "sub-1",
    writeId: "write-1", writeCommitRevision: 2, idempotencyKey: "idem-1", dialogId: "777", messageId: "msg-1",
    actorMemberId: "member-1", actorUserId: "user-1", sentMediaIds: ["9001", "9002"], approvedMediaIds: ["9001", "9002"],
    matchedMediaIds: ["9001", "9002"], newlyDeliveredMediaIds: ["9002"], deliveredMediaIdsAfter: ["9001", "9002"], duplicateMediaIds: ["9001"],
    expectedPriceCents: 2000, actualPriceCents: 1500, totalPriceCents: 6000, paidAmountCents: 4000,
    remainingAmountCents: 2000, previousDeliveryOfferedCents: 1000, deliveryOfferedCents: 2500,
    paymentStatus: "PARTIALLY_PAID", paymentMismatch: "UNDERCHARGE", overrideReason: "manual decision",
    duplicateOverrideConfirmed: true, priceMismatchOverrideConfirmed: true, complete: true,
    occurredAt: new Date("2026-09-08T00:00:00Z"), ...overrides,
  };
}

function storage() {
  const rows = [];
  const db = {
    customDeliveryReceipt: {
      findFirst: async ({ where }) => rows.find((row) => (where.OR || []).some((o) =>
        (o.messageId && row.agencyId === o.agencyId && row.creatorId === o.creatorId && row.messageId === o.messageId)
        || (o.writeId && row.writeId === o.writeId && row.writeCommitRevision === o.writeCommitRevision))) || null,
      create: async ({ data }) => { const row = { id: `r-${rows.length + 1}`, ...structuredClone(data) }; rows.push(row); return row; },
    },
  };
  return { db, rows };
}

test("receipt fingerprint ignores replay processing time and actor lookup drift but preserves business facts", () => {
  const a = normalizeReceiptData(base());
  const b = normalizeReceiptData(base({ occurredAt: new Date("2026-09-08T01:00:00Z"), actorMemberId: "member-new", actorUserId: "user-new" }));
  assert.equal(a.receiptFingerprint, b.receiptFingerprint);
  const changed = normalizeReceiptData(base({ actualPriceCents: 1700 }));
  assert.notEqual(a.receiptFingerprint, changed.receiptFingerprint);
  const changedSnapshot = normalizeReceiptData(base({ deliveredMediaIdsAfter: ["9002"] }));
  assert.notEqual(a.receiptFingerprint, changedSnapshot.receiptFingerprint);
});

test("same provider/write proof replays idempotently and conflicting facts are rejected", async () => {
  const { db, rows } = storage();
  const first = await createCustomDeliveryReceipt({ db, input: base() });
  assert.equal(first.idempotent, false);
  const replay = await createCustomDeliveryReceipt({ db, input: base({ occurredAt: new Date("2026-09-08T01:00:00Z"), actorMemberId: "other" }) });
  assert.equal(replay.idempotent, true);
  assert.equal(rows.length, 1);
  await assert.rejects(() => createCustomDeliveryReceipt({ db, input: base({ actualPriceCents: 1800 }) }), (error) => error?.code === "CUSTOM_DELIVERY_RECEIPT_CONFLICT");
});

test("unique-create race re-reads the winner instead of creating duplicate business history", async () => {
  const { db, rows } = storage();
  const data = normalizeReceiptData(base());
  let first = true;
  db.customDeliveryReceipt.findFirst = async () => rows[0] || null;
  db.customDeliveryReceipt.create = async ({ data: createData }) => {
    if (first) {
      first = false;
      rows.push({ id: "winner", ...structuredClone(createData) });
      throw Object.assign(new Error("unique race"), { code: "P2002" });
    }
    throw new Error("unexpected second create");
  };
  const result = await createCustomDeliveryReceipt({ db, input: data });
  assert.equal(result.idempotent, true);
  assert.equal(result.receipt.id, "winner");
  assert.equal(rows.length, 1);
});

test("receipt-derived management signals preserve exact send-time duplicate set and payment mismatch", () => {
  const receipt = { id: "r1", ...normalizeReceiptData(base()) };
  const rows = receiptSignalRows(receipt);
  assert.equal(rows.length, 2);
  const duplicate = rows.find((row) => row.type === "CUSTOM_DELIVERY_DUPLICATE_ATTEMPT");
  const undercharge = rows.find((row) => row.type === "CUSTOM_PAYMENT_UNDERCHARGE");
  assert.equal(duplicate.duplicateMediaCount, 1);
  assert.equal(undercharge.shortfallCents, 500);
  assert.equal(undercharge.messageId, "msg-1");
});
