"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { canUsePermission, isOwner, normalizeAssignedCreators } = require("./team-access-control");
const { assertAutomationEnabled, getAutomationControlSnapshot } = require("./automation-control-service");
const { claimPacingRetryAt } = require("./automation-pacing-service");
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

const CLAIMABLE_STATUSES = ["QUEUED", "RETRY_SCHEDULED"];
const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "SKIPPED", "CANCELED"];
const DEFAULT_LEASE_MS = 3 * 60_000;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 10 * 60_000;

class ActionDeliveryError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "ActionDeliveryError";
    this.code = code;
    this.status = status;
  }
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
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


async function assertDeliveryControl(delivery, { allowRunningUnfollow = false } = {}) {
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
    });
  }
  const snapshot = await getAutomationControlSnapshot({
    agencyId: delivery.agencyId,
    creatorId: delivery.creatorId,
  });
  if (!snapshot.effective.workspaceEnabled) {
    throw new ActionDeliveryError("workspace_disabled", "Automation workspace is disabled");
  }
  if (!snapshot.effective.creatorEnabled) {
    throw new ActionDeliveryError("creator_disabled", "Creator automation is disabled");
  }
  return snapshot;
}

async function requireOwnedSeniorDevice({ userId, deviceId }) {
  const device = await prisma.workerDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== userId) throw new ActionDeliveryError("NOT_YOUR_DEVICE", "Invalid device", 403);
  const member = await prisma.agencyMember.findFirst({
    where: { agencyId: device.agencyId, userId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null } },
  });
  if (!member) throw new ActionDeliveryError("DEVICE_AGENCY_ACCESS_REVOKED", "Device agency access was revoked", 403);
  if (!(await canUsePermission({ member, key: "automation.manage", db: prisma }))) throw new ActionDeliveryError("WRITE_AUTOMATION_FORBIDDEN", "automation.manage permission is required", 403);
  return { device, member };
}

async function scopedReadyCreatorIds({ userId, device }) {
  const member = await prisma.agencyMember.findFirst({
    where: { agencyId: device.agencyId, userId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null } },
  });
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
    take: 10000,
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
    take: 10000,
  });
  return bindings.map((item) => item.creatorId);
}

async function sweepExpiredActionLeases(now = new Date()) {
  const rows = await prisma.automationDelivery.findMany({
    where: { status: { in: ["CLAIMED", "RUNNING"] }, claimUntil: { lt: now } },
    select: {
      id: true, agencyId: true, creatorId: true, moduleKey: true, actionType: true, fanId: true, targetId: true,
      payload: true, contentCollectionId: true, status: true, failureCode: true, attempts: true, maxAttempts: true, result: true, leaseRevision: true,
    },
    take: 10000,
  });
  let changed = 0;
  for (const row of rows) {
    const safetySaga = mustPreserveRefollowSaga(row, "lease_lost") || isSfsCleanupDelivery(row);
    const terminal = !safetySaga && row.attempts >= row.maxAttempts;
    const updated = await prisma.automationDelivery.updateMany({
      where: {
        id: row.id,
        status: { in: ["CLAIMED", "RUNNING"] },
        leaseRevision: row.leaseRevision,
        claimUntil: { lt: now },
      },
      data: terminal
        ? {
            status: "FAILED",
            failureCode: "lease_lost",
            lastError: "Action lease expired",
            finishedAt: now,
            claimedByDeviceId: null,
            claimedAt: null,
            claimUntil: null,
            leaseTokenHash: null,
            leaseRevision: { increment: 1 },
            result: { ...object(row.result), leaseExpiredAt: now.toISOString() },
          }
        : {
            status: "RETRY_SCHEDULED",
            failureCode: "lease_lost",
            lastError: "Action lease expired",
            notBefore: new Date(now.getTime() + retryDelayMs(row.attempts || 1, "lease_lost")),
            claimedByDeviceId: null,
            claimedAt: null,
            claimUntil: null,
            leaseTokenHash: null,
            leaseRevision: { increment: 1 },
            result: { ...object(row.result), leaseExpiredAt: now.toISOString() },
          },
    });
    if (updated.count) {
      changed += 1;
      const latest = await prisma.automationDelivery.findUnique({ where: { id: row.id } });
      if (terminal && row.moduleKey === "bumps") {
        await finalizeBumpFailure({ delivery: latest, failureCode: "lease_lost", retryable: false });
      }
      if (row.moduleKey === "likes") {
        await finalizeLikeFailure({
          delivery: latest,
          failureCode: "lease_lost",
          retryable: !terminal,
          result: latest?.result || {},
        });
      }
      if (row.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
        await finalizeFollowAutomationFailure({
          delivery: latest,
          failureCode: "lease_lost",
          retryable: !terminal,
        });
      }
      if (row.moduleKey === SFS_MODULE_KEY) {
        await finalizeSfsFailure({ delivery: latest, failureCode: "lease_lost", retryable: !terminal });
      }
    }
  }
  return changed;
}

async function fairCandidates({ agencyId, creatorIds, actionTypes, now }) {
  const candidates = await prisma.automationDelivery.findMany({
    where: {
      agencyId,
      creatorId: { in: creatorIds },
      actionType: { in: actionTypes },
      status: { in: CLAIMABLE_STATUSES },
      notBefore: { lte: now },
    },
    orderBy: [{ priority: "desc" }, { notBefore: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
  const withinAttempts = candidates.filter((item) => item.attempts < item.maxAttempts || mustPreserveRefollowSaga(item) || isSfsCleanupDelivery(item));
  if (!withinAttempts.length) return [];
  const creatorSet = [...new Set(withinAttempts.map((item) => item.creatorId))];
  const touches = await prisma.automationDelivery.groupBy({
    by: ["creatorId"],
    where: { agencyId, creatorId: { in: creatorSet }, status: { in: ["CLAIMED", "RUNNING", "COMPLETED"] } },
    _max: { claimedAt: true, finishedAt: true },
  });
  const lastTouch = new Map(touches.map((row) => [row.creatorId, Math.max(
    row._max.claimedAt?.getTime?.() || 0,
    row._max.finishedAt?.getTime?.() || 0,
  )]));
  return withinAttempts.sort((a, b) =>
    b.priority - a.priority
    || (lastTouch.get(a.creatorId) || 0) - (lastTouch.get(b.creatorId) || 0)
    || a.notBefore.getTime() - b.notBefore.getTime()
    || a.createdAt.getTime() - b.createdAt.getTime());
}

async function updateCandidateProgress(delivery, status, failureCode = null) {
  if (!delivery || delivery.moduleKey !== "follow_back" || !(delivery.targetId || delivery.fanId)) return;
  await prisma.followBackCandidate.updateMany({
    where: {
      agencyId: delivery.agencyId,
      creatorId: delivery.creatorId,
      fanId: delivery.targetId || delivery.fanId,
    },
    data: {
      state: status,
      latestDeliveryId: delivery.id,
      latestActionType: delivery.actionType,
      latestStatus: status,
      latestError: failureCode,
    },
  });
}

async function updateLikeCandidateProgress(delivery, status, failureCode = null) {
  if (!delivery || delivery.moduleKey !== "likes") return;
  const contentId = delivery.targetId || clean(object(delivery.payload).postId, 160);
  if (!contentId) return;
  await prisma.automationContentCandidate.updateMany({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, contentType: "post", contentId },
    data: {
      state: status,
      latestDeliveryId: delivery.id,
      latestActionType: delivery.actionType,
      latestStatus: status,
      latestError: failureCode,
    },
  });
}

async function updateFollowAutomationCandidateProgress(delivery, status, failureCode = null) {
  if (!delivery || delivery.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY) return;
  const fanId = delivery.targetId || delivery.fanId;
  if (!fanId) return;
  const phase = delivery.actionType === FOLLOW_FAN_ACTION_TYPE
    ? (status === "FAILED" ? "RECOVERY" : "FOLLOW")
    : "UNFOLLOW";
  const state = delivery.actionType === FOLLOW_FAN_ACTION_TYPE
    ? (status === "RUNNING" ? "FOLLOWING" : "QUEUED_FOLLOW")
    : (status === "RUNNING" ? "UNFOLLOWING" : "QUEUED_UNFOLLOW");
  await prisma.followAutomationCandidate.updateMany({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId },
    data: {
      state,
      phase,
      latestDeliveryId: delivery.id,
      latestActionType: delivery.actionType,
      latestStatus: status,
      latestError: failureCode,
    },
  });
}

async function updateSfsCandidateProgress(delivery, status, failureCode = null) {
  if (!delivery || delivery.moduleKey !== SFS_MODULE_KEY) return;
  const candidateId = clean(object(delivery.payload).candidateId, 160);
  if (!candidateId) return;
  await prisma.sfsTargetCandidate.updateMany({
    where: { id: candidateId, agencyId: delivery.agencyId, creatorId: delivery.creatorId },
    data: {
      state: isSfsCleanupDelivery(delivery)
        ? (status === "RUNNING" ? "UNFOLLOWING" : "UNFOLLOW_DUE")
        : delivery.actionType === "SFS_FOLLOW_TARGET"
          ? (status === "RUNNING" ? "FOLLOWING" : "QUEUED")
          : (status === "RUNNING" ? "ACTING" : status),
      latestDeliveryId: delivery.id,
      latestActionType: delivery.actionType,
      latestStatus: status,
      latestError: failureCode,
    },
  });
}

async function updateModuleCandidateProgress(delivery, status, failureCode = null) {
  await updateCandidateProgress(delivery, status, failureCode);
  await updateLikeCandidateProgress(delivery, status, failureCode);
  await updateFollowAutomationCandidateProgress(delivery, status, failureCode);
  await updateSfsCandidateProgress(delivery, status, failureCode);
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
    const updated = await prisma.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: CLAIMABLE_STATUSES } },
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
    if (updated.count) {
      const latest = await prisma.automationDelivery.findUnique({ where: { id: delivery.id } });
      await updateCandidateFromTerminal(latest, terminalStatus, code);
    }
    return true;
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
    const updated = await prisma.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: CLAIMABLE_STATUSES } },
      data: {
        status: "RETRY_SCHEDULED",
        failureCode: "daily_limit",
        lastError: "Follow Back daily limit reached",
        notBefore: nextDayStart(now),
      },
    });
    if (updated.count) {
      const latest = await prisma.automationDelivery.findUnique({ where: { id: delivery.id } });
      await updateCandidateProgress(latest, "RETRY_SCHEDULED", "daily_limit");
    }
    return true;
  }
  return false;
}

async function applyBumpValidationTransition(delivery, validation, now = new Date()) {
  if (!delivery || delivery.moduleKey !== "bumps" || validation?.ok !== false) return false;
  const terminal = validation.terminal === true;
  const status = terminal ? (validation.status || "SKIPPED") : "RETRY_SCHEDULED";
  return prisma.$transaction(async (tx) => {
    const changed = await tx.automationDelivery.updateMany({
      where: {
        id: delivery.id,
        status: { in: [...CLAIMABLE_STATUSES, "CLAIMED", "RUNNING"] },
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

async function applyLikeValidationTransition(delivery, validation, now = new Date()) {
  if (!delivery || delivery.moduleKey !== "likes" || validation?.ok !== false) return false;
  const terminal = validation.terminal === true;
  const status = terminal ? (validation.status || "SKIPPED") : "RETRY_SCHEDULED";
  return prisma.$transaction(async (tx) => {
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: [...CLAIMABLE_STATUSES, "CLAIMED", "RUNNING"] }, leaseRevision: delivery.leaseRevision },
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

async function applyFollowAutomationValidationTransition(delivery, validation, now = new Date()) {
  if (!delivery || delivery.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY || validation?.ok !== false) return false;
  const terminal = validation.terminal === true;
  const status = terminal ? (validation.status || "SKIPPED") : "RETRY_SCHEDULED";
  return prisma.$transaction(async (tx) => {
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: [...CLAIMABLE_STATUSES, "CLAIMED", "RUNNING"] }, leaseRevision: delivery.leaseRevision },
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

async function applySfsValidationTransition(delivery, validation, now = new Date()) {
  const status = validation.terminal === true ? (validation.code === "already_unfollowed" ? "COMPLETED" : "SKIPPED") : "RETRY_SCHEDULED";
  const retryAt = validation.retryAt || new Date(now.getTime() + 30_000);
  return prisma.$transaction(async (tx) => {
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: { in: CLAIMABLE_STATUSES }, leaseRevision: delivery.leaseRevision },
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
  const { device } = await requireOwnedSeniorDevice({ userId, deviceId });
  await sweepExpiredActionLeases();
  if (!device.lastSeenAt || device.lastSeenAt < new Date(Date.now() - 5 * 60_000)) return { delivery: null, reason: "device_stale" };
  const creatorIds = await scopedReadyCreatorIds({ userId, device });
  if (!creatorIds.length) return { delivery: null, reason: "no_ready_creator" };
  const allowedActionTypes = [...new Set((Array.isArray(actionTypes) ? actionTypes : []).map((item) => clean(item, 80)).filter(Boolean))];
  if (!allowedActionTypes.length) return { delivery: null, reason: "no_capabilities" };
  const now = new Date();
  const candidates = await fairCandidates({ agencyId: device.agencyId, creatorIds, actionTypes: allowedActionTypes, now });
  for (const candidate of candidates) {
    let control;
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
        where: { id: candidate.id, status: { in: CLAIMABLE_STATUSES }, leaseRevision: candidate.leaseRevision },
        data: { status: "RETRY_SCHEDULED", notBefore: pacingRetryAt, failureCode: "write_pacing", lastError: null },
      });
      continue;
    }
    if (candidate.moduleKey === "bumps") {
      const validation = await validateBumpDelivery({ delivery: candidate, control, now });
      if (validation.ok === false) {
        await applyBumpValidationTransition(candidate, validation, now);
        continue;
      }
    }
    if (candidate.moduleKey === "likes") {
      const validation = await validateLikeDelivery({ delivery: candidate, control, now });
      if (validation.ok === false) {
        await applyLikeValidationTransition(candidate, validation, now);
        continue;
      }
    }
    if (candidate.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
      const validation = await validateFollowAutomationDelivery({ delivery: candidate, control, now });
      if (validation.ok === false) {
        await applyFollowAutomationValidationTransition(candidate, validation, now);
        continue;
      }
    }
    if (candidate.moduleKey === SFS_MODULE_KEY) {
      const validation = await validateSfsDelivery({ delivery: candidate, control, now });
      if (validation.ok === false) {
        await applySfsValidationTransition(candidate, validation, now);
        continue;
      }
    }
    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const claimUntil = new Date(now.getTime() + leaseDuration(leaseMs));
    try {
      const updated = await prisma.automationDelivery.updateMany({
        where: {
          id: candidate.id,
          status: { in: CLAIMABLE_STATUSES },
          notBefore: { lte: now },
          claimUntil: null,
        },
        data: {
          status: "CLAIMED",
          claimedByDeviceId: device.id,
          claimedAt: now,
          claimUntil,
          leaseTokenHash: hashToken(leaseToken),
          leaseRevision: { increment: 1 },
          attempts: { increment: 1 },
          failureCode: null,
          lastError: null,
        },
      });
      if (!updated.count) continue;
      const claimed = await prisma.automationDelivery.findUnique({ where: { id: candidate.id } });
      if (!claimed) continue;
      await updateModuleCandidateProgress(claimed, "CLAIMED");
      return {
        reason: "claimed",
        delivery: {
          id: claimed.id,
          agencyId: claimed.agencyId,
          creatorId: claimed.creatorId,
          moduleKey: claimed.moduleKey,
          actionType: claimed.actionType,
          targetId: claimed.targetId || claimed.fanId,
          fanId: claimed.fanId,
          dialogId: claimed.dialogId,
          idempotencyKey: claimed.idempotencyKey,
          generation: claimed.generation,
          priority: claimed.priority,
          payload: object(claimed.payload),
          result: object(claimed.result),
          createdAt: claimed.createdAt,
          scheduledAt: claimed.scheduledAt,
          messageId: claimed.messageId,
          sentAt: claimed.sentAt,
          cancelAt: claimed.cancelAt,
          contentCollectionId: claimed.contentCollectionId,
          trigger: claimed.trigger,
          attempt: claimed.attempts,
          maxAttempts: claimed.maxAttempts,
          notBefore: claimed.notBefore,
          leaseUntil: claimed.claimUntil,
          leaseToken,
          leaseRevision: claimed.leaseRevision,
        },
      };
    } catch (error) {
      // The partial creator lease index intentionally turns a multi-device race
      // into a harmless loser. Continue looking for another creator.
      if (error?.code === "P2002" || String(error?.message || "").includes("creator_write_lease_unique")) continue;
      throw error;
    }
  }
  return { delivery: null, reason: "no_work" };
}

async function requireLease({ deliveryId, userId, deviceId, leaseToken, leaseRevision, allowTerminal = false, allowExpired = false }) {
  const { device } = await requireOwnedSeniorDevice({ userId, deviceId });
  const delivery = await prisma.automationDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) throw new ActionDeliveryError("DELIVERY_NOT_FOUND", "Delivery not found", 404);
  if (delivery.agencyId !== device.agencyId) throw new ActionDeliveryError("DELIVERY_DEVICE_AGENCY_MISMATCH", "Delivery belongs to another agency", 403);
  const terminal = TERMINAL_STATUSES.includes(delivery.status);
  if (!(delivery.status === "CLAIMED" || delivery.status === "RUNNING" || (allowTerminal && terminal))) {
    throw new ActionDeliveryError("DELIVERY_NOT_CLAIMED", `Delivery status is ${delivery.status}`);
  }
  if (delivery.claimedByDeviceId !== deviceId) throw new ActionDeliveryError("DELIVERY_CLAIMED_BY_OTHER", "Delivery is claimed by another device");
  if (!tokenMatches(leaseToken, delivery.leaseTokenHash)) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery lease token is stale");
  if (!Number.isInteger(leaseRevision) || delivery.leaseRevision !== leaseRevision) throw new ActionDeliveryError("DELIVERY_LEASE_REVISION_STALE", "Delivery lease revision is stale");
  if (!allowExpired && !terminal && (!delivery.claimUntil || delivery.claimUntil.getTime() <= Date.now())) {
    throw new ActionDeliveryError("DELIVERY_LEASE_EXPIRED", "Delivery lease expired");
  }
  return delivery;
}

async function renewActionLease(input) {
  const delivery = await requireLease(input);
  await assertDeliveryControl(delivery, { allowRunningUnfollow: true });
  const now = new Date();
  const result = await prisma.automationDelivery.updateMany({
    where: {
      id: delivery.id,
      status: { in: ["CLAIMED", "RUNNING"] },
      claimedByDeviceId: input.deviceId,
      leaseTokenHash: hashToken(input.leaseToken),
      leaseRevision: input.leaseRevision,
      claimUntil: { gt: now },
    },
    data: { claimUntil: new Date(now.getTime() + leaseDuration(input.leaseMs)), lastCheckedAt: now },
  });
  if (!result.count) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery lease changed before renewal");
  return { ok: true, id: delivery.id, leaseRevision: delivery.leaseRevision, leaseUntil: new Date(now.getTime() + leaseDuration(input.leaseMs)) };
}

async function startActionDelivery(input) {
  const delivery = await requireLease(input);
  await assertDeliveryControl(delivery);
  if (delivery.notBefore.getTime() > Date.now()) throw new ActionDeliveryError("DELIVERY_NOT_DUE", "Delivery is not due yet");
  if (delivery.status === "RUNNING") return { ok: true, delivery };
  const now = new Date();
  const updated = await prisma.automationDelivery.updateMany({
    where: { id: delivery.id, status: "CLAIMED", leaseRevision: input.leaseRevision, claimedByDeviceId: input.deviceId },
    data: {
      status: "RUNNING",
      lastCheckedAt: now,
      result: {
        ...object(delivery.result),
        attemptStartedAt: now.toISOString(),
        attemptLeaseRevision: delivery.leaseRevision,
      },
    },
  });
  if (!updated.count) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery changed before start");
  const running = await prisma.automationDelivery.findUnique({ where: { id: delivery.id } });
  await updateModuleCandidateProgress(running, "RUNNING");
  return { ok: true, delivery: running };
}

async function validateActionDelivery(input) {
  const delivery = await requireLease(input);
  const control = await assertDeliveryControl(delivery);
  if (delivery.moduleKey === "bumps") {
    const validation = await validateBumpDelivery({ delivery, control, now: new Date() });
    if (validation.ok === false) {
      await applyBumpValidationTransition(delivery, validation, new Date());
      throw new ActionDeliveryError(validation.code || "BUMP_VALIDATION_FAILED", validation.code || "Bump delivery validation failed");
    }
  }
  if (delivery.moduleKey === "likes") {
    const validation = await validateLikeDelivery({ delivery, control, now: new Date() });
    if (validation.ok === false) {
      await applyLikeValidationTransition(delivery, validation, new Date());
      throw new ActionDeliveryError(validation.code || "LIKE_VALIDATION_FAILED", validation.code || "Like delivery validation failed");
    }
  }
  if (delivery.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
    const validation = await validateFollowAutomationDelivery({ delivery, control, now: new Date() });
    if (validation.ok === false) {
      await applyFollowAutomationValidationTransition(delivery, validation, new Date());
      throw new ActionDeliveryError(validation.code || "FOLLOW_AUTOMATION_VALIDATION_FAILED", validation.code || "Follow Automation delivery validation failed");
    }
  }
  if (delivery.moduleKey === SFS_MODULE_KEY) {
    const validation = await validateSfsDelivery({ delivery, control, now: new Date() });
    if (validation.ok === false) {
      await applySfsValidationTransition(delivery, validation, new Date());
      throw new ActionDeliveryError(validation.code || "SFS_VALIDATION_FAILED", validation.code || "SFS delivery validation failed");
    }
  }
  return { ok: true, id: delivery.id, status: delivery.status, leaseRevision: delivery.leaseRevision, control: control.effective };
}

async function updateCandidateFromTerminal(delivery, status, failureCode) {
  if (delivery.moduleKey !== "follow_back" || !delivery.targetId) return;
  const candidateState = status === "COMPLETED"
    ? "FOLLOWED"
    : status === "SKIPPED"
      ? (failureCode === "already_followed" ? "FOLLOWED" : "SKIPPED")
      : status;
  await prisma.followBackCandidate.updateMany({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.targetId },
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
  const delivery = await requireLease({ ...input, allowTerminal: true });
  if (TERMINAL_STATUSES.includes(delivery.status)) return { ok: true, duplicate: true, delivery };
  const now = new Date();
  const result = object(input.result);
  const outcomeCode = clean(input.outcomeCode, 120) || clean(result.code, 120) || null;
  const terminalStatus = input.status === "SKIPPED" ? "SKIPPED" : "COMPLETED";
  const finalDelivery = await prisma.$transaction(async (tx) => {
    const changed = await tx.automationDelivery.updateMany({
      where: {
        id: delivery.id,
        status: { in: ["CLAIMED", "RUNNING"] },
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
    return tx.automationDelivery.findUnique({ where: { id: delivery.id } });
  }, { timeout: 30_000 });
  await updateCandidateFromTerminal(finalDelivery, terminalStatus, outcomeCode);
  return { ok: true, duplicate: false, delivery: finalDelivery };
}

async function failActionDelivery(input) {
  const delivery = await requireLease(input);
  const now = new Date();
  const failureCode = clean(input.failureCode, 120) || "unknown";
  const lastError = clean(input.error, 2000) || failureCode;
  const safetyRecovery = mustPreserveRefollowSaga(delivery, failureCode) || isSfsCleanupDelivery(delivery);
  const retryable = input.retryable === true && (safetyRecovery || delivery.attempts < delivery.maxAttempts);
  const nextStatus = retryable ? "RETRY_SCHEDULED" : "FAILED";
  const nextNotBefore = retryable ? new Date(now.getTime() + retryDelayMs(delivery.attempts, failureCode, input.retryAfterMs)) : delivery.notBefore;
  const result = {
    ...object(delivery.result),
    ...object(input.result),
    failureCode,
    failedAt: now.toISOString(),
    retryable,
  };
  const changed = await prisma.automationDelivery.updateMany({
    where: {
      id: delivery.id,
      status: { in: ["CLAIMED", "RUNNING"] },
      claimedByDeviceId: input.deviceId,
      leaseTokenHash: hashToken(input.leaseToken),
      leaseRevision: input.leaseRevision,
    },
    data: {
      status: nextStatus,
      failureCode,
      lastError,
      result,
      notBefore: nextNotBefore,
      finishedAt: retryable ? null : now,
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      leaseTokenHash: null,
      leaseRevision: { increment: 1 },
      lastCheckedAt: now,
    },
  });
  if (!changed.count) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery changed before failure update");
  const updated = await prisma.automationDelivery.findUnique({ where: { id: delivery.id } });
  if (retryable) {
    await updateModuleCandidateProgress(updated, "RETRY_SCHEDULED", failureCode);
    if (updated?.moduleKey === "likes") await finalizeLikeFailure({ delivery: updated, failureCode, retryable: true, result });
    if (updated?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) await finalizeFollowAutomationFailure({ delivery: updated, failureCode, retryable: true });
    if (updated?.moduleKey === SFS_MODULE_KEY) await finalizeSfsFailure({ delivery: updated, failureCode, retryable: true });
  } else {
    await updateCandidateFromTerminal(updated, "FAILED", failureCode);
    if (updated?.moduleKey === "bumps") await finalizeBumpFailure({ delivery: updated, failureCode, retryable: false });
    if (updated?.moduleKey === "likes") await finalizeLikeFailure({ delivery: updated, failureCode, retryable: false, result });
    if (updated?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) await finalizeFollowAutomationFailure({ delivery: updated, failureCode, retryable: false });
    if (updated?.moduleKey === SFS_MODULE_KEY) await finalizeSfsFailure({ delivery: updated, failureCode, retryable: false });
  }
  return { ok: true, retryable, retryAt: retryable ? nextNotBefore : null, delivery: updated };
}

async function releaseActionDelivery(input) {
  const delivery = await requireLease({ ...input, allowExpired: true });
  const now = new Date();
  const runAfterMs = Math.max(0, Math.min(24 * 60 * 60_000, Number(input.runAfterMs) || 0));
  const changed = await prisma.automationDelivery.updateMany({
    where: {
      id: delivery.id,
      status: { in: ["CLAIMED", "RUNNING"] },
      claimedByDeviceId: input.deviceId,
      leaseTokenHash: hashToken(input.leaseToken),
      leaseRevision: input.leaseRevision,
    },
    data: {
      status: "QUEUED",
      notBefore: new Date(now.getTime() + runAfterMs),
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      leaseTokenHash: null,
      leaseRevision: { increment: 1 },
      attempts: { decrement: 1 },
      failureCode: null,
      lastError: clean(input.reason, 500),
      result: { ...object(delivery.result), releasedAt: now.toISOString(), releaseReason: clean(input.reason, 500) },
    },
  });
  if (!changed.count) throw new ActionDeliveryError("DELIVERY_LEASE_STALE", "Delivery changed before release");
  const updated = await prisma.automationDelivery.findUnique({ where: { id: delivery.id } });
  await updateModuleCandidateProgress(updated, "QUEUED", clean(input.reason, 500));
  return { ok: true, delivery: updated };
}

async function listActionDeliveries({ agencyId, creatorId, creatorIds = null, moduleKey, actionType, status, deviceId, fan, offset = 0, limit = 100 }) {
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  const skip = Math.max(0, Number(offset) || 0);
  const search = clean(fan, 160);
  const where = {
    agencyId,
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

async function retryActionDelivery({ agencyId, deliveryId }) {
  const delivery = await prisma.automationDelivery.findFirst({ where: { id: deliveryId, agencyId } });
  if (!delivery) throw new ActionDeliveryError("DELIVERY_NOT_FOUND", "Delivery not found", 404);
  if (!["FAILED", "SKIPPED", "CANCELED", "PAUSED"].includes(delivery.status)) {
    throw new ActionDeliveryError("DELIVERY_NOT_RETRYABLE", `Delivery status ${delivery.status} cannot be retried`);
  }
  if (delivery.failureCode && ["permission_denied", "invalid_payload", "fan_not_found", "blocked", "creator_revoked"].includes(delivery.failureCode)) {
    throw new ActionDeliveryError("DELIVERY_UNSAFE_RETRY", `Failure ${delivery.failureCode} requires a new action generation`);
  }
  const control = await assertDeliveryControl(delivery);
  let retryAt = new Date();
  if (delivery.moduleKey === "bumps") {
    const validation = await validateBumpDelivery({ delivery, control, now: retryAt });
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
      const changed = await prisma.automationDelivery.updateMany({
        where: { id: delivery.id, status: delivery.status, leaseRevision: delivery.leaseRevision },
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
      const latest = await prisma.automationDelivery.findUnique({ where: { id: delivery.id } });
      await finalizeLikeTerminal({ delivery: latest, status: "COMPLETED", failureCode: "already_liked", result: latest?.result || {} });
      return { ok: true, duplicate: true, delivery: latest };
    }
    if (validation.ok === false && validation.retryAt) retryAt = validation.retryAt;
  }
  if (delivery.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
    const validation = await validateFollowAutomationDelivery({ delivery, control, now: retryAt });
    if (validation.ok === false && validation.terminal === true) {
      throw new ActionDeliveryError("DELIVERY_UNSAFE_RETRY", `Follow Automation delivery is no longer valid: ${validation.code || "validation_failed"}`);
    }
    if (validation.ok === false && validation.retryAt) retryAt = validation.retryAt;
  }
  if (delivery.moduleKey === SFS_MODULE_KEY) {
    const validation = await validateSfsDelivery({ delivery, control, now: retryAt });
    if (validation.ok === false && validation.terminal === true && validation.code !== "already_unfollowed") {
      throw new ActionDeliveryError("DELIVERY_UNSAFE_RETRY", `SFS delivery is no longer valid: ${validation.code || "validation_failed"}`);
    }
    if (validation.ok === false && validation.retryAt) retryAt = validation.retryAt;
  }
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, leaseRevision: delivery.leaseRevision },
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
    return latest;
  });
  await updateModuleCandidateProgress(updated, "QUEUED");
  return { ok: true, delivery: updated };
}

async function cancelActionDelivery({ agencyId, deliveryId, reason = "manual_cancel" }) {
  const delivery = await prisma.automationDelivery.findFirst({ where: { id: deliveryId, agencyId } });
  if (!delivery) throw new ActionDeliveryError("DELIVERY_NOT_FOUND", "Delivery not found", 404);
  if (TERMINAL_STATUSES.includes(delivery.status)) return { ok: true, duplicate: true, delivery };
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
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, leaseRevision: delivery.leaseRevision },
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
    return latest;
  });
  await updateCandidateFromTerminal(updated, "CANCELED", "canceled");
  return { ok: true, duplicate: false, delivery: updated };
}

async function releaseClaimByAdmin({ agencyId, deliveryId }) {
  const delivery = await prisma.automationDelivery.findFirst({ where: { id: deliveryId, agencyId } });
  if (!delivery) throw new ActionDeliveryError("DELIVERY_NOT_FOUND", "Delivery not found", 404);
  if (!["CLAIMED", "RUNNING"].includes(delivery.status)) return { ok: true, duplicate: true, delivery };
  const changed = await prisma.automationDelivery.updateMany({
    where: { id: delivery.id, status: { in: ["CLAIMED", "RUNNING"] }, leaseRevision: delivery.leaseRevision },
    data: {
      status: "QUEUED",
      notBefore: new Date(Date.now() + 15_000),
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      leaseTokenHash: null,
      leaseRevision: { increment: 1 },
      attempts: { decrement: 1 },
      lastError: "Claim released by administrator",
    },
  });
  if (!changed.count) throw new ActionDeliveryError("DELIVERY_CHANGED", "Delivery changed before administrative release");
  const updated = await prisma.automationDelivery.findUnique({ where: { id: delivery.id } });
  await updateModuleCandidateProgress(updated, "QUEUED", "claim_released");
  return { ok: true, delivery: updated };
}

async function retrySafeFailures({ agencyId, creatorId = null, moduleKey = null, limit = 100 }) {
  const safeCodes = [
    "network_error",
    "timeout",
    "rate_limited",
    "temporary_of_error",
    "backend_temporary_error",
    "creator_unavailable",
    "lease_lost",
    "unknown",
  ];
  const rows = await prisma.automationDelivery.findMany({
    where: {
      agencyId,
      status: "FAILED",
      failureCode: { in: safeCodes },
      ...(creatorId ? { creatorId } : {}),
      ...(moduleKey ? { moduleKey } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(500, Number(limit) || 100)),
    select: { id: true },
  });
  const results = [];
  for (const row of rows) {
    try {
      results.push(await retryActionDelivery({ agencyId, deliveryId: row.id }));
    } catch (error) {
      results.push({ ok: false, deliveryId: row.id, code: error?.code || "retry_failed", error: error?.message || String(error) });
    }
  }
  return { ok: true, requested: rows.length, retried: results.filter((item) => item.ok).length, results };
}

module.exports = {
  ActionDeliveryError,
  CLAIMABLE_STATUSES,
  TERMINAL_STATUSES,
  sweepExpiredActionLeases,
  claimActionDelivery,
  renewActionLease,
  startActionDelivery,
  validateActionDelivery,
  completeActionDelivery,
  failActionDelivery,
  releaseActionDelivery,
  listActionDeliveries,
  retryActionDelivery,
  retrySafeFailures,
  cancelActionDelivery,
  releaseClaimByAdmin,
};
