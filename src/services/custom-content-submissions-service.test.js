"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assignCustomContentSubmission,
  claimCustomContentSubmissionUploadWork,
  commitCustomContentSubmissionMedia,
  createCustomContentSubmission,
  deterministicSubmissionId,
  listCustomContentSubmissions,
  sameMessageIds,
  telegramMessageIds,
} = require("./custom-content-submissions-service");

function clone(value) { return value == null ? value : structuredClone(value); }

function fakeDb(seed = {}) {
  const creators = (seed.creators || [
    { id: "creator-1", agencyId: "agency-1", deletedAt: null, displayName: "Model A", username: "a", status: "READY", telegramContact: "@model_a", telegramAccountId: "tg-1", customsVaultFolderId: "vault-1" },
    { id: "creator-2", agencyId: "agency-1", deletedAt: null, displayName: "Model B", username: "b", status: "READY", telegramContact: "@model_b", telegramAccountId: "tg-1", customsVaultFolderId: "vault-2" },
  ]).map(clone);
  const orders = (seed.orders || [
    { id: "custom-1", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", scenario: "custom one", priceCents: 6000 },
    { id: "call-1", agencyId: "agency-1", creatorId: "creator-1", type: "CALL", scenario: "call one", priceCents: 1000 },
    { id: "custom-2", agencyId: "agency-1", creatorId: "creator-2", type: "CONTENT", scenario: "custom two", priceCents: 7000 },
  ]).map(clone);
  const submissions = (seed.submissions || []).map(clone);
  const mediaAssets = (seed.mediaAssets || []).map(clone);
  const telegramAccounts = (seed.telegramAccounts || [
    { id: "tg-1", agencyId: "agency-1", runtimeClaimedByDeviceId: "device-1", runtimeClaimToken: "lease-1", runtimeClaimUntil: new Date("2026-08-21T14:00:00.000Z") },
  ]).map(clone);
  const workspaceSettings = new Map(Object.entries(seed.workspaceSettings || { vaultUploadRecipient: "relay_model" }));
  const audits = [];
  let seq = submissions.length;

  function matchesSubmission(row, where = {}) {
    if (where.id !== undefined) {
      if (where.id && typeof where.id === "object") {
        if (Array.isArray(where.id.in) && !where.id.in.includes(row.id)) return false;
        if (where.id.not !== undefined && row.id === where.id.not) return false;
      } else if (row.id !== where.id) return false;
    }
    if (where.agencyId !== undefined && row.agencyId !== where.agencyId) return false;
    if (where.creatorId !== undefined) {
      if (where.creatorId && typeof where.creatorId === "object" && Array.isArray(where.creatorId.in)) {
        if (!where.creatorId.in.includes(row.creatorId)) return false;
      } else if (row.creatorId !== where.creatorId) return false;
    }
    if (where.customOrderId !== undefined && row.customOrderId !== where.customOrderId) return false;
    if (where.reviewStatus !== undefined && String(row.reviewStatus || "WAITING_REVIEW") !== String(where.reviewStatus)) return false;
    if (where.telegramMessageIds?.hasSome) {
      const ids = new Set((row.telegramMessageIds || []).map(Number));
      if (!where.telegramMessageIds.hasSome.some((id) => ids.has(Number(id)))) return false;
    }
    return true;
  }

  return {
    _submissions: submissions,
    _mediaAssets: mediaAssets,
    _audits: audits,
    creatorAccount: {
      async findFirst({ where }) {
        const row = creators.find((candidate) => candidate.agencyId === where.agencyId && candidate.id === where.id && !candidate.deletedAt);
        return clone(row || null);
      },
      async findMany({ where, take = 10000 }) {
        return creators.filter((candidate) => {
          if (candidate.agencyId !== where.agencyId || candidate.deletedAt) return false;
          if (where.id?.in && !where.id.in.includes(candidate.id)) return false;
          if (where.telegramContact?.not === null && !candidate.telegramContact) return false;
          if (where.customsVaultFolderId?.not === null && !candidate.customsVaultFolderId) return false;
          if (where.telegramAccountId?.in && !where.telegramAccountId.in.includes(candidate.telegramAccountId)) return false;
          return true;
        }).slice(0, take).map(clone);
      },
    },
    agencyTelegramMtprotoAccount: {
      async findMany({ where, take = 100 }) {
        return telegramAccounts.filter((row) => {
          if (row.agencyId !== where.agencyId) return false;
          if (where.id?.in && !where.id.in.includes(row.id)) return false;
          if (where.runtimeClaimedByDeviceId !== undefined && row.runtimeClaimedByDeviceId !== where.runtimeClaimedByDeviceId) return false;
          if (where.runtimeClaimUntil?.gt && !(new Date(row.runtimeClaimUntil).getTime() > new Date(where.runtimeClaimUntil.gt).getTime())) return false;
          return true;
        }).slice(0, take).map(clone);
      },
    },
    workspaceSetting: {
      async findUnique({ where }) {
        const key = where.agencyId_key?.key;
        if (!workspaceSettings.has(key)) return null;
        return { value: workspaceSettings.get(key) };
      },
    },
    customOrder: {
      async findFirst({ where }) {
        const row = orders.find((candidate) => candidate.id === where.id && candidate.agencyId === where.agencyId && candidate.creatorId === where.creatorId);
        return clone(row || null);
      },
    },
    customContentSubmission: {
      async findFirst({ where, orderBy = [] }) {
        const matches = submissions.filter((row) => matchesSubmission(row, where));
        if (Array.isArray(orderBy) && orderBy[0]?.receivedAt === "desc") {
          matches.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt) || new Date(b.createdAt) - new Date(a.createdAt) || String(b.id).localeCompare(String(a.id)));
        }
        return clone(matches[0] || null);
      },
      async create({ data }) {
        const stamp = new Date(`2026-08-21T12:${String(seq).padStart(2, "0")}:00.000Z`);
        const row = { id: `submission-${++seq}`, ...clone(data), createdAt: stamp, updatedAt: stamp };
        submissions.push(row);
        return clone(row);
      },
      async update({ where, data }) {
        const row = submissions.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, clone(data), { updatedAt: new Date("2026-08-21T13:00:00.000Z") });
        return clone(row);
      },
      async findMany({ where, take = 100, skip = 0, orderBy = [] }) {
        const direction = Array.isArray(orderBy) && orderBy[0]?.receivedAt === "asc" ? 1 : -1;
        return submissions.filter((row) => matchesSubmission(row, where))
          .sort((a, b) => direction * (new Date(a.receivedAt) - new Date(b.receivedAt)))
          .slice(skip, skip + take).map(clone);
      },
      async count({ where }) { return submissions.filter((row) => matchesSubmission(row, where)).length; },
      async updateMany({ where, data }) {
        const row = submissions.find((candidate) => candidate.id === where.id && candidate.agencyId === where.agencyId && (!where.updatedAt || new Date(candidate.updatedAt).getTime() === new Date(where.updatedAt).getTime()));
        if (!row) return { count: 0 };
        Object.assign(row, clone(data), { updatedAt: new Date(new Date(row.updatedAt).getTime() + 1000) });
        return { count: 1 };
      },
    },
    creatorMediaAsset: {
      async findMany({ where, take = 100 }) {
        return mediaAssets.filter((row) => {
          if (where.agencyId !== undefined && row.agencyId !== where.agencyId) return false;
          if (where.creatorId !== undefined && row.creatorId !== where.creatorId) return false;
          if (where.mediaId?.in && !where.mediaId.in.includes(row.mediaId)) return false;
          if (where.source !== undefined && row.source !== where.source) return false;
          return true;
        }).slice(0, take).map(clone);
      },
      async createMany({ data, skipDuplicates }) {
        let count = 0;
        for (const item of data) {
          if (skipDuplicates && mediaAssets.some((row) => row.creatorId === item.creatorId && row.mediaId === item.mediaId)) continue;
          mediaAssets.push({ ...clone(item), metadataUpdatedAt: null, folderIds: item.folderIds || [], createdAt: new Date(), updatedAt: new Date() });
          count += 1;
        }
        return { count };
      },
      async update({ where, data }) {
        const row = mediaAssets.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("asset not found");
        Object.assign(row, clone(data));
        return clone(row);
      },
    },
    auditLog: { async create({ data }) { audits.push(clone(data)); return { id: `audit-${audits.length}`, ...clone(data) }; } },
  };
}

const member = { id: "member-1", userId: "user-1", roleKey: "chatter", role: "OPERATOR", assignedCreators: ["creator-1"] };

test("Prisma submission ledger stays deliberately compact", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const match = schema.match(/model CustomContentSubmission \{([\s\S]*?)\n\}/);
  assert.ok(match, "CustomContentSubmission model must exist");
  const block = match[1];
  for (const required of ["agencyId", "creatorId", "customOrderId", "telegramMessageIds", "ofMediaIds", "comment", "reviewStatus", "reviewComment", "reviewedByMemberId", "reviewedAt", "receivedAt", "createdAt", "updatedAt"]) {
    assert.match(block, new RegExp(`\\b${required}\\b`));
  }
  for (const forbidden of ["uploadStatus", "assignmentStatus", "deviceId", "endpoint", "peerId", "fileName", "mimeType", "sizeBytes", "attemptCount", "lastError"]) {
    assert.doesNotMatch(block, new RegExp(`\\b${forbidden}\\b`, "i"), `do not persist ${forbidden} on the compact ledger`);
  }
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260821115000_custom_content_submission_ledger/migration.sql"), "utf8");
  assert.match(migration, /CREATE TABLE "CustomContentSubmission"/);
  assert.match(migration, /"telegramMessageIds" INTEGER\[\]/);
  assert.match(migration, /"ofMediaIds" TEXT\[\]/);
});

function baseSubmission(overrides = {}) {
  return {
    id: "submission-existing",
    agencyId: "agency-1",
    creatorId: "creator-1",
    customOrderId: "custom-1",
    telegramMessageIds: [101, 102],
    ofMediaIds: [],
    comment: "first",
    receivedAt: new Date("2026-08-21T10:00:00.000Z"),
    createdAt: new Date("2026-08-21T10:00:00.000Z"),
    updatedAt: new Date("2026-08-21T10:00:00.000Z"),
    ...overrides,
  };
}

test("submission message ids are compact, positive, de-duplicated facts", () => {
  assert.deepEqual(telegramMessageIds([101, "102", 101]), [101, 102]);
  assert.equal(sameMessageIds([102, 101], [101, 102, 102]), true);
  assert.throws(() => telegramMessageIds([]), /at least one/i);
  assert.throws(() => telegramMessageIds([0]), /positive/i);
  assert.equal(
    deterministicSubmissionId("agency-1", "creator-1", [102, 101]),
    deterministicSubmissionId("agency-1", "creator-1", [101, 102, 101]),
    "the row id itself is the compact exact-retry fence",
  );
  assert.notEqual(
    deterministicSubmissionId("agency-1", "creator-1", [101]),
    deterministicSubmissionId("agency-1", "creator-2", [101]),
  );
});

test("create stores one compact submission row and exact retries are idempotent", async () => {
  const db = fakeDb();
  const first = await createCustomContentSubmission({
    agencyId: "agency-1", member, db,
    input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [501, 502, 501], comment: "  second angle  ", receivedAt: "2026-08-21T11:00:00.000Z" },
  });
  assert.equal(first.deduped, false);
  assert.deepEqual(first.submission.telegramMessageIds, ["501", "502"]);
  assert.deepEqual(first.submission.ofMediaIds, []);
  assert.equal(first.submission.comment, "second angle");
  assert.equal(db._submissions.length, 1);

  const retry = await createCustomContentSubmission({
    agencyId: "agency-1", member, db,
    input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [502, 501], comment: "ignored retry text" },
  });
  assert.equal(retry.deduped, true);
  assert.equal(retry.submission.id, first.submission.id);
  assert.equal(db._submissions.length, 1);
  assert.equal(db._audits.length, 1, "idempotent retries do not create audit noise");
});

test("partial Telegram overlap is rejected instead of silently duplicating media", async () => {
  const db = fakeDb({ submissions: [baseSubmission()] });
  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member, db, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [102, 103] } }),
    (error) => error?.code === "CUSTOM_SUBMISSION_TELEGRAM_MESSAGE_CONFLICT" && error?.status === 409,
  );
});

test("submission may stay unassigned and can later be assigned only to CONTENT of same creator", async () => {
  const db = fakeDb({ submissions: [baseSubmission({ customOrderId: null })] });
  const assigned = await assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: "custom-1", db });
  assert.equal(assigned.unchanged, false);
  assert.equal(assigned.submission.customOrderId, "custom-1");

  await assert.rejects(
    () => assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: "call-1", db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ORDER_TYPE_INVALID" && error?.status === 409,
  );
  await assert.rejects(
    () => assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: "custom-2", db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ORDER_NOT_FOUND" && error?.status === 404,
  );

  const unassigned = await assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: null, db });
  assert.equal(unassigned.submission.customOrderId, null);
});


test("reviewed submissions cannot be reassigned after a manager decision", async () => {
  const db = fakeDb({ submissions: [baseSubmission({ reviewStatus: "APPROVED", reviewedByMemberId: "manager-1", reviewedAt: new Date("2026-08-21T12:00:00.000Z") })] });
  await assert.rejects(
    () => assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: null, db }),
    (error) => error.code === "CUSTOM_SUBMISSION_REVIEW_LOCKED",
  );
});

test("list is creator-scoped and supports compact unassigned queue", async () => {
  const db = fakeDb({ submissions: [
    baseSubmission({ id: "a", customOrderId: null, receivedAt: new Date("2026-08-21T12:00:00.000Z") }),
    baseSubmission({ id: "b", customOrderId: "custom-1", telegramMessageIds: [201], receivedAt: new Date("2026-08-21T11:00:00.000Z") }),
    baseSubmission({ id: "c", creatorId: "creator-2", customOrderId: "custom-2", telegramMessageIds: [301], receivedAt: new Date("2026-08-21T10:00:00.000Z") }),
  ] });
  const result = await listCustomContentSubmissions({ agencyId: "agency-1", member, creatorId: "creator-1", unassigned: true, db });
  assert.equal(result.count, 1);
  assert.equal(result.items[0].id, "a");
  await assert.rejects(
    () => listCustomContentSubmissions({ agencyId: "agency-1", member, creatorId: "creator-2", db }),
    /do not have access/i,
  );
});

test("V20.3 upload work reuses the existing Telegram runtime lease and stores no upload claim fields", async () => {
  const db = fakeDb({ submissions: [
    baseSubmission({ id: "pending-a", telegramMessageIds: [501, 502], ofMediaIds: ["9001"], receivedAt: new Date("2026-08-21T09:00:00.000Z") }),
    baseSubmission({ id: "done", telegramMessageIds: [601], ofMediaIds: ["9101"], receivedAt: new Date("2026-08-21T08:00:00.000Z") }),
  ], mediaAssets: [{ id: "asset-done", agencyId: "agency-1", creatorId: "creator-1", mediaId: "9101", source: "CUSTOM", customOrderId: "custom-1", customSubmissionId: "done", customFullPriceCents: 6000, catalogActive: true, folderIds: ["vault-1"], sortingStatus: "SORTED", metadataUpdatedAt: null, description: "custom one", idealPriceCents: 6000, accessType: "paid" }] });
  const result = await claimCustomContentSubmissionUploadWork({
    agencyId: "agency-1",
    member,
    deviceId: "device-1",
    leases: [{ accountId: "tg-1", claimToken: "lease-1" }],
    limit: 2,
    now: new Date("2026-08-21T13:00:00.000Z"),
    db,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].submission.id, "pending-a");
  assert.equal(result.items[0].kind, "UPLOAD_MEDIA");
  assert.equal(result.items[0].expectedIndex, 1);
  assert.equal(result.items[0].telegramMessageId, "502");
  assert.equal(result.items[0].folderId, "vault-1");
  assert.equal(result.items[0].accountId, "tg-1");
  assert.equal(result.items[0].recipient, "relay_model");

  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const block = schema.match(/model CustomContentSubmission \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(block, /uploadClaim|claimUntil|claimedByDevice|uploadStatus/i);
});

test("V20.3 rejects stale runtime leases before exposing Telegram source work", async () => {
  const db = fakeDb({ submissions: [baseSubmission({ telegramMessageIds: [701], ofMediaIds: [] })] });
  const result = await claimCustomContentSubmissionUploadWork({
    agencyId: "agency-1",
    member,
    deviceId: "device-1",
    leases: [{ accountId: "tg-1", claimToken: "wrong-token" }],
    now: new Date("2026-08-21T13:00:00.000Z"),
    db,
  });
  assert.deepEqual(result.items, []);
});

test("V20.3 commits OF media ids strictly by Telegram position and exact retries are idempotent", async () => {
  const db = fakeDb({ submissions: [baseSubmission({ telegramMessageIds: [801, 802], ofMediaIds: [] })] });
  const first = await commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 0, mediaId: "99001", db });
  assert.equal(first.completed, false);
  assert.deepEqual(first.submission.ofMediaIds, ["99001"]);

  const retry = await commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 0, mediaId: "99001", db });
  assert.equal(retry.idempotent, true);

  await assert.rejects(
    () => commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 0, mediaId: "99002", db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_MEDIA_COMMIT_CONFLICT",
  );
  await assert.rejects(
    () => commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 2, mediaId: "99003", db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_MEDIA_INDEX_INVALID" || error?.code === "CUSTOM_SUBMISSION_MEDIA_COMMIT_OUT_OF_ORDER",
  );

  const second = await commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 1, mediaId: "99002", db });
  assert.equal(second.completed, true);
  assert.deepEqual(second.submission.ofMediaIds, ["99001", "99002"]);
  assert.equal(db._audits.filter((row) => row.action === "custom_content_submission.of_upload_complete").length, 1);
});


test("V20.4 returns complete-but-not-finalized submissions as move-only library recovery work", async () => {
  const db = fakeDb({ submissions: [
    baseSubmission({ id: "crash-window", telegramMessageIds: [901, 902], ofMediaIds: ["99001", "99002"] }),
  ] });
  const result = await claimCustomContentSubmissionUploadWork({
    agencyId: "agency-1",
    member,
    deviceId: "device-1",
    leases: [{ accountId: "tg-1", claimToken: "lease-1" }],
    limit: 1,
    now: new Date("2026-08-21T13:00:00.000Z"),
    db,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "FINALIZE_LIBRARY");
  assert.equal(result.items[0].submission.id, "crash-window");
  assert.equal(result.items[0].expectedIndex, null);
  assert.equal(result.items[0].telegramMessageId, null);
});

test("V20.4 does not requeue a submission whose typed Content Library provenance is finalized", async () => {
  const db = fakeDb({
    submissions: [baseSubmission({ id: "finalized", telegramMessageIds: [911], ofMediaIds: ["99111"] })],
    mediaAssets: [{
      id: "asset-finalized", agencyId: "agency-1", creatorId: "creator-1", mediaId: "99111",
      source: "CUSTOM", customOrderId: "custom-1", customSubmissionId: "finalized", customFullPriceCents: 6000,
      catalogActive: true, folderIds: ["vault-1"], sortingStatus: "SORTED",
      metadataUpdatedAt: null, description: "custom one", idealPriceCents: 6000, accessType: "paid",
    }],
  });
  const result = await claimCustomContentSubmissionUploadWork({
    agencyId: "agency-1", member, deviceId: "device-1",
    leases: [{ accountId: "tg-1", claimToken: "lease-1" }], limit: 1,
    now: new Date("2026-08-21T13:00:00.000Z"), db,
  });
  assert.deepEqual(result.items, []);
});

test("V20.9 transport-neutral intake allows a new assigned version only after explicit revision request", async () => {
  const waiting = baseSubmission({ id: "v1-waiting", telegramMessageIds: [1001], customOrderId: "custom-1", reviewStatus: "WAITING_REVIEW" });
  const dbBusy = fakeDb({ submissions: [waiting] });
  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member, db: dbBusy, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1002] } }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ORDER_BUSY" && error?.status === 409,
  );

  const revision = baseSubmission({ id: "v1-revision", telegramMessageIds: [1101], customOrderId: "custom-1", reviewStatus: "REVISION_REQUESTED", reviewComment: "Redo ending", reviewedAt: new Date("2026-08-21T11:00:00.000Z") });
  const dbRevision = fakeDb({ submissions: [revision] });
  const next = await createCustomContentSubmission({ agencyId: "agency-1", member, db: dbRevision, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1102] } });
  assert.equal(next.deduped, false);
  assert.equal(next.submission.customOrderId, "custom-1");

  const approved = baseSubmission({ id: "v1-approved", telegramMessageIds: [1201], customOrderId: "custom-1", reviewStatus: "APPROVED", reviewedAt: new Date("2026-08-21T11:00:00.000Z") });
  const dbApproved = fakeDb({ submissions: [approved] });
  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member, db: dbApproved, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1202] } }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ORDER_ALREADY_APPROVED" && error?.status === 409,
  );
});

test("V20.9 migration repairs ambiguous waiting rows into UNASSIGNED and enforces one active review version per custom", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260822123500_custom_content_submission_asset_provenance/migration.sql"), "utf8");
  assert.match(migration, /SET "customOrderId" = NULL/);
  assert.match(migration, /ROW_NUMBER\(\) OVER/);
  assert.match(migration, /CustomContentSubmission_one_waiting_per_order_key/);
  assert.match(migration, /WHERE "customOrderId" IS NOT NULL\s+AND "reviewStatus" = 'WAITING_REVIEW'/);
});
