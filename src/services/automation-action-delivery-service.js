"use strict";

const crypto = require("node:crypto");
const { runDbTransaction } = require("./db-transaction-service");
const { readBillingExecutionAccess } = require("./billing-execution-access-service");
const { lockBillingWriteAdmission, assertBillingWriteAdmission, billingActionClaimWhere, isBillingAdmissionError } = require("./billing-write-admission-service");
const prisma = require("../prisma");
const { canUsePermission, isOwner, normalizeAssignedCreators } = require("./team-access-control");
const { requireCreatorAccess, allowedCreatorScope } = require("../middleware/automation-permissions");
const { assertExecutionAccessFence, ExecutionAccessFenceError } = require("./execution-access-fence-service");
const automationControlService = require("./automation-control-service");
const { assertAutomationEnabled, getAutomationControlSnapshot } = automationControlService;
const normalizeFollowBackSettings = automationControlService.normalizeFollowBackSettings || ((value) => value || {});
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { buildAutomationEffectTimeEvidence, sanitizeAutomationSettlementResult } = require("./automation-effect-time-service");
const { validateFollowBackDeliveryCurrent, assertFanCurrentFieldFence } = require("./fan-current-consumer-service");
const { scheduleFanDataPointRefresh } = require("./fan-data-authority-service");
const { createActionFanObservationToken } = require("./fan-observation-token-service");
const {
  FanObservationReadLeaseError,
  FAN_OBSERVATION_READ_LEASE_TTL_MS,
  acquireFanObservationReadLease,
  completeDeliveryFanObservationReadLease,
  releaseDeliveryFanObservationReadLease,
} = require("./fan-observation-read-lease-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { CREATOR_WRITE_LANE_STATUSES } = require("./automation-delivery-statuses");
const { claimPacingRetryAt } = require("./automation-pacing-service");
const {
  FAILURE_CATEGORIES, SAFE_RETRY_CATEGORIES, normalizeFailureCategory, classifyAutomationFailure, automationActionWriteSemantics,
} = require("./automation-failure-taxonomy");
const {
  validateBumpDelivery,
  finalizeBumpSend,
  finalizeBumpDelete,
  finalizeBumpFailure,
  finalizeBumpTerminal,
  prepareBumpRetry,
} = require("./bump-service");
const {
  validateLikeDelivery,
  finalizeLikeSuccess,
  finalizeLikeFailure,
  finalizeLikeTerminal,
  prepareLikeRetry,
} = require("./likes-service");
const {
  validateFollowAutomationDelivery,
  finalizeFollowAutomationSuccess,
  finalizeFollowAutomationFailure,
  finalizeFollowAutomationTerminal,
  prepareFollowAutomationRetry,
} = require("./follow-automation-service");
const {
  validateSfsDelivery,
  finalizeSfsSuccess,
  finalizeSfsFailure,
  finalizeSfsTerminal,
  prepareSfsRetry,
} = require("./sfs-service");
const {
  SFS_MODULE_KEY,
  isSfsCleanupDelivery,
} = require("./sfs-constants");
const {
  FOLLOW_AUTOMATION_MODULE_KEY,
  UNFOLLOW_FAN_ACTION_TYPE,
  FOLLOW_FAN_ACTION_TYPE,
  isFollowRecoveryDelivery,
  mustPreserveRefollowSaga,
} = require("./follow-automation-constants");

const NORMAL_CLAIMABLE_STATUSES = ["QUEUED", "RETRY_SCHEDULED"];
const CLAIMABLE_STATUSES = [...NORMAL_CLAIMABLE_STATUSES, "RECONCILE_REQUIRED"];
const PRECOMMIT_EXECUTABLE_STATUSES = [...NORMAL_CLAIMABLE_STATUSES, "CLAIMED", "RUNNING"];
const LEASED_STATUSES = ["CLAIMED", "RUNNING", "COMMITTING"];
const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "SKIPPED", "CANCELED"];
const DEFAULT_LEASE_MS = 3 * 60_000;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 10 * 60_000;
const MAX_RECONCILIATION_WAIT_MS = 30 * 60_000;
const ACTION_PROFILE_OBSERVATION_PURPOSE = "action_user_profile";
const PROFILE_OBSERVATION_ACTION_TYPES = new Set([
  "FOLLOW_BACK",
  UNFOLLOW_FAN_ACTION_TYPE,
  FOLLOW_FAN_ACTION_TYPE,
  "SFS_FOLLOW_TARGET",
  "SFS_UNFOLLOW_TARGET",
]);

class ActionDeliveryError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "ActionDeliveryError";
    this.code = code;
    this.status = status;
  }
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

async function scheduleValidationFanRefresh(delivery, validation, trigger = "validation") {
  if (!delivery || validation?.refreshRequired !== true) return null;
  const fanIds = [...new Set((validation.refreshFanIds || [delivery.fanId || delivery.targetId])
    .map((value) => clean(value, 160)).filter(Boolean))].slice(0, 500);
  if (!fanIds.length) return null;
  try {
    return await scheduleFanDataPointRefresh({
      agencyId: delivery.agencyId,
      creatorId: delivery.creatorId,
      onlyFansUserIds: fanIds,
      reason: `${delivery.moduleKey || "fan"}_current_refresh_required`,
      priority: 90,
      params: {
        consumer: delivery.moduleKey || "automation",
        trigger,
        ...(Array.isArray(validation.refreshFields) && validation.refreshFields.length
          ? { refreshFields: [...new Set(validation.refreshFields.map((value) => clean(value, 80)).filter(Boolean))] }
          : {}),
      },
    });
  } catch {
    // Admission remains fail-closed even if scheduling itself is temporarily unavailable.
    return null;
  }
}

function validationActionError(delivery, validation, fallbackCode, fallbackMessage) {
  const error = new ActionDeliveryError(validation?.code || fallbackCode, validation?.code || fallbackMessage);
  if (validation?.refreshRequired === true) error.fanRefresh = { delivery, validation };
  if (validation?.terminal === false) {
    error.retryable = true;
    error.retryAt = validation?.retryAt || null;
  }
  return error;
}

function deliveryRequiresReconciliation(delivery) {
  const result = object(delivery?.result);
  return delivery?.status === "RECONCILE_REQUIRED"
    || delivery?.failureCategory === FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE
    || String(result.outcomeState || "").toUpperCase() === "RECONCILE_REQUIRED";
}
function reconciliationStartedAt(delivery, now = new Date()) {
  const result = object(delivery?.result);
  const value = delivery?.writeCommitAt || result.reconciliationStartedAt || delivery?.updatedAt || now;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : now;
}
function reconciliationWindowExpired(delivery, now = new Date()) {
  return now.getTime() - reconciliationStartedAt(delivery, now).getTime() >= MAX_RECONCILIATION_WAIT_MS;
}
function clean(value, max = 1000) { const text = String(value ?? "").trim(); return text ? text.slice(0, max) : null; }
function hashToken(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }
function tokenMatches(token, expectedHash) {
  if (!expectedHash) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(String(expectedHash), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function leaseDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LEASE_MS;
  return Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(parsed)));
}
function retryDelayMs(attempt, failureCode, retryAfterMs) {
  const explicit = Number(retryAfterMs);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(5_000, Math.min(24 * 60 * 60_000, Math.floor(explicit)));
  if (failureCode === "rate_limited") return Math.min(60 * 60_000, 60_000 * Math.max(1, attempt) ** 2);
  return Math.min(30 * 60_000, 30_000 * Math.max(1, attempt));
}
function validDate(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}
function dayStart(date = new Date()) { const out = new Date(date); out.setHours(0, 0, 0, 0); return out; }
function nextDayStart(date = new Date()) { const out = dayStart(date); out.setDate(out.getDate() + 1); return out; }


async function assertDeliveryControl(delivery, { allowRunningUnfollow = false, db = prisma } = {}) {
  if (!delivery) throw new ActionDeliveryError("DELIVERY_NOT_FOUND", "Delivery not found", 404);
  const recovery = isFollowRecoveryDelivery(delivery);
  const sfsCleanup = isSfsCleanupDelivery(delivery);
  const runningUnfollow = allowRunningUnfollow
    && delivery.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY
    && delivery.actionType === UNFOLLOW_FAN_ACTION_TYPE
    && delivery.status === "RUNNING";
  if (!recovery && !sfsCleanup && !runningUnfollow) {
    return assertAutomationEnabled({
      agencyId: delivery.agencyId,
      creatorId: delivery.creatorId,
      moduleKey: delivery.moduleKey,
      db,
    });
  }
  const snapshot = await getAutomationControlSnapshot({
    agencyId: delivery.agencyId,
    creatorId: delivery.creatorId,
    db,
  });
  if (!snapshot.effective.workspaceEnabled) {
    throw new ActionDeliveryError("workspace_disabled", "Automation workspace is disabled");
  }
  if (!snapshot.effective.creatorEnabled) {
    throw new ActionDeliveryError("creator_disabled", "Creator automation is disabled");
  }
  return snapshot;
}

async function requireLiveAutomationManagementActor({ db = prisma, agencyId, actorUserId, creatorId = null }) {
  const userId = clean(actorUserId, 180);
  if (!userId) throw new ActionDeliveryError("AUTOMATION_ACTOR_REQUIRED", "Authenticated automation actor is required", 401);
  const member = await db.agencyMember.findFirst({
    where: { agencyId, userId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null } },
  });
  if (!member) throw new ActionDeliveryError("AUTOMATION_MEMBER_INACTIVE", "Agency membership is no longer active", 403);
  if (!(await canUsePermission({ member, key: "automation.manage", db }))) {
    throw new ActionDeliveryError("WRITE_AUTOMATION_FORBIDDEN", "automation.manage permission is required", 403);
  }
  if (creatorId) {
    await requireCreatorAccess({ agencyId, member, creatorId, db });
  }
  return { member };
}

async function requireOwnedSeniorDevice({ userId, deviceId, db = prisma }) {
  const device = await db.workerDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== userId) throw new ActionDeliveryError("NOT_YOUR_DEVICE", "Invalid device", 403);
  const member = await db.agencyMember.findFirst({
    where: { agencyId: device.agencyId, userId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null } },
  });
  if (!member) throw new ActionDeliveryError("DEVICE_AGENCY_ACCESS_REVOKED", "Device agency access was revoked", 403);
  if (!(await canUsePermission({ member, key: "automation.manage", db }))) throw new ActionDeliveryError("WRITE_AUTOMATION_FORBIDDEN", "automation.manage permission is required", 403);
  return { device, member };
}

async function scopedReadyCreatorIds({ device, member }) {
  if (!member) return [];
  const scope = normalizeAssignedCreators(member.assignedCreators);
  const broad = isOwner(member) || scope.mode === "all";
  const visible = await prisma.creatorAccount.findMany({
    where: {
      agencyId: device.agencyId,
      deletedAt: null,
      status: "READY",
      ...(!broad ? { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } } : {}),
    },
    select: { id: true },
  });
  const ids = visible.map((item) => item.id);
  if (!ids.length) return [];
  const freshAfter = new Date(Date.now() - 2 * 60_000);
  const bindings = await prisma.deviceCreatorBinding.findMany({
    where: {
      agencyId: device.agencyId,
      deviceId: device.id,
      status: "ACTIVE",
      sessionWriteReady: true,
      lastSeenAt: { gte: freshAfter },
      creatorId: { in: ids },
    },
    select: { creatorId: true },
  });
  return bindings.map((item) => item.creatorId);
}

async function sweepExpiredAutomationLeases(input = new Date()) {
  const options = input instanceof Date ? { now: input } : (input || {});
  const client = options.db || prisma;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const agencyId = clean(options.agencyId, 180);
  const creatorIds = Array.isArray(options.creatorIds) ? [...new Set(options.creatorIds.map(String).filter(Boolean))] : null;
  const scopeWhere = {
    originKind: "AUTOMATION",
    ...(agencyId ? { agencyId } : {}),
    ...(creatorIds ? { creatorId: { in: creatorIds.length ? creatorIds : ["__none__"] } } : {}),
  };
  const rows = await client.automationDelivery.findMany({
    where: { ...scopeWhere, status: { in: LEASED_STATUSES }, claimUntil: { lt: now } },
    select: {
      id: true, agencyId: true, creatorId: true, moduleKey: true, actionType: true, fanId: true, targetId: true,
      payload: true, contentCollectionId: true, status: true, failureCode: true, failureCategory: true, writeCommitAt: true,
      attempts: true, maxAttempts: true, result: true, leaseRevision: true, generation: true, notBefore: true,
    }, orderBy: [{ claimUntil: "asc" }, { id: "asc" }], take: 100,
  });
  let changed = 0;
  const terminalizeUnresolved = async (row, where) => {
    const failureCode = "outcome_unresolved_do_not_retry";
    const result = { ...object(row.result), outcomeState: "UNRESOLVED_DO_NOT_RETRY", unresolvedClosedAt: now.toISOString(), unresolvedCloseReason: "MAINTENANCE_RECONCILIATION_WINDOW_EXPIRED" };
    const updated = await runDbTransaction(client, async (tx) => {
      const changedRow = await tx.automationDelivery.updateMany({ where, data: {
        status: "FAILED", failureCode, failureCategory: FAILURE_CATEGORIES.TERMINAL,
        lastError: "Reconciliation evidence remained insufficient beyond the bounded verification window; logical commit closed permanently without retry",
        finishedAt: now, claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 }, lastCheckedAt: now, result,
      } });
      if (!changedRow.count) return null;
      if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
        await tx.fanObservationReadLease.deleteMany({
          where: { deliveryId: row.id, leaseRevision: row.leaseRevision },
        });
      }
      const current = await tx.automationDelivery.findUnique({ where: { id: row.id } });
      await updateModuleCandidateProgress(current, "FAILED", failureCode, tx);
      await updateCandidateFromTerminal(current, "FAILED", failureCode, tx);
      if (current?.moduleKey === "bumps") await finalizeBumpFailure({ delivery: current, failureCode, retryable: false, db: tx });
      if (current?.moduleKey === "likes") await finalizeLikeFailure({ delivery: current, failureCode, retryable: false, result, db: tx });
      if (current?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) await finalizeFollowAutomationFailure({ delivery: current, failureCode, retryable: false, db: tx });
      if (current?.moduleKey === SFS_MODULE_KEY) await finalizeSfsFailure({ delivery: current, failureCode, retryable: false, db: tx });
      return current;
    }, { timeout: 30_000 });
    if (updated) changed += 1;
    return Boolean(updated);
  };
  for (const row of rows) {
    const committing = row.status === "COMMITTING";
    const reconciliationLease = !committing && deliveryRequiresReconciliation(row);
    const mustReconcile = committing || reconciliationLease;
    if (mustReconcile && reconciliationWindowExpired(row, now)) {
      if (await terminalizeUnresolved(row, { id: row.id, status: row.status, leaseRevision: row.leaseRevision, claimUntil: { lt: now } })) continue;
    }
    const failureCode = committing ? "write_outcome_unknown" : (reconciliationLease ? "reconciliation_lease_lost" : "lease_lost");
    const failureCategory = mustReconcile ? FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE : classifyAutomationFailure({ failureCode, deliveryStatus: row.status, provenNoEffect: true, endpointSemantics: automationActionWriteSemantics(row.actionType) });
    const safetySaga = mustPreserveRefollowSaga(row, failureCode) || isSfsCleanupDelivery(row);
    const terminal = !mustReconcile && !safetySaga && row.attempts >= row.maxAttempts;
    const retryAt = new Date(now.getTime() + retryDelayMs(row.attempts || 1, failureCode));
    const nextStatus = mustReconcile ? "RECONCILE_REQUIRED" : (terminal ? "FAILED" : "RETRY_SCHEDULED");
    const nextResult = {
      ...object(row.result), failureCode, failureCategory, outcomeState: mustReconcile ? "RECONCILE_REQUIRED" : "PROVEN_NO_EFFECT", leaseExpiredAt: now.toISOString(),
      ...(mustReconcile ? { reconciliationStartedAt: object(row.result).reconciliationStartedAt || row.writeCommitAt?.toISOString?.() || now.toISOString() } : {}),
      ...(row.actionType === "SEND_MESSAGE" && mustReconcile ? { phase: "send" } : {}),
    };
    const latest = await runDbTransaction(client, async (tx) => {
      const updated = await tx.automationDelivery.updateMany({
        where: { id: row.id, status: row.status, leaseRevision: row.leaseRevision, claimUntil: { lt: now } },
        data: { status: nextStatus, failureCode, failureCategory, lastError: mustReconcile ? "Action outcome must be reconciled after lost commit/reconciliation lease" : "Action lease expired", notBefore: terminal ? row.notBefore : retryAt, finishedAt: terminal ? now : null, claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 }, result: nextResult },
      });
      if (!updated.count) return null;
      if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
        await tx.fanObservationReadLease.deleteMany({
          where: { deliveryId: row.id, leaseRevision: row.leaseRevision },
        });
      }
      const current = await tx.automationDelivery.findUnique({ where: { id: row.id } });
      await updateModuleCandidateProgress(current, nextStatus, failureCode, tx);
      if (!mustReconcile) {
        if (current?.moduleKey === "bumps" && terminal) await finalizeBumpFailure({ delivery: current, failureCode, retryable: false, db: tx });
        if (current?.moduleKey === "likes") await finalizeLikeFailure({ delivery: current, failureCode, retryable: !terminal, result: nextResult, db: tx });
        if (current?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) await finalizeFollowAutomationFailure({ delivery: current, failureCode, retryable: !terminal, db: tx });
        if (current?.moduleKey === SFS_MODULE_KEY) await finalizeSfsFailure({ delivery: current, failureCode, retryable: !terminal, db: tx });
      }
      return current;
    }, { timeout: 30_000 });
    if (latest) changed += 1;
  }
  // Stranded reconciliation rows have no lease timestamp, so they need an
  // explicit bounded sweep or they would hold the global creator lane forever.
  const stranded = await client.automationDelivery.findMany({
    where: { ...scopeWhere, status: "RECONCILE_REQUIRED", claimUntil: null,
      OR: [{ writeCommitAt: { lte: new Date(now.getTime() - MAX_RECONCILIATION_WAIT_MS) } }, { writeCommitAt: null, updatedAt: { lte: new Date(now.getTime() - MAX_RECONCILIATION_WAIT_MS) } }] },
    select: { id: true, agencyId: true, creatorId: true, moduleKey: true, actionType: true, fanId: true, targetId: true, payload: true, status: true, result: true, failureCode: true, writeCommitAt: true, updatedAt: true, leaseRevision: true, attempts: true, maxAttempts: true },
    orderBy: [{ writeCommitAt: "asc" }, { id: "asc" }], take: 100,
  });
  for (const row of stranded) {
    if (reconciliationWindowExpired(row, now)) await terminalizeUnresolved(row, { id: row.id, status: "RECONCILE_REQUIRED", leaseRevision: row.leaseRevision, claimUntil: null });
  }
  return changed;
}

async function sweepExpiredActionLeases(input = new Date()) {
  const options = input instanceof Date ? { now: input } : (input || {});
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const { sweepExpiredProgrammaticWriteLeases } = require("./programmatic-of-write-authority-service");
  const [automationChanged, programmaticChanged] = await Promise.all([
    sweepExpiredAutomationLeases({ now, agencyId: options.agencyId, creatorIds: options.creatorIds }),
    sweepExpiredProgrammaticWriteLeases({ now, agencyId: options.agencyId, creatorIds: options.creatorIds }),
  ]);
  return automationChanged + programmaticChanged;
}

const ACTION_FAIR_CANDIDATES_SQL = `/* phase4_action_fairness */
    SELECT candidate.* FROM unnest($2::text[]) AS scope(id)
    CROSS JOIN LATERAL (
      SELECT d.* FROM "AutomationDelivery" d
      WHERE d."agencyId"=$1 AND d."creatorId"=scope.id AND d."originKind"='AUTOMATION'
        AND d."status" IN ('QUEUED','RETRY_SCHEDULED','RECONCILE_REQUIRED')
        AND d."actionType"=ANY($3::text[]) AND d."notBefore"<=$4 AND d."claimUntil" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "AutomationDelivery" busy WHERE busy."agencyId"=d."agencyId" AND busy."creatorId"=d."creatorId"
          AND busy."id"<>d."id" AND busy."status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED'))
        AND (d."creatorId"=ANY($5::text[]) OR d."status"='RECONCILE_REQUIRED'
          OR COALESCE(d."failureCategory",'')='OUTCOME_UNKNOWN_RECONCILE' OR d."result"->>'outcomeState'='RECONCILE_REQUIRED')
        AND (d."attempts"<d."maxAttempts" OR d."status"='RECONCILE_REQUIRED'
          OR COALESCE(d."failureCategory",'')='OUTCOME_UNKNOWN_RECONCILE' OR d."result"->>'outcomeState'='RECONCILE_REQUIRED'
          OR (d."moduleKey"='follow' AND (d."actionType"='FOLLOW_FAN' AND d."payload"->>'recovery'='true'
            OR d."actionType"='UNFOLLOW_FAN' AND (d."result" ? 'attemptStartedAt'
              OR d."failureCode" IN ('network_error','timeout','temporary_of_error','of_temporary_error','backend_unavailable','lease_lost'))))
          OR d."moduleKey"='sfs' AND d."actionType"='SFS_UNFOLLOW_TARGET')
      ORDER BY (d."status"='RECONCILE_REQUIRED' OR COALESCE(d."failureCategory",'')='OUTCOME_UNKNOWN_RECONCILE' OR COALESCE(d."result"->>'outcomeState','')='RECONCILE_REQUIRED') DESC,
        d."priority" DESC,d."notBefore",d."createdAt",d."id" LIMIT 1
    ) candidate
    LEFT JOIN LATERAL (SELECT d."claimedAt" FROM "AutomationDelivery" d
      WHERE d."agencyId"=$1 AND d."creatorId"=scope.id AND d."originKind"='AUTOMATION' AND d."claimedAt" IS NOT NULL
      ORDER BY d."claimedAt" DESC LIMIT 1) claim ON true
    LEFT JOIN LATERAL (SELECT d."finishedAt" FROM "AutomationDelivery" d
      WHERE d."agencyId"=$1 AND d."creatorId"=scope.id AND d."originKind"='AUTOMATION' AND d."status"='COMPLETED' AND d."finishedAt" IS NOT NULL
      ORDER BY d."finishedAt" DESC LIMIT 1) finish ON true
    ORDER BY (candidate."status"='RECONCILE_REQUIRED' OR COALESCE(candidate."failureCategory",'')='OUTCOME_UNKNOWN_RECONCILE' OR COALESCE(candidate."result"->>'outcomeState','')='RECONCILE_REQUIRED') DESC,
      candidate."priority" DESC,GREATEST(claim."claimedAt",finish."finishedAt") ASC NULLS FIRST,
      candidate."notBefore",candidate."createdAt",candidate."id" LIMIT 100`;

async function fairCandidates({ agencyId, creatorIds, actionTypes, now, billingWhere }) {
  const paidIds = billingWhere.OR[0].creatorId.in;
  // One candidate per creator before the global page, so a busy/blocked
  // creator cannot hide all other creators behind its queue prefix.
  // Two ordered index probes replace the historical COMPLETED groupBy.
  return prisma.$queryRawUnsafe(ACTION_FAIR_CANDIDATES_SQL, agencyId, creatorIds, actionTypes, now, paidIds);
}

async function updateCandidateProgress(delivery, status, failureCode = null, db = prisma, claimOwnership = false) {
  if (!delivery || delivery.moduleKey !== "follow_back" || !(delivery.targetId || delivery.fanId)) return;
  await db.followBackCandidate.updateMany({
    where: {
      agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.targetId || delivery.fanId,
      ...(claimOwnership ? {} : { OR: [{ latestDeliveryId: null }, { latestDeliveryId: delivery.id }] }),
    },
    data: { state: status, latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status, latestError: failureCode },
  });
}

async function updateLikeCandidateProgress(delivery, status, failureCode = null, db = prisma, claimOwnership = false) {
  if (!delivery || delivery.moduleKey !== "likes") return;
  const contentId = delivery.targetId || clean(object(delivery.payload).postId, 160);
  if (!contentId) return;
  await db.automationContentCandidate.updateMany({
    where: {
      agencyId: delivery.agencyId, creatorId: delivery.creatorId, contentType: "post", contentId,
      ...(claimOwnership ? {} : { OR: [{ latestDeliveryId: null }, { latestDeliveryId: delivery.id }] }),
    },
    data: { state: status, latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status, latestError: failureCode },
  });
}

async function updateFollowAutomationCandidateProgress(delivery, status, failureCode = null, db = prisma, claimOwnership = false) {
  if (!delivery || delivery.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY) return;
  const fanId = delivery.targetId || delivery.fanId;
  if (!fanId) return;
  const phase = delivery.actionType === FOLLOW_FAN_ACTION_TYPE ? (status === "FAILED" ? "RECOVERY" : "FOLLOW") : "UNFOLLOW";
  const state = delivery.actionType === FOLLOW_FAN_ACTION_TYPE
    ? (status === "RUNNING" ? "FOLLOWING" : "QUEUED_FOLLOW")
    : (status === "RUNNING" ? "UNFOLLOWING" : "QUEUED_UNFOLLOW");
  await db.followAutomationCandidate.updateMany({
    where: {
      agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId,
      ...(claimOwnership ? {} : { OR: [{ latestDeliveryId: null }, { latestDeliveryId: delivery.id }] }),
    },
    data: { state, phase, latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status, latestError: failureCode },
  });
}

async function updateSfsCandidateProgress(delivery, status, failureCode = null, db = prisma, claimOwnership = false) {
  if (!delivery || delivery.moduleKey !== SFS_MODULE_KEY) return;
  const candidateId = clean(object(delivery.payload).candidateId, 160);
  if (!candidateId) return;
  await db.sfsTargetCandidate.updateMany({
    where: {
      id: candidateId, agencyId: delivery.agencyId, creatorId: delivery.creatorId,
      ...(claimOwnership ? {} : { OR: [{ latestDeliveryId: null }, { latestDeliveryId: delivery.id }] }),
    },
    data: {
      state: isSfsCleanupDelivery(delivery) ? (status === "RUNNING" ? "UNFOLLOWING" : "UNFOLLOW_DUE")
        : delivery.actionType === "SFS_FOLLOW_TARGET" ? (status === "RUNNING" ? "FOLLOWING" : "QUEUED")
          : (status === "RUNNING" ? "ACTING" : status),
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status, latestError: failureCode,
    },
  });
}

async function updateModuleCandidateProgress(delivery, status, failureCode = null, db = prisma, claimOwnership = false) {
  await updateCandidateProgress(delivery, status, failureCode, db, claimOwnership);
  await updateLikeCandidateProgress(delivery, status, failureCode, db, claimOwnership);
  await updateFollowAutomationCandidateProgress(delivery, status, failureCode, db, claimOwnership);
  await updateSfsCandidateProgress(delivery, status, failureCode, db, claimOwnership);
}

async function deferOrSkipFollowBackClaim(delivery, control, now) {
  if (delivery.actionType !== "FOLLOW_BACK") return false;
  const state = await prisma.subscriberDirectoryState.findFirst({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, status: "READY" },
    select: { currentRunId: true },
  });
  const candidate = await prisma.followBackCandidate.findFirst({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.targetId || delivery.fanId },
  });
  let code = null;
  let terminalStatus = "SKIPPED";
  if (!candidate) code = "invalid_target";
  else if (candidate.blocked) { code = "blocked"; terminalStatus = "CANCELED"; }
  else if (candidate.ignored) { code = "ignored"; terminalStatus = "CANCELED"; }
  else if (!state?.currentRunId || candidate.snapshotRunId !== state.currentRunId || candidate.state === "STALE") code = "stale_candidate";
  else if (candidate.subscribedByCreator === true) code = "already_followed";

  if (code) {
    return runDbTransaction(prisma, async (tx) => {
      const updated = await tx.automationDelivery.updateMany({
        where: { id: delivery.id, status: { in: NORMAL_CLAIMABLE_STATUSES } },
        data: {
          status: terminalStatus,
          failureCode: code,
          lastError: code,
          finishedAt: now,
          claimUntil: null,
          leaseTokenHash: null,
          leaseRevision: { increment: 1 },
        },
      });
      if (!updated.count) return true;
      const latest = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
      await updateCandidateFromTerminal(latest, terminalStatus, code, tx);
      return true;
    });
  }

  const dailyLimit = Number(control.modules?.follow_back?.settings?.dailyLimit || 0);
  const completedToday = await prisma.automationDelivery.count({
    where: {
      agencyId: delivery.agencyId,
      creatorId: delivery.creatorId,
      moduleKey: "follow_back",
      actionType: "FOLLOW_BACK",
      status: "COMPLETED",
      finishedAt: { gte: dayStart(now) },
    },
  });
  if (completedToday >= dailyLimit) {
    return runDbTransaction(prisma, async (tx) => {
      const updated = await tx.automationDelivery.updateMany({
        where: { id: delivery.id, status: { in: NORMAL_CLAIMABLE_STATUSES } },
        data: {
          status: "RETRY_SCHEDULED",
          failureCode: "daily_limit",
          lastError: "Follow Back daily limit reached",
          notBefore: nextDayStart(now),
        },
      });
      if (!updated.count) return true;
      const latest = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
      await updateCandidateProgress(latest, "RETRY_SCHEDULED", "daily_limit", tx);
      return true;
    });
  }
  return false;
}

async function applyBumpValidationTransition(delivery, validation, now = new Date(), executionAccess = null) {
  if (!delivery || delivery.moduleKey !== "bumps" || validation?.ok !== false) return false;
  const terminal = validation.terminal === true;
  const status = terminal ? (validation.status || "SKIPPED") : "RETRY_SCHEDULED";
  return runDbTransaction(prisma, async (tx) => {
    if (executionAccess?.userId) await lockDeliveryExecutionAccess({ db: tx, delivery, userId: executionAccess.userId });
    const changed = await tx.automationDelivery.updateMany({
      where: {
        id: delivery.id,
        status: { in: PRECOMMIT_EXECUTABLE_STATUSES },
        leaseRevision: delivery.leaseRevision,
      },
      data: {
        status,
        failureCode: validation.code || "bump_validation_failed",
        lastError: validation.code || "bump_validation_failed",
        notBefore: terminal ? delivery.notBefore : (validation.retryAt || new Date(now.getTime() + 30_000)),
        finishedAt: terminal ? now : null,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
        lastCheckedAt: now,
      },
    });
    if (!changed.count) return false;
    if (terminal) {
      const latest = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
      await finalizeBumpTerminal({
        delivery: latest,
        status,
        failureCode: validation.code || "bump_validation_failed",
        db: tx,
      });
    }
    return true;
  });
}

async function applyLikeValidationTransition(delivery, validation, now = new Date(), executionAccess = null) {
  if (!delivery || delivery.moduleKey !== "likes" || validation?.ok !== false) return false;
  const terminal = validation.terminal === true;
  const status = terminal ? (validation.status || "SKIPPED") : "RETRY_SCHEDULED";
  return runDbTransaction(prisma, async (tx) => {
    if (executionAccess?.userId) await lockDeliveryExecutionAccess({ db: tx, delivery, userId: executionAccess.userId });
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: PRECOMMIT_EXECUTABLE_STATUSES }, leaseRevision: delivery.leaseRevision },
      data: {
        status,
        failureCode: validation.code || "like_validation_failed",
        lastError: validation.code || "like_validation_failed",
        notBefore: terminal ? delivery.notBefore : (validation.retryAt || new Date(now.getTime() + 30_000)),
        finishedAt: terminal ? now : null,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
        lastCheckedAt: now,
        result: { ...object(delivery.result), validationCode: validation.code || "like_validation_failed" },
      },
    });
    if (!changed.count) return false;
    const latest = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    if (terminal) await finalizeLikeTerminal({ delivery: latest, status, failureCode: validation.code || "like_validation_failed", result: latest?.result || {}, db: tx });
    else await tx.automationContentCandidate.updateMany({
      where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, contentType: "post", contentId: delivery.targetId },
      data: { state: "ELIGIBLE", latestStatus: status, latestError: validation.code || "like_validation_failed" },
    });
    return true;
  });
}

async function applyFollowAutomationValidationTransition(delivery, validation, now = new Date(), executionAccess = null) {
  if (!delivery || delivery.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY || validation?.ok !== false) return false;
  const terminal = validation.terminal === true;
  const status = terminal ? (validation.status || "SKIPPED") : "RETRY_SCHEDULED";
  return runDbTransaction(prisma, async (tx) => {
    if (executionAccess?.userId) await lockDeliveryExecutionAccess({ db: tx, delivery, userId: executionAccess.userId });
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: PRECOMMIT_EXECUTABLE_STATUSES }, leaseRevision: delivery.leaseRevision },
      data: {
        status,
        failureCode: validation.code || "follow_validation_failed",
        lastError: validation.code || "follow_validation_failed",
        notBefore: terminal ? delivery.notBefore : (validation.retryAt || new Date(now.getTime() + 30_000)),
        finishedAt: terminal ? now : null,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
        lastCheckedAt: now,
        result: { ...object(delivery.result), validationCode: validation.code || "follow_validation_failed" },
      },
    });
    if (!changed.count) return false;
    const latest = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    if (terminal) {
      await finalizeFollowAutomationTerminal({
        delivery: latest,
        status,
        failureCode: validation.code || "follow_validation_failed",
        db: tx,
      });
    } else {
      await tx.followAutomationCandidate.updateMany({
        where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.targetId || delivery.fanId },
        data: { latestStatus: status, latestError: validation.code || "follow_validation_failed" },
      });
    }
    return true;
  });
}

async function applySfsValidationTransition(delivery, validation, now = new Date(), executionAccess = null) {
  const status = validation.terminal === true ? (validation.code === "already_unfollowed" ? "COMPLETED" : "SKIPPED") : "RETRY_SCHEDULED";
  const retryAt = validation.retryAt || new Date(now.getTime() + 30_000);
  return runDbTransaction(prisma, async (tx) => {
    if (executionAccess?.userId) await lockDeliveryExecutionAccess({ db: tx, delivery, userId: executionAccess.userId });
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: PRECOMMIT_EXECUTABLE_STATUSES }, leaseRevision: delivery.leaseRevision },
      data: {
        status,
        notBefore: status === "RETRY_SCHEDULED" ? retryAt : delivery.notBefore,
        failureCode: validation.code || "sfs_validation_failed",
        lastError: validation.code || "SFS validation failed",
        finishedAt: ["COMPLETED", "SKIPPED"].includes(status) ? now : null,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
      },
    });
    if (!changed.count) return false;
    const latest = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    if (["COMPLETED", "SKIPPED"].includes(status)) {
      if (status === "COMPLETED") await finalizeSfsSuccess({ delivery: latest, outcomeCode: validation.code, result: { idempotent: true }, db: tx, now });
      else await finalizeSfsTerminal({ delivery: latest, status, failureCode: validation.code, db: tx });
    }
    return true;
  }, { timeout: 30_000 });
}

async function claimActionDelivery({ userId, deviceId, leaseMs, actionTypes = ["FOLLOW_BACK", "SEND_MESSAGE", "DELETE_MESSAGE", "LIKE_POST", "UNFOLLOW_FAN", "FOLLOW_FAN", "SFS_FOLLOW_TARGET", "SFS_COMMENT_POST", "SFS_LIKE_COMMENT", "SFS_UNFOLLOW_TARGET"] }) {
  const { device, member } = await requireOwnedSeniorDevice({ userId, deviceId });
  if (!device.lastSeenAt || device.lastSeenAt < new Date(Date.now() - 5 * 60_000)) return { delivery: null, reason: "device_stale" };
  const creatorIds = await scopedReadyCreatorIds({ device, member });
  if (creatorIds.length) await sweepExpiredActionLeases({ now: new Date(), agencyId: device.agencyId, creatorIds });
  if (!creatorIds.length) return { delivery: null, reason: "no_ready_creator" };
  const allowedActionTypes = [...new Set((Array.isArray(actionTypes) ? actionTypes : []).map((item) => clean(item, 80)).filter(Boolean))];
  if (!allowedActionTypes.length) return { delivery: null, reason: "no_capabilities" };
  // claimedAt is a fallback causal generation for action profile observations.
  // Keep it on the same PostgreSQL clock authority as attemptStartedAt.
  const now = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  const billingAccess = await readBillingExecutionAccess({ db: prisma, agencyId: device.agencyId, creatorIds });
  const candidates = await fairCandidates({ agencyId: device.agencyId, creatorIds, actionTypes: allowedActionTypes, now, billingWhere: billingActionClaimWhere(billingAccess) });
  for (const candidate of candidates) {
    const reconciliationClaim = deliveryRequiresReconciliation(candidate);
    let control = null;
    if (!reconciliationClaim) {
      try {
        control = await assertDeliveryControl(candidate);
      } catch {
        continue;
      }
      if (await deferOrSkipFollowBackClaim(candidate, control, now)) continue;
      const actionSettings = candidate.moduleKey === "bumps"
        ? control.modules.bumps.settings
        : candidate.moduleKey === "follow_back"
          ? control.modules.follow_back.settings
          : candidate.moduleKey === "likes"
            ? control.modules.likes.settings
            : candidate.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY
              ? control.modules.follow.settings
              : candidate.moduleKey === SFS_MODULE_KEY
                ? control.modules.sfs.settings
                : {
                  minimumIntervalMs: control.workspace.settings.globalWriteMinIntervalMs,
                  maximumIntervalMs: control.workspace.settings.globalWriteMaxIntervalMs,
                  randomJitter: control.workspace.settings.randomJitter,
                };
      const pacingRetryAt = await claimPacingRetryAt({
        delivery: candidate,
        workspaceSettings: control.workspace.settings,
        actionSettings,
        now,
      });
      if (pacingRetryAt) {
        await prisma.automationDelivery.updateMany({
          where: { id: candidate.id, status: candidate.status, leaseRevision: candidate.leaseRevision },
          data: { status: "RETRY_SCHEDULED", notBefore: pacingRetryAt, failureCode: "write_pacing", lastError: null },
        });
        continue;
      }
      if (candidate.moduleKey === "bumps") {
        const validation = await validateBumpDelivery({ delivery: candidate, control, now });
        if (validation.ok === false) {
          if (validation.refreshRequired === true) await scheduleValidationFanRefresh(candidate, validation, "claim");
          await applyBumpValidationTransition(candidate, validation, now);
          continue;
        }
      }
      if (candidate.moduleKey === "likes") {
        const validation = await validateLikeDelivery({ delivery: candidate, control, now });
        if (validation.ok === false) {
          if (validation.refreshRequired === true) await scheduleValidationFanRefresh(candidate, validation, "claim");
          await applyLikeValidationTransition(candidate, validation, now);
          continue;
        }
      }
      if (candidate.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
        const validation = await validateFollowAutomationDelivery({ delivery: candidate, control, now });
        if (validation.ok === false) {
          if (validation.refreshRequired === true) await scheduleValidationFanRefresh(candidate, validation, "claim");
          await applyFollowAutomationValidationTransition(candidate, validation, now);
          continue;
        }
      }
      if (candidate.moduleKey === SFS_MODULE_KEY) {
        const validation = await validateSfsDelivery({ delivery: candidate, control, now });
        if (validation.ok === false) {
          if (validation.refreshRequired === true) await scheduleValidationFanRefresh(candidate, validation, "claim");
          await applySfsValidationTransition(candidate, validation, now);
          continue;
        }
      }
    }

    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const claimUntil = new Date(now.getTime() + leaseDuration(leaseMs));
    try {
      const claimed = await runDbTransaction(prisma, async (tx) => {
        await lockBillingWriteAdmission({ db: tx, agencyId: candidate.agencyId });
        await assertExecutionAccessFence({ db: tx, userId, agencyId: candidate.agencyId, memberId: member.id, accessEpoch: Number(member.accessEpoch || 1), creatorId: candidate.creatorId, lock: true });
        if (!reconciliationClaim) await assertBillingWriteAdmission({ db: tx, agencyId: candidate.agencyId, creatorId: candidate.creatorId });
        // Legacy Audit13 rows may still be RETRY_SCHEDULED while carrying the
        // durable OUTCOME_UNKNOWN_RECONCILE category. They must block unrelated
        // writes just like RECONCILE_REQUIRED until they are reconciled.
        if (!reconciliationClaim) {
          const unresolved = await tx.automationDelivery.findFirst({
            where: {
              agencyId: candidate.agencyId,
              creatorId: candidate.creatorId,
              id: { not: candidate.id },
              OR: [
                { status: "RECONCILE_REQUIRED" },
                { failureCategory: FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE },
              ],
            },
            select: { id: true },
          });
          if (unresolved) return null;
        }
        const updated = await tx.automationDelivery.updateMany({
          where: { id: candidate.id, status: candidate.status, notBefore: { lte: now }, claimUntil: null, leaseRevision: candidate.leaseRevision },
          data: {
            status: "CLAIMED", claimedByDeviceId: device.id, claimedAt: now, claimUntil,
            leaseTokenHash: hashToken(leaseToken), leaseRevision: { increment: 1 },
            leaseMemberId: member.id, leaseAccessEpoch: Number(member.accessEpoch || 1),
            ...(reconciliationClaim ? {} : { attempts: { increment: 1 } }), lastError: null,
            ...(reconciliationClaim ? { result: { ...object(candidate.result), reconciliationClaimedAt: now.toISOString(), outcomeState: "RECONCILE_REQUIRED", reconciliationStartedAt: object(candidate.result).reconciliationStartedAt || candidate.writeCommitAt?.toISOString?.() || now.toISOString() } } : {}),
          },
        });
        if (!updated.count) return null;
        const current = await tx.automationDelivery.findUnique({ where: { id: candidate.id } });
        if (current) await updateModuleCandidateProgress(current, reconciliationClaim ? "RECONCILE_REQUIRED" : "CLAIMED", null, tx, true);
        return current;
      }, { timeout: 30_000 });
      if (!claimed) continue;
      return {
        reason: "claimed",
        delivery: {
          id: claimed.id, agencyId: claimed.agencyId, creatorId: claimed.creatorId, moduleKey: claimed.moduleKey,
          actionType: claimed.actionType, targetId: claimed.targetId || claimed.fanId, fanId: claimed.fanId, dialogId: claimed.dialogId,
          idempotencyKey: claimed.idempotencyKey, generation: claimed.generation, priority: claimed.priority,
          payload: object(claimed.payload), result: object(claimed.result), createdAt: claimed.createdAt, scheduledAt: claimed.scheduledAt,
          messageId: claimed.messageId, sentAt: claimed.sentAt, cancelAt: claimed.cancelAt, contentCollectionId: claimed.contentCollectionId,
          trigger: claimed.trigger, attempt: claimed.attempts, maxAttempts: claimed.maxAttempts, notBefore: claimed.notBefore,
          leaseUntil: claimed.claimUntil, leaseToken, leaseRevision: claimed.leaseRevision, leaseAccessEpoch: claimed.leaseAccessEpoch,
          failureCode: claimed.failureCode || null, failureCategory: claimed.failureCategory || null,
          writeCommitRevision: Number(claimed.writeCommitRevision || 0), reconciliationRequired: reconciliationClaim,
        },
      };
    } catch (error) {
      if (isBillingAdmissionError(error)) continue;
      if (error?.code === "P2002" || String(error?.message || "").includes("creator_write_lease_unique")) continue;
      throw error;
    }
  }
  return { delivery: null, reason: "no_work" };
}

async function requireLease({ deliveryId, userId, deviceId, leaseToken, leaseRevision, allowTerminal = false, allowExpired = false, allowCommittedSettlement = false, lockAccess = false, billingAdmission = false, db = prisma }) {
  const { device, member } = await requireOwnedSeniorDevice({ userId, deviceId, db });
  const delivery = await db.automationDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) throw new ActionDeliveryError("DELIVERY_NOT_FOUND", "Delivery not found", 404);
  if (delivery.originKind !== "AUTOMATION") {
    throw new ActionDeliveryError("DELIVERY_WRONG_AUTHORITY", "Programmatic write deliveries must use ProgrammaticOfWriteAuthority", 403);
  }
  if (delivery.agencyId !== device.agencyId) throw new ActionDeliveryError("DELIVERY_DEVICE_AGENCY_MISMATCH", "Delivery belongs to another agency", 403);
  if (billingAdmission && lockAccess) await lockBillingWriteAdmission({ db, agencyId: delivery.agencyId, creatorId: delivery.creatorId });
  const terminal = TERMINAL_STATUSES.includes(delivery.status);
  if (!(LEASED_STATUSES.includes(delivery.status) || (allowTerminal && terminal))) {
    throw new ActionDeliveryError("DELIVERY_NOT_CLAIMED", `Delivery status is ${delivery.status}`);
  }
  if (delivery.claimedByDeviceId !== deviceId) throw new ActionDeliveryError("DELIVERY_CLAIMED_BY_OTHER", "Delivery is claimed by another device");
  if (!tokenMatches(leaseToken, delivery.leaseTokenHash)) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery lease token is stale");
  if (!Number.isInteger(leaseRevision) || delivery.leaseRevision !== leaseRevision) throw new ActionDeliveryError("DELIVERY_LEASE_REVISION_STALE", "Delivery lease revision is stale");
  const committedSettlement = allowCommittedSettlement && delivery.status === "COMMITTING" && delivery.writeCommitAt;
  if (!allowExpired && !terminal && !committedSettlement && (!delivery.claimUntil || delivery.claimUntil.getTime() <= Date.now())) {
    throw new ActionDeliveryError("DELIVERY_LEASE_EXPIRED", "Delivery lease expired");
  }
  try {
    if (!committedSettlement) {
      await assertExecutionAccessFence({
        userId, agencyId: device.agencyId, memberId: delivery.leaseMemberId,
        accessEpoch: delivery.leaseAccessEpoch, creatorId: delivery.creatorId, db, lock: lockAccess === true,
      });
    }
  } catch (error) {
    if (error instanceof ExecutionAccessFenceError) throw new ActionDeliveryError(error.code, error.message, error.status);
    throw error;
  }
  if (billingAdmission && delivery.status !== "COMMITTING" && !deliveryRequiresReconciliation(delivery)) {
    await assertBillingWriteAdmission({ db, agencyId: delivery.agencyId, creatorId: delivery.creatorId });
  }
  return delivery;
}

async function lockDeliveryExecutionAccess({ db, delivery, userId }) {
  if (delivery.status === "COMMITTING" && delivery.writeCommitAt) return;
  try {
    await assertExecutionAccessFence({
      db, userId, agencyId: delivery.agencyId, memberId: delivery.leaseMemberId,
      accessEpoch: delivery.leaseAccessEpoch, creatorId: delivery.creatorId, lock: true,
    });
  } catch (error) {
    if (error instanceof ExecutionAccessFenceError) throw new ActionDeliveryError(error.code, error.message, error.status);
    throw error;
  }
}

function actionReadLeaseError(error) {
  if (error instanceof FanObservationReadLeaseError) {
    const wrapped = new ActionDeliveryError(error.code, error.message, error.status);
    if (Number.isFinite(Number(error.retryAfterMs))) wrapped.retryAfterMs = Number(error.retryAfterMs);
    return wrapped;
  }
  return error;
}

async function lockCurrentActionProfileLease({ db, delivery, deviceId, leaseToken, leaseRevision, now }) {
  const rows = await db.$queryRawUnsafe(`
    SELECT "id" FROM "AutomationDelivery"
    WHERE "id" = $1
      AND "status" = 'RUNNING'
      AND "claimedByDeviceId" = $2
      AND "leaseTokenHash" = $3
      AND "leaseRevision" = $4
      AND "claimUntil" > $5
    FOR UPDATE
  `, delivery.id, deviceId, hashToken(leaseToken), Number(leaseRevision), now);
  if (!rows?.[0]) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery changed before profile observation read boundary", 409);
}

async function acquireActionProfileObservationReadLease({ deliveryId, userId, deviceId, leaseToken, leaseRevision, db = prisma }) {
  const now = await dbAuthorityNow({ db, fallbackNow: new Date() });
  return runDbTransaction(db, async (tx) => {
    const delivery = await requireLease({ deliveryId, userId, deviceId, leaseToken, leaseRevision, db: tx, lockAccess: true });
    if (delivery.status !== "RUNNING") throw new ActionDeliveryError("FAN_DATA_OBSERVATION_DELIVERY_NOT_RUNNING", "Profile observation read lease requires a RUNNING delivery", 409);
    if (!PROFILE_OBSERVATION_ACTION_TYPES.has(String(delivery.actionType || ""))) {
      throw new ActionDeliveryError("FAN_DATA_OBSERVATION_ACTION_SCOPE_FORBIDDEN", "Delivery action is not allowed to observe USER_PROFILE", 403);
    }
    if (Number(object(delivery.result).profileObservationReadLeaseVersion || 0) < 1) {
      throw new ActionDeliveryError("FAN_OBSERVATION_READ_LEASE_NOT_REQUIRED", "Delivery does not use the cross-device profile observation read lease", 409);
    }
    await lockCurrentActionProfileLease({ db: tx, delivery, deviceId, leaseToken, leaseRevision, now });
    const requestId = `obs-read-action:${delivery.id}:${delivery.leaseRevision}:${ACTION_PROFILE_OBSERVATION_PURPOSE}`;
    try {
      return await acquireFanObservationReadLease({
        db: tx, deliveryId: delivery.id, agencyId: delivery.agencyId, creatorId: delivery.creatorId, deviceId,
        leaseRevision, purpose: ACTION_PROFILE_OBSERVATION_PURPOSE, requestId,
      });
    } catch (error) { throw actionReadLeaseError(error); }
  }, { timeout: 30_000 });
}

async function releaseActionProfileObservationReadLease({ deliveryId, userId, deviceId, leaseToken, leaseRevision, readLeaseToken, db = prisma }) {
  // Release is deliberately allowed after the delivery itself changed/expired:
  // the read-lease token + delivery/device/revision tuple is the cleanup authority.
  // This prevents admin release / lease expiry racing an in-flight OF read from
  // parking the entire creator observation lane until TTL.
  const { device } = await requireOwnedSeniorDevice({ userId, deviceId, db });
  const delivery = await db.automationDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) return { released: false };
  if (delivery.agencyId !== device.agencyId) throw new ActionDeliveryError("DELIVERY_DEVICE_AGENCY_MISMATCH", "Delivery belongs to another agency", 403);
  try {
    return await releaseDeliveryFanObservationReadLease({ db, delivery, deviceId, leaseRevision, readLeaseToken });
  } catch (error) { throw actionReadLeaseError(error); }
}

async function authorizeActionProfileObservation({
  deliveryId,
  userId,
  deviceId,
  leaseToken,
  leaseRevision,
  creatorId,
  onlyFansUserIds = [],
  db = prisma,
}) {
  const delivery = await requireLease({
    deliveryId,
    userId,
    deviceId,
    leaseToken,
    leaseRevision,
    db,
    lockAccess: true,
  });
  if (delivery.creatorId !== creatorId) {
    throw new ActionDeliveryError("FAN_DATA_OBSERVATION_CREATOR_SCOPE_MISMATCH", "Profile observation creator does not match the active delivery", 403);
  }
  if (!PROFILE_OBSERVATION_ACTION_TYPES.has(String(delivery.actionType || ""))) {
    throw new ActionDeliveryError("FAN_DATA_OBSERVATION_ACTION_SCOPE_FORBIDDEN", "Delivery action is not allowed to publish a USER_PROFILE observation", 403);
  }
  const targetId = clean(delivery.targetId || delivery.fanId, 180);
  const fanIds = [...new Set((Array.isArray(onlyFansUserIds) ? onlyFansUserIds : []).map((value) => clean(value, 180)).filter(Boolean))];
  if (!targetId || fanIds.length !== 1 || fanIds[0] !== targetId) {
    throw new ActionDeliveryError("FAN_DATA_OBSERVATION_TARGET_SCOPE_MISMATCH", "Profile observation fan does not match the active delivery target", 403);
  }
  const attemptStartedAt = validDate(object(delivery.result).attemptStartedAt, validDate(delivery.claimedAt, validDate(delivery.createdAt, null)));
  if (!attemptStartedAt) {
    throw new ActionDeliveryError("FAN_DATA_OBSERVATION_CAUSAL_GENERATION_MISSING", "Active delivery is missing its server-owned observation generation", 409);
  }
  return { delivery, targetId, causalObservedAt: attemptStartedAt };
}

async function issueActionProfileObservationToken({
  deliveryId,
  userId,
  deviceId,
  leaseToken,
  leaseRevision,
  readLeaseToken = null,
  db = prisma,
}) {
  const now = await dbAuthorityNow({ db, fallbackNow: new Date() });
  return runDbTransaction(db, async (tx) => {
    const delivery = await requireLease({
      deliveryId, userId, deviceId, leaseToken, leaseRevision, lockAccess: true, db: tx,
    });
    if (delivery.status !== "RUNNING") {
      throw new ActionDeliveryError("FAN_DATA_OBSERVATION_DELIVERY_NOT_RUNNING", "Profile observation token requires a RUNNING delivery", 409);
    }
    if (!PROFILE_OBSERVATION_ACTION_TYPES.has(String(delivery.actionType || ""))) {
      throw new ActionDeliveryError("FAN_DATA_OBSERVATION_ACTION_SCOPE_FORBIDDEN", "Delivery action is not allowed to observe USER_PROFILE", 403);
    }
    const targetId = clean(delivery.targetId || delivery.fanId, 180);
    if (!targetId) {
      throw new ActionDeliveryError("FAN_DATA_OBSERVATION_TARGET_SCOPE_MISSING", "Profile observation delivery is missing its target fan", 409);
    }
    const readLeaseRequired = Number(object(delivery.result).profileObservationReadLeaseVersion || 0) >= 1;
    if (readLeaseRequired) {
      if (!clean(readLeaseToken, 500)) {
        throw new ActionDeliveryError("FAN_OBSERVATION_READ_LEASE_REQUIRED", "Profile observation token requires the active cross-device read lease", 409);
      }
      await lockCurrentActionProfileLease({ db: tx, delivery, deviceId, leaseToken, leaseRevision, now });
      try {
        const issued = await completeDeliveryFanObservationReadLease({
          db: tx, delivery, deviceId, leaseRevision, readLeaseToken,
          purpose: ACTION_PROFILE_OBSERVATION_PURPOSE, subjects: [targetId],
        });
        return { ok: true, token: issued.token, observedAt: issued.observedAt, targetId };
      } catch (error) { throw actionReadLeaseError(error); }
    }
    const issued = await createActionFanObservationToken({
      db: tx, delivery, deviceId, leaseRevision, purpose: ACTION_PROFILE_OBSERVATION_PURPOSE, subjects: [targetId],
    });
    return { ok: true, token: issued.token, observedAt: issued.observedAt, targetId };
  }, { timeout: 30_000 });
}

async function renewActionLease(input) {
  return runDbTransaction(prisma, async (tx) => {
    const delivery = await requireLease({ ...input, db: tx, lockAccess: true });
    if (delivery.status !== "COMMITTING" && !deliveryRequiresReconciliation(delivery)) await assertDeliveryControl(delivery, { allowRunningUnfollow: true, db: tx });
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const nextLeaseUntil = new Date(now.getTime() + leaseDuration(input.leaseMs));
    const result = await tx.automationDelivery.updateMany({
      where: {
        id: delivery.id,
        status: { in: LEASED_STATUSES },
        claimedByDeviceId: input.deviceId,
        leaseTokenHash: hashToken(input.leaseToken),
        leaseRevision: input.leaseRevision,
        claimUntil: { gt: now },
      },
      data: { claimUntil: nextLeaseUntil, lastCheckedAt: now },
    });
    if (!result.count) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery lease changed before renewal");
    if (typeof tx.fanObservationReadLease?.updateMany === "function") {
      await tx.fanObservationReadLease.updateMany({
        where: { deliveryId: delivery.id, deviceId: input.deviceId, leaseRevision: input.leaseRevision },
        data: { expiresAt: new Date(now.getTime() + FAN_OBSERVATION_READ_LEASE_TTL_MS) },
      });
    }
    return { ok: true, id: delivery.id, leaseRevision: delivery.leaseRevision, leaseUntil: nextLeaseUntil };
  }, { timeout: 30_000 });
}

async function startActionDelivery(input) {
  const running = await runDbTransaction(prisma, async (tx) => {
    // attemptStartedAt remains rollout compatibility only for deliveries that
    // were already RUNNING before this server cutover. For every newly-started
    // profile-reading action the Backend itself marks post-provider-read tokens
    // mandatory; client capability input is informational, never chronology authority.
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const delivery = await requireLease({ ...input, db: tx, lockAccess: true, billingAdmission: true });
    const reconciliationLease = deliveryRequiresReconciliation(delivery);
    if (!reconciliationLease) await assertDeliveryControl(delivery, { db: tx });
    if (delivery.notBefore.getTime() > now.getTime()) throw new ActionDeliveryError("DELIVERY_NOT_DUE", "Delivery is not due yet");
    if (delivery.status === "RUNNING") return delivery;
    if (delivery.status === "COMMITTING") throw new ActionDeliveryError("DELIVERY_ALREADY_COMMITTING", "Delivery already crossed the write commit boundary");
    const updated = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "CLAIMED", leaseRevision: input.leaseRevision, claimedByDeviceId: input.deviceId },
      data: { status: "RUNNING", lastCheckedAt: now, result: { ...object(delivery.result), ...(reconciliationLease ? { outcomeState: "RECONCILE_REQUIRED", reconciliationStartedAt: object(delivery.result).reconciliationStartedAt || delivery.writeCommitAt?.toISOString?.() || now.toISOString() } : { attemptStartedAt: now.toISOString() }), ...(PROFILE_OBSERVATION_ACTION_TYPES.has(String(delivery.actionType || "")) ? { profileObservationTokenVersion: 1, profileObservationReadLeaseVersion: 1 } : {}), attemptLeaseRevision: delivery.leaseRevision } },
    });
    if (!updated.count) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery changed before start");
    const current = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    await updateModuleCandidateProgress(current, reconciliationLease ? "RECONCILE_REQUIRED" : "RUNNING", null, tx);
    return current;
  }, { timeout: 30_000 });
  return { ok: true, delivery: running };
}

async function validateActionDelivery(input) {
  const delivery = await requireLease(input);
  if (deliveryRequiresReconciliation(delivery)) return { ok: true, id: delivery.id, status: delivery.status, leaseRevision: delivery.leaseRevision, reconciliationRequired: true };
  const control = await assertDeliveryControl(delivery);
  if (delivery.moduleKey === "follow_back") {
    const validation = await validateFollowBackDeliveryCurrent({
      db: prisma,
      delivery,
      settings: normalizeFollowBackSettings(control.modules.follow_back.settings),
      now: new Date(),
    });
    if (validation.ok === false) {
      if (validation.refreshRequired === true) await scheduleValidationFanRefresh(delivery, validation, "validate");
      throw validationActionError(delivery, validation, "FOLLOW_BACK_VALIDATION_FAILED", "Follow Back delivery validation failed");
    }
  }
  if (delivery.moduleKey === "bumps") {
    const validation = await validateBumpDelivery({ delivery, control, now: new Date() });
    if (validation.ok === false) {
      if (validation.refreshRequired === true) await scheduleValidationFanRefresh(delivery, validation, "validate");
      await applyBumpValidationTransition(delivery, validation, new Date(), { userId: input.userId });
      throw validationActionError(delivery, validation, "BUMP_VALIDATION_FAILED", "Bump delivery validation failed");
    }
  }
  if (delivery.moduleKey === "likes") {
    const validation = await validateLikeDelivery({ delivery, control, now: new Date() });
    if (validation.ok === false) {
      if (validation.refreshRequired === true) await scheduleValidationFanRefresh(delivery, validation, "validate");
      await applyLikeValidationTransition(delivery, validation, new Date(), { userId: input.userId });
      throw validationActionError(delivery, validation, "LIKE_VALIDATION_FAILED", "Like delivery validation failed");
    }
  }
  if (delivery.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
    const validation = await validateFollowAutomationDelivery({ delivery, control, now: new Date() });
    if (validation.ok === false) {
      if (validation.refreshRequired === true) await scheduleValidationFanRefresh(delivery, validation, "validate");
      await applyFollowAutomationValidationTransition(delivery, validation, new Date(), { userId: input.userId });
      throw validationActionError(delivery, validation, "FOLLOW_AUTOMATION_VALIDATION_FAILED", "Follow Automation delivery validation failed");
    }
  }
  if (delivery.moduleKey === SFS_MODULE_KEY) {
    const validation = await validateSfsDelivery({ delivery, control, now: new Date() });
    if (validation.ok === false) {
      if (validation.refreshRequired === true) await scheduleValidationFanRefresh(delivery, validation, "validate");
      await applySfsValidationTransition(delivery, validation, new Date(), { userId: input.userId });
      throw validationActionError(delivery, validation, "SFS_VALIDATION_FAILED", "SFS delivery validation failed");
    }
  }
  return { ok: true, id: delivery.id, status: delivery.status, leaseRevision: delivery.leaseRevision, control: control.effective };
}

async function prepareWriteActionDelivery(input) {
  try {
    return await runDbTransaction(prisma, async (tx) => {
    let delivery = await requireLease({ ...input, db: tx, lockAccess: true, billingAdmission: true });
    await lockAutomationWriteCommitFence({ db: tx, agencyId: delivery.agencyId, creatorId: delivery.creatorId });
    // The control writer holds the same transaction-scoped fence. Re-read the
    // lease after acquiring it so a queued control/revoke transition cannot
    // race a stale pre-lock delivery snapshot into COMMITTING.
    delivery = await requireLease({ ...input, db: tx, lockAccess: true });
    if (delivery.status === "COMMITTING" && delivery.writeCommitAt) {
      return { ok: true, duplicate: true, id: delivery.id, status: delivery.status, leaseRevision: delivery.leaseRevision, writeCommitRevision: delivery.writeCommitRevision, writeCommitAt: delivery.writeCommitAt };
    }
    if (deliveryRequiresReconciliation(delivery)) throw new ActionDeliveryError("DELIVERY_RECONCILIATION_REQUIRED", "Delivery must prove the previous external write outcome before another write permit");
    if (delivery.status !== "RUNNING") throw new ActionDeliveryError("DELIVERY_NOT_RUNNING", `Delivery status is ${delivery.status}`);
    const control = await assertDeliveryControl(delivery, { db: tx });
    let now = (await assertBillingWriteAdmission({ db: tx, agencyId: delivery.agencyId, creatorId: delivery.creatorId })).now;
    let fanCurrentFence = null;
    if (delivery.moduleKey === "follow_back") {
      const validation = await validateFollowBackDeliveryCurrent({
        db: tx,
        delivery,
        settings: normalizeFollowBackSettings(control.modules.follow_back.settings),
        now,
      });
      if (validation.ok === false) throw validationActionError(delivery, validation, "FOLLOW_BACK_VALIDATION_FAILED", "Follow Back delivery validation failed");
      fanCurrentFence = validation.fanCurrentFence || fanCurrentFence;
    }
    if (delivery.moduleKey === "bumps") {
      const validation = await validateBumpDelivery({ delivery, control, now, db: tx });
      if (validation.ok === false) throw validationActionError(delivery, validation, "BUMP_VALIDATION_FAILED", "Bump delivery validation failed");
      fanCurrentFence = validation.fanCurrentFence || fanCurrentFence;
    }
    if (delivery.moduleKey === "likes") {
      const validation = await validateLikeDelivery({ delivery, control, now, db: tx });
      if (validation.ok === false) throw validationActionError(delivery, validation, "LIKE_VALIDATION_FAILED", "Like delivery validation failed");
      fanCurrentFence = validation.fanCurrentFence || fanCurrentFence;
    }
    if (delivery.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
      const validation = await validateFollowAutomationDelivery({ delivery, control, now, db: tx });
      if (validation.ok === false) throw validationActionError(delivery, validation, "FOLLOW_AUTOMATION_VALIDATION_FAILED", "Follow Automation delivery validation failed");
      fanCurrentFence = validation.fanCurrentFence || fanCurrentFence;
    }
    if (delivery.moduleKey === SFS_MODULE_KEY) {
      const validation = await validateSfsDelivery({ delivery, control, now, db: tx });
      if (validation.ok === false) {
        const error = validationActionError(delivery, validation, "SFS_VALIDATION_FAILED", "SFS delivery validation failed");
        if (validation.code === "already_followed") error.sfsTerminal = { delivery, validation };
        throw error;
      }
      fanCurrentFence = validation.fanCurrentFence || fanCurrentFence;
    }
    if (fanCurrentFence) {
      const currentFence = await assertFanCurrentFieldFence({ db: tx, agencyId: delivery.agencyId, fence: fanCurrentFence });
      if (currentFence.ok === false) {
        const error = new ActionDeliveryError("FAN_CURRENT_COMMIT_FENCE_STALE", "Required fan current fields changed before write commit permit");
        error.fanCurrentChangedFields = currentFence.changedFields || [];
        throw error;
      }
    }
    // Re-read the DB clock after potentially slow consumer validation. The Agency
    // share lock acquired before membership prevents a concurrent hold/refund.
    now = (await assertBillingWriteAdmission({ db: tx, agencyId: delivery.agencyId, creatorId: delivery.creatorId })).now;
    // Transaction-local proof for the DB release fence. Set only after current
    // consumer/access/field validation; old replicas cannot mint a new permit.
    await tx.$executeRawUnsafe(
      "SELECT set_config('onlinod.phase3_fan_consumer_generation',$1,true)",
      "phase3_fan_consumer_v1_current_bounded",
    );
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "RUNNING", claimedByDeviceId: input.deviceId, leaseTokenHash: hashToken(input.leaseToken), leaseRevision: input.leaseRevision, claimUntil: { gt: now } },
      data: {
        status: "COMMITTING", writeCommitRevision: { increment: 1 }, writeCommitAt: now, lastCheckedAt: now,
        result: { ...object(delivery.result), writeCommitGrantedAt: now.toISOString(), writeCommitLeaseRevision: delivery.leaseRevision },
      },
    });
    if (!changed.count) throw new ActionDeliveryError("DELIVERY_COMMIT_PERMIT_STALE", "Delivery changed before write commit permit");
    const committing = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    return { ok: true, duplicate: false, id: committing.id, status: committing.status, leaseRevision: committing.leaseRevision, writeCommitRevision: committing.writeCommitRevision, writeCommitAt: committing.writeCommitAt };
    }, { timeout: 30_000 });
  } catch (error) {
    if (error?.sfsTerminal?.delivery && error?.sfsTerminal?.validation) {
      await applySfsValidationTransition(error.sfsTerminal.delivery, error.sfsTerminal.validation, new Date(), { userId: input.userId });
    }
    if (error?.fanRefresh?.delivery && error?.fanRefresh?.validation) {
      await scheduleValidationFanRefresh(error.fanRefresh.delivery, error.fanRefresh.validation, "prepare_write");
    }
    throw error;
  }
}

function relationshipEffectRefreshTarget(delivery) {
  if (!delivery?.creatorId || !(delivery.targetId || delivery.fanId)) return null;
  const result = object(delivery.result);
  if (result.fanDataReconcileRequired !== true) return null;
  const action = String(delivery.actionType || "");
  const code = String(result.code || delivery.failureCode || "").trim().toLowerCase();
  // SFS compensation ownership is stricter than desired-state observation.
  // An ambiguous/already-followed completion may prove current provider state via
  // USER_PROFILE feedback, but it must never masquerade as a known owned write.
  if (action === "SFS_FOLLOW_TARGET" && code !== "followed") return null;
  if (!["FOLLOW_BACK", "FOLLOW_FAN", "SFS_FOLLOW_TARGET", "UNFOLLOW_FAN", "SFS_UNFOLLOW_TARGET"].includes(action)) return null;
  return {
    agencyId: delivery.agencyId,
    creatorId: delivery.creatorId,
    onlyFansUserId: delivery.targetId || delivery.fanId,
    deliveryId: delivery.id,
    effectCausalLowerAt: clean(result.effectCausalLowerAt, 120),
    effectCausalUpperAt: clean(result.effectCausalUpperAt, 120),
  };
}

async function ensureRelationshipEffectFanRefresh(delivery) {
  const target = relationshipEffectRefreshTarget(delivery);
  if (!target) return null;
  return scheduleFanDataPointRefresh({
    agencyId: target.agencyId,
    creatorId: target.creatorId,
    onlyFansUserIds: [target.onlyFansUserId],
    reason: "automation_relationship_effect_reconcile",
    priority: 110,
    params: {
      causalBarrierKey: `automation-effect:${target.deliveryId}`,
      sourceDeliveryId: target.deliveryId,
      effectCausalLowerAt: target.effectCausalLowerAt,
      effectCausalUpperAt: target.effectCausalUpperAt,
    },
  });
}

async function updateCandidateFromTerminal(delivery, status, failureCode, db = prisma) {
  if (delivery.moduleKey !== "follow_back" || !delivery.targetId) return;
  const candidateState = status === "COMPLETED"
    ? "FOLLOWED"
    : status === "SKIPPED"
      ? (failureCode === "already_followed" ? "FOLLOWED" : "SKIPPED")
      : status;
  await db.followBackCandidate.updateMany({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.targetId, OR: [{ latestDeliveryId: null }, { latestDeliveryId: delivery.id }] },
    data: {
      state: candidateState,
      subscribedByCreator: status === "COMPLETED" || failureCode === "already_followed" ? true : undefined,
      latestDeliveryId: delivery.id,
      latestActionType: delivery.actionType,
      latestStatus: status,
      latestError: failureCode || null,
      eligibilityReason: status === "COMPLETED" || failureCode === "already_followed" ? "already_followed" : undefined,
    },
  });
}

async function completeActionDelivery(input) {
  const delivery = await requireLease({ ...input, allowTerminal: true, allowCommittedSettlement: true });
  if (TERMINAL_STATUSES.includes(delivery.status)) {
    await ensureRelationshipEffectFanRefresh(delivery);
    return { ok: true, duplicate: true, delivery };
  }
  const now = new Date();
  const clientResult = object(input.result);
  const effectTime = buildAutomationEffectTimeEvidence(delivery, clientResult, now);
  const result = sanitizeAutomationSettlementResult(clientResult, effectTime);
  const outcomeCode = clean(input.outcomeCode, 120) || clean(result.code, 120) || null;
  let terminalStatus = input.status === "SKIPPED" ? "SKIPPED" : "COMPLETED";
  if (delivery.moduleKey === SFS_MODULE_KEY && delivery.actionType === "SFS_FOLLOW_TARGET" && String(outcomeCode || "").trim().toLowerCase() !== "followed") {
    terminalStatus = "SKIPPED";
  }
  const finalDelivery = await runDbTransaction(prisma, async (tx) => {
    await lockDeliveryExecutionAccess({ db: tx, delivery, userId: input.userId });
    const changed = await tx.automationDelivery.updateMany({
      where: {
        id: delivery.id,
        status: { in: LEASED_STATUSES },
        claimedByDeviceId: input.deviceId,
        leaseTokenHash: hashToken(input.leaseToken),
        leaseRevision: input.leaseRevision,
      },
      data: {
        status: terminalStatus,
        failureCode: terminalStatus === "SKIPPED" ? outcomeCode : null,
        lastError: null,
        result,
        messageId: clean(result.messageId, 160) || delivery.messageId,
        sentAt: delivery.actionType === "SEND_MESSAGE" ? validDate(result.sentAt, now) : delivery.sentAt,
        cancelAt: validDate(result.cancelAt, delivery.cancelAt),
        finishedAt: now,
        lastCheckedAt: now,
        claimUntil: null,
      },
    });
    if (!changed.count) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery changed before completion");
    const current = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    if (current?.moduleKey === "bumps") {
      if (current.actionType === "SEND_MESSAGE" && terminalStatus === "COMPLETED") {
        const finalized = await finalizeBumpSend({ delivery: current, result, db: tx });
        if (finalized) {
          await tx.automationDelivery.update({
            where: { id: current.id },
            data: { messageId: finalized.messageId, sentAt: finalized.sentAt, cancelAt: finalized.cancelAt },
          });
        }
      } else if (current.actionType === "DELETE_MESSAGE") {
        await finalizeBumpDelete({ delivery: current, result, outcomeCode, db: tx });
      }
    }
    if (current?.moduleKey === "likes" && current.actionType === "LIKE_POST") {
      if (terminalStatus === "COMPLETED") await finalizeLikeSuccess({ delivery: current, outcomeCode, result, db: tx });
      else await finalizeLikeTerminal({ delivery: current, status: terminalStatus, failureCode: outcomeCode, result, db: tx });
    }
    if (current?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
      if (terminalStatus === "COMPLETED") {
        await finalizeFollowAutomationSuccess({ delivery: current, outcomeCode, result, db: tx, now });
      } else {
        await finalizeFollowAutomationTerminal({ delivery: current, status: terminalStatus, failureCode: outcomeCode, db: tx });
      }
    }
    if (current?.moduleKey === SFS_MODULE_KEY) {
      if (terminalStatus === "COMPLETED") await finalizeSfsSuccess({ delivery: current, outcomeCode, result, db: tx, now });
      else await finalizeSfsTerminal({ delivery: current, status: terminalStatus, failureCode: outcomeCode, db: tx });
    }
    const latest = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    await updateCandidateFromTerminal(latest, terminalStatus, outcomeCode, tx);
    return latest;
  }, { timeout: 30_000 });
  await ensureRelationshipEffectFanRefresh(finalDelivery);
  return { ok: true, duplicate: false, delivery: finalDelivery };
}

async function failActionDelivery(input) {
  const delivery = await requireLease({ ...input, allowCommittedSettlement: true });
  const now = new Date();
  const failureCode = clean(input.failureCode, 120) || "unknown";
  const lastError = clean(input.error, 2000) || failureCode;
  const reportedFailureCategory = normalizeFailureCategory(input.failureCategory);
  const inputResult = object(input.result);
  const endpointSemantics = automationActionWriteSemantics(delivery.actionType);
  const idempotent = endpointSemantics === "IDEMPOTENT_WRITE";
  const reachedWire = delivery.status === "COMMITTING" || Boolean(delivery.writeCommitAt);
  // Strong negative proof is action-specific and server-owned. Generic client
  // provenNoEffect/idempotent flags never unlock a non-idempotent COMMITTING row.
  // SEND_MESSAGE has the existing anchored recent-message reconciliation contract.
  const actionSpecificNoEffectProof = deliveryRequiresReconciliation(delivery)
    && delivery.actionType === "SEND_MESSAGE"
    && failureCode === "send_reconcile_no_effect"
    && inputResult.readbackCovered === true;
  const provenNoEffect = !reachedWire || actionSpecificNoEffectProof;
  const failureCategory = reachedWire && !idempotent && !actionSpecificNoEffectProof
    ? FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE
    : classifyAutomationFailure({
      failureCode, deliveryStatus: delivery.status, provenNoEffect, idempotent, endpointSemantics,
      writeReachedWire: reachedWire, outcomeState: reachedWire ? "ON_WIRE_UNKNOWN" : "PRE_WIRE_FAILURE",
      transportCode: inputResult.transportCode || inputResult.originalCode || null,
    });
  const safetyRecovery = mustPreserveRefollowSaga(delivery, failureCode) || isSfsCleanupDelivery(delivery);
  const reconcile = failureCategory === FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE;
  const categoryRetryable = SAFE_RETRY_CATEGORIES.includes(failureCategory) || reconcile;
  const retryable = categoryRetryable && (reconcile || safetyRecovery || delivery.attempts < delivery.maxAttempts);
  const nextStatus = reconcile ? "RECONCILE_REQUIRED" : (retryable ? "RETRY_SCHEDULED" : "FAILED");
  const nextNotBefore = (retryable || reconcile) ? new Date(now.getTime() + retryDelayMs(delivery.attempts, failureCode, input.retryAfterMs)) : delivery.notBefore;
  const result = {
    ...object(delivery.result), ...inputResult,
    reportedEndpointSemantics: inputResult.endpointSemantics || null, reportedIdempotent: inputResult.idempotent === true, reportedProvenNoEffect: inputResult.provenNoEffect === true,
    endpointSemantics, writeReachedWire: reachedWire, provenNoEffect, failureCode, failureCategory, reportedFailureCategory,
    outcomeState: reconcile ? "RECONCILE_REQUIRED" : (provenNoEffect ? "PROVEN_NO_EFFECT" : "TERMINAL"),
    ...(reconcile ? { reconciliationStartedAt: object(delivery.result).reconciliationStartedAt || delivery.writeCommitAt?.toISOString?.() || now.toISOString() } : {}),
    failedAt: now.toISOString(), retryable,
  };
  const updated = await runDbTransaction(prisma, async (tx) => {
    await lockDeliveryExecutionAccess({ db: tx, delivery, userId: input.userId });
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: LEASED_STATUSES }, claimedByDeviceId: input.deviceId, leaseTokenHash: hashToken(input.leaseToken), leaseRevision: input.leaseRevision },
      data: {
        status: nextStatus, failureCode, failureCategory, reportedFailureCategory, lastError, result, notBefore: nextNotBefore,
        finishedAt: retryable || reconcile ? null : now, claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null,
        leaseRevision: { increment: 1 }, lastCheckedAt: now,
      },
    });
    if (!changed.count) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery changed before failure update");
    if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
      await tx.fanObservationReadLease.deleteMany({
        where: { deliveryId: delivery.id, deviceId: input.deviceId, leaseRevision: input.leaseRevision },
      });
    }
    const current = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    if (reconcile) {
      await updateModuleCandidateProgress(current, "RECONCILE_REQUIRED", failureCode, tx);
    } else if (retryable) {
      await updateModuleCandidateProgress(current, "RETRY_SCHEDULED", failureCode, tx);
      if (current?.moduleKey === "likes") await finalizeLikeFailure({ delivery: current, failureCode, retryable: true, result, db: tx });
      if (current?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) await finalizeFollowAutomationFailure({ delivery: current, failureCode, retryable: true, db: tx });
      if (current?.moduleKey === SFS_MODULE_KEY) await finalizeSfsFailure({ delivery: current, failureCode, retryable: true, db: tx });
    } else {
      await updateCandidateFromTerminal(current, "FAILED", failureCode, tx);
      if (current?.moduleKey === "bumps") await finalizeBumpFailure({ delivery: current, failureCode, retryable: false, db: tx });
      if (current?.moduleKey === "likes") await finalizeLikeFailure({ delivery: current, failureCode, retryable: false, result, db: tx });
      if (current?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) await finalizeFollowAutomationFailure({ delivery: current, failureCode, retryable: false, db: tx });
      if (current?.moduleKey === SFS_MODULE_KEY) await finalizeSfsFailure({ delivery: current, failureCode, retryable: false, db: tx });
    }
    return current;
  }, { timeout: 30_000 });
  return { ok: true, retryable, retryAt: (retryable || reconcile) ? nextNotBefore : null, failureCategory, delivery: updated };
}

async function releaseActionDelivery(input) {
  const delivery = await requireLease({ ...input, allowExpired: true });
  if (delivery.status === "COMMITTING") throw new ActionDeliveryError("DELIVERY_COMMIT_IN_FLIGHT", "A committed write cannot be released; reconcile its outcome");
  const reconciliationLease = deliveryRequiresReconciliation(delivery);
  const now = new Date();
  const runAfterMs = Math.max(0, Math.min(24 * 60 * 60_000, Number(input.runAfterMs) || 0));
  const nextStatus = reconciliationLease ? "RECONCILE_REQUIRED" : "QUEUED";
  const updated = await runDbTransaction(prisma, async (tx) => {
    await lockDeliveryExecutionAccess({ db: tx, delivery, userId: input.userId });
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: ["CLAIMED", "RUNNING"] }, claimedByDeviceId: input.deviceId, leaseTokenHash: hashToken(input.leaseToken), leaseRevision: input.leaseRevision },
      data: {
        status: nextStatus, notBefore: new Date(now.getTime() + runAfterMs), claimedByDeviceId: null, claimedAt: null, claimUntil: null,
        leaseTokenHash: null, leaseRevision: { increment: 1 }, ...(reconciliationLease ? {} : { attempts: { decrement: 1 }, failureCode: null, failureCategory: null, reportedFailureCategory: null }),
        lastError: clean(input.reason, 500),
        result: { ...object(delivery.result), ...(reconciliationLease ? { outcomeState: "RECONCILE_REQUIRED" } : {}), releasedAt: now.toISOString(), releaseReason: clean(input.reason, 500) },
      },
    });
    if (!changed.count) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery changed before release");
    if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
      await tx.fanObservationReadLease.deleteMany({
        where: { deliveryId: delivery.id, deviceId: input.deviceId, leaseRevision: input.leaseRevision },
      });
    }
    const current = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    await updateModuleCandidateProgress(current, nextStatus, clean(input.reason, 500), tx);
    return current;
  }, { timeout: 30_000 });
  return { ok: true, delivery: updated };
}

async function listActionDeliveries({ agencyId, creatorId, creatorIds = null, moduleKey, actionType, status, deviceId, fan, offset = 0, limit = 100 }) {
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  const skip = Math.max(0, Number(offset) || 0);
  const search = clean(fan, 160);
  const where = {
    agencyId,
    originKind: "AUTOMATION",
    ...(creatorId ? { creatorId } : Array.isArray(creatorIds) ? { creatorId: { in: creatorIds } } : {}),
    ...(moduleKey ? { moduleKey } : {}),
    ...(actionType ? { actionType } : {}),
    ...(status ? { status: Array.isArray(status) ? { in: status } : status } : {}),
    ...(deviceId ? { claimedByDeviceId: deviceId } : {}),
    ...(search ? { OR: [{ fanId: { contains: search, mode: "insensitive" } }, { targetId: { contains: search, mode: "insensitive" } }] } : {}),
  };
  const [items, count] = await Promise.all([
    prisma.automationDelivery.findMany({
      where,
      orderBy: [{ priority: "desc" }, { notBefore: "asc" }, { createdAt: "desc" }],
      skip,
      take,
      select: {
        id: true, agencyId: true, creatorId: true, moduleKey: true, actionType: true, targetId: true, fanId: true,
        dialogId: true, idempotencyKey: true, generation: true, priority: true, payload: true, status: true,
        scheduledAt: true, notBefore: true, attempts: true, maxAttempts: true, claimedByDeviceId: true,
        claimedAt: true, claimUntil: true, leaseRevision: true, failureCode: true, lastError: true, result: true,
        messageId: true, sentAt: true, cancelAt: true, contentCollectionId: true, trigger: true,
        createdAt: true, updatedAt: true, finishedAt: true,
      },
    }),
    prisma.automationDelivery.count({ where }),
  ]);
  return { ok: true, items, count, offset: skip, nextOffset: skip + items.length, hasMore: skip + items.length < count };
}

async function retryActionDelivery({ agencyId, actorUserId, deliveryId }) {
  const delivery = await prisma.automationDelivery.findFirst({ where: { id: deliveryId, agencyId, originKind: "AUTOMATION" } });
  if (!delivery) throw new ActionDeliveryError("DELIVERY_NOT_FOUND", "Delivery not found", 404);
  await requireLiveAutomationManagementActor({ agencyId, actorUserId, creatorId: delivery.creatorId });
  if (!["FAILED", "SKIPPED", "CANCELED", "PAUSED"].includes(delivery.status)) {
    throw new ActionDeliveryError("DELIVERY_NOT_RETRYABLE", `Delivery status ${delivery.status} cannot be retried`);
  }
  if (delivery.failureCode && ["permission_denied", "invalid_payload", "fan_not_found", "blocked", "creator_revoked", "custom_media_programmatic_forbidden"].includes(delivery.failureCode)) {
    throw new ActionDeliveryError("DELIVERY_UNSAFE_RETRY", `Failure ${delivery.failureCode} requires a new action generation`);
  }
  const control = await assertDeliveryControl(delivery);
  let retryAt = new Date();
  if (delivery.moduleKey === "bumps") {
    const validation = await validateBumpDelivery({ delivery, control, now: retryAt });
    if (validation.refreshRequired === true) await scheduleValidationFanRefresh(delivery, validation, "retry");
    if (validation.ok === false && validation.terminal === true) {
      throw new ActionDeliveryError("DELIVERY_UNSAFE_RETRY", `Bump delivery is no longer valid: ${validation.code || "validation_failed"}`);
    }
    if (validation.ok === false && validation.retryAt) retryAt = validation.retryAt;
  }
  if (delivery.moduleKey === "likes") {
    const validation = await validateLikeDelivery({ delivery, control, now: retryAt });
    if (validation.ok === false && validation.terminal === true && validation.code !== "already_liked") {
      throw new ActionDeliveryError("DELIVERY_UNSAFE_RETRY", `Like delivery is no longer valid: ${validation.code || "validation_failed"}`);
    }
    if (validation.ok === false && validation.code === "already_liked") {
      const now = new Date();
      const latest = await runDbTransaction(prisma, async (tx) => {
        await requireLiveAutomationManagementActor({ db: tx, agencyId, actorUserId, creatorId: delivery.creatorId });
        const changed = await tx.automationDelivery.updateMany({
          where: { id: delivery.id, originKind: "AUTOMATION", status: delivery.status, leaseRevision: delivery.leaseRevision },
          data: {
            status: "COMPLETED",
            failureCode: null,
            lastError: null,
            finishedAt: now,
            claimedByDeviceId: null,
            claimedAt: null,
            claimUntil: null,
            leaseTokenHash: null,
            leaseRevision: { increment: 1 },
            result: { ...object(delivery.result), code: "already_liked", idempotent: true, completedAt: now.toISOString() },
          },
        });
        if (!changed.count) throw new ActionDeliveryError("DELIVERY_CHANGED", "Delivery changed before idempotent completion");
        const current = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
        await finalizeLikeTerminal({ delivery: current, status: "COMPLETED", failureCode: "already_liked", result: current?.result || {}, db: tx });
        return current;
      });
      return { ok: true, duplicate: true, delivery: latest };
    }
    if (validation.ok === false && validation.retryAt) retryAt = validation.retryAt;
  }
  if (delivery.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
    const validation = await validateFollowAutomationDelivery({ delivery, control, now: retryAt });
    if (validation.refreshRequired === true) await scheduleValidationFanRefresh(delivery, validation, "retry");
    if (validation.ok === false && validation.terminal === true) {
      throw new ActionDeliveryError("DELIVERY_UNSAFE_RETRY", `Follow Automation delivery is no longer valid: ${validation.code || "validation_failed"}`);
    }
    if (validation.ok === false && validation.retryAt) retryAt = validation.retryAt;
  }
  if (delivery.moduleKey === SFS_MODULE_KEY) {
    const validation = await validateSfsDelivery({ delivery, control, now: retryAt });
    if (validation.refreshRequired === true) await scheduleValidationFanRefresh(delivery, validation, "retry");
    if (validation.ok === false && validation.terminal === true && !["already_unfollowed", "already_followed"].includes(validation.code)) {
      throw new ActionDeliveryError("DELIVERY_UNSAFE_RETRY", `SFS delivery is no longer valid: ${validation.code || "validation_failed"}`);
    }
    if (validation.ok === false && validation.code === "already_followed") {
      const now = new Date();
      const latest = await runDbTransaction(prisma, async (tx) => {
        await requireLiveAutomationManagementActor({ db: tx, agencyId, actorUserId, creatorId: delivery.creatorId });
        const changed = await tx.automationDelivery.updateMany({
          where: { id: delivery.id, originKind: "AUTOMATION", status: delivery.status, leaseRevision: delivery.leaseRevision },
          data: {
            status: "SKIPPED", failureCode: "already_followed", lastError: null, finishedAt: now,
            claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 },
            result: { ...object(delivery.result), code: "already_followed", idempotent: true, completedAt: now.toISOString() },
          },
        });
        if (!changed.count) throw new ActionDeliveryError("DELIVERY_CHANGED", "Delivery changed before idempotent SFS completion");
        const current = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
        await finalizeSfsTerminal({ delivery: current, status: "SKIPPED", failureCode: "already_followed", db: tx, now });
        return current;
      });
      return { ok: true, duplicate: true, delivery: latest };
    }
    if (validation.ok === false && validation.retryAt) retryAt = validation.retryAt;
  }
  const updated = await runDbTransaction(prisma, async (tx) => {
    await requireLiveAutomationManagementActor({ db: tx, agencyId, actorUserId, creatorId: delivery.creatorId });
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, originKind: "AUTOMATION", status: delivery.status, leaseRevision: delivery.leaseRevision },
      data: {
        status: "QUEUED",
        attempts: 0,
        notBefore: retryAt,
        failureCode: null,
        lastError: null,
        finishedAt: null,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
        result: { ...object(delivery.result), retriedAt: retryAt.toISOString() },
      },
    });
    if (!changed.count) throw new ActionDeliveryError("DELIVERY_CHANGED", "Delivery changed before retry");
    const latest = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    if (latest?.moduleKey === "bumps") {
      const prepared = await prepareBumpRetry({ delivery: latest, db: tx });
      if (!prepared?.changed) throw new ActionDeliveryError("DELIVERY_UNSAFE_RETRY", "Bump fan state no longer permits retry");
    }
    if (latest?.moduleKey === "likes") await prepareLikeRetry({ delivery: latest, db: tx });
    if (latest?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) await prepareFollowAutomationRetry({ delivery: latest, db: tx });
    if (latest?.moduleKey === SFS_MODULE_KEY) await prepareSfsRetry({ delivery: latest, db: tx });
    await updateModuleCandidateProgress(latest, "QUEUED", null, tx);
    return latest;
  });
  return { ok: true, delivery: updated };
}

async function cancelActionDelivery({ agencyId, actorUserId, deliveryId, reason = "manual_cancel" }) {
  const delivery = await prisma.automationDelivery.findFirst({ where: { id: deliveryId, agencyId, originKind: "AUTOMATION" } });
  if (!delivery) throw new ActionDeliveryError("DELIVERY_NOT_FOUND", "Delivery not found", 404);
  await requireLiveAutomationManagementActor({ agencyId, actorUserId, creatorId: delivery.creatorId });
  if (TERMINAL_STATUSES.includes(delivery.status)) return { ok: true, duplicate: true, delivery };
  if (["COMMITTING", "RECONCILE_REQUIRED"].includes(delivery.status)) {
    throw new ActionDeliveryError("DELIVERY_COMMIT_IN_FLIGHT", "Committed write must settle or reconcile before cancellation");
  }
  if (isSfsCleanupDelivery(delivery)) {
    throw new ActionDeliveryError("UNSAFE_SFS_CLEANUP_CANCEL", "An SFS safety unfollow cannot be canceled");
  }
  if (delivery.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY && delivery.actionType === FOLLOW_FAN_ACTION_TYPE) {
    throw new ActionDeliveryError("UNSAFE_RECOVERY_CANCEL", "A compensating refollow action cannot be canceled");
  }
  if (delivery.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY && delivery.actionType === UNFOLLOW_FAN_ACTION_TYPE && ["CLAIMED", "RUNNING"].includes(delivery.status)) {
    throw new ActionDeliveryError("UNSAFE_REFOLLOW_CANCEL", "A started refollow cycle cannot be canceled before recovery");
  }
  const finishedAt = new Date();
  const updated = await runDbTransaction(prisma, async (tx) => {
    await requireLiveAutomationManagementActor({ db: tx, agencyId, actorUserId, creatorId: delivery.creatorId });
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, originKind: "AUTOMATION", status: delivery.status, leaseRevision: delivery.leaseRevision },
      data: {
        status: "CANCELED",
        failureCode: "canceled",
        lastError: clean(reason, 500),
        finishedAt,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
      },
    });
    if (!changed.count) throw new ActionDeliveryError("DELIVERY_CHANGED", "Delivery changed before cancel");
    if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
      await tx.fanObservationReadLease.deleteMany({
        where: { deliveryId: delivery.id, leaseRevision: delivery.leaseRevision },
      });
    }
    const latest = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    if (latest?.moduleKey === "bumps") {
      await finalizeBumpTerminal({ delivery: latest, status: "CANCELED", failureCode: "canceled", db: tx });
    }
    if (latest?.moduleKey === "likes") {
      await finalizeLikeTerminal({ delivery: latest, status: "CANCELED", failureCode: "canceled", result: latest.result || {}, db: tx });
    }
    if (latest?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
      await finalizeFollowAutomationTerminal({ delivery: latest, status: "CANCELED", failureCode: "canceled", db: tx });
    }
    if (latest?.moduleKey === SFS_MODULE_KEY) {
      await finalizeSfsTerminal({ delivery: latest, status: "CANCELED", failureCode: "canceled", db: tx });
    }
    await updateCandidateFromTerminal(latest, "CANCELED", "canceled", tx);
    return latest;
  });
  return { ok: true, duplicate: false, delivery: updated };
}

async function releaseClaimByAdmin({ agencyId, actorUserId, deliveryId }) {
  const delivery = await prisma.automationDelivery.findFirst({ where: { id: deliveryId, agencyId, originKind: "AUTOMATION" } });
  if (!delivery) throw new ActionDeliveryError("DELIVERY_NOT_FOUND", "Delivery not found", 404);
  await requireLiveAutomationManagementActor({ agencyId, actorUserId, creatorId: delivery.creatorId });
  if (["COMMITTING", "RECONCILE_REQUIRED"].includes(delivery.status)) throw new ActionDeliveryError("DELIVERY_COMMIT_IN_FLIGHT", "Committed write must settle or reconcile before administrative release");
  if (!["CLAIMED", "RUNNING"].includes(delivery.status)) return { ok: true, duplicate: true, delivery };
  const updated = await runDbTransaction(prisma, async (tx) => {
    await requireLiveAutomationManagementActor({ db: tx, agencyId, actorUserId, creatorId: delivery.creatorId });
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, originKind: "AUTOMATION", status: { in: ["CLAIMED", "RUNNING"] }, leaseRevision: delivery.leaseRevision },
      data: { status: "QUEUED", notBefore: new Date(Date.now() + 15_000), claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 }, attempts: { decrement: 1 }, lastError: "Claim released by administrator" },
    });
    if (!changed.count) throw new ActionDeliveryError("DELIVERY_CHANGED", "Delivery changed before administrative release");
    if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
      await tx.fanObservationReadLease.deleteMany({
        where: { deliveryId: delivery.id, leaseRevision: delivery.leaseRevision },
      });
    }
    const current = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    await updateModuleCandidateProgress(current, "QUEUED", "claim_released", tx);
    return current;
  });
  return { ok: true, delivery: updated };
}

async function retrySafeFailures({ agencyId, actorUserId, creatorId = null, moduleKey = null, limit = 100 }) {
  const authority = await requireLiveAutomationManagementActor({ agencyId, actorUserId });
  const scope = await allowedCreatorScope({
    agencyId,
    member: authority.member,
    requestedCreatorId: creatorId || null,
    db: prisma,
  });
  const creatorFilter = creatorId
    ? { creatorId }
    : scope.broad
      ? {}
      : { creatorId: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } };
  const rows = await prisma.automationDelivery.findMany({
    where: { agencyId, originKind: "AUTOMATION", status: "FAILED", failureCategory: { in: SAFE_RETRY_CATEGORIES }, ...creatorFilter, ...(moduleKey ? { moduleKey } : {}) },
    orderBy: { updatedAt: "asc" }, take: Math.max(1, Math.min(500, Number(limit) || 100)), select: { id: true },
  });
  const results = [];
  for (const row of rows) {
    try { results.push(await retryActionDelivery({ agencyId, actorUserId, deliveryId: row.id })); }
    catch (error) { results.push({ ok: false, deliveryId: row.id, code: error?.code || "retry_failed", error: error?.message || String(error) }); }
  }
  return { ok: true, requested: rows.length, retried: results.filter((item) => item.ok).length, results };
}

module.exports = {
  ACTION_FAIR_CANDIDATES_SQL,
  ActionDeliveryError,
  NORMAL_CLAIMABLE_STATUSES,
  CLAIMABLE_STATUSES,
  PRECOMMIT_EXECUTABLE_STATUSES,
  TERMINAL_STATUSES,
  sweepExpiredAutomationLeases,
  sweepExpiredActionLeases,
  claimActionDelivery,
  renewActionLease,
  startActionDelivery,
  validateActionDelivery,
  prepareWriteActionDelivery,
  completeActionDelivery,
  failActionDelivery,
  releaseActionDelivery,
  listActionDeliveries,
  retryActionDelivery,
  retrySafeFailures,
  cancelActionDelivery,
  releaseClaimByAdmin,
  authorizeActionProfileObservation,
  acquireActionProfileObservationReadLease,
  releaseActionProfileObservationReadLease,
  issueActionProfileObservationToken,
  __test: { requireLiveAutomationManagementActor, requireLease },
};
