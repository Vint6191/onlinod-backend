"use strict";

const { createHash } = require("node:crypto");
const { runDbTransaction } = require("./db-transaction-service");
const { deriveCustomCancellationInstruction } = require("./custom-cancellation-instruction-authority-service");

const PROVIDER_OPERATIONAL_PROJECTION_VERSION = "provider_operational_debt_v1";
const PROVIDER_OPERATIONAL_BACKFILL_LANE_KEY = "provider_operational_debt_backfill_v1";
const PROVIDER_OPERATIONAL_BACKFILL_GENERATION = "provider_operational_debt_v1";
const PROVIDER_OPERATIONAL_DIRTY_LANE_KEY = "provider_operational_dirty_v1";
const PROVIDER_OPERATIONAL_DIRTY_GENERATION = "provider_operational_debt_v1";
const CUSTOM_EXTERNAL_PROOF_BACKFILL_LANE_KEY = "custom_external_proof_backfill_v1";
const CUSTOM_EXTERNAL_PROOF_BACKFILL_LANE_GENERATION = "custom_external_proof_backfill_v1";
const DEFAULT_BATCH_SIZE = 100;

const DEBT = Object.freeze({
  UNKNOWN_EXTERNAL_OUTCOME: "UNKNOWN_EXTERNAL_OUTCOME",
  PINNED_CANCELLATION_FOLLOWUP: "PINNED_CANCELLATION_FOLLOWUP",
  CURRENT_PROVIDER_THREAD_CAPABILITY: "CURRENT_PROVIDER_THREAD_CAPABILITY",
  CANCELLATION_FOLLOWUP_DEBT: "CANCELLATION_FOLLOWUP_DEBT",
  INCOMPLETE_SOURCE_RELAY: "INCOMPLETE_SOURCE_RELAY",
  CONFIRMED_PROJECTION_DEBT: "CONFIRMED_PROJECTION_DEBT",
  PROVIDER_BINDING_RETRY: "PROVIDER_BINDING_RETRY",
  CUSTOM_EXTERNAL_PROJECTION_DEBT: "CUSTOM_EXTERNAL_PROJECTION_DEBT",
});

// Order reconciliation owns only provider-capability/current-thread semantics.
// External Custom proof projection has its own lifecycle and must never be deleted
// by an order rebuild (R2 ownership boundary).
const ORDER_OWNED_DEBT_CLASSES = Object.freeze([
  DEBT.UNKNOWN_EXTERNAL_OUTCOME,
  DEBT.PINNED_CANCELLATION_FOLLOWUP,
  DEBT.CURRENT_PROVIDER_THREAD_CAPABILITY,
  DEBT.CANCELLATION_FOLLOWUP_DEBT,
  DEBT.INCOMPLETE_SOURCE_RELAY,
  DEBT.CONFIRMED_PROJECTION_DEBT,
  DEBT.PROVIDER_BINDING_RETRY,
]);

function clean(value, max = 180) {
  const out = String(value == null ? "" : value).trim();
  return out ? out.slice(0, max) : "";
}

function bounded(value, fallback = DEFAULT_BATCH_SIZE, max = 1000) {
  const n = Math.floor(Number(value) || fallback);
  return Math.max(1, Math.min(max, n));
}

function debtId({ agencyId, accountId, debtClass, objectType, objectId }) {
  const identity = [agencyId, accountId, debtClass, objectType, objectId].map((v) => clean(v, 500)).join("\u001f");
  return `pod_${createHash("sha256").update(identity).digest("hex").slice(0, 48)}`;
}

function candidate({ agencyId, accountId, creatorId = null, debtClass, objectType, objectId, customOrderId = null, customSubmissionId = null, intentId = null, reason = null }) {
  const row = {
    agencyId: clean(agencyId), accountId: clean(accountId), creatorId: clean(creatorId) || null, debtClass: clean(debtClass, 120), objectType: clean(objectType, 120), objectId: clean(objectId),
    customOrderId: clean(customOrderId) || null, customSubmissionId: clean(customSubmissionId) || null, intentId: clean(intentId) || null,
    reason: clean(reason, 500) || null, sourceVersion: PROVIDER_OPERATIONAL_PROJECTION_VERSION,
  };
  if (!row.agencyId || !row.accountId || !row.debtClass || !row.objectType || !row.objectId) return null;
  row.id = debtId(row);
  return row;
}

function confirmedEffectAt(row) {
  const raw = row?.remoteSentAt || row?.confirmedAt || null;
  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function hasProjectedReference(order, remoteMessageId) {
  const target = Number(remoteMessageId);
  if (!Number.isFinite(target)) return false;
  return new Set((Array.isArray(order?.telegramReferenceMessageIds) ? order.telegramReferenceMessageIds : []).map(Number)).has(target);
}

function intentProjectionDebt({ intent, order }) {
  if (!intent || String(intent.state || "") !== "CONFIRMED") return false;
  if (intent.projectionBlockedAt) return true;
  const kind = String(intent.kind || "");
  if (kind === "TASK") {
    return intent.remoteMessageId != null && (Number(order?.telegramTaskMessageId) !== Number(intent.remoteMessageId) || !order?.deliveredAt);
  }
  if (kind === "REFERENCE") return intent.remoteMessageId != null && !hasProjectedReference(order, intent.remoteMessageId);
  if (["MANUAL_REMINDER", "AUTO_REMINDER"].includes(kind)) {
    const effectAt = confirmedEffectAt(intent);
    if (!effectAt) return false;
    const projected = order?.lastReminderAt ? new Date(order.lastReminderAt) : null;
    return !(projected && Number.isFinite(projected.getTime()) && projected.getTime() >= effectAt.getTime());
  }
  return false;
}

async function loadOrderFacts({ agencyId, orderId, db }) {
  const order = await db.customOrder?.findFirst?.({ where: { agencyId, id: String(orderId) } });
  if (!order) return { order: null, intents: [], submissions: [] };
  const intents = await db.telegramDeliveryIntent?.findMany?.({
    where: { agencyId, customOrderId: String(order.id) },
    select: {
      id: true, agencyId: true, creatorId: true, customOrderId: true, customSubmissionId: true, accountId: true,
      kind: true, state: true, commitStartedAt: true, remoteMessageId: true, remoteRecipientTelegramUserId: true,
      remoteSentAt: true, confirmedAt: true, projectionBlockedAt: true, providerBindingRetryAt: true, outcomeReason: true,
      createdAt: true, updatedAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  }) || [];
  const submissions = await db.customContentSubmission?.findMany?.({
    where: { agencyId, customOrderId: String(order.id) },
    select: {
      id: true, agencyId: true, creatorId: true, customOrderId: true, telegramSourceAccountId: true, telegramSourceUserId: true,
      telegramMessageIds: true, ofMediaIds: true, pipelineDisposition: true, reviewStatus: true, receivedAt: true, createdAt: true,
    },
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  }) || [];
  return { order, intents, submissions };
}

function latest(rows, primary = "createdAt") {
  const stamp = (row) => {
    const raw = row?.[primary] || row?.createdAt || null;
    const date = raw ? new Date(raw) : null;
    return date && Number.isFinite(date.getTime()) ? date.getTime() : Number.NEGATIVE_INFINITY;
  };
  return (rows || []).slice().sort((a, b) => stamp(b) - stamp(a) || String(b?.id || "").localeCompare(String(a?.id || "")))[0] || null;
}

async function buildOrderDebtCandidates({ agencyId, order, intents, submissions, db }) {
  const rows = [];
  const add = (data) => { const row = candidate({ agencyId, creatorId: order?.creatorId || data?.creatorId || null, customOrderId: order?.id || null, ...data }); if (row) rows.push(row); };

  for (const intent of intents || []) {
    const state = String(intent.state || "");
    const kind = String(intent.kind || "");
    if (["COMMITTING", "RECONCILE_REQUIRED"].includes(state)) add({ accountId: intent.accountId, debtClass: DEBT.UNKNOWN_EXTERNAL_OUTCOME, objectType: "TelegramDeliveryIntent", objectId: intent.id, customSubmissionId: intent.customSubmissionId, intentId: intent.id, reason: state });
    if (kind === "CANCELLATION" && ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(state) && intent.commitStartedAt == null) add({ accountId: intent.accountId, debtClass: DEBT.PINNED_CANCELLATION_FOLLOWUP, objectType: "TelegramDeliveryIntent", objectId: intent.id, customSubmissionId: intent.customSubmissionId, intentId: intent.id, reason: state });
    if (intentProjectionDebt({ intent, order })) add({ accountId: intent.accountId, debtClass: DEBT.CONFIRMED_PROJECTION_DEBT, objectType: "TelegramDeliveryIntent", objectId: intent.id, customSubmissionId: intent.customSubmissionId, intentId: intent.id, reason: kind });
    if (intent.providerBindingRetryAt && ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(state)) add({ accountId: intent.accountId, debtClass: DEBT.PROVIDER_BINDING_RETRY, objectType: "TelegramDeliveryIntent", objectId: intent.id, customSubmissionId: intent.customSubmissionId, intentId: intent.id, reason: clean(intent.outcomeReason, 500) || state });
  }

  const orderType = String(order?.type || "CONTENT").toUpperCase();
  const pendingSupported = String(order?.status || "").toUpperCase() === "PENDING" && ["CONTENT", "CALL", "PHYSICAL"].includes(orderType);
  if (pendingSupported) {
    const accountIds = new Set();
    const task = latest((intents || []).filter((row) => String(row.kind) === "TASK" && String(row.state) === "CONFIRMED"), "confirmedAt");
    if (task?.accountId) accountIds.add(String(task.accountId));
    if (orderType === "CONTENT") {
      for (const revision of (intents || []).filter((row) => String(row.kind) === "REVISION_REQUEST" && ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT", "COMMITTING", "RECONCILE_REQUIRED", "CONFIRMED"].includes(String(row.state)))) {
        if (revision.accountId) accountIds.add(String(revision.accountId));
      }
      for (const submission of submissions || []) {
        if (String(submission.pipelineDisposition || "ACTIVE").toUpperCase() !== "ACTIVE") continue;
        if (["WAITING_REVIEW", "REVISION_REQUESTED"].includes(String(submission.reviewStatus || "WAITING_REVIEW").toUpperCase()) && submission.telegramSourceAccountId) accountIds.add(String(submission.telegramSourceAccountId));
        const sourceCount = Array.isArray(submission.telegramMessageIds) ? submission.telegramMessageIds.length : 0;
        const mediaCount = Array.isArray(submission.ofMediaIds) ? submission.ofMediaIds.length : 0;
        if (submission.telegramSourceAccountId && sourceCount > 0 && mediaCount < sourceCount) {
          add({ accountId: submission.telegramSourceAccountId, debtClass: DEBT.INCOMPLETE_SOURCE_RELAY, objectType: "CustomContentSubmission", objectId: submission.id, customSubmissionId: submission.id, reason: "ACTIVE_SOURCE_MEDIA_INCOMPLETE" });
        }
      }
    }
    for (const accountId of accountIds) add({ accountId, debtClass: DEBT.CURRENT_PROVIDER_THREAD_CAPABILITY, objectType: "CustomOrder", objectId: order.id, reason: `CURRENT_PENDING_${orderType}` });
  }

  if (String(order?.status || "").toUpperCase() === "CANCELLED" && !order?.telegramCancellationWaivedAt) {
    const decision = await deriveCustomCancellationInstruction({ agencyId, order, db });
    const instruction = decision?.instruction || null;
    const anchorAccountId = decision?.anchor?.accountId || instruction?.accountId || null;
    if (anchorAccountId && instruction) {
      const cancellation = await db.telegramDeliveryIntent?.findFirst?.({
        where: {
          agencyId, customOrderId: String(order.id), creatorId: String(order.creatorId), accountId: String(anchorAccountId), kind: "CANCELLATION",
          state: { in: ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT", "CONFIRMED"] },
        },
        select: { id: true },
      });
      if (!cancellation) add({ accountId: anchorAccountId, debtClass: DEBT.CANCELLATION_FOLLOWUP_DEBT, objectType: "CustomOrder", objectId: order.id, intentId: instruction.id, reason: String(decision.state || "CANCELLATION_FOLLOWUP_REQUIRED") });
    }
  }

  const uniqueRows = new Map();
  for (const row of rows) uniqueRows.set(row.id, row);
  return [...uniqueRows.values()];
}

async function reconcileProviderOperationalDebtForOrder({ agencyId, orderId, db, now = new Date(), markClean = true } = {}) {
  if (!agencyId || !orderId || !db) throw Object.assign(new Error("Provider operational debt reconciliation requires agencyId/orderId/db"), { code: "PROVIDER_OPERATIONAL_DEBT_SCOPE_REQUIRED" });
  const run = async (tx) => {
    if (typeof tx.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe('SELECT "id" FROM "CustomOrder" WHERE "agencyId"=$1 AND "id"=$2 FOR UPDATE', String(agencyId), String(orderId));
    }
    const facts = await loadOrderFacts({ agencyId, orderId, db: tx });
    if (!facts.order) {
      await tx.providerOperationalDebt?.deleteMany?.({ where: { agencyId, customOrderId: String(orderId), debtClass: { in: ORDER_OWNED_DEBT_CLASSES } } });
      return { ok: true, missing: true, projected: 0 };
    }
    const candidates = await buildOrderDebtCandidates({ agencyId, ...facts, db: tx });
    if (!tx.providerOperationalDebt?.deleteMany || !tx.providerOperationalDebt?.createMany) {
      const error = new Error("ProviderOperationalDebt storage is required"); error.code = "PROVIDER_OPERATIONAL_DEBT_STORAGE_REQUIRED"; throw error;
    }
    await tx.providerOperationalDebt.deleteMany({ where: { agencyId, customOrderId: String(orderId), debtClass: { in: ORDER_OWNED_DEBT_CLASSES } } });
    if (candidates.length) await tx.providerOperationalDebt.createMany({ data: candidates, skipDuplicates: true });
    if (markClean && tx.customOrder?.updateMany) {
      await tx.customOrder.updateMany({
        where: { agencyId, id: String(orderId) },
        data: { providerOperationalDirty: false, providerOperationalProjectedAt: now, providerOperationalProjectionVersion: PROVIDER_OPERATIONAL_PROJECTION_VERSION },
      });
    }
    return { ok: true, missing: false, projected: candidates.length, candidates };
  };
  return runDbTransaction(db, run, { isolationLevel: "Serializable" });
}

async function selectProviderOperationalBackfillBatch({ db, agencyId = null, cursor = null, limit = DEFAULT_BATCH_SIZE } = {}) {
  const take = bounded(limit);
  if (!db?.customOrder?.findMany) return [];
  return db.customOrder.findMany({
    where: { ...(agencyId ? { agencyId: String(agencyId) } : {}), ...(cursor ? { id: { gt: String(cursor) } } : {}) },
    select: { id: true, agencyId: true, creatorId: true, status: true, type: true },
    orderBy: { id: "asc" },
    take,
  });
}

async function selectProviderOperationalDirtyBatch({ db, limit = DEFAULT_BATCH_SIZE } = {}) {
  const take = bounded(limit);
  if (!db?.customOrder?.findMany) return [];
  return db.customOrder.findMany({
    where: { providerOperationalDirty: true },
    select: { id: true, agencyId: true, status: true, type: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take,
  });
}


async function customExternalProofBackfillReady({ db, agencyId } = {}) {
  const { FAMILY: PHASE2_COVERAGE_FAMILY, GENERATION: PHASE2_COVERAGE_GENERATION, phase2CoverageStatus } = require("./phase2-work-coverage-authority-service");
  if (!String(agencyId || "").trim()) return false;
  const status = await phase2CoverageStatus({ db, agencyId: String(agencyId), family: PHASE2_COVERAGE_FAMILY.CUSTOM_EXTERNAL_PROJECTION, generation: PHASE2_COVERAGE_GENERATION.CUSTOM_EXTERNAL_PROJECTION });
  return status.ready;
}

async function providerOperationalBackfillReady({ db, agencyId } = {}) {
  const { FAMILY: PHASE2_COVERAGE_FAMILY, GENERATION: PHASE2_COVERAGE_GENERATION, phase2CoverageStatus } = require("./phase2-work-coverage-authority-service");
  if (!String(agencyId || "").trim()) return false;
  const status = await phase2CoverageStatus({ db, agencyId: String(agencyId), family: PHASE2_COVERAGE_FAMILY.PROVIDER_OPERATIONAL, generation: PHASE2_COVERAGE_GENERATION.PROVIDER_OPERATIONAL });
  return status.ready;
}

async function requireProviderOperationalBackfillReady({ db, agencyId } = {}) {
  const { FAMILY: PHASE2_COVERAGE_FAMILY, GENERATION: PHASE2_COVERAGE_GENERATION, requirePhase2CoverageReady } = require("./phase2-work-coverage-authority-service");
  if (!String(agencyId || "").trim()) {
    const error = new Error("Provider operational coverage requires agency scope"); error.code = "PROVIDER_OPERATIONAL_DEBT_COVERAGE_SCOPE_REQUIRED"; error.status = 500; throw error;
  }
  await requirePhase2CoverageReady({ db, agencyId: String(agencyId), family: PHASE2_COVERAGE_FAMILY.PROVIDER_OPERATIONAL, generation: PHASE2_COVERAGE_GENERATION.PROVIDER_OPERATIONAL, code: "PROVIDER_OPERATIONAL_DEBT_BACKFILL_INCOMPLETE" });
  return true;
}

async function dirtyOrderIdsForAccount({ agencyId, accountId, db, limit = DEFAULT_BATCH_SIZE } = {}) {
  const take = bounded(limit, DEFAULT_BATCH_SIZE, 500);
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `SELECT DISTINCT co."id"
       FROM "CustomOrder" co
       WHERE co."agencyId"=$1
         AND co."providerOperationalDirty"=TRUE
         AND (
           EXISTS (SELECT 1 FROM "TelegramDeliveryIntent" ti WHERE ti."agencyId"=co."agencyId" AND ti."customOrderId"=co."id" AND ti."accountId"=$2)
           OR EXISTS (SELECT 1 FROM "CustomContentSubmission" cs WHERE cs."agencyId"=co."agencyId" AND cs."customOrderId"=co."id" AND cs."telegramSourceAccountId"=$2)
         )
       ORDER BY co."id" ASC
       LIMIT ${take}`,
      String(agencyId), String(accountId),
    );
    return (rows || []).map((row) => String(row.id)).filter(Boolean);
  }
  const rows = await db?.customOrder?.findMany?.({ where: { agencyId, providerOperationalDirty: true }, select: { id: true, providerOperationalDirty: true }, orderBy: { id: "asc" }, take }) || [];
  // Reduced doubles cannot reproduce the production account-reference EXISTS clauses. Treat a
  // row as dirty only when the double explicitly returns the marker; omitted fields are UNKNOWN,
  // not proof of current reconciliation debt.
  return rows.filter((row) => row?.providerOperationalDirty === true).map((row) => String(row.id));
}

async function reconcileDirtyProviderOrdersForAccount({ agencyId, accountId, db, limit = DEFAULT_BATCH_SIZE } = {}) {
  const ids = await dirtyOrderIdsForAccount({ agencyId, accountId, db, limit });
  for (const orderId of ids) await reconcileProviderOperationalDebtForOrder({ agencyId, orderId, db, markClean: false });
  return { reconciled: ids.length, orderIds: ids };
}

async function findStandaloneIncompleteSource({ agencyId, accountId, db }) {
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `SELECT "id"
       FROM "CustomContentSubmission"
       WHERE "agencyId"=$1
         AND "telegramSourceAccountId"=$2
         AND COALESCE("pipelineDisposition", 'ACTIVE')='ACTIVE'
         AND cardinality("telegramMessageIds") > 0
         AND cardinality("ofMediaIds") < cardinality("telegramMessageIds")
       ORDER BY "id" ASC
       LIMIT 1`, String(agencyId), String(accountId),
    );
    return rows?.[0] || null;
  }
  const rows = await db?.customContentSubmission?.findMany?.({
    where: { agencyId, telegramSourceAccountId: String(accountId), pipelineDisposition: "ACTIVE" },
    select: { id: true, telegramMessageIds: true, ofMediaIds: true }, orderBy: { id: "asc" }, take: 100,
  }) || [];
  return rows.find((row) => (row.telegramMessageIds || []).length > 0 && (row.ofMediaIds || []).length < (row.telegramMessageIds || []).length) || null;
}

async function listCurrentIncompleteSourceAccountsForCreators({ agencyId, creatorIds = null, db } = {}) {
  const scopedIds = creatorIds == null ? null : Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : []).map(String).filter(Boolean)));
  if (scopedIds && !scopedIds.length) return [];
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `SELECT DISTINCT "creatorId", "telegramSourceAccountId"
       FROM "CustomContentSubmission"
       WHERE "agencyId"=$1
         AND ($2::text[] IS NULL OR "creatorId" = ANY($2::text[]))
         AND "telegramSourceAccountId" IS NOT NULL
         AND "telegramSourceUserId" IS NOT NULL
         AND COALESCE("pipelineDisposition", 'ACTIVE')='ACTIVE'
         AND cardinality("telegramMessageIds") > 0
         AND cardinality("ofMediaIds") < cardinality("telegramMessageIds")
       ORDER BY "creatorId" ASC, "telegramSourceAccountId" ASC`,
      String(agencyId), scopedIds,
    );
    return (rows || []).map((row) => ({ creatorId: String(row.creatorId), telegramSourceAccountId: String(row.telegramSourceAccountId) }));
  }
  // Reduced test doubles: read a bounded current set and collapse to account identity.
  const rows = await db?.customContentSubmission?.findMany?.({
    where: { agencyId, ...(scopedIds ? { creatorId: { in: scopedIds } } : {}), telegramSourceAccountId: { not: null }, telegramSourceUserId: { not: null }, pipelineDisposition: "ACTIVE" },
    select: { creatorId: true, telegramSourceAccountId: true, telegramMessageIds: true, ofMediaIds: true },
    orderBy: { id: "asc" }, take: 5000,
  }) || [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if ((row.telegramMessageIds || []).length <= 0 || (row.ofMediaIds || []).length >= (row.telegramMessageIds || []).length) continue;
    const key = `${row.creatorId}|${row.telegramSourceAccountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ creatorId: String(row.creatorId), telegramSourceAccountId: String(row.telegramSourceAccountId) });
  }
  return out;
}

async function listProviderOperationalAccountsForCreators({ agencyId, creatorIds = null, db, debtClasses = null } = {}) {
  const scopedIds = creatorIds == null ? null : Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : []).map(String).filter(Boolean)));
  if (scopedIds && !scopedIds.length) return [];
  const classes = Array.isArray(debtClasses) ? Array.from(new Set(debtClasses.map(String).filter(Boolean))) : [];
  if (typeof db?.$queryRawUnsafe === "function") {
    const params = [String(agencyId), scopedIds];
    let classSql = "";
    if (classes.length) { params.push(classes); classSql = ` AND "debtClass" = ANY($${params.length}::text[])`; }
    const rows = await db.$queryRawUnsafe(
      `SELECT DISTINCT "creatorId", "accountId", "debtClass"
       FROM "ProviderOperationalDebt"
       WHERE "agencyId"=$1
         AND ($2::text[] IS NULL OR "creatorId" = ANY($2::text[]))
         AND "accountId" IS NOT NULL${classSql}
       ORDER BY "creatorId" ASC, "accountId" ASC, "debtClass" ASC`,
      ...params,
    );
    return (rows || []).map((row) => ({ creatorId: String(row.creatorId), accountId: String(row.accountId), debtClass: String(row.debtClass) }));
  }
  const rows = await db?.providerOperationalDebt?.findMany?.({
    where: { agencyId, ...(scopedIds ? { creatorId: { in: scopedIds } } : {}), accountId: { not: null }, ...(classes.length ? { debtClass: { in: classes } } : {}) },
    select: { creatorId: true, accountId: true, debtClass: true },
    orderBy: [{ id: "asc" }], take: 5000,
  }) || [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.creatorId}|${row.accountId}|${row.debtClass}`;
    if (!row.accountId || seen.has(key)) continue;
    seen.add(key);
    out.push({ creatorId: String(row.creatorId), accountId: String(row.accountId), debtClass: String(row.debtClass) });
  }
  return out;
}

async function countProviderOperationalDebt({ agencyId, creatorId = null, db, debtClasses = null } = {}) {
  if (!db?.providerOperationalDebt?.count) return 0;
  return db.providerOperationalDebt.count({
    where: { agencyId, ...(creatorId ? { creatorId: String(creatorId) } : {}), ...(Array.isArray(debtClasses) && debtClasses.length ? { debtClass: { in: debtClasses } } : {}) },
  });
}

async function listProviderOperationalDebtForAccount({ agencyId, accountId, db, limit = DEFAULT_BATCH_SIZE, debtClasses = null } = {}) {
  const take = bounded(limit, DEFAULT_BATCH_SIZE, 500);
  if (!db?.providerOperationalDebt?.findMany) return [];
  return db.providerOperationalDebt.findMany({
    where: { agencyId, accountId: String(accountId), ...(Array.isArray(debtClasses) && debtClasses.length ? { debtClass: { in: debtClasses } } : {}) },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take,
  });
}

module.exports = {
  DEBT,
  ORDER_OWNED_DEBT_CLASSES,
  PROVIDER_OPERATIONAL_PROJECTION_VERSION,
  PROVIDER_OPERATIONAL_BACKFILL_LANE_KEY,
  PROVIDER_OPERATIONAL_BACKFILL_GENERATION,
  PROVIDER_OPERATIONAL_DIRTY_LANE_KEY,
  PROVIDER_OPERATIONAL_DIRTY_GENERATION,
  CUSTOM_EXTERNAL_PROOF_BACKFILL_LANE_KEY,
  CUSTOM_EXTERNAL_PROOF_BACKFILL_LANE_GENERATION,
  debtId,
  buildOrderDebtCandidates,
  reconcileProviderOperationalDebtForOrder,
  selectProviderOperationalBackfillBatch,
  selectProviderOperationalDirtyBatch,
  providerOperationalBackfillReady,
  customExternalProofBackfillReady,
  requireProviderOperationalBackfillReady,
  dirtyOrderIdsForAccount,
  reconcileDirtyProviderOrdersForAccount,
  findStandaloneIncompleteSource,
  listCurrentIncompleteSourceAccountsForCreators,
  listProviderOperationalAccountsForCreators,
  countProviderOperationalDebt,
  listProviderOperationalDebtForAccount,
};
