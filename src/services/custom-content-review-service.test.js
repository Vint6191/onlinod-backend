"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { listCustomContentReviewQueue, reviewCustomContentSubmission } = require("./custom-content-review-service");
const { vaultSettlementFingerprint } = require("./custom-content-pipeline-authority-service");
const { ensureRevisionRequestIntents } = require("./telegram-delivery-authority-service");


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
  const member = { id: "manager-1", userId: "user-1", agencyId: "agency-1", roleKey: "manager", role: "MANAGER", assignedCreators: "all", accessEpoch: 1, permissions: { "team.analytics.view": true, "content.review_customs": true } };
  const currentMember = { ...member, permissions: { ...member.permissions } };
  const creator = { id: "creator-1", displayName: "Model One", username: "modelone", avatarUrl: null };
  const order = { id: "custom-1", creatorId: "creator-1", dialogId: "777", scenario: "Do the custom", internalNote: null, type: "CONTENT", contentKind: "VIDEO", status: "PENDING", fanDeliveredAt: null, priceCents: 6000, paidAmountCents: 4000, createdAt: now, creator };
  const row = { id: "sub-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1", pipelineDisposition: "ACTIVE", executionVaultFolderId: "vault-1", executionRelayRecipient: "relay_model", executionProfileRevision: 1, executionPinnedAt: now, ...receipt("vault-1", 1, ["9001", "9002"], now), telegramMessageIds: [101, 102], ofMediaIds: ["9001", "9002"], comment: "two versions", reviewStatus: "WAITING_REVIEW", reviewComment: null, reviewedByMemberId: null, reviewedAt: null, bindingRevision: 1, reviewDecisionRevision: 0, receivedAt: now, createdAt: now, updatedAt: now, creator, customOrder: order, reviewedByMember: null };
  const rows = [row];
  const reviewDecisions = [];
  const assets = ["9001", "9002"].map((mediaId) => ({ agencyId: "agency-1", creatorId: "creator-1", mediaId, source: "CUSTOM", customOrderId: "custom-1", customSubmissionId: "sub-1", customFullPriceCents: 6000, mediaType: "video", thumbUrl: `https://cdn/${mediaId}.jpg`, previewUrl: null, fullUrl: null, folderIds: ["vault-1"], catalogActive: true, sortingStatus: "SORTED" }));
  const intents = [{
    id: "task-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1", customSubmissionId: null, accountId: "tg-1", kind: "TASK", logicalKey: "task-key", clientIntentId: null, referenceOrdinal: null,
    payloadFingerprint: "task-fingerprint", payload: {}, state: "CONFIRMED", claimRevision: 0, claimUntil: null, commitStartedAt: now,
    remoteMessageId: 555, remoteRecipientTelegramUserId: "900001", remoteSentAt: now, outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT", confirmedAt: now, createdAt: now, updatedAt: now,
  }];
  const pick = (item, select) => { if (!select) return item; const out = {}; for (const [key, enabled] of Object.entries(select)) if (enabled) out[key] = item[key]; return out; };
  const matchesIntent = (item, where = {}) => {
    for (const [key, expected] of Object.entries(where || {})) {
      const actual = item[key];
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        if (Array.isArray(expected.in) && !expected.in.map(String).includes(String(actual))) return false;
        if (expected.not != null && String(actual) === String(expected.not)) return false;
      } else if (expected !== undefined && String(actual) !== String(expected)) return false;
    }
    return true;
  };
  const db = {
    agencyMember: {
      findFirst: async ({ where = {} } = {}) => {
        if (where.id && String(where.id) !== String(currentMember.id)) return null;
        if (where.userId && String(where.userId) !== String(currentMember.userId)) return null;
        if (where.agencyId && String(where.agencyId) !== String(currentMember.agencyId)) return null;
        if (currentMember.deletedAt || currentMember.deactivatedAt) return null;
        return { ...currentMember, permissions: { ...(currentMember.permissions || {}) } };
      },
    },
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
      findFirst: async ({ where = {}, select = null, orderBy = [] }) => {
        let found = rows.filter((item) => {
          if (where.id && typeof where.id !== "object" && String(item.id) !== String(where.id)) return false;
          if (where.id?.not && String(item.id) === String(where.id.not)) return false;
          if (where.agencyId && String(item.agencyId) !== String(where.agencyId)) return false;
          if (where.creatorId && String(item.creatorId) !== String(where.creatorId)) return false;
          if (where.customOrderId && typeof where.customOrderId !== "object" && String(item.customOrderId) !== String(where.customOrderId)) return false;
          if (where.reviewStatus && String(item.reviewStatus) !== String(where.reviewStatus)) return false;
          return true;
        });
        const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
        found.sort((a,b) => { for (const spec of specs) { const [key,dir] = Object.entries(spec || {})[0] || []; if (!key) continue; const av=a[key], bv=b[key]; const cmp=(av instanceof Date || bv instanceof Date) ? new Date(av||0)-new Date(bv||0) : String(av??"").localeCompare(String(bv??"")); if (cmp) return dir === "desc" ? -cmp : cmp; } return 0; });
        return found.length ? pick(found[0], select) : null;
      },
      updateMany: async ({ where = {}, data = {} }) => {
        const item = rows.find((candidate) => {
          if (where.id && String(candidate.id) !== String(where.id)) return false;
          if (where.agencyId && String(candidate.agencyId) !== String(where.agencyId)) return false;
          if (where.pipelineDisposition && String(candidate.pipelineDisposition) !== String(where.pipelineDisposition)) return false;
          if (where.reviewStatus && String(candidate.reviewStatus) !== String(where.reviewStatus)) return false;
          if (where.customOrderId && String(candidate.customOrderId) !== String(where.customOrderId)) return false;
          if (where.bindingRevision != null && Number(candidate.bindingRevision) !== Number(where.bindingRevision)) return false;
          if (where.reviewDecisionRevision != null && Number(candidate.reviewDecisionRevision) !== Number(where.reviewDecisionRevision)) return false;
          if (where.updatedAt && candidate.updatedAt !== where.updatedAt) return false;
          return true;
        });
        if (!item) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && Number.isFinite(Number(value.increment))) item[key] = Number(item[key] || 0) + Number(value.increment);
          else item[key] = value;
        }
        item.updatedAt = new Date(item.updatedAt.getTime() + 1);
        item.reviewedByMember = data.reviewedByMemberId ? { id: member.id, displayName: "Manager", roleKey: "manager" } : null;
        return { count: 1 };
      },
    },
    customContentReviewDecision: {
      create: async ({ data }) => {
        const created = { id: `review-decision-${reviewDecisions.length + 1}`, createdAt: data.decidedAt || now, ...data };
        reviewDecisions.push(created);
        return created;
      },
      findMany: async ({ where = {} } = {}) => reviewDecisions.filter((item) => {
        if (where.submissionId && String(item.submissionId) !== String(where.submissionId)) return false;
        return true;
      }),
    },
    agencyTelegramMtprotoAccount: {
      updateMany: async ({ where }) => ({ count: String(where?.id || "") === "tg-1" ? 1 : 0 }),
      findFirst: async ({ where, select = null }) => String(where?.id || "") === "tg-1" ? pick({ id: "tg-1", agencyId: "agency-1", lifecycleState: "ACTIVE" }, select) : null,
    },
    telegramDeliveryIntent: {
      findUnique: async ({ where }) => {
        if (where?.logicalKey) return intents.find((item) => String(item.logicalKey) === String(where.logicalKey)) || null;
        return null;
      },
      findFirst: async ({ where = {}, select = null, orderBy = [] }) => {
        let found = intents.filter((item) => matchesIntent(item, where));
        const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
        found.sort((a,b) => { for (const spec of specs) { const [key,dir] = Object.entries(spec || {})[0] || []; if (!key) continue; const av=a[key], bv=b[key]; const cmp=(av instanceof Date || bv instanceof Date) ? new Date(av||0)-new Date(bv||0) : String(av??"").localeCompare(String(bv??"")); if (cmp) return dir === "desc" ? -cmp : cmp; } return 0; });
        return found.length ? pick(found[0], select) : null;
      },
      findMany: async ({ where = {}, select = null, orderBy = [], take = 999999 }) => {
        let found = intents.filter((item) => matchesIntent(item, where));
        const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
        found.sort((a,b) => { for (const spec of specs) { const [key,dir] = Object.entries(spec || {})[0] || []; if (!key) continue; const av=a[key], bv=b[key]; const cmp=(av instanceof Date || bv instanceof Date) ? new Date(av||0)-new Date(bv||0) : String(av??"").localeCompare(String(bv??"")); if (cmp) return dir === "desc" ? -cmp : cmp; } return 0; });
        return found.slice(0, take).map((item) => pick(item, select));
      },
      create: async ({ data }) => {
        const created = { id: `intent-${intents.length + 1}`, claimRevision: 0, claimUntil: null, commitStartedAt: null, remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null, outcomeReason: null, confirmationAuthority: null, confirmedAt: null, updatedAt: data.createdAt || now, ...data };
        intents.push(created); return created;
      },
      updateMany: async ({ where = {}, data = {} }) => {
        let count = 0;
        for (const item of intents) {
          if (!matchesIntent(item, where)) continue;
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object" && Number.isFinite(Number(value.increment))) item[key] = Number(item[key] || 0) + Number(value.increment);
            else item[key] = value;
          }
          item.updatedAt = data.updatedAt || new Date(now.getTime() + 1);
          count += 1;
        }
        return { count };
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
  return { db, member, currentMember, row, rows, assets, intents, reviewDecisions };
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
    () => reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db }),
    (error) => error?.code === "CUSTOM_REVIEW_NOT_READY",
  );
});

test("revision request requires a non-empty manager comment", async () => {
  const { db, member } = fixture();
  await assert.rejects(() => reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: "sub-1", action: "REQUEST_REVISION", comment: "   ", db }), (error) => error.code === "CUSTOM_REVIEW_COMMENT_REQUIRED");
});

test("approve is final and persists reviewer without mutating the custom order", async () => {
  const { db, member, row } = fixture();
  const result = await reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db });
  assert.equal(result.ok, true);
  assert.equal(result.item.reviewStatus, "APPROVED");
  assert.equal(row.reviewedByMemberId, "manager-1");
  assert.ok(row.reviewedAt instanceof Date);
  await assert.rejects(() => reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: "sub-1", action: "REQUEST_REVISION", comment: "change it", db }), (error) => error.code === "CUSTOM_REVIEW_APPROVAL_FINAL");
});

test("revision decision atomically creates one durable revision dispatch and preserves exact manager instruction", async () => {
  const { db, member, row, intents } = fixture();
  const result = await reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: "sub-1", action: "REQUEST_REVISION", comment: "Need another angle", db });
  assert.equal(result.item.reviewStatus, "REVISION_REQUESTED");
  assert.equal(row.reviewComment, "Need another angle");
  assert.equal(result.item.revisionDispatch.status, "DISPATCH_PENDING");
  const revision = intents.filter((intent) => intent.kind === "REVISION_REQUEST");
  assert.equal(revision.length, 1);
  assert.equal(revision[0].customSubmissionId, "sub-1");
  assert.equal(revision[0].state, "PLANNED");
  assert.equal(revision[0].payload.replyToMessageId, "555");
  assert.equal(revision[0].payload.recipientTelegramUserId, "900001");
  assert.equal(revision[0].payload.reviewComment, "Need another angle");
  assert.match(revision[0].payload.text, /Need another angle/);

  const retry = await reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: "sub-1", action: "REQUEST_REVISION", comment: "Need another angle", db });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.item.revisionDispatch.intentId, revision[0].id);
  assert.equal(intents.filter((intent) => intent.kind === "REVISION_REQUEST").length, 1, "manager retry/restart recovery must not create a second revision instruction");

  await assert.rejects(() => reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db }), (error) => error.code === "CUSTOM_REVIEW_ALREADY_DECIDED");
});



test("legacy REVISION_REQUESTED decision materializes one PLANNED provider intent without inventing success", async () => {
  const { db, row, intents } = fixture();
  row.reviewStatus = "REVISION_REQUESTED";
  row.reviewComment = "Legacy manager instruction";
  row.reviewedAt = new Date("2026-08-21T14:10:00.000Z");
  row.reviewedByMemberId = "manager-1";
  row.customOrder.telegramTaskMessageId = 555;

  const planned = await ensureRevisionRequestIntents({ agencyId: "agency-1", member: null, limit: 25, now: new Date("2026-08-21T14:30:00.000Z"), db });
  assert.equal(planned, 1);
  const revision = intents.find((intent) => intent.kind === "REVISION_REQUEST");
  assert.ok(revision);
  assert.equal(revision.customSubmissionId, "sub-1");
  assert.equal(revision.state, "PLANNED");
  assert.equal(revision.remoteMessageId, null);
  assert.equal(revision.confirmedAt, null);
  assert.equal(revision.payload.reviewComment, "Legacy manager instruction");

  const retry = await ensureRevisionRequestIntents({ agencyId: "agency-1", member: null, limit: 25, now: new Date("2026-08-21T14:31:00.000Z"), db });
  assert.equal(retry, 0);
  assert.equal(intents.filter((intent) => intent.kind === "REVISION_REQUEST").length, 1);
});

test("commit-time review fence rejects APPROVE when cancellation wins the CustomOrder lock", async () => {
  const { db, member, row } = fixture();
  const originalRaw = db.$queryRawUnsafe;
  db.$queryRawUnsafe = async (...args) => {
    row.customOrder.status = "CANCELLED";
    return originalRaw(...args);
  };
  await assert.rejects(
    () => reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db }),
    (error) => error?.code === "CUSTOM_REVIEW_ORDER_TERMINAL",
  );
  assert.equal(row.reviewStatus, "WAITING_REVIEW");
});

test("decision-convergence migration adds exact revision intent identity without inventing provider success", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  assert.match(schema, /model TelegramDeliveryIntent[\s\S]*customSubmissionId\s+String\?/);
  assert.match(schema, /@@index\(\[agencyId, customSubmissionId, kind, createdAt\]\)/);
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260907163000_custom_content_decision_convergence_authority/migration.sql"), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "customSubmissionId" TEXT/);
  assert.match(migration, /one_revision_request_per_submission_key/);
  assert.match(migration, /kind" = 'REVISION_REQUEST'/);
  assert.match(migration, /CHECK \("kind" IN \('TASK', 'REFERENCE', 'MANUAL_REMINDER', 'AUTO_REMINDER', 'CANCELLATION', 'REVISION_REQUEST'\)\)/);
  assert.match(migration, /no synthetic receipt/i);
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


test("historical revision is not projected as current after a later model response exists", async () => {
  const { db, member, row, rows, assets, intents } = fixture();
  row.receivedAt = new Date("2026-08-21T14:30:00.000Z");
  row.createdAt = new Date("2026-08-21T14:30:00.000Z");
  const oldStamp = new Date("2026-08-21T14:00:00.000Z");
  const historical = {
    ...row,
    id: "sub-v1-revision",
    telegramMessageIds: [90],
    ofMediaIds: ["8999"],
    reviewStatus: "REVISION_REQUESTED",
    reviewComment: "Need another angle",
    reviewedAt: new Date("2026-08-21T14:10:00.000Z"),
    reviewedByMemberId: "manager-1",
    reviewedByMember: { id: "manager-1", displayName: "Manager", roleKey: "manager" },
    receivedAt: oldStamp,
    createdAt: oldStamp,
    updatedAt: oldStamp,
    ...receipt("vault-1", 1, ["8999"], oldStamp),
  };
  rows.unshift(historical);
  assets.push({
    agencyId: "agency-1", creatorId: "creator-1", mediaId: "8999", source: "CUSTOM", customOrderId: "custom-1",
    customSubmissionId: historical.id, customFullPriceCents: 6000, mediaType: "video", thumbUrl: null, previewUrl: null, fullUrl: null,
    folderIds: ["vault-1"], catalogActive: true, sortingStatus: "SORTED",
  });
  intents.push({
    id: "revision-v1-confirmed", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1", customSubmissionId: historical.id,
    accountId: "tg-1", kind: "REVISION_REQUEST", logicalKey: "revision-v1-key", clientIntentId: null, referenceOrdinal: null, payloadFingerprint: "revision-v1-fp", payload: {},
    state: "CONFIRMED", claimRevision: 1, claimUntil: null, commitStartedAt: new Date("2026-08-21T14:10:01.000Z"),
    remoteMessageId: 556, remoteRecipientTelegramUserId: "900001", remoteSentAt: new Date("2026-08-21T14:10:02.000Z"), outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT",
    confirmedAt: new Date("2026-08-21T14:10:02.000Z"), createdAt: new Date("2026-08-21T14:10:00.000Z"), updatedAt: new Date("2026-08-21T14:10:02.000Z"),
  });

  const revisions = await listCustomContentReviewQueue({ agencyId: "agency-1", member, status: "REVISION_REQUESTED", db, limit: 50 });
  assert.deepEqual(revisions.items, [], "V1 is durable history, but V2 already satisfies the current model-response obligation");

  await assert.rejects(
    () => reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: historical.id, action: "REQUEST_REVISION", comment: "Need another angle", db }),
    (error) => error?.code === "CUSTOM_REVIEW_DECISION_SUPERSEDED",
    "a stale exact-id retry must not resurrect the historical V1 revision read-model",
  );
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

test("revision dispatch bulk read cannot let duplicate legacy intents hide another submission's durable state", async () => {
  const { db, member, row, rows, assets, intents } = fixture();
  row.reviewStatus = "REVISION_REQUESTED";
  row.reviewComment = "Redo A";
  row.reviewedAt = new Date("2026-08-21T14:05:00.000Z");
  row.telegramSourceAccountId = "tg-1";
  row.telegramSourceUserId = "900001";

  const orderB = { ...row.customOrder, id: "custom-2", dialogId: "778" };
  const stampB = new Date("2026-08-21T14:20:00.000Z");
  const rowB = {
    ...row, id: "sub-2", customOrderId: orderB.id, customOrder: orderB, telegramMessageIds: [201], ofMediaIds: ["9101"],
    reviewComment: "Redo B", reviewedAt: new Date("2026-08-21T14:21:00.000Z"), receivedAt: stampB, createdAt: stampB, updatedAt: stampB,
    ...receipt("vault-1", 1, ["9101"], stampB),
  };
  rows.push(rowB);
  assets.push({ agencyId: "agency-1", creatorId: "creator-1", mediaId: "9101", source: "CUSTOM", customOrderId: orderB.id, customSubmissionId: rowB.id, customFullPriceCents: 6000, mediaType: "video", thumbUrl: null, previewUrl: null, fullUrl: null, folderIds: ["vault-1"], catalogActive: true, sortingStatus: "SORTED" });

  const revisionBase = {
    agencyId: "agency-1", creatorId: "creator-1", accountId: "tg-1", kind: "REVISION_REQUEST", clientIntentId: null, referenceOrdinal: null,
    state: "CONFIRMED", claimRevision: 1, claimUntil: null, commitStartedAt: new Date("2026-08-21T14:22:00.000Z"), remoteRecipientTelegramUserId: "900001",
    remoteSentAt: new Date("2026-08-21T14:22:01.000Z"), outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT", confirmedAt: new Date("2026-08-21T14:22:01.000Z"), updatedAt: new Date("2026-08-21T14:22:01.000Z"), payload: {},
  };
  intents.push(
    { ...revisionBase, id: "revision-a-new", customOrderId: "custom-1", customSubmissionId: row.id, logicalKey: "revision-a-new", payloadFingerprint: "a-new", remoteMessageId: 601, createdAt: new Date("2026-08-21T14:29:00.000Z") },
    { ...revisionBase, id: "revision-a-old", customOrderId: "custom-1", customSubmissionId: row.id, logicalKey: "revision-a-old", payloadFingerprint: "a-old", remoteMessageId: 600, createdAt: new Date("2026-08-21T14:28:00.000Z") },
    { ...revisionBase, id: "revision-b", customOrderId: "custom-2", customSubmissionId: rowB.id, logicalKey: "revision-b", payloadFingerprint: "b", remoteMessageId: 602, createdAt: new Date("2026-08-21T14:10:00.000Z") },
  );

  const result = await listCustomContentReviewQueue({ agencyId: "agency-1", member, status: "REVISION_REQUESTED", db, limit: 50 });
  assert.equal(result.items.length, 2);
  const byId = new Map(result.items.map((item) => [item.submissionId, item]));
  assert.equal(byId.get("sub-1")?.revisionDispatch.status, "WAITING_MODEL");
  assert.equal(byId.get("sub-2")?.revisionDispatch.status, "WAITING_MODEL", "sub-2 confirmed intent must not disappear behind duplicate sub-1 history");
  assert.equal(byId.get("sub-2")?.revisionDispatch.intentId, "revision-b");
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
    () => reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId: "agency-1", member, submissionId: "sub-1", action: "APPROVE", db }),
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

test("historical reviewed submission without TASK plans revision against its pinned Telegram source thread", async () => {
  const { db, member, row, intents } = fixture();
  intents.splice(0, intents.length); // no canonical TASK exists for this historical import
  row.telegramSourceAccountId = "tg-1";
  row.telegramSourceUserId = "900001";
  row.telegramMessageIds = [101, 102];
  const result = await reviewCustomContentSubmission({
    agencyId: "agency-1", member, submissionId: "sub-1", expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, action: "REQUEST_REVISION", comment: "Redo the historical version", db,
  });
  assert.equal(result.item.reviewStatus, "REVISION_REQUESTED");
  assert.equal(result.item.revisionDispatch.status, "DISPATCH_PENDING");
  const revision = intents.find((intent) => intent.kind === "REVISION_REQUEST");
  assert.ok(revision);
  assert.equal(revision.accountId, "tg-1");
  assert.equal(revision.payload.replyToMessageId, "102");
  assert.equal(revision.payload.recipientTelegramUserId, "900001");
  assert.equal(revision.payload.replyToDeliveryId, null, "pinned provider source is not fabricated into a TASK delivery id");
});

test("revision decision remains durable as DISPATCH_BLOCKED without TASK/source and materializes after provider binding repair", async () => {
  const { db, member, row, intents } = fixture();
  intents.splice(0, intents.length);
  row.telegramSourceAccountId = null;
  row.telegramSourceUserId = null;
  row.telegramMessageIds = [101, 102];

  const blocked = await reviewCustomContentSubmission({
    agencyId: "agency-1", member, submissionId: "sub-1", expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, action: "REQUEST_REVISION", comment: "Revision still required", db,
  });
  assert.equal(row.reviewStatus, "REVISION_REQUESTED", "manager quality decision must commit independently of provider dispatch capability");
  assert.equal(blocked.item.revisionDispatch.status, "DISPATCH_BLOCKED");
  assert.equal(blocked.item.revisionDispatch.blockedCode, "TASK_AND_PINNED_SOURCE_UNAVAILABLE");
  assert.equal(intents.filter((intent) => intent.kind === "REVISION_REQUEST").length, 0);

  const queue = await listCustomContentReviewQueue({ agencyId: "agency-1", member, status: "REVISION_REQUESTED", db, limit: 50 });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].revisionDispatch.status, "DISPATCH_BLOCKED");
  assert.equal(queue.items[0].revisionDispatch.blockedCode, "TASK_AND_PINNED_SOURCE_UNAVAILABLE");

  row.telegramSourceAccountId = "tg-1";
  row.telegramSourceUserId = "900001";
  row.telegramMessageIds = [101, 444];
  const repaired = await reviewCustomContentSubmission({
    agencyId: "agency-1", member, submissionId: "sub-1", expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, action: "REQUEST_REVISION", comment: "Revision still required", db,
  });
  assert.equal(repaired.idempotent, true);
  assert.equal(repaired.item.revisionDispatch.status, "DISPATCH_PENDING");
  const revision = intents.filter((intent) => intent.kind === "REVISION_REQUEST");
  assert.equal(revision.length, 1);
  assert.equal(revision[0].payload.replyToMessageId, "444");
  assert.equal(revision[0].payload.recipientTelegramUserId, "900001");
});

test("review mutation enforces current creator scope, not knowledge of an opaque submission id", async () => {
  const { db, member, currentMember, row } = fixture();
  member.assignedCreators = ["creator-other"];
  currentMember.assignedCreators = ["creator-other"];
  await assert.rejects(
    () => reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId:"agency-1", member, submissionId:row.id, action:"APPROVE", db }),
    (error) => error?.code === "CUSTOM_MANAGEMENT_CREATOR_ACCESS_FORBIDDEN" && error?.status === 403,
  );
  assert.equal(row.reviewStatus, "WAITING_REVIEW");
});

test("review mutation permits the same scoped manager for the assigned creator", async () => {
  const { db, member, currentMember, row } = fixture();
  member.assignedCreators = ["creator-1"];
  currentMember.assignedCreators = ["creator-1"];
  const result = await reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId:"agency-1", member, submissionId:row.id, action:"APPROVE", db });
  assert.equal(result.item.reviewStatus, "APPROVED");
});

test("review mutation rechecks access inside commit transaction after target pre-read", async () => {
  const { db, member, currentMember, row } = fixture();
  member.assignedCreators = ["creator-1"];
  currentMember.assignedCreators = ["creator-1"];
  const normalTransaction = db.$transaction;
  let changedBeforeCommit = false;
  db.$transaction = async (work) => {
    if (!changedBeforeCommit) {
      changedBeforeCommit = true;
      currentMember.assignedCreators = [];
      currentMember.accessEpoch = 2;
    }
    return normalTransaction(work);
  };
  await assert.rejects(
    () => reviewCustomContentSubmission({ expectedCustomOrderId: "custom-1", expectedBindingRevision: 1, agencyId:"agency-1", member, submissionId:row.id, action:"APPROVE", db }),
    (error) => error?.code === "CUSTOM_MANAGEMENT_ACCESS_STALE" && error?.status === 409,
  );
  assert.equal(row.reviewStatus, "WAITING_REVIEW", "stale scope request must not leave a review mutation behind");
});

test("review decisions are durable numbered history, not only mutable submission fields", async () => {
  const { db, member, row, reviewDecisions } = fixture();
  const result = await reviewCustomContentSubmission({
    agencyId: "agency-1", member, submissionId: row.id,
    expectedCustomOrderId: row.customOrderId, expectedBindingRevision: 1,
    action: "REQUEST_REVISION", comment: "Need a cleaner ending", db,
  });
  assert.equal(result.item.reviewStatus, "REVISION_REQUESTED");
  assert.equal(result.item.reviewDecisionRevision, 1);
  assert.equal(row.reviewDecisionRevision, 1);
  assert.equal(reviewDecisions.length, 1);
  assert.deepEqual({
    revision: reviewDecisions[0].decisionRevision,
    decision: reviewDecisions[0].decision,
    supersedes: reviewDecisions[0].supersedesDecisionRevision,
    reason: reviewDecisions[0].supersessionReason,
  }, { revision: 1, decision: "REQUEST_REVISION", supersedes: null, reason: null });
});

test("blocked revision can be explicitly superseded by APPROVE while preserving history and cancelling only precommit work", async () => {
  const { db, member, row, intents, reviewDecisions } = fixture();
  intents.splice(0, intents.length);
  row.telegramSourceAccountId = null;
  row.telegramSourceUserId = null;

  const revision = await reviewCustomContentSubmission({
    agencyId: "agency-1", member, submissionId: row.id,
    expectedCustomOrderId: row.customOrderId, expectedBindingRevision: 1,
    action: "REQUEST_REVISION", comment: "Need another take", db,
  });
  assert.equal(revision.item.revisionDispatch.status, "DISPATCH_BLOCKED");
  assert.equal(row.reviewDecisionRevision, 1);

  intents.push({
    id: "revision-blocked-precommit", agencyId: "agency-1", creatorId: "creator-1", customOrderId: row.customOrderId,
    customSubmissionId: row.id, accountId: "tg-dead", kind: "REVISION_REQUEST", logicalKey: "blocked-revision-key",
    payloadFingerprint: "blocked-fp", payload: {}, state: "PLANNED", claimRevision: 4, claimUntil: null,
    commitStartedAt: null, remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null,
    outcomeReason: "PRECOMMIT_PROVIDER_UNAVAILABLE:ACCOUNT_RETIRED", confirmationAuthority: null, confirmedAt: null,
    createdAt: new Date("2026-08-21T14:31:00.000Z"), updatedAt: new Date("2026-08-21T14:31:00.000Z"),
  });

  const reconsidered = await reviewCustomContentSubmission({
    agencyId: "agency-1", member, submissionId: row.id,
    expectedCustomOrderId: row.customOrderId, expectedBindingRevision: 1, expectedReviewDecisionRevision: 1,
    action: "RECONSIDER_APPROVE", supersessionReason: "PROVIDER_UNRECOVERABLE", db,
  });

  assert.equal(reconsidered.item.reviewStatus, "APPROVED");
  assert.equal(reconsidered.item.reviewDecisionRevision, 2);
  assert.equal(row.reviewDecisionRevision, 2);
  assert.equal(reviewDecisions.length, 2);
  assert.deepEqual(reviewDecisions.map((item) => ({ revision: item.decisionRevision, decision: item.decision, supersedes: item.supersedesDecisionRevision, reason: item.supersessionReason })), [
    { revision: 1, decision: "REQUEST_REVISION", supersedes: null, reason: null },
    { revision: 2, decision: "APPROVE", supersedes: 1, reason: "PROVIDER_UNRECOVERABLE" },
  ]);
  const cancelled = intents.find((item) => item.id === "revision-blocked-precommit");
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.outcomeReason, "REVIEW_DECISION_SUPERSEDED:PROVIDER_UNRECOVERABLE");
  assert.equal(cancelled.claimRevision, 5);
  assert.equal(cancelled.remoteMessageId, null, "reconsideration must not invent provider success");
  assert.equal(cancelled.confirmedAt, null, "reconsideration must not invent provider confirmation");
});

test("reconsideration is rejected while revision provider dispatch is still usable", async () => {
  const { db, member, row } = fixture();
  await reviewCustomContentSubmission({
    agencyId: "agency-1", member, submissionId: row.id,
    expectedCustomOrderId: row.customOrderId, expectedBindingRevision: 1,
    action: "REQUEST_REVISION", comment: "Need another take", db,
  });
  await assert.rejects(
    () => reviewCustomContentSubmission({
      agencyId: "agency-1", member, submissionId: row.id,
      expectedCustomOrderId: row.customOrderId, expectedBindingRevision: 1, expectedReviewDecisionRevision: 1,
      action: "RECONSIDER_APPROVE", supersessionReason: "PROVIDER_UNRECOVERABLE", db,
    }),
    (error) => error?.code === "CUSTOM_REVIEW_RECONSIDERATION_PROVIDER_NOT_BLOCKED" && error?.status === 409,
  );
  assert.equal(row.reviewStatus, "REVISION_REQUESTED");
  assert.equal(row.reviewDecisionRevision, 1);
});

test("reconsideration fences the exact current review decision revision", async () => {
  const { db, member, row } = fixture();
  row.reviewStatus = "REVISION_REQUESTED";
  row.reviewComment = "Old decision";
  row.reviewedAt = new Date("2026-08-21T14:00:00.000Z");
  row.reviewDecisionRevision = 2;
  row.telegramSourceAccountId = null;
  row.telegramSourceUserId = null;
  await assert.rejects(
    () => reviewCustomContentSubmission({
      agencyId: "agency-1", member, submissionId: row.id,
      expectedCustomOrderId: row.customOrderId, expectedBindingRevision: 1, expectedReviewDecisionRevision: 1,
      action: "RECONSIDER_APPROVE", supersessionReason: "MANAGER_RECONSIDERATION", db,
    }),
    (error) => error?.code === "STALE_COMMAND_TARGET" && error?.status === 409,
  );
  assert.equal(row.reviewStatus, "REVISION_REQUESTED");
  assert.equal(row.reviewDecisionRevision, 2);
});

test("reconsideration never cancels committing or reconcile-required revision outcomes", async () => {
  const { db, member, row, intents } = fixture();
  row.reviewStatus = "REVISION_REQUESTED";
  row.reviewComment = "Need revision";
  row.reviewedAt = new Date("2026-08-21T14:00:00.000Z");
  row.reviewDecisionRevision = 1;
  row.telegramSourceAccountId = null;
  row.telegramSourceUserId = null;
  intents.splice(0, intents.length,
    {
      id: "revision-reconcile", agencyId: "agency-1", creatorId: "creator-1", customOrderId: row.customOrderId,
      customSubmissionId: row.id, accountId: "tg-dead", kind: "REVISION_REQUEST", logicalKey: "reconcile-key", payloadFingerprint: "reconcile-fp", payload: {},
      state: "RECONCILE_REQUIRED", claimRevision: 3, claimUntil: null, commitStartedAt: new Date("2026-08-21T14:01:00.000Z"),
      remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null, outcomeReason: "UNKNOWN_EXTERNAL_OUTCOME", confirmationAuthority: null,
      confirmedAt: null, createdAt: new Date("2026-08-21T14:01:00.000Z"), updatedAt: new Date("2026-08-21T14:01:00.000Z"),
    },
  );
  await assert.rejects(
    () => reviewCustomContentSubmission({
      agencyId: "agency-1", member, submissionId: row.id,
      expectedCustomOrderId: row.customOrderId, expectedBindingRevision: 1, expectedReviewDecisionRevision: 1,
      action: "RECONSIDER_APPROVE", supersessionReason: "PROVIDER_UNRECOVERABLE", db,
    }),
    (error) => error?.code === "CUSTOM_REVIEW_RECONSIDERATION_PROVIDER_NOT_BLOCKED",
    "unknown external outcome must remain authoritative and cannot be superseded as provider-unrecoverable precommit work",
  );
  assert.equal(intents[0].state, "RECONCILE_REQUIRED");
  assert.equal(intents[0].claimRevision, 3);
});
