"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recordCustomDeliverySend, projectCustomDeliveryFromTeamEvent } = require("./custom-content-delivery-tracking-service");

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
    auditLog: { create: async ({ data }) => { audits.push(data); return { id: `audit-${audits.length}`, ...data }; } },
  };
  return { order, submission, db, audits };
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
