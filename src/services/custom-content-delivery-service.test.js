"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listCustomReadyDeliveries, getCustomReadyDelivery } = require("./custom-content-delivery-service");

function fixture() {
  const readyAt = new Date("2026-08-22T08:00:00.000Z");
  const creator = { id: "creator-1", displayName: "Model One", username: "modelone", avatarUrl: null, customsVaultFolderId: "folder-77" };
  const order = {
    id: "custom-1", creatorId: "creator-1", dialogId: "777", scenario: "Custom scenario", internalNote: null,
    type: "CONTENT", contentKind: "VIDEO", status: "PENDING", deliveredAt: null,
    priceCents: 6000, paidAmountCents: 4000, createdAt: new Date("2026-08-20T00:00:00.000Z"), creator,
  };
  const row = {
    id: "sub-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1",
    telegramMessageIds: [101, 102], ofMediaIds: ["9001", "9002"], reviewStatus: "APPROVED", reviewedAt: readyAt,
    receivedAt: new Date("2026-08-21T00:00:00.000Z"), creator, customOrder: order,
  };
  const assets = ["9001", "9002"].map((mediaId) => ({
    creatorId: "creator-1", mediaId, source: "CUSTOM", customOrderId: "custom-1", customFullPriceCents: 6000,
    mediaType: "video", thumbUrl: `https://cdn/${mediaId}.jpg`, previewUrl: `https://cdn/${mediaId}.preview`, fullUrl: `https://cdn/${mediaId}.mp4`, folderIds: ["folder-77"],
  }));
  const rows = [row];
  const db = {
    customContentSubmission: {
      findMany: async ({ where }) => rows.filter((item) => {
        if (where?.reviewStatus && item.reviewStatus !== where.reviewStatus) return false;
        if (where?.creatorId?.in && !where.creatorId.in.includes(item.creatorId)) return false;
        return true;
      }),
      findFirst: async ({ where }) => rows.find((item) => item.customOrderId === where.customOrderId && item.reviewStatus === where.reviewStatus && (!where.creatorId?.in || where.creatorId.in.includes(item.creatorId))) || null,
    },
    creatorMediaAsset: {
      findMany: async ({ where }) => assets.filter((asset) => !where?.OR || where.OR.some((group) => group.creatorId === asset.creatorId && group.mediaId.in.includes(asset.mediaId))),
    },
  };
  const member = { id: "chatter-1", agencyId: "agency-1", roleKey: "chatter", role: "OPERATOR", assignedCreators: "all", permissions: { "chats.reply": true } };
  return { db, member, row, order, assets };
}

test("approved finalized content becomes a compact READY_TO_DELIVER read model with due price", async () => {
  const { db, member } = fixture();
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.customOrderId, "custom-1");
  assert.equal(item.remainingAmountCents, 2000);
  assert.equal(item.deliveryPriceCents, 2000);
  assert.equal(item.freeDelivery, false);
  assert.equal(item.readyAt, "2026-08-22T08:00:00.000Z");
  assert.equal(item.vaultFolderId, "folder-77");
  assert.deepEqual(item.media.map((media) => media.mediaId), ["9001", "9002"]);
});

test("fully paid approved custom is prepared as FREE without storing another payment state", async () => {
  const { db, member, order } = fixture();
  order.paidAmountCents = 6000;
  const result = await getCustomReadyDelivery({ agencyId: "agency-1", member, customOrderId: "custom-1", db });
  assert.equal(result.item.deliveryPriceCents, 0);
  assert.equal(result.item.freeDelivery, true);
  assert.equal(result.item.paymentStatus, "PAID_IN_FULL");
});

test("delivery queue fails closed for partial Content Library finalization or delivered order", async () => {
  const { db, member, assets, order } = fixture();
  assets.pop();
  let result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.equal(result.items.length, 0);
  assets.push({ creatorId: "creator-1", mediaId: "9002", source: "CUSTOM", customOrderId: "custom-1", customFullPriceCents: 6000, mediaType: "video", thumbUrl: null, previewUrl: null, fullUrl: null, folderIds: [] });
  order.deliveredAt = new Date();
  result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.equal(result.items.length, 0);
});

test("ready delivery requires chats.reply and creator scope", async () => {
  const { db, member } = fixture();
  await assert.rejects(
    () => listCustomReadyDeliveries({ agencyId: "agency-1", member: { ...member, permissions: { "chats.reply": false } }, db }),
    (error) => error.code === "CUSTOM_DELIVERY_FORBIDDEN",
  );
  const scoped = { ...member, assignedCreators: ["creator-other"] };
  db.creatorAccount = { findMany: async () => [{ id: "creator-other" }] };
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member: scoped, db });
  assert.equal(result.items.length, 0);
});

test("ready queue pushes delivered/history filtering into Prisma instead of bounded post-filter scans", async () => {
  let capturedWhere = null;
  const db = {
    customContentSubmission: { findMany: async ({ where }) => { capturedWhere = where; return []; } },
    creatorMediaAsset: { findMany: async () => [] },
  };
  const member = { id: "chatter-1", agencyId: "agency-1", roleKey: "chatter", role: "OPERATOR", assignedCreators: "all", permissions: { "chats.reply": true } };
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.equal(result.items.length, 0);
  assert.deepEqual(capturedWhere.customOrder, { is: { type: "CONTENT", status: "PENDING", deliveredAt: null } });
  assert.deepEqual(capturedWhere.reviewedAt, { not: null });
});
