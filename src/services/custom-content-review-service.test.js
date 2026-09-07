"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { listCustomContentReviewQueue, reviewCustomContentSubmission } = require("./custom-content-review-service");
const { vaultSettlementFingerprint } = require("./custom-content-pipeline-authority-service");


function receipt(folderId, profileRevision, mediaIds, at = new Date("2026-08-21T14:30:00.000Z")) {
  return {
    vaultSettlementFolderId: folderId,
    vaultSettlementProfileRevision: profileRevision,
    vaultSettlementMediaFingerprint: vaultSettlementFingerprint({ folderId, profileRevision, mediaIds }),
    vaultSettlementConfirmedAt: at,
    vaultSettlementConfirmedByDeviceId: "device-1",
  };
}

function fixture() {
  const now = new Date("2026-08-21T14:30:00.000Z");
  const member = { id: "manager-1", userId: "user-1", agencyId: "agency-1", roleKey: "manager", role: "MANAGER", assignedCreators: "all", permissions: { "team.analytics.view": true, "content.review_customs": true } };
  const creator = { id: "creator-1", displayName: "Model One", username: "modelone", avatarUrl: null };
  const order = { id: "custom-1", creatorId: "creator-1", dialogId: "777", scenario: "Do the custom", internalNote: null, type: "CONTENT", contentKind: "VIDEO", status: "PENDING", fanDeliveredAt: null, priceCents: 6000, paidAmountCents: 4000, createdAt: now, creator };
  const row = { id: "sub-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1", pipelineDisposition: "ACTIVE", executionVaultFolderId: "vault-1", executionRelayRecipient: "relay_model", executionProfileRevision: 1, executionPinnedAt: now, ...receipt("vault-1", 1, ["9001", "9002"], now), telegramMessageIds: [101, 102], ofMediaIds: ["9001", "9002"], comment: "two versions", reviewStatus: "WAITING_REVIEW", reviewComment: null, reviewedByMemberId: null, reviewedAt: null, receivedAt: now, createdAt: now, updatedAt: now, creator, customOrder: order, reviewedByMember: null };
  const rows = [row];
  const assets = ["9001", "9002"].map((mediaId) => ({ agencyId: "agency-1", creatorId: "creator-1", mediaId, source: "CUSTOM", customOrderId: "custom-1", customSubmissionId: "sub-1", customFullPriceCents: 6000, mediaType: "video", thumbUrl: `https://cdn/${mediaId}.jpg`, previewUrl: null, fullUrl: null, folderIds: ["vault-1"], catalogActive: true, sortingStatus: "SORTED" }));
  const db = {
    customContentSubmission: {
      findMany: async ({ where, take = 999999, cursor = null, skip = 0, orderBy = [], select = null }) => {
        let found = rows.filter((item) => {
          if (where?.agencyId && item.agencyId !== where.agencyId) return false;
          if (where?.pipelineDisposition && String(item.pipelineDisposition || "ACTIVE") !== String(where.pipelineDisposition)) return false;
          if (where?.reviewStatus && item.reviewStatus !== where.reviewStatus) return false;
          if (where?.customOrderId?.in && !where.customOrderId.in.includes(item.customOrderId)) return false;
          if (where?.customOrderId?.not === null && item.customOrderId === null) return false;
          return true;
        });
        const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
        found.sort((a,b) => { for (const spec of specs) { const [key,dir] = Object.entries(spec || {})[0] || []; if (!key) continue; const av=a[key], bv=b[key]; const cmp=(av instanceof Date || bv instanceof Date) ? new Date(av||0)-new Date(bv||0) : String(av??"").localeCompare(String(bv??"")); if (cmp) return dir === "desc" ? -cmp : cmp; } return 0; });
        if (cursor?.id) { const index = found.findIndex((item) => item.id === cursor.id); if (index >= 0) found = found.slice(index + Math.max(1, skip)); }
        else if (skip) found = found.slice(skip);
        return found.slice(0, take).map((item) => {
          if (!select) return item;
          const picked = {}; for (const [key, enabled] of Object.entries(select)) if (enabled) picked[key] = item[key]; return picked;
        });
      },
      findFirst: async ({ where }) => rows.find((item) => item.id === where.id || (where.customOrderId === item.customOrderId && where.reviewStatus === item.reviewStatus && where.id?.not !== item.id)) || null,
      updateMany: async ({ where, data }) => {
        const item = rows.find((candidate) => candidate.id === where.id && candidate.reviewStatus === where.reviewStatus && candidate.updatedAt === where.updatedAt);
        if (!item) return { count: 0 };
        Object.assign(item, data, { updatedAt: new Date(item.updatedAt.getTime() + 1) });
        item.reviewedByMember = data.reviewedByMemberId ? { id: member.id, displayName: "Manager", roleKey: "manager" } : null;
        return { count: 1 };
      },
    },
    creatorMediaAsset: { findMany: async ({ where }) => assets.filter((asset) => {
      if (where?.agencyId && asset.agencyId && asset.agencyId !== where.agencyId) return false;
      if (Array.isArray(where?.OR) && !where.OR.some((group) => group.creatorId === asset.creatorId && group.mediaId?.in?.includes(asset.mediaId))) return false;
      return true;
    }) },
    auditLog: { create: async () => ({ id: "audit" }) },
    $queryRawUnsafe: async () => [{ id: order.id }],
    $transaction: async (work) => work(db),
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

test("legacy complete assets without a pinned execution profile remain outside manager review until Vault destination recovery converges", async () => {
  const { db, member, row } = fixture();
  row.executionPinnedAt = null;
  row.executionVaultFolderId = null;
  const result = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 50 });
  assert.deepEqual(result.items, []);
  await assert.rejects(
    () => reviewCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db }),
    (error) => error?.code === "CUSTOM_REVIEW_NOT_READY",
  );
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



test("commit-time review fence rejects APPROVE when cancellation wins the CustomOrder lock", async () => {
  const { db, member, row } = fixture();
  const originalRaw = db.$queryRawUnsafe;
  db.$queryRawUnsafe = async (...args) => {
    row.customOrder.status = "CANCELLED";
    return originalRaw(...args);
  };
  await assert.rejects(
    () => reviewCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db }),
    (error) => error?.code === "CUSTOM_REVIEW_ORDER_TERMINAL",
  );
  assert.equal(row.reviewStatus, "WAITING_REVIEW");
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


test("revision context remains exact beyond 500 historical versions", async () => {
  const { db, member, row, rows, assets } = fixture();
  const base = new Date("2026-01-01T00:00:00.000Z").getTime();
  rows.splice(0, rows.length);
  for (let i = 1; i <= 500; i += 1) {
    rows.push({
      ...row, id: `history-${String(i).padStart(4, "0")}`, telegramMessageIds: [i], ofMediaIds: [`8${String(i).padStart(4, "0")}`],
      reviewStatus: "REVISION_REQUESTED", reviewComment: `revision-${i}`, reviewedAt: new Date(base + i * 1000),
      receivedAt: new Date(base + i * 1000), createdAt: new Date(base + i * 1000), executionPinnedAt: new Date(base + i * 1000),
      reviewedByMember: { id: "manager-1", displayName: "Manager", roleKey: "manager" },
    });
  }
  const current = { ...row, id: "history-0501", telegramMessageIds: [501], ofMediaIds: ["9501"], receivedAt: new Date(base + 501000), createdAt: new Date(base + 501000), executionPinnedAt: new Date(base + 501000), ...receipt("vault-1", 1, ["9501"], new Date(base + 501000)) };
  rows.push(current);
  assets.splice(0, assets.length, { agencyId: "agency-1", creatorId: "creator-1", mediaId: "9501", source: "CUSTOM", customOrderId: "custom-1", customSubmissionId: "history-0501", customFullPriceCents: 6000, mediaType: "video", thumbUrl: null, previewUrl: null, fullUrl: null, folderIds: ["vault-1"], catalogActive: true, sortingStatus: "SORTED" });
  const result = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].submissionId, "history-0501");
  assert.equal(result.items[0].revisionNumber, 501);
  assert.equal(result.items[0].previousRevisionRequest.comment, "revision-500");
});

test("review queue reaches a valid row after more than 2000 poisoned WAITING rows", async () => {
  const { db, member, row, rows, assets } = fixture();
  const base = new Date("2026-02-01T00:00:00.000Z").getTime();
  rows.splice(0, rows.length); assets.splice(0, assets.length);
  for (let i = 0; i < 2000; i += 1) {
    const order = { ...row.customOrder, id: `poison-order-${i}`, dialogId: String(10000 + i) };
    rows.push({ ...row, id: `poison-${String(i).padStart(4, "0")}`, customOrderId: order.id, customOrder: order, telegramMessageIds: [i + 1], ofMediaIds: [`7${10000 + i}`], executionPinnedAt: null, executionVaultFolderId: null, receivedAt: new Date(base + i), createdAt: new Date(base + i) });
  }
  const readyOrder = { ...row.customOrder, id: "reachable-order", dialogId: "99999" };
  rows.push({ ...row, id: "reachable-review", customOrderId: readyOrder.id, customOrder: readyOrder, telegramMessageIds: [999999], ofMediaIds: ["999999"], executionPinnedAt: new Date(base + 3000), executionVaultFolderId: "vault-1", ...receipt("vault-1", 1, ["999999"], new Date(base + 3000)), receivedAt: new Date(base + 3000), createdAt: new Date(base + 3000) });
  assets.push({ agencyId: "agency-1", creatorId: "creator-1", mediaId: "999999", source: "CUSTOM", customOrderId: "reachable-order", customSubmissionId: "reachable-review", customFullPriceCents: 6000, mediaType: "video", thumbUrl: null, previewUrl: null, fullUrl: null, folderIds: ["vault-1"], catalogActive: true, sortingStatus: "SORTED" });
  const result = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 1 });
  assert.deepEqual(result.items.map((item) => item.submissionId), ["reachable-review"]);
});

test("Review fails closed when a current-receipt CUSTOM asset loses the pinned folder projection", async () => {
  const { db, member, assets } = fixture();
  assets[0].folderIds = [];
  assets[0].sortingStatus = "UNSORTED";
  const result = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 50 });
  assert.deepEqual(result.items, []);
  await assert.rejects(
    () => reviewCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db }),
    (error) => error?.code === "CUSTOM_REVIEW_NOT_READY",
  );
});

test("V20.9 review queue refuses Content Library assets belonging to another submission version", async () => {
  const { db, member, assets } = fixture();
  assets[1].customSubmissionId = "sub-v1-rejected";
  const result = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 50 });
  assert.deepEqual(result.items, []);
});

test("review queue exposes lossless cursor continuation beyond the first UI page", async () => {
  const { db, member, row, rows, assets } = fixture();
  rows.splice(0, rows.length); assets.splice(0, assets.length);
  const base = new Date("2026-03-01T00:00:00.000Z").getTime();
  for (let i = 0; i < 120; i += 1) {
    const id = `review-page-${String(i).padStart(3, "0")}`;
    const orderId = `order-page-${String(i).padStart(3, "0")}`;
    const mediaId = `media-page-${String(i).padStart(3, "0")}`;
    const stamp = new Date(base + i * 1000);
    const customOrder = { ...row.customOrder, id: orderId, dialogId: String(50000 + i) };
    rows.push({
      ...row, id, customOrderId: orderId, customOrder, telegramMessageIds: [i + 1], ofMediaIds: [mediaId],
      receivedAt: stamp, createdAt: stamp, executionPinnedAt: stamp, ...receipt("vault-1", 1, [mediaId], stamp),
    });
    assets.push({ agencyId: "agency-1", creatorId: "creator-1", mediaId, source: "CUSTOM", customOrderId: orderId, customSubmissionId: id, customFullPriceCents: 6000, mediaType: "video", thumbUrl: null, previewUrl: null, fullUrl: null, folderIds: ["vault-1"], catalogActive: true, sortingStatus: "SORTED" });
  }
  const first = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 50 });
  assert.equal(first.items.length, 50);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 50, cursor: first.nextCursor });
  assert.equal(second.items.length, 50);
  assert.equal(second.hasMore, true);
  const third = await listCustomContentReviewQueue({ agencyId: "agency-1", member, db, limit: 50, cursor: second.nextCursor });
  assert.equal(third.items.length, 20);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);
  const all = [...first.items, ...second.items, ...third.items].map((item) => item.submissionId);
  assert.equal(new Set(all).size, 120);
  assert.equal(all[119], "review-page-119");
});
