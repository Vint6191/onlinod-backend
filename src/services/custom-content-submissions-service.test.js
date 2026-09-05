"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assignCustomContentSubmission,
  assertCustomSubmissionTelegramSourceAccess,
  claimCustomContentSubmissionUploadWork,
  commitCustomContentSubmissionMedia,
  createCustomContentSubmission,
  createCustomContentSubmissionFromInboundEvent,
  deterministicSubmissionId,
  listCustomContentSubmissions,
  reserveCustomContentSubmissionRelayWrite,
  sameMessageIds,
  telegramMessageIds,
} = require("./custom-content-submissions-service");

function clone(value) { return value == null ? value : structuredClone(value); }

function fakeDb(seed = {}) {
  const creators = (seed.creators || [
    { id: "creator-1", agencyId: "agency-1", deletedAt: null, displayName: "Model A", username: "a", status: "READY", telegramContact: "@model_a", telegramAccountId: "tg-1", customsVaultFolderId: "vault-1" },
    { id: "creator-2", agencyId: "agency-1", deletedAt: null, displayName: "Model B", username: "b", status: "READY", telegramContact: "@model_b", telegramAccountId: "tg-1", customsVaultFolderId: "vault-2" },
  ]).map(clone);
  const orderStamp = new Date("2026-08-21T10:00:00.000Z");
  const orders = (seed.orders || [
    { id: "custom-1", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", scenario: "custom one", priceCents: 6000 },
    { id: "call-1", agencyId: "agency-1", creatorId: "creator-1", type: "CALL", scenario: "call one", priceCents: 1000 },
    { id: "custom-2", agencyId: "agency-1", creatorId: "creator-2", type: "CONTENT", scenario: "custom two", priceCents: 7000 },
  ]).map((row) => ({
    status: "PENDING",
    fanDeliveredAt: null,
    contentBoundAt: null,
    createdAt: orderStamp,
    updatedAt: orderStamp,
    ...clone(row),
  }));
  const submissions = (seed.submissions || []).map(clone);
  const mediaAssets = (seed.mediaAssets || []).map(clone);
  const telegramAccounts = (seed.telegramAccounts || [
    {
      id: "tg-1", agencyId: "agency-1", runtimeClaimedByDeviceId: "device-1", runtimeClaimToken: "lease-1",
      runtimeClaimUntil: new Date("2026-08-21T14:00:00.000Z"), runtimeLeaseUserId: "user-1",
      runtimeLeaseMemberId: "member-1", runtimeLeaseAccessEpoch: 1, runtimeLeaseCreatorId: "creator-1", lifecycleState: "ACTIVE",
    },
  ]).map(clone);
  const workspaceSettings = new Map(Object.entries(seed.workspaceSettings || { vaultUploadRecipient: "relay_model" }));
  const audits = [];
  const relayProofs = (seed.relayProofs || []).map(clone);
  const inboundEvents = (seed.inboundEvents || []).map(clone);
  let injectAlbumRace = seed.injectAlbumRace === true;
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
    if (where.telegramSourceKey !== undefined && row.telegramSourceKey !== where.telegramSourceKey) return false;
    if (where.telegramSourceAccountId !== undefined) {
      if (where.telegramSourceAccountId && typeof where.telegramSourceAccountId === "object") {
        if (where.telegramSourceAccountId.not === null && row.telegramSourceAccountId == null) return false;
      } else if (row.telegramSourceAccountId !== where.telegramSourceAccountId) return false;
    }
    if (where.telegramSourceUserId !== undefined) {
      if (where.telegramSourceUserId && typeof where.telegramSourceUserId === "object") {
        if (where.telegramSourceUserId.not === null && row.telegramSourceUserId == null) return false;
      } else if (row.telegramSourceUserId !== where.telegramSourceUserId) return false;
    }
    if (where.reviewStatus !== undefined && String(row.reviewStatus || "WAITING_REVIEW") !== String(where.reviewStatus)) return false;
    if (where.telegramMessageIds?.hasSome) {
      const ids = new Set((row.telegramMessageIds || []).map(Number));
      if (!where.telegramMessageIds.hasSome.some((id) => ids.has(Number(id)))) return false;
    }
    return true;
  }

  return {
    _orders: orders,
    _submissions: submissions,
    _mediaAssets: mediaAssets,
    _relayProofs: relayProofs,
    _inboundEvents: inboundEvents,
    _telegramAccounts: telegramAccounts,
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
      async findFirst({ where }) {
        const row = telegramAccounts.find((candidate) => {
          if (candidate.agencyId !== where.agencyId || candidate.id !== where.id) return false;
          if (where.lifecycleState !== undefined && String(candidate.lifecycleState || "ACTIVE") !== String(where.lifecycleState)) return false;
          if (Array.isArray(where.OR) && !where.OR.some((entry) => entry.lifecycleState === String(candidate.lifecycleState || "ACTIVE") || (entry.lifecycleState === null && candidate.lifecycleState == null))) return false;
          return true;
        });
        return clone(row || null);
      },
      async updateMany({ where, data }) {
        const row = telegramAccounts.find((candidate) => {
          if (candidate.agencyId !== where.agencyId || candidate.id !== where.id) return false;
          if (where.lifecycleState !== undefined && String(candidate.lifecycleState || "ACTIVE") !== String(where.lifecycleState)) return false;
          if (Array.isArray(where.OR) && !where.OR.some((entry) => entry.lifecycleState === String(candidate.lifecycleState || "ACTIVE") || (entry.lifecycleState === null && candidate.lifecycleState == null))) return false;
          return true;
        });
        if (!row) return { count: 0 };
        Object.assign(row, clone(data));
        return { count: 1 };
      },
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
    telegramDeliveryIntent: {
      async findMany() { return []; },
    },
    customOrder: {
      async findFirst({ where, select = null }) {
        const row = orders.find((candidate) =>
          (where.id === undefined || candidate.id === where.id)
          && (where.agencyId === undefined || candidate.agencyId === where.agencyId)
          && (where.creatorId === undefined || candidate.creatorId === where.creatorId)
          && (where.type === undefined || String(candidate.type || "CONTENT") === String(where.type))
          && (where.status === undefined || String(candidate.status || "PENDING") === String(where.status))
          && (where.contentBoundAt === undefined || (where.contentBoundAt === null ? candidate.contentBoundAt == null : candidate.contentBoundAt === where.contentBoundAt))
        );
        if (!row) return null;
        if (!select) return clone(row);
        const picked = {};
        for (const [key, enabled] of Object.entries(select)) if (enabled) picked[key] = clone(row[key]);
        return picked;
      },
      async updateMany({ where, data }) {
        const row = orders.find((candidate) =>
          (where.id === undefined || candidate.id === where.id)
          && (where.agencyId === undefined || candidate.agencyId === where.agencyId)
          && (where.creatorId === undefined || candidate.creatorId === where.creatorId)
          && (where.type === undefined || String(candidate.type || "CONTENT") === String(where.type))
          && (where.status === undefined || String(candidate.status || "PENDING") === String(where.status))
          && (where.contentBoundAt === undefined || (where.contentBoundAt === null ? candidate.contentBoundAt == null : candidate.contentBoundAt === where.contentBoundAt))
          && (where.updatedAt === undefined || new Date(candidate.updatedAt).getTime() === new Date(where.updatedAt).getTime())
        );
        if (!row) return { count: 0 };
        const previousUpdatedAt = new Date(row.updatedAt);
        Object.assign(row, clone(data));
        if (data.updatedAt === undefined) row.updatedAt = new Date(previousUpdatedAt.getTime() + 1);
        return { count: 1 };
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
        if (injectAlbumRace && data.telegramSourceKey) {
          injectAlbumRace = false;
          const winnerEvent = inboundEvents.find((event) => event.id !== data.telegramInboundEventIds?.[0] && event.groupedId && String(data.telegramSourceKey).endsWith(`group:${event.groupedId}`));
          if (winnerEvent) {
            submissions.push({ id: data.id, agencyId: data.agencyId, creatorId: data.creatorId, customOrderId: data.customOrderId, telegramMessageIds: [Number(winnerEvent.messageId)], telegramInboundEventIds: [winnerEvent.id], telegramSourceKey: data.telegramSourceKey, telegramSourceAccountId: data.telegramSourceAccountId, telegramSourceUserId: data.telegramSourceUserId, ofMediaIds: [], comment: winnerEvent.text || null, receivedAt: winnerEvent.sentAt, createdAt: stamp, updatedAt: stamp });
            const error = new Error("source key race"); error.code = "P2002"; throw error;
          }
        }
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
        const row = submissions.find((candidate) => candidate.id === where.id && candidate.agencyId === where.agencyId
          && (where.reviewStatus === undefined || String(candidate.reviewStatus || "WAITING_REVIEW") === String(where.reviewStatus))
          && (where.customOrderId === undefined || candidate.customOrderId === where.customOrderId)
          && (!where.updatedAt || new Date(candidate.updatedAt).getTime() === new Date(where.updatedAt).getTime()));
        if (!row) return { count: 0 };
        Object.assign(row, clone(data), { updatedAt: new Date(new Date(row.updatedAt).getTime() + 1000) });
        return { count: 1 };
      },
    },
    telegramInboundEvent: {
      async findFirst({ where = {} }) {
        const row = inboundEvents.find((candidate) => {
          if (where.id !== undefined && candidate.id !== where.id) return false;
          if (where.agencyId !== undefined && candidate.agencyId !== where.agencyId) return false;
          if (where.accountId !== undefined && candidate.accountId !== where.accountId) return false;
          if (where.senderTelegramUserId !== undefined && String(candidate.senderTelegramUserId) !== String(where.senderTelegramUserId)) return false;
          if (where.messageId !== undefined && Number(candidate.messageId) !== Number(where.messageId)) return false;
          return true;
        });
        return clone(row || null);
      },
      async create({ data }) {
        if (inboundEvents.some((row) => row.id === data.id || (row.agencyId === data.agencyId && row.accountId === data.accountId && String(row.senderTelegramUserId) === String(data.senderTelegramUserId) && Number(row.messageId) === Number(data.messageId)))) {
          const error = new Error("duplicate provider source"); error.code = "P2002"; throw error;
        }
        const row = { submissionId: null, createdAt: new Date(), updatedAt: new Date(), ...clone(data) };
        inboundEvents.push(row);
        return clone(row);
      },
      async findMany({ where, orderBy = [] }) {
        const ids = where?.id?.in || [];
        const rows = inboundEvents.filter((row) => !ids.length || ids.includes(row.id));
        rows.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt) || Number(a.messageId) - Number(b.messageId));
        return rows.map(clone);
      },
      async updateMany({ where, data }) {
        const row = inboundEvents.find((candidate) => candidate.id === where.id && (where.submissionId === undefined || candidate.submissionId === where.submissionId));
        if (!row) return { count: 0 }; Object.assign(row, clone(data)); return { count: 1 };
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
    automationDelivery: {
      async findFirst({ where }) {
        const row = relayProofs.find((candidate) => {
          if (candidate.agencyId !== where.agencyId || candidate.creatorId !== where.creatorId || candidate.actionType !== where.actionType) return false;
          if (where.status !== undefined && candidate.status !== where.status) return false;
          if (where.idempotencyKey && typeof where.idempotencyKey === "object" && where.idempotencyKey.startsWith) return String(candidate.idempotencyKey || "").startsWith(where.idempotencyKey.startsWith);
          if (where.idempotencyKey !== undefined && candidate.idempotencyKey !== where.idempotencyKey) return false;
          return true;
        });
        return clone(row || null);
      },
    },
    auditLog: { async create({ data }) { audits.push(clone(data)); return { id: `audit-${audits.length}`, ...clone(data) }; } },
  };
}

function withTransactionalRollback(db) {
  let tail = Promise.resolve();
  db.$transaction = async (work) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const orderSnapshot = clone(db._orders);
    const submissionSnapshot = clone(db._submissions);
    const inboundSnapshot = clone(db._inboundEvents);
    const telegramAccountSnapshot = clone(db._telegramAccounts);
    try {
      return await work(db);
    } catch (error) {
      db._orders.splice(0, db._orders.length, ...orderSnapshot.map(clone));
      db._submissions.splice(0, db._submissions.length, ...submissionSnapshot.map(clone));
      db._inboundEvents.splice(0, db._inboundEvents.length, ...inboundSnapshot.map(clone));
      db._telegramAccounts.splice(0, db._telegramAccounts.length, ...telegramAccountSnapshot.map(clone));
      throw error;
    } finally {
      release();
    }
  };
  return db;
}

const member = { id: "member-1", userId: "user-1", agencyId: "agency-1", roleKey: "chatter", role: "OPERATOR", assignedCreators: ["creator-1"], accessEpoch: 1, permissions: { "content.review_customs": true } };

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
  const sourceIdentityMigration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260905090000_custom_submission_telegram_source_account/migration.sql"), "utf8");
  assert.match(sourceIdentityMigration, /ADD COLUMN IF NOT EXISTS "telegramSourceAccountId" TEXT/);
  assert.match(sourceIdentityMigration, /ADD COLUMN IF NOT EXISTS "telegramSourceUserId" TEXT/);
  assert.match(sourceIdentityMigration, /COUNT\(DISTINCT inbound\."accountId"\)/);
  assert.match(sourceIdentityMigration, /COUNT\(DISTINCT inbound\."senderTelegramUserId"\)/);
  assert.match(sourceIdentityMigration, /eventCount" = source_identity\."expectedEventCount/);
});

function baseSubmission(overrides = {}) {
  return {
    id: "submission-existing",
    agencyId: "agency-1",
    creatorId: "creator-1",
    customOrderId: "custom-1",
    telegramMessageIds: [101, 102],
    telegramSourceAccountId: "tg-1",
    telegramSourceUserId: "987654321012345678",
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
    deterministicSubmissionId("agency-1", "tg-1", "987654321012345678", [102, 101]),
    deterministicSubmissionId("agency-1", "tg-1", "987654321012345678", [101, 102, 101]),
    "the row id itself is the compact exact-retry fence",
  );
  assert.equal(
    deterministicSubmissionId("agency-1", "tg-1", "987654321012345678", [101]),
    deterministicSubmissionId("agency-1", "tg-1", "987654321012345678", [101]),
    "provider ownership is independent of the requested creator",
  );
  assert.notEqual(
    deterministicSubmissionId("agency-1", "tg-1", "987654321012345678", [101]),
    deterministicSubmissionId("agency-1", "tg-1", "987654321012345679", [101]),
    "Telegram message ids are namespaced by both account and provider user",
  );
});

test("create stores one compact submission row and exact retries are idempotent", async () => {
  const db = withTransactionalRollback(fakeDb());
  const first = await createCustomContentSubmission({
    agencyId: "agency-1", member, db,
    input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [501, 502, 501], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", comment: "  second angle  ", manualImportReason: "operator recovery", receivedAt: "2026-08-21T11:00:00.000Z" },
  });
  assert.equal(first.deduped, false);
  assert.deepEqual(first.submission.telegramMessageIds, ["501", "502"]);
  assert.deepEqual(first.submission.ofMediaIds, []);
  assert.equal(first.submission.comment, "second angle");
  assert.equal(first.submission.intakeAuthority, "MANUAL_HISTORICAL_IMPORT");
  assert.equal(first.submission.telegramSourceAccountId, "tg-1");
  assert.equal(first.submission.telegramSourceUserId, "987654321012345678");
  assert.equal(db._submissions.length, 1);

  const retry = await createCustomContentSubmission({
    agencyId: "agency-1", member, db,
    input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [502, 501], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", comment: "ignored retry text", manualImportReason: "operator recovery" },
  });
  assert.equal(retry.deduped, true);
  assert.equal(retry.submission.id, first.submission.id);
  assert.equal(db._submissions.length, 1);
  assert.equal(db._audits.length, 1, "idempotent retries do not create audit noise");
});


test("exact manual-import retry cannot silently change the CustomOrder assignment", async () => {
  const db = withTransactionalRollback(fakeDb({
    orders: [
      { id: "custom-1", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", scenario: "custom one", priceCents: 6000 },
      { id: "custom-alt", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", scenario: "custom alt", priceCents: 6500 },
    ],
  }));
  const input = { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [551], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "operator recovery" };
  const first = await createCustomContentSubmission({ agencyId: "agency-1", member, db, input });
  assert.equal(first.submission.customOrderId, "custom-1");

  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member, db, input: { ...input, customOrderId: "custom-alt" } }),
    (error) => error?.code === "CUSTOM_SUBMISSION_MANUAL_IMPORT_TARGET_CONFLICT" && error?.status === 409,
  );
  assert.equal(db._submissions.length, 1);
  assert.equal(db._submissions[0].customOrderId, "custom-1");
  assert.equal(db._orders.find((row) => row.id === "custom-alt").contentBoundAt, null, "a dedupe conflict must not bind the requested loser target");
});

test("manual raw Telegram import is forbidden by the domain service without content.review_customs", async () => {
  const db = fakeDb();
  const denied = { ...member, id: "member-denied", permissions: { "content.review_customs": false } };
  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member: denied, db, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [601], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "operator recovery" } }),
    (error) => error?.code === "CUSTOM_SUBMISSION_MANUAL_IMPORT_FORBIDDEN" && error?.status === 403,
  );
  assert.equal(db._submissions.length, 0);
});

test("customs source read is pinned to exact account + provider user and only while source media is pending", async () => {
  const db = fakeDb({ submissions: [baseSubmission()] });
  const access = await assertCustomSubmissionTelegramSourceAccess({
    agencyId: "agency-1", member, submissionId: "submission-existing", creatorId: "creator-1", accountId: "tg-1", messageIds: [101], db,
  });
  assert.equal(access.accountId, "tg-1");
  assert.equal(access.telegramSourceUserId, "987654321012345678");
  assert.deepEqual(access.telegramMessageIds, ["101"]);
  await assert.rejects(
    () => assertCustomSubmissionTelegramSourceAccess({ agencyId: "agency-1", member, submissionId: "submission-existing", creatorId: "creator-1", accountId: "tg-1", messageIds: [999], db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_SOURCE_MESSAGE_MISMATCH" && error?.status === 403,
  );
  await assert.rejects(
    () => assertCustomSubmissionTelegramSourceAccess({ agencyId: "agency-1", member, submissionId: "submission-existing", creatorId: "creator-1", accountId: "tg-2", messageIds: [101], db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_SOURCE_ACCOUNT_MISMATCH",
  );

  const completeDb = fakeDb({ submissions: [baseSubmission({ ofMediaIds: ["9001", "9002"] })] });
  await assert.rejects(
    () => assertCustomSubmissionTelegramSourceAccess({ agencyId: "agency-1", member, submissionId: "submission-existing", creatorId: "creator-1", accountId: "tg-1", messageIds: [101], db: completeDb }),
    (error) => error?.code === "CUSTOM_SUBMISSION_SOURCE_READ_NOT_REQUIRED",
  );
});

test("partial Telegram overlap is rejected instead of silently duplicating media", async () => {
  const db = withTransactionalRollback(fakeDb({ submissions: [baseSubmission()] }));
  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member, db, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [102, 103], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "operator recovery" } }),
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

test("relay reservation fences the exact Telegram source identity from claimed upload work", async () => {
  const db = fakeDb({ submissions: [baseSubmission({ id: "source-fence", telegramMessageIds: [721, 722], ofMediaIds: [] })] });
  const claimed = await claimCustomContentSubmissionUploadWork({
    agencyId: "agency-1", member, deviceId: "device-1", leases: [{ accountId: "tg-1", claimToken: "lease-1" }],
    now: new Date("2026-08-21T13:00:00.000Z"), db,
  });
  const work = claimed.items[0];
  assert.equal(work.expectedIndex, 0);
  assert.equal(work.telegramMessageId, "721");

  // Forced interleaving: source ordering changes after work exposure but before
  // reserve. The old protocol reserved index 0 for the new source while Desktop
  // still held/downloaded message 721. No canonical write row may be created.
  db._submissions[0].telegramMessageIds = [720, 721, 722];
  let reserveCalls = 0;
  await assert.rejects(
    () => reserveCustomContentSubmissionRelayWrite({
      agencyId: "agency-1", member, deviceId: "device-1", submissionId: "source-fence",
      expectedIndex: work.expectedIndex, expectedTelegramMessageId: work.telegramMessageId, accessEpoch: 1, db,
      reserveWrite: async () => { reserveCalls += 1; return { delivery: { id: "should-not-exist" } }; },
    }),
    (error) => error?.code === "CUSTOM_SUBMISSION_UPLOAD_WORK_STALE" && error?.status === 409,
  );
  assert.equal(reserveCalls, 0, "stale source is rejected before Audit17 reservation");
});

test("relay reservation binds canonical CUSTOM_RELAY_SEND payload to the full Telegram source namespace while holding the submission row lock", async () => {
  const db = fakeDb({ submissions: [baseSubmission({ id: "source-bound", telegramMessageIds: [731], ofMediaIds: [] })] });
  let locked = false;
  db.$transaction = async (work) => work(db);
  db.$queryRawUnsafe = async (sql, submissionId, agencyId) => {
    assert.match(String(sql), /CustomContentSubmission[\s\S]*FOR UPDATE/);
    assert.equal(submissionId, "source-bound");
    assert.equal(agencyId, "agency-1");
    locked = true;
    return [{ id: submissionId }];
  };
  let captured = null;
  const result = await reserveCustomContentSubmissionRelayWrite({
    agencyId: "agency-1", member, deviceId: "device-1", submissionId: "source-bound",
    expectedIndex: 0, expectedTelegramMessageId: "731", accessEpoch: 1, db,
    reserveWrite: async (input) => { assert.equal(locked, true, "source row must be locked before Audit17 reservation"); captured = input; return { delivery: { id: "write-731", status: "READY" }, lease: null }; },
  });
  assert.equal(captured.idempotencyKey, "custom-relay:source-bound:0");
  assert.equal(captured.payload.telegramSourceAccountId, "tg-1");
  assert.equal(captured.payload.telegramSourceUserId, "987654321012345678");
  assert.equal(captured.payload.telegramMessageId, "731");
  assert.equal(result.telegramSourceAccountId, "tg-1");
  assert.equal(result.telegramSourceUserId, "987654321012345678");
  assert.equal(result.telegramMessageId, "731");
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

test("Audit16 upload work rejects a Telegram lease from a stale access epoch before exposing OF work", async () => {
  const db = fakeDb({
    submissions: [baseSubmission({ telegramMessageIds: [702], ofMediaIds: [] })],
    telegramAccounts: [{
      id: "tg-1", agencyId: "agency-1", runtimeClaimedByDeviceId: "device-1", runtimeClaimToken: "lease-1",
      runtimeClaimUntil: new Date("2026-08-21T14:00:00.000Z"), runtimeLeaseUserId: "user-1",
      runtimeLeaseMemberId: "member-1", runtimeLeaseAccessEpoch: 0, runtimeLeaseCreatorId: "creator-1",
    }],
  });
  const result = await claimCustomContentSubmissionUploadWork({
    agencyId: "agency-1", member, deviceId: "device-1", leases: [{ accountId: "tg-1", claimToken: "lease-1" }],
    now: new Date("2026-08-21T13:00:00.000Z"), db,
  });
  assert.deepEqual(result.items, []);
});

test("proven CUSTOM_RELAY_SEND results project OF media ids strictly by Telegram position and retries are idempotent", async () => {
  const relayProofs = [
    { id: "write-0", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", idempotencyKey: "custom-relay:submission-existing:0", status: "COMPLETED", payload: { submissionId: "submission-existing", expectedIndex: 0, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "801" }, result: { programmaticWriteKind: "CUSTOM_RELAY_SEND", mediaId: "99001" }, messageId: null, finishedAt: new Date() },
    { id: "write-1", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", idempotencyKey: "custom-relay:submission-existing:1", status: "COMPLETED", payload: { submissionId: "submission-existing", expectedIndex: 1, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "802" }, result: { programmaticWriteKind: "CUSTOM_RELAY_SEND", mediaId: "99002" }, messageId: null, finishedAt: new Date() },
  ];
  const db = fakeDb({ submissions: [baseSubmission({ telegramMessageIds: [801, 802], ofMediaIds: [] })], relayProofs });
  const first = await commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 0, db });
  assert.equal(first.completed, false);
  assert.deepEqual(first.submission.ofMediaIds, ["99001"]);
  assert.equal(first.proof.writeId, "write-0");

  const retry = await commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 0, db });
  assert.equal(retry.idempotent, true);

  db._relayProofs[0].result.mediaId = "99999";
  await assert.rejects(
    () => commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 0, db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_MEDIA_COMMIT_CONFLICT",
  );
  db._relayProofs[0].result.mediaId = "99001";

  await assert.rejects(
    () => commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 2, db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_MEDIA_INDEX_INVALID" || error?.code === "CUSTOM_SUBMISSION_MEDIA_COMMIT_OUT_OF_ORDER",
  );

  const second = await commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 1, db });
  assert.equal(second.completed, true);
  assert.deepEqual(second.submission.ofMediaIds, ["99001", "99002"]);
  assert.equal(db._audits.filter((row) => row.action === "custom_content_submission.of_upload_complete").length, 1);
});

test("media projection rejects a completed relay whose stored payload is bound to a different Telegram source", async () => {
  const db = fakeDb({
    submissions: [baseSubmission({ id: "source-mismatch", telegramMessageIds: [811], ofMediaIds: [] })],
    relayProofs: [{ id: "write-mismatch", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", idempotencyKey: "custom-relay:source-mismatch:0", status: "COMPLETED", payload: { submissionId: "source-mismatch", expectedIndex: 0, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "812" }, result: { programmaticWriteKind: "CUSTOM_RELAY_SEND", mediaId: "99111" } }],
  });
  await assert.rejects(
    () => commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "source-mismatch", expectedIndex: 0, db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_RELAY_PROOF_SOURCE_MISMATCH" && error?.status === 409,
  );
  assert.deepEqual(db._submissions[0].ofMediaIds, []);
});

test("media projection rejects a completed relay with the same message id but a different Telegram account or provider user", async () => {
  for (const payloadOverride of [
    { telegramSourceAccountId: "tg-other" },
    { telegramSourceUserId: "987654321012345679" },
  ]) {
    const db = fakeDb({
      submissions: [baseSubmission({ id: "namespace-mismatch", telegramMessageIds: [813], ofMediaIds: [] })],
      relayProofs: [{
        id: "write-namespace-mismatch", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND",
        idempotencyKey: "custom-relay:namespace-mismatch:0", status: "COMPLETED",
        payload: { submissionId: "namespace-mismatch", expectedIndex: 0, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "813", ...payloadOverride },
        result: { programmaticWriteKind: "CUSTOM_RELAY_SEND", mediaId: "99112" },
      }],
    });
    await assert.rejects(
      () => commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "namespace-mismatch", expectedIndex: 0, db }),
      (error) => error?.code === "CUSTOM_SUBMISSION_RELAY_PROOF_SOURCE_MISMATCH" && error?.status === 409,
    );
    assert.deepEqual(db._submissions[0].ofMediaIds, []);
  }
});

test("legacy completed relay proof without account/user namespace stays fail-closed instead of being silently upgraded", async () => {
  const db = fakeDb({
    submissions: [baseSubmission({ id: "legacy-source-unproven", telegramMessageIds: [814], ofMediaIds: [] })],
    relayProofs: [{
      id: "write-legacy-source", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND",
      idempotencyKey: "custom-relay:legacy-source-unproven:0", status: "COMPLETED",
      payload: { submissionId: "legacy-source-unproven", expectedIndex: 0, telegramMessageId: "814" },
      result: { programmaticWriteKind: "CUSTOM_RELAY_SEND", mediaId: "99113" },
    }],
  });
  await assert.rejects(
    () => commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "legacy-source-unproven", expectedIndex: 0, db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_RELAY_PROOF_SOURCE_MISMATCH" && error?.status === 409,
  );
  assert.deepEqual(db._submissions[0].ofMediaIds, []);
});

test("media projection fails closed when no confirmed CUSTOM_RELAY_SEND proof exists", async () => {
  const db = fakeDb({ submissions: [baseSubmission({ telegramMessageIds: [811], ofMediaIds: [] })] });
  await assert.rejects(
    () => commitCustomContentSubmissionMedia({ agencyId: "agency-1", member, submissionId: "submission-existing", expectedIndex: 0, db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_RELAY_PROOF_REQUIRED" && error?.status === 409,
  );
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
  const dbBusy = withTransactionalRollback(fakeDb({ submissions: [waiting] }));
  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member, db: dbBusy, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1002], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "operator recovery" } }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ORDER_BUSY" && error?.status === 409,
  );

  const revision = baseSubmission({ id: "v1-revision", telegramMessageIds: [1101], customOrderId: "custom-1", reviewStatus: "REVISION_REQUESTED", reviewComment: "Redo ending", reviewedAt: new Date("2026-08-21T11:00:00.000Z") });
  const dbRevision = withTransactionalRollback(fakeDb({ submissions: [revision] }));
  const next = await createCustomContentSubmission({ agencyId: "agency-1", member, db: dbRevision, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1102], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "operator recovery" } });
  assert.equal(next.deduped, false);
  assert.equal(next.submission.customOrderId, "custom-1");

  const approved = baseSubmission({ id: "v1-approved", telegramMessageIds: [1201], customOrderId: "custom-1", reviewStatus: "APPROVED", reviewedAt: new Date("2026-08-21T11:00:00.000Z") });
  const dbApproved = withTransactionalRollback(fakeDb({ submissions: [approved] }));
  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member, db: dbApproved, input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1202], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "operator recovery" } }),
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


test("concurrent members of one Telegram album merge into the winning submission instead of losing the P2002 loser event", async () => {
  const sent = new Date("2026-09-04T16:00:00.000Z");
  const db = fakeDb({
    injectAlbumRace: true,
    inboundEvents: [
      { id: "event-a", agencyId: "agency-1", accountId: "tg-1", creatorId: "creator-1", customOrderId: "custom-1", submissionId: null, senderTelegramUserId: "900001", messageId: 701, groupedId: "album-9", hasMedia: true, text: "a", sentAt: sent },
      { id: "event-b", agencyId: "agency-1", accountId: "tg-1", creatorId: "creator-1", customOrderId: "custom-1", submissionId: null, senderTelegramUserId: "900001", messageId: 702, groupedId: "album-9", hasMedia: true, text: "b", sentAt: new Date(sent.getTime() + 1000) },
    ],
  });
  const result = await createCustomContentSubmissionFromInboundEvent({ eventId: "event-b", actorUserId: "user-1", db });
  assert.deepEqual(result.submission.telegramMessageIds, ["701", "702"]);
  assert.deepEqual(result.submission.telegramInboundEventIds, ["event-a", "event-b"]);
  assert.equal(db._inboundEvents.find((row) => row.id === "event-b").submissionId, result.submission.id);
  assert.equal(result.submission.intakeAuthority, "PROVIDER_ACTIVE_THREAD");
});




test("relay reservation racing an album merge serializes on the submission row and forces the late member to re-check relay execution", async () => {
  const sent = new Date("2026-09-04T16:00:00.000Z");
  const existing = baseSubmission({
    id: "submission-lock-race", customOrderId: "custom-1", telegramMessageIds: [742], telegramInboundEventIds: ["event-lock-existing"],
    telegramSourceKey: "telegram:agency-1:tg-1:900001:group:album-lock-race", telegramSourceUserId: "900001", ofMediaIds: [], receivedAt: new Date(sent.getTime() + 1000),
  });
  const db = fakeDb({ submissions: [existing], inboundEvents: [
    { id: "event-lock-existing", agencyId: "agency-1", accountId: "tg-1", creatorId: "creator-1", customOrderId: "custom-1", submissionId: "submission-lock-race", senderTelegramUserId: "900001", messageId: 742, groupedId: "album-lock-race", hasMedia: true, text: "existing", sentAt: new Date(sent.getTime() + 1000) },
    { id: "event-lock-late", agencyId: "agency-1", accountId: "tg-1", creatorId: "creator-1", customOrderId: "custom-1", submissionId: null, senderTelegramUserId: "900001", messageId: 741, groupedId: "album-lock-race", hasMedia: true, text: "late earlier", sentAt: sent },
  ] });
  let injected = false;
  db.$transaction = async (work) => work(db);
  db.$queryRawUnsafe = async (sql, submissionId) => {
    assert.match(String(sql), /FOR UPDATE/);
    assert.equal(submissionId, "submission-lock-race");
    if (!injected) {
      injected = true;
      db._relayProofs.push({ id: "write-raced-in", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", idempotencyKey: "custom-relay:submission-lock-race:0", status: "RUNNING", result: {} });
    }
    return [{ id: submissionId }];
  };
  const result = await createCustomContentSubmissionFromInboundEvent({ eventId: "event-lock-late", actorUserId: "user-1", db });
  const frozen = db._submissions.find((row) => row.id === "submission-lock-race");
  assert.deepEqual(frozen.telegramMessageIds.map(String), ["742"]);
  assert.notEqual(result.submission.id, "submission-lock-race");
  assert.equal(result.submission.customOrderId, null);
  assert.deepEqual(result.submission.telegramMessageIds, ["741"]);
});

test("Telegram source ordering freezes as soon as CUSTOM_RELAY_SEND execution identity exists, before media projection", async () => {
  const sent = new Date("2026-09-04T16:00:00.000Z");
  const existing = baseSubmission({
    id: "submission-frozen",
    customOrderId: "custom-1",
    telegramMessageIds: [722],
    telegramInboundEventIds: ["event-existing"],
    telegramSourceKey: "telegram:agency-1:tg-1:900001:group:album-frozen",
    telegramSourceUserId: "900001",
    ofMediaIds: [],
    receivedAt: new Date(sent.getTime() + 1000),
  });
  const db = fakeDb({
    submissions: [existing],
    relayProofs: [{ id: "write-reserved", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", idempotencyKey: "custom-relay:submission-frozen:0", status: "RUNNING", result: {} }],
    inboundEvents: [
      { id: "event-existing", agencyId: "agency-1", accountId: "tg-1", creatorId: "creator-1", customOrderId: "custom-1", submissionId: "submission-frozen", senderTelegramUserId: "900001", messageId: 722, groupedId: "album-frozen", hasMedia: true, text: "existing", sentAt: new Date(sent.getTime() + 1000) },
      { id: "event-late-earlier", agencyId: "agency-1", accountId: "tg-1", creatorId: "creator-1", customOrderId: "custom-1", submissionId: null, senderTelegramUserId: "900001", messageId: 721, groupedId: "album-frozen", hasMedia: true, text: "late but earlier", sentAt: sent },
    ],
  });
  const result = await createCustomContentSubmissionFromInboundEvent({ eventId: "event-late-earlier", actorUserId: "user-1", db });
  const frozen = db._submissions.find((row) => row.id === "submission-frozen");
  assert.deepEqual(frozen.telegramMessageIds.map(String), ["722"]);
  assert.notEqual(result.submission.id, "submission-frozen");
  assert.equal(result.submission.customOrderId, null);
  assert.deepEqual(result.submission.telegramMessageIds, ["721"]);
});

test("Telegram album members with contradictory proven CustomOrder provenance never merge into the same submission", async () => {
  const sent = new Date("2026-09-04T16:00:00.000Z");
  const db = fakeDb({
    orders: [
      { id: "custom-a", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", scenario: "A", priceCents: 1000 },
      { id: "custom-b", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", scenario: "B", priceCents: 1000 },
    ],
    inboundEvents: [
      { id: "event-order-a", agencyId: "agency-1", accountId: "tg-1", creatorId: "creator-1", customOrderId: "custom-a", submissionId: null, senderTelegramUserId: "900001", messageId: 711, groupedId: "album-conflict", hasMedia: true, text: "a", sentAt: sent },
      { id: "event-order-b", agencyId: "agency-1", accountId: "tg-1", creatorId: "creator-1", customOrderId: "custom-b", submissionId: null, senderTelegramUserId: "900001", messageId: 712, groupedId: "album-conflict", hasMedia: true, text: "b", sentAt: new Date(sent.getTime() + 1000) },
    ],
  });
  const first = await createCustomContentSubmissionFromInboundEvent({ eventId: "event-order-a", actorUserId: "user-1", db });
  const second = await createCustomContentSubmissionFromInboundEvent({ eventId: "event-order-b", actorUserId: "user-1", db });
  assert.notEqual(second.submission.id, first.submission.id);
  assert.equal(first.submission.customOrderId, "custom-a");
  assert.equal(second.submission.customOrderId, null);
  assert.deepEqual(first.submission.telegramMessageIds, ["711"]);
  assert.deepEqual(second.submission.telegramMessageIds, ["712"]);
  assert.equal(db._inboundEvents.find((row) => row.id === "event-order-b").submissionId, second.submission.id);
});

test("first submission bind and CONTENT type edit race on the same CustomOrder revision", async () => {
  const base = baseSubmission({ customOrderId: null, reviewStatus: "WAITING_REVIEW" });
  const target = {
    id: "custom-race", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", status: "PENDING", fanDeliveredAt: null,
    scenario: "race", priceCents: 6000, contentBoundAt: null,
    createdAt: new Date("2026-08-21T10:00:00.000Z"), updatedAt: new Date("2026-08-21T10:00:00.000Z"),
  };

  // Business type edit wins first: the stale submission bind must fail and attach nothing.
  let db = fakeDb({ submissions: [base], orders: [target] });
  const originalUpdateMany = db.customOrder.updateMany.bind(db.customOrder);
  let injected = false;
  db.customOrder.updateMany = async (args) => {
    if (!injected && args?.data?.contentBoundAt) {
      injected = true;
      const edited = await originalUpdateMany({
        where: { id: target.id, agencyId: "agency-1", creatorId: "creator-1", status: "PENDING", updatedAt: args.where.updatedAt },
        data: { type: "CALL" },
      });
      assert.equal(edited.count, 1, "forced type edit must win the stale revision exactly once");
    }
    return originalUpdateMany(args);
  };
  await assert.rejects(
    () => assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: base.id, customOrderId: target.id, db }),
    (error) => ["CUSTOM_SUBMISSION_ORDER_TYPE_INVALID", "CUSTOM_SUBMISSION_ORDER_BIND_CONFLICT"].includes(error?.code),
  );
  assert.equal(db._submissions[0].customOrderId, null);
  assert.equal(db._orders[0].type, "CALL");
  assert.equal(db._orders[0].contentBoundAt, null);

  // Submission bind wins first: the stale type writer cannot cross the updatedAt fence.
  db = fakeDb({ submissions: [baseSubmission({ customOrderId: null, reviewStatus: "WAITING_REVIEW" })], orders: [clone(target)] });
  const staleRevision = new Date(db._orders[0].updatedAt);
  const assigned = await assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: "submission-existing", customOrderId: target.id, db });
  assert.equal(assigned.submission.customOrderId, target.id);
  assert.ok(db._orders[0].contentBoundAt instanceof Date);
  const staleEdit = await db.customOrder.updateMany({
    where: { id: target.id, agencyId: "agency-1", creatorId: "creator-1", status: "PENDING", updatedAt: staleRevision },
    data: { type: "CALL" },
  });
  assert.equal(staleEdit.count, 0, "stale type mutation must lose after content binding advances updatedAt");
  assert.equal(db._orders[0].type, "CONTENT");
});

test("losing concurrent reassignment rolls back target content binding", async () => {
  const base = baseSubmission({ customOrderId: null, reviewStatus: "WAITING_REVIEW" });
  const stamp = new Date("2026-08-21T10:00:00.000Z");
  const db = withTransactionalRollback(fakeDb({
    submissions: [base],
    orders: [
      { id: "custom-a", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", status: "PENDING", fanDeliveredAt: null, scenario: "A", priceCents: 6000, contentBoundAt: null, createdAt: stamp, updatedAt: stamp },
      { id: "custom-b", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", status: "PENDING", fanDeliveredAt: null, scenario: "B", priceCents: 6000, contentBoundAt: null, createdAt: stamp, updatedAt: stamp },
    ],
  }));

  const results = await Promise.allSettled([
    assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: base.id, customOrderId: "custom-a", db }),
    assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: base.id, customOrderId: "custom-b", db }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  const winnerId = db._submissions[0].customOrderId;
  const loserId = winnerId === "custom-a" ? "custom-b" : "custom-a";
  assert.ok(db._orders.find((row) => row.id === winnerId)?.contentBoundAt, "winning target is durably bound");
  assert.equal(db._orders.find((row) => row.id === loserId)?.contentBoundAt, null, "losing transaction must not leave a false CONTENT binding");
});

test("two manager reassignments from the same submission revision cannot both win", async () => {
  const base = baseSubmission({ customOrderId: null, reviewStatus: "WAITING_REVIEW" });
  const db = fakeDb({
    submissions: [base],
    orders: [
      { id: "custom-a", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", scenario: "A", priceCents: 1000, status: "PENDING" },
      { id: "custom-b", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", scenario: "B", priceCents: 1000, status: "PENDING" },
    ],
  });
  const [a, b] = await Promise.allSettled([
    assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: base.id, customOrderId: "custom-a", db }),
    assignCustomContentSubmission({ agencyId: "agency-1", member, submissionId: base.id, customOrderId: "custom-b", db }),
  ]);
  const fulfilled = [a, b].filter((row) => row.status === "fulfilled");
  const rejected = [a, b].filter((row) => row.status === "rejected");
  assert.equal(fulfilled.length, 1); assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "CUSTOM_SUBMISSION_ASSIGNMENT_STALE");
});

test("manual historical import cannot cross a current active Telegram thread that belongs to another creator", async () => {
  const db = withTransactionalRollback(fakeDb());
  db.telegramDeliveryIntent.findMany = async ({ where }) => {
    if (where.kind !== "TASK" || where.accountId !== "tg-1" || String(where.remoteRecipientTelegramUserId) !== "987654321012345678") return [];
    return [{ id: "task-thread-b", agencyId: "agency-1", accountId: "tg-1", creatorId: "creator-2", customOrderId: "custom-2", kind: "TASK", state: "CONFIRMED", remoteMessageId: 901, remoteRecipientTelegramUserId: "987654321012345678", confirmationAuthority: "PROVIDER_RECEIPT", remoteSentAt: new Date("2026-09-05T10:00:00.000Z"), confirmedAt: new Date("2026-09-05T10:00:01.000Z") }];
  };
  db.customOrder.findMany = async ({ where }) => db._orders.filter((row) => row.agencyId === where.agencyId && where.id?.in?.includes(row.id) && String(row.status || "PENDING") === String(where.status || row.status || "PENDING")).map(clone);
  await assert.rejects(
    () => createCustomContentSubmission({
      agencyId: "agency-1", member, db,
      input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [901], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "historical recovery", receivedAt: "2026-09-05T10:00:02.000Z" },
    }),
    (error) => error?.code === "CUSTOM_SUBMISSION_MANUAL_IMPORT_THREAD_CONFLICT" && error?.status === 409,
  );
  assert.equal(db._submissions.length, 0);
  assert.equal(db._inboundEvents.length, 0);
  assert.equal(db._orders.find((row) => row.id === "custom-1").contentBoundAt, null);
});

test("automatic inbound exception cannot be adjudicated through the separate manual historical import path", async () => {
  const db = withTransactionalRollback(fakeDb({ inboundEvents: [{
    id: "tgi-existing-auto", agencyId: "agency-1", accountId: "tg-1", creatorId: null, customOrderId: null, submissionId: null,
    senderTelegramUserId: "987654321012345678", messageId: 909, replyToMessageId: null, groupedId: null, hasMedia: true, text: "provider media",
    sentAt: new Date("2026-09-05T09:00:00.000Z"), observedAt: new Date("2026-09-05T09:00:01.000Z"),
    projectionState: "REVIEW_REQUIRED", projectionReason: "AMBIGUOUS_ACTIVE_THREADS", intakeAuthority: "PROVIDER_OBSERVATION",
    threadResolutionType: "AMBIGUOUS_ACTIVE_THREADS", resolutionAuthority: null, createdAt: new Date(), updatedAt: new Date(),
  }] }));
  // Match the real canonical provider key used by the service.
  const canonicalId = require("./custom-telegram-thread-authority-service").providerMessageEventId({ agencyId: "agency-1", accountId: "tg-1", senderTelegramUserId: "987654321012345678", messageId: 909 });
  db._inboundEvents[0].id = canonicalId;
  await assert.rejects(
    () => createCustomContentSubmission({
      agencyId: "agency-1", member, db,
      input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [909], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "try to bypass review queue" },
    }),
    (error) => error?.code === "CUSTOM_SUBMISSION_PROVIDER_EVENT_EXISTS" && error?.status === 409,
  );
  assert.equal(db._submissions.length, 0);
  assert.equal(db._inboundEvents[0].submissionId, null);
  assert.equal(db._inboundEvents[0].projectionState, "REVIEW_REQUIRED");
  assert.equal(db._orders.find((row) => row.id === "custom-1").contentBoundAt, null);
});

test("the same provider message manually claimed for creator A cannot acquire a second owner through creator B", async () => {
  const broad = { ...member, role: "OWNER", roleKey: "owner", assignedCreators: "all" };
  const db = withTransactionalRollback(fakeDb());
  const source = { telegramMessageIds: [902], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "operator recovery" };
  const first = await createCustomContentSubmission({ agencyId: "agency-1", member: broad, db, input: { creatorId: "creator-1", customOrderId: "custom-1", ...source } });
  await assert.rejects(
    () => createCustomContentSubmission({ agencyId: "agency-1", member: broad, db, input: { creatorId: "creator-2", customOrderId: "custom-2", ...source } }),
    (error) => ["CUSTOM_SUBMISSION_MANUAL_IMPORT_TARGET_CONFLICT", "CUSTOM_SUBMISSION_PROVIDER_SOURCE_OWNED", "CUSTOM_SUBMISSION_TELEGRAM_MESSAGE_CONFLICT"].includes(error?.code) && error?.status === 409,
  );
  assert.equal(db._submissions.length, 1);
  assert.equal(db._submissions[0].id, first.submission.id);
  assert.equal(db._inboundEvents.length, 1);
  assert.equal(db._inboundEvents[0].submissionId, first.submission.id);
});

test("manual historical import audit failure rolls back provider ownership, order binding and submission atomically", async () => {
  const db = withTransactionalRollback(fakeDb());
  db.auditLog.create = async () => { throw Object.assign(new Error("audit unavailable"), { code: "AUDIT_DOWN" }); };
  await assert.rejects(
    () => createCustomContentSubmission({
      agencyId: "agency-1", member, db,
      input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [903], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "operator recovery with mandatory audit" },
    }),
    (error) => error?.code === "AUDIT_DOWN",
  );
  assert.equal(db._submissions.length, 0);
  assert.equal(db._inboundEvents.length, 0);
  assert.equal(db._orders.find((row) => row.id === "custom-1").contentBoundAt, null);
});

test("concurrent automatic provider ownership beats manual recovery through the canonical TelegramInboundEvent key", async () => {
  const db = withTransactionalRollback(fakeDb());
  const canonicalId = deterministicSubmissionId("agency-1", "tg-1", "987654321012345678", [904]);
  const originalCreate = db.telegramInboundEvent.create.bind(db.telegramInboundEvent);
  const originalFindFirst = db.telegramInboundEvent.findFirst.bind(db.telegramInboundEvent);
  let externalWinner = null;
  db.telegramInboundEvent.create = async ({ data }) => {
    if (!externalWinner) {
      // Model the P2002 winner as a row committed by a different transaction. It must not
      // participate in (or be rolled back with) the losing manual-import transaction.
      externalWinner = { ...clone(data), submissionId: "auto-owner-submission", intakeAuthority: "PROVIDER_OBSERVATION", resolutionAuthority: "PROVIDER_ACTIVE_THREAD", projectionState: "APPLIED", createdAt: new Date(), updatedAt: new Date() };
      const error = new Error("automatic intake won provider source race"); error.code = "P2002"; throw error;
    }
    return originalCreate({ data });
  };
  db.telegramInboundEvent.findFirst = async ({ where = {} }) => {
    if (externalWinner && where.id === externalWinner.id) return clone(externalWinner);
    return originalFindFirst({ where });
  };
  await assert.rejects(
    () => createCustomContentSubmission({
      agencyId: "agency-1", member, db,
      input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [904], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "manual recovery raced auto intake" },
    }),
    (error) => error?.code === "CUSTOM_SUBMISSION_PROVIDER_SOURCE_OWNED" && error?.status === 409,
  );
  assert.ok(externalWinner, "the canonical provider identity must have exactly one external winner");
  assert.equal(externalWinner.submissionId, "auto-owner-submission");
  assert.equal(db._submissions.some((row) => row.id === canonicalId), false);
  assert.equal(db._submissions.length, 0);
  assert.equal(db._inboundEvents.length, 0, "the losing manual transaction must not create a second local source row");
  assert.equal(db._orders.find((row) => row.id === "custom-1").contentBoundAt, null);
});

test("multi-message manual recovery rolls back every earlier source claim when a later provider message is concurrently owned by automatic intake", async () => {
  const db = withTransactionalRollback(fakeDb());
  const originalCreate = db.telegramInboundEvent.create.bind(db.telegramInboundEvent);
  const originalFindFirst = db.telegramInboundEvent.findFirst.bind(db.telegramInboundEvent);
  let externalWinner = null;
  db.telegramInboundEvent.create = async ({ data }) => {
    if (Number(data.messageId) === 906 && !externalWinner) {
      externalWinner = { ...clone(data), submissionId: "auto-album-owner", intakeAuthority: "PROVIDER_OBSERVATION", resolutionAuthority: "PROVIDER_ACTIVE_THREAD", projectionState: "APPLIED", createdAt: new Date(), updatedAt: new Date() };
      const error = new Error("automatic album member won provider source race"); error.code = "P2002"; throw error;
    }
    return originalCreate({ data });
  };
  db.telegramInboundEvent.findFirst = async ({ where = {} }) => {
    if (externalWinner && where.id === externalWinner.id) return clone(externalWinner);
    return originalFindFirst({ where });
  };
  await assert.rejects(
    () => createCustomContentSubmission({
      agencyId:"agency-1",member,db,
      input:{creatorId:"creator-1",customOrderId:"custom-1",telegramMessageIds:[905,906],telegramAccountId:"tg-1",telegramUserId:"987654321012345678",manualImportReason:"recover two-message set"},
    }),
    (error)=>error?.code==="CUSTOM_SUBMISSION_PROVIDER_SOURCE_OWNED"&&error?.status===409,
  );
  assert.ok(externalWinner);
  assert.equal(externalWinner.submissionId,"auto-album-owner");
  assert.equal(db._inboundEvents.length,0,"message 905 claimed earlier in the losing manual transaction must roll back too");
  assert.equal(db._submissions.length,0);
  assert.equal(db._orders.find((row)=>row.id==="custom-1").contentBoundAt,null);
});

test("F40 manual historical import rejects a RETIRING source account before provider ownership is created", async () => {
  const db = withTransactionalRollback(fakeDb({ telegramAccounts: [{ id: "tg-1", agencyId: "agency-1", lifecycleState: "RETIRING" }] }));
  await assert.rejects(
    () => createCustomContentSubmission({
      agencyId: "agency-1", member, db,
      input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1201], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "historical recovery" },
    }),
    (error) => error?.code === "CUSTOM_SUBMISSION_TELEGRAM_SOURCE_ACCOUNT_RETIRING" && error?.status === 409,
  );
  assert.equal(db._inboundEvents.length, 0);
  assert.equal(db._submissions.length, 0);
  assert.equal(db._orders.find((row) => row.id === "custom-1")?.contentBoundAt, null);
});

test("F40 manual historical import cannot create a dangling source after account deletion", async () => {
  const db = withTransactionalRollback(fakeDb({ telegramAccounts: [] }));
  await assert.rejects(
    () => createCustomContentSubmission({
      agencyId: "agency-1", member, db,
      input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1202], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "historical recovery" },
    }),
    (error) => error?.code === "CUSTOM_SUBMISSION_TELEGRAM_SOURCE_ACCOUNT_NOT_FOUND" && error?.status === 404,
  );
  assert.equal(db._inboundEvents.length, 0);
  assert.equal(db._submissions.length, 0);
});

test("F40 retirement winning the shared account transaction rejects a racing manual import with no provider/source residue", async () => {
  const db = withTransactionalRollback(fakeDb());
  let retireLockedResolve;
  const retireLocked = new Promise((resolve) => { retireLockedResolve = resolve; });
  let allowRetireResolve;
  const allowRetire = new Promise((resolve) => { allowRetireResolve = resolve; });

  const retirement = db.$transaction(async (tx) => {
    const changed = await tx.agencyTelegramMtprotoAccount.updateMany({
      where: { id: "tg-1", agencyId: "agency-1", OR: [{ lifecycleState: "ACTIVE" }, { lifecycleState: null }] },
      data: { lifecycleState: "RETIRING" },
    });
    assert.equal(changed.count, 1);
    retireLockedResolve();
    await allowRetire;
  });
  await retireLocked;

  const importing = createCustomContentSubmission({
    agencyId: "agency-1", member, db,
    input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1301], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "historical recovery" },
  });
  allowRetireResolve();
  await retirement;
  await assert.rejects(importing, (error) => error?.code === "CUSTOM_SUBMISSION_TELEGRAM_SOURCE_ACCOUNT_RETIRING");
  assert.equal(db._inboundEvents.length, 0);
  assert.equal(db._submissions.length, 0);
});

test("F40 manual import winning the shared account transaction commits source before retirement can evaluate blockers", async () => {
  const db = withTransactionalRollback(fakeDb());
  const originalCreate = db.telegramInboundEvent.create.bind(db.telegramInboundEvent);
  let sourceCreatedResolve;
  const sourceCreated = new Promise((resolve) => { sourceCreatedResolve = resolve; });
  let allowImportResolve;
  const allowImport = new Promise((resolve) => { allowImportResolve = resolve; });
  let paused = false;
  db.telegramInboundEvent.create = async (args) => {
    const row = await originalCreate(args);
    if (!paused) {
      paused = true;
      sourceCreatedResolve();
      await allowImport;
    }
    return row;
  };

  const importing = createCustomContentSubmission({
    agencyId: "agency-1", member, db,
    input: { creatorId: "creator-1", customOrderId: "custom-1", telegramMessageIds: [1302], telegramAccountId: "tg-1", telegramUserId: "987654321012345678", manualImportReason: "historical recovery" },
  });
  await sourceCreated;

  const retirement = db.$transaction(async (tx) => {
    const pendingSource = db._submissions.some((row) => row.telegramSourceAccountId === "tg-1" && (row.telegramMessageIds || []).length > (row.ofMediaIds || []).length);
    if (pendingSource) return { blocked: true };
    await tx.agencyTelegramMtprotoAccount.updateMany({ where: { id: "tg-1", agencyId: "agency-1" }, data: { lifecycleState: "RETIRING" } });
    return { blocked: false };
  });

  allowImportResolve();
  const created = await importing;
  assert.equal(created.ok, true);
  const retireResult = await retirement;
  assert.equal(retireResult.blocked, true, "retirement must observe the durable source committed by the winning import");
  assert.equal(db._telegramAccounts[0].lifecycleState, "ACTIVE");
  assert.equal(db._submissions.length, 1);
});
