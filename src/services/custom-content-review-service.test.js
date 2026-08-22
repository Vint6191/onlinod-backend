"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { listCustomContentReviewQueue, reviewCustomContentSubmission } = require("./custom-content-review-service");

function fixture() {
  const now = new Date("2026-08-21T14:30:00.000Z");
  const member = { id: "manager-1", userId: "user-1", agencyId: "agency-1", roleKey: "manager", role: "MANAGER", assignedCreators: "all", permissions: { "team.analytics.view": true, "content.review_customs": true } };
  const creator = { id: "creator-1", displayName: "Model One", username: "modelone", avatarUrl: null };
  const order = { id: "custom-1", creatorId: "creator-1", dialogId: "777", scenario: "Do the custom", internalNote: null, type: "CONTENT", contentKind: "VIDEO", priceCents: 6000, paidAmountCents: 4000, createdAt: now, creator };
  const row = { id: "sub-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [101, 102], ofMediaIds: ["9001", "9002"], comment: "two versions", reviewStatus: "WAITING_REVIEW", reviewComment: null, reviewedByMemberId: null, reviewedAt: null, receivedAt: now, createdAt: now, updatedAt: now, creator, customOrder: order, reviewedByMember: null };
  const rows = [row];
  const assets = ["9001", "9002"].map((mediaId) => ({ creatorId: "creator-1", mediaId, source: "CUSTOM", customOrderId: "custom-1", customSubmissionId: "sub-1", customFullPriceCents: 6000, mediaType: "video", thumbUrl: `https://cdn/${mediaId}.jpg`, previewUrl: null, fullUrl: null }));
  const db = {
    customContentSubmission: {
      findMany: async ({ where }) => rows.filter((item) => {
        if (where?.reviewStatus && item.reviewStatus !== where.reviewStatus) return false;
        if (where?.customOrderId?.in && !where.customOrderId.in.includes(item.customOrderId)) return false;
        if (where?.customOrderId?.not === null && item.customOrderId === null) return false;
        return true;
      }),
      findFirst: async ({ where }) => rows.find((item) => item.id === where.id || (where.customOrderId === item.customOrderId && where.reviewStatus === item.reviewStatus && where.id?.not !== item.id)) || null,
      updateMany: async ({ where, data }) => {
        const item = rows.find((candidate) => candidate.id === where.id && candidate.reviewStatus === where.reviewStatus && candidate.updatedAt === where.updatedAt);
        if (!item) return { count: 0 };
        Object.assign(item, data, { updatedAt: new Date(item.updatedAt.getTime() + 1) });
        item.reviewedByMember = data.reviewedByMemberId ? { id: member.id, displayName: "Manager", roleKey: "manager" } : null;
        return { count: 1 };
      },
    },
    creatorMediaAsset: { findMany: async () => assets },
    auditLog: { create: async () => ({ id: "audit" }) },
  };
  return { db, member, row, rows, assets };
}

test("manager review queue exposes only finalized custom facts and full payment context", async () => {
  const { db, member } = fixture();
  const result = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.canReview, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].totalPriceCents, 6000);
  assert.equal(result.items[0].paidAmountCents, 4000);
  assert.equal(result.items[0].remainingAmountCents, 2000);
  assert.deepEqual(result.items[0].media.map((item) => item.mediaId), ["9001", "9002"]);
});

test("revision request requires a non-empty manager comment", async () => {
  const { db, member } = fixture();
  await assert.rejects(() => reviewCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "sub-1", action: "REQUEST_REVISION", comment: "   ", db }), (error) => error.code === "CUSTOM_REVIEW_COMMENT_REQUIRED");
});

test("approve is final and persists reviewer without mutating the custom order", async () => {
  const { db, member, row } = fixture();
  const result = await reviewCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db });
  assert.equal(result.ok, true);
  assert.equal(result.item.reviewStatus, "APPROVED");
  assert.equal(row.reviewedByMemberId, "manager-1");
  assert.ok(row.reviewedAt instanceof Date);
  await assert.rejects(() => reviewCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "sub-1", action: "REQUEST_REVISION", comment: "change it", db }), (error) => error.code === "CUSTOM_REVIEW_APPROVAL_FINAL");
});

test("revision decision is immutable and stores the exact manager instruction", async () => {
  const { db, member, row } = fixture();
  const result = await reviewCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "sub-1", action: "REQUEST_REVISION", comment: "Need another angle", db });
  assert.equal(result.item.reviewStatus, "REVISION_REQUESTED");
  assert.equal(row.reviewComment, "Need another angle");
  await assert.rejects(() => reviewCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db }), (error) => error.code === "CUSTOM_REVIEW_ALREADY_DECIDED");
});


test("V20.5 migration keeps review typed and enforces one approved version per custom", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  assert.match(schema, /enum CustomContentReviewStatus[\s\S]*WAITING_REVIEW[\s\S]*REVISION_REQUESTED[\s\S]*APPROVED/);
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260821143000_custom_content_manager_review/migration.sql"), "utf8");
  assert.match(migration, /CREATE TYPE "CustomContentReviewStatus"/);
  assert.match(migration, /one_approved_per_order_key/);
  assert.match(migration, /WHERE "reviewStatus" = 'APPROVED'/);
});

test("review queue derives revision version and previous manager instruction without schema fields", async () => {
  const { db, member, row, rows } = fixture();
  row.receivedAt = new Date("2026-08-21T14:00:00.000Z");
  row.createdAt = new Date("2026-08-21T14:00:00.000Z");
  rows.unshift({
    ...row,
    id: "sub-v1",
    telegramMessageIds: [90],
    ofMediaIds: ["8999"],
    reviewStatus: "REVISION_REQUESTED",
    reviewComment: "Need another angle",
    reviewedAt: new Date("2026-08-21T13:00:00.000Z"),
    receivedAt: new Date("2026-08-21T12:00:00.000Z"),
    createdAt: new Date("2026-08-21T12:00:00.000Z"),
    reviewedByMember: { id: "manager-1", displayName: "Manager", roleKey: "manager" },
  });
  const result = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 50 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].revisionNumber, 2);
  assert.equal(result.items[0].previousRevisionRequest.comment, "Need another angle");
  assert.equal(result.items[0].previousRevisionRequest.reviewedBy.name, "Manager");
});


test("V20.9 review queue refuses Content Library assets belonging to another submission version", async () => {
  const { db, member, assets } = fixture();
  assets[1].customSubmissionId = "sub-v1-rejected";
  const result = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 50 });
  assert.deepEqual(result.items, []);
});
