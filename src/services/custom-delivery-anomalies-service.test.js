"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listCustomDeliveryAnomalies } = require("./custom-delivery-anomalies-service");

function fixture() {
  const creator = { id: "creator-1", displayName: "Model One", username: "modelone", avatarUrl: null, customsVaultFolderId: "folder-1" };
  const order = {
    id: "custom-1", creatorId: "creator-1", dialogId: "777", scenario: "Custom scenario", internalNote: null,
    type: "CONTENT", contentKind: "VIDEO", status: "PENDING", deliveredAt: new Date("2026-08-21T08:00:00Z"), fanDeliveredAt: null,
    deliverySentMediaIds: ["9001"], deliveryMessageIds: ["msg-1"], deliveryOfferedCents: 1000,
    priceCents: 6000, paidAmountCents: 4000, createdAt: new Date("2026-08-21T07:00:00Z"), creator,
  };
  const submission = {
    id: "sub-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1",
    telegramMessageIds: [101, 102], ofMediaIds: ["9001", "9002"], reviewStatus: "APPROVED",
    reviewedAt: new Date("2026-08-22T08:00:00Z"), creator, customOrder: order,
  };
  const assets = ["9001", "9002"].map((mediaId) => ({
    creatorId: "creator-1", mediaId, source: "CUSTOM", customOrderId: "custom-1", customFullPriceCents: 6000,
    mediaType: "video", thumbUrl: null, previewUrl: null, fullUrl: null, folderIds: ["folder-1"],
  }));
  const audits = [
    { id: "a3", actorUserId: "user-1", action: "CUSTOM_DELIVERY_DUPLICATE_ATTEMPT", targetId: "custom-1", createdAt: new Date("2026-08-22T10:40:00Z"), metadata: { creatorId: "creator-1", dialogId: "777", messageId: "msg-3", duplicateMediaIds: ["9001"], expectedPriceCents: 0, actualPriceCents: 0, totalPriceCents: 6000, paidAmountCents: 6000, remainingAmountCents: 0 } },
    { id: "a2", actorUserId: "user-1", action: "CUSTOM_PAYMENT_UNDERCHARGE", targetId: "custom-1", createdAt: new Date("2026-08-22T10:30:00Z"), metadata: { creatorId: "creator-1", dialogId: "777", messageId: "msg-2", expectedPriceCents: 2000, actualPriceCents: 1500, shortfallCents: 500, totalPriceCents: 6000, paidAmountCents: 4000, remainingAmountCents: 2000 } },
    { id: "a1", actorUserId: "user-1", action: "CUSTOM_PAYMENT_OVERRIDE", targetId: "custom-1", createdAt: new Date("2026-08-22T10:20:00Z"), metadata: { creatorId: "creator-1", dialogId: "777", messageId: "msg-1", expectedPriceCents: 0, actualPriceCents: 3000, reason: "extra paid version", totalPriceCents: 6000, paidAmountCents: 6000, remainingAmountCents: 0 } },
  ];
  const db = {
    customContentSubmission: {
      findMany: async ({ where }) => {
        if (where?.creatorId?.in && !where.creatorId.in.includes(submission.creatorId)) return [];
        const lte = where?.reviewedAt?.lte ? new Date(where.reviewedAt.lte).getTime() : Infinity;
        return submission.reviewedAt.getTime() <= lte ? [submission] : [];
      },
    },
    creatorMediaAsset: { findMany: async () => assets },
    auditLog: {
      findMany: async ({ where }) => audits.filter((row) => {
        if (where?.action?.in && !where.action.in.includes(row.action)) return false;
        if (where?.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
        if (where?.createdAt?.lte && row.createdAt > where.createdAt.lte) return false;
        return true;
      }).sort((a, b) => b.createdAt - a.createdAt),
    },
    agencyMember: { findMany: async () => [{ id: "member-1", userId: "user-1", displayName: "Alex", roleKey: "chatter", user: { name: "Alex", email: "a@test" } }] },
    creatorAccount: { findMany: async () => [creator] },
  };
  return { db, order, submission, audits };
}

test("live overdue is derived from approved readyAt after two hours and keeps partial delivery progress", async () => {
  const { db } = fixture();
  const result = await listCustomDeliveryAnomalies({ agencyId: "agency-1", rangeKey: "24h", now: new Date("2026-08-22T10:15:00Z"), db });
  assert.equal(result.overdueThresholdSeconds, 7200);
  assert.equal(result.overdue.length, 1);
  assert.equal(result.overdue[0].customOrderId, "custom-1");
  assert.equal(result.overdue[0].overdueForSeconds, 900);
  assert.equal(result.overdue[0].approvedMediaCount, 2);
  assert.equal(result.overdue[0].deliveredMediaCount, 1);
  assert.equal(result.summary.overdueDeliveries, 1);
});

test("custom management signals reuse AuditLog and summarize fully-paid PPV override without another event table", async () => {
  const { db } = fixture();
  const result = await listCustomDeliveryAnomalies({ agencyId: "agency-1", rangeKey: "24h", now: new Date("2026-08-22T11:00:00Z"), db });
  assert.equal(result.summary.paymentOverrides, 1);
  assert.equal(result.summary.undercharges, 1);
  assert.equal(result.summary.duplicateAttempts, 1);
  assert.equal(result.summary.fullyPaidSentAsPpv, 1);
  assert.equal(result.events.length, 3);
  const override = result.events.find((row) => row.type === "CUSTOM_PAYMENT_OVERRIDE");
  assert.equal(override.actor.name, "Alex");
  assert.equal(override.expectedPriceCents, 0);
  assert.equal(override.actualPriceCents, 3000);
  assert.equal(override.reason, "extra paid version");
});

test("creator scope hides both current overdue state and historical anomaly signals", async () => {
  const { db } = fixture();
  const result = await listCustomDeliveryAnomalies({ agencyId: "agency-1", allowedCreatorIds: ["creator-other"], rangeKey: "24h", now: new Date("2026-08-22T11:00:00Z"), db });
  assert.equal(result.overdue.length, 0);
  assert.equal(result.events.length, 0);
  assert.deepEqual(result.summary, { overdueDeliveries: 0, paymentOverrides: 0, undercharges: 0, duplicateAttempts: 0, fullyPaidSentAsPpv: 0 });
});
