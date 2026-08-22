"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assignUnassignedCustomContentSubmission,
  listAwaitingCustomRevisions,
  listCustomSubmissionAssignmentCandidates,
  listUnassignedCustomContentSubmissions,
} = require("./custom-content-workflow-service");

const manager = { id: "manager-1", userId: "user-1", agencyId: "agency-1", roleKey: "manager", role: "MANAGER", assignedCreators: "all", permissions: { "team.analytics.view": true, "content.review_customs": true } };
const viewer = { ...manager, id: "viewer-1", permissions: { "team.analytics.view": true, "content.review_customs": false } };
const creator = { id: "creator-1", agencyId: "agency-1", displayName: "Model One", username: "modelone", avatarUrl: null, deletedAt: null };
const now = new Date("2026-08-22T12:00:00.000Z");

function submission(overrides = {}) {
  return {
    id: "sub-unassigned", agencyId: "agency-1", creatorId: "creator-1", customOrderId: null,
    telegramMessageIds: [101, 102], ofMediaIds: ["9001"], comment: "second angle",
    reviewStatus: "WAITING_REVIEW", reviewComment: null, reviewedAt: null, reviewedByMemberId: null,
    receivedAt: new Date("2026-08-22T11:00:00.000Z"), createdAt: new Date("2026-08-22T11:00:00.000Z"), updatedAt: new Date("2026-08-22T11:00:00.000Z"),
    creator, reviewedByMember: null,
    ...overrides,
  };
}
function order(id, overrides = {}) {
  return {
    id, agencyId: "agency-1", creatorId: "creator-1", dialogId: id.replace(/\D/g, "") || "777", scenario: `Scenario ${id}`,
    type: "CONTENT", contentKind: "VIDEO", status: "PENDING", fanDeliveredAt: null,
    priceCents: 6000, paidAmountCents: 2000, dueAt: null, createdAt: new Date("2026-08-22T10:00:00.000Z"),
    creator,
    ...overrides,
  };
}
function fakeDb({ submissions = [], orders = [], assets = [] } = {}) {
  return {
    creatorAccount: {
      findFirst: async ({ where }) => where.id === creator.id && where.agencyId === creator.agencyId ? creator : null,
      findMany: async () => [creator],
    },
    customContentSubmission: {
      findMany: async ({ where, take = 9999 }) => submissions.filter((row) => {
        if (where?.agencyId && row.agencyId !== where.agencyId) return false;
        if (where?.creatorId && typeof where.creatorId === "string" && row.creatorId !== where.creatorId) return false;
        if (where?.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
        if (where?.customOrderId === null && row.customOrderId !== null) return false;
        if (where?.customOrderId?.not === null && row.customOrderId === null) return false;
        if (where?.customOrderId?.in && !where.customOrderId.in.includes(row.customOrderId)) return false;
        if (where?.reviewStatus && row.reviewStatus !== where.reviewStatus) return false;
        return true;
      }).sort((a,b) => new Date(a.receivedAt)-new Date(b.receivedAt) || String(a.id).localeCompare(String(b.id))).slice(0, take).map((row) => ({ ...row, creator: row.creator || creator, customOrder: row.customOrder || orders.find((o) => o.id === row.customOrderId) || null })),
      findFirst: async ({ where }) => submissions.find((row) => {
        if (where.id && row.id !== where.id) return false;
        if (where.agencyId && row.agencyId !== where.agencyId) return false;
        return true;
      }) || null,
      count: async ({ where }) => submissions.filter((row) => where.customOrderId === null ? row.customOrderId === null : true).length,
      update: async ({ where, data }) => {
        const row = submissions.find((item) => item.id === where.id);
        if (!row) throw new Error("missing submission");
        Object.assign(row, data, { updatedAt: new Date(now) });
        return row;
      },
    },
    customOrder: {
      findMany: async ({ where, take = 9999 }) => orders.filter((row) => {
        if (where.agencyId && row.agencyId !== where.agencyId) return false;
        if (where.creatorId && row.creatorId !== where.creatorId) return false;
        if (where.type && row.type !== where.type) return false;
        if (where.status && row.status !== where.status) return false;
        if (where.fanDeliveredAt === null && row.fanDeliveredAt !== null) return false;
        return true;
      }).slice(0, take),
      findFirst: async ({ where }) => orders.find((row) => row.id === where.id && row.agencyId === where.agencyId && row.creatorId === where.creatorId) || null,
    },
    creatorMediaAsset: {
      findMany: async ({ where }) => assets.filter((asset) => {
        if (where.agencyId && asset.agencyId !== where.agencyId) return false;
        if (where.source && asset.source !== where.source) return false;
        if (Array.isArray(where.OR) && !where.OR.some((group) => group.creatorId === asset.creatorId && group.mediaId.in.includes(asset.mediaId))) return false;
        return true;
      }),
    },
    auditLog: { create: async () => ({ id: "audit-1" }) },
  };
}

test("unassigned queue stays compact and reports real upload/library progress", async () => {
  const row = submission();
  const db = fakeDb({ submissions: [row], assets: [{ agencyId: "agency-1", creatorId: "creator-1", mediaId: "9001", source: "CUSTOM", customOrderId: null, customSubmissionId: "sub-unassigned", customFullPriceCents: null, mediaType: "video", thumbUrl: "https://cdn/9001.jpg", previewUrl: null, fullUrl: null }] });
  const result = await listUnassignedCustomContentSubmissions({ agencyId: "agency-1", member: manager, db });
  assert.equal(result.count, 1);
  assert.equal(result.canAssign, true);
  assert.equal(result.items[0].telegramMessageCount, 2);
  assert.equal(result.items[0].ofMediaCount, 1);
  assert.equal(result.items[0].uploadComplete, false);
  assert.equal(result.items[0].finalizedMediaCount, 1);
  assert.equal(result.items[0].media[0].mediaId, "9001");
});

test("manual assignment candidates are only first submission or explicit revision targets", async () => {
  const row = submission();
  const orders = [order("custom-new", { createdAt: new Date("2026-08-22T11:30:00Z") }), order("custom-revision"), order("custom-active"), order("custom-approved")];
  const submissions = [
    row,
    submission({ id: "rev-1", customOrderId: "custom-revision", telegramMessageIds: [201], reviewStatus: "REVISION_REQUESTED", reviewComment: "Need another angle", reviewedAt: new Date("2026-08-22T11:10:00Z"), receivedAt: new Date("2026-08-22T10:10:00Z") }),
    submission({ id: "active-1", customOrderId: "custom-active", telegramMessageIds: [301], reviewStatus: "WAITING_REVIEW", receivedAt: new Date("2026-08-22T10:20:00Z") }),
    submission({ id: "approved-1", customOrderId: "custom-approved", telegramMessageIds: [401], reviewStatus: "APPROVED", reviewedAt: new Date("2026-08-22T11:20:00Z"), receivedAt: new Date("2026-08-22T10:30:00Z") }),
  ];
  const db = fakeDb({ submissions, orders });
  const result = await listCustomSubmissionAssignmentCandidates({ agencyId: "agency-1", member: manager, submissionId: row.id, db });
  assert.deepEqual(result.items.map((item) => item.customOrderId), ["custom-revision", "custom-new"]);
  assert.equal(result.items[0].awaitingRevision, true);
  assert.equal(result.items[0].nextRevisionNumber, 2);
  assert.equal(result.items[0].lastRevisionComment, "Need another angle");
});

test("review permission gates manual unassigned assignment and safe target is enforced", async () => {
  const row = submission({ telegramMessageIds: [101], ofMediaIds: [] });
  const target = order("custom-new");
  const db = fakeDb({ submissions: [row], orders: [target] });
  await assert.rejects(() => assignUnassignedCustomContentSubmission({ agencyId: "agency-1", member: viewer, submissionId: row.id, customOrderId: target.id, db }), (error) => error.code === "CUSTOM_WORKFLOW_ASSIGN_FORBIDDEN");
  const result = await assignUnassignedCustomContentSubmission({ agencyId: "agency-1", member: manager, submissionId: row.id, customOrderId: target.id, db });
  assert.equal(result.submission.customOrderId, target.id);
});

test("awaiting revision queue only keeps the latest rejected version per custom", async () => {
  const a = order("custom-a");
  const b = order("custom-b");
  const revA = submission({ id: "a-v1", customOrderId: a.id, reviewStatus: "REVISION_REQUESTED", reviewComment: "Redo ending", reviewedAt: new Date("2026-08-22T11:00:00Z"), receivedAt: new Date("2026-08-22T10:00:00Z"), customOrder: a, reviewedByMember: { id: "manager-1", displayName: "Manager", roleKey: "manager" } });
  const revB = submission({ id: "b-v1", customOrderId: b.id, reviewStatus: "REVISION_REQUESTED", reviewComment: "More light", reviewedAt: new Date("2026-08-22T10:30:00Z"), receivedAt: new Date("2026-08-22T09:00:00Z"), customOrder: b, reviewedByMember: { id: "manager-1", displayName: "Manager", roleKey: "manager" } });
  const newB = submission({ id: "b-v2", customOrderId: b.id, reviewStatus: "WAITING_REVIEW", receivedAt: new Date("2026-08-22T11:30:00Z"), customOrder: b });
  const db = fakeDb({ submissions: [revA, revB, newB], orders: [a, b] });
  const result = await listAwaitingCustomRevisions({ agencyId: "agency-1", member: manager, db });
  assert.deepEqual(result.items.map((item) => item.customOrderId), ["custom-a"]);
  assert.equal(result.items[0].revisionNumber, 1);
  assert.equal(result.items[0].nextRevisionNumber, 2);
  assert.equal(result.items[0].revisionComment, "Redo ending");
});

test("V20.9 keeps revision workflow derived and adds only exact typed asset→submission provenance", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const submissionBlock = schema.match(/model CustomContentSubmission \{[\s\S]*?\n\}/)?.[0] || "";
  for (const forbidden of ["revisionNumber", "previousRevision", "awaitingRevision", "assignmentStatus", "revisionDispatchedAt"]) assert.doesNotMatch(submissionBlock, new RegExp(forbidden));
  const assetBlock = schema.match(/model CreatorMediaAsset \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(assetBlock, /customSubmissionId\s+String\?/);
  assert.match(assetBlock, /customSubmission\s+CustomContentSubmission\?/);
  assert.match(assetBlock, /@@index\(\[customSubmissionId\]\)/);
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260822123500_custom_content_submission_asset_provenance/migration.sql"), "utf8");
  assert.match(migration, /ADD COLUMN "customSubmissionId" TEXT/);
  assert.match(migration, /REFERENCES "CustomContentSubmission"\("id"\)/);
  assert.doesNotMatch(migration, /revisionNumber|awaitingRevision|revisionDispatchedAt/);
});
