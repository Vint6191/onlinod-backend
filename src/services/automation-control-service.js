"use strict";

const prisma = require("../prisma");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { runDbTransaction } = require("./db-transaction-service");

const FOLLOW_BACK_MODULE_KEY = "follow_back";
const BUMPS_MODULE_KEY = "bumps";
const { LIKES_MODULE_KEY, LIKES_DISCOVERY_JOB_KEY } = require("./likes-constants");
const { FOLLOW_AUTOMATION_MODULE_KEY, UNFOLLOW_FAN_ACTION_TYPE, FOLLOW_FAN_ACTION_TYPE } = require("./follow-automation-constants");
const { SFS_MODULE_KEY, SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY, SFS_UNFOLLOW_TARGET_ACTION_TYPE } = require("./sfs-constants");
const { DEFAULT_SFS_SETTINGS, normalizeSfsSettings } = require("./sfs-rules");
const SUPPORTED_MODULE_KEYS = new Set([FOLLOW_BACK_MODULE_KEY, BUMPS_MODULE_KEY, LIKES_MODULE_KEY, FOLLOW_AUTOMATION_MODULE_KEY, SFS_MODULE_KEY]);
const ACTIVE_DELIVERY_STATUSES = ["QUEUED", "CLAIMED", "RUNNING", "RETRY_SCHEDULED"];
const QUEUED_DELIVERY_STATUSES = ["QUEUED", "RETRY_SCHEDULED"];

const DEFAULT_WORKSPACE_SETTINGS = Object.freeze({
  globalWriteMinIntervalMs: 15_000,
  globalWriteMaxIntervalMs: 30_000,
  randomJitter: true,
});

const DEFAULT_FOLLOW_BACK_SETTINGS = Object.freeze({
  enabled: false,
  automatic: false,
  activeSubscribers: true,
  freeSubscribers: true,
  paidSubscribers: true,
  expiredSubscribers: false,
  dailyLimit: 50,
  minimumIntervalMs: 15_000,
  maximumIntervalMs: 60_000,
  randomJitter: true,
  maxAttempts: 2,
  refollowEnabled: false,
  refollowCooldownDays: 14,
  attentionTouchEnabled: false,
  likesEnabled: false,
});

const DEFAULT_BUMP_SETTINGS = Object.freeze({
  enabled: false,
  automatic: false,
  onlineEnabled: true,
  hiddenOnlineEnabled: true,
  paidSubscribersEnabled: true,
  freeSubscribersEnabled: true,
  subscriptionEventsEnabled: true,
  dailyLimit: 250,
  minimumIntervalMs: 15_000,
  maximumIntervalMs: 30_000,
  randomJitter: true,
  maxAttempts: 3,
  deleteAfterNoReplyMs: 60 * 60_000,
  hiddenRetryIntervalMs: 3 * 60 * 60_000,
  afterReplyCooldownMs: 24 * 60 * 60_000,
  afterSendCooldownMs: 6 * 60 * 60_000,
  sameTemplateCooldownMs: 24 * 60 * 60_000,
  onlineObservationTtlMs: 2 * 60_000,
  candidateBatchSize: 50,
  verifyRecentMessagesLimit: 20,
});
const DEFAULT_FOLLOW_AUTOMATION_SETTINGS = Object.freeze({
  enabled: false,
  automatic: false,
  refollowEnabled: false,
  dailyLimit: 25,
  minimumIntervalMs: 15_000,
  maximumIntervalMs: 60_000,
  randomJitter: true,
  maxAttempts: 3,
  recoveryMaxAttempts: 10,
  refollowPauseMinMs: 15_000,
  refollowPauseMaxMs: 60_000,
  refollowCooldownDays: 14,
  maxNudgesPerFan: 1,
});

const DEFAULT_LIKES_SETTINGS = Object.freeze({
  enabled: false,
  automatic: false,
  activeSubscribers: true,
  freeSubscribers: true,
  paidSubscribers: true,
  expiredSubscribers: false,
  dailyLimit: 100,
  minimumIntervalMs: 8_000,
  maximumIntervalMs: 35_000,
  randomJitter: true,
  maxAttempts: 3,
  postsPerFanMin: 1,
  postsPerFanMax: 3,
  discoveryPostLimit: 10,
  contentMaxAgeDays: 90,
  discoveryBatchSize: 50,
  discoveryFreshnessHours: 24,
  onlyUnliked: true,
});


function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function clean(value, max = 160) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function int(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
function bool(value, fallback) {
  return value === undefined || value === null ? fallback : value === true;
}
function workspaceScopeKey() { return "workspace"; }
function creatorScopeKey(creatorId) { return `creator:${creatorId}`; }
function moduleScopeKey(creatorId, moduleKey) { return `creator:${creatorId}:module:${moduleKey}`; }

function normalizeWorkspaceSettings(value) {
  const input = object(value);
  const min = int(input.globalWriteMinIntervalMs, DEFAULT_WORKSPACE_SETTINGS.globalWriteMinIntervalMs, 1_000, 10 * 60_000);
  const max = int(input.globalWriteMaxIntervalMs, DEFAULT_WORKSPACE_SETTINGS.globalWriteMaxIntervalMs, min, 30 * 60_000);
  return {
    globalWriteMinIntervalMs: min,
    globalWriteMaxIntervalMs: max,
    randomJitter: bool(input.randomJitter, DEFAULT_WORKSPACE_SETTINGS.randomJitter),
  };
}

function normalizeFollowBackSettings(value) {
  const input = object(value);
  const minimumIntervalMs = int(input.minimumIntervalMs, DEFAULT_FOLLOW_BACK_SETTINGS.minimumIntervalMs, 5_000, 30 * 60_000);
  const maximumIntervalMs = int(input.maximumIntervalMs, DEFAULT_FOLLOW_BACK_SETTINGS.maximumIntervalMs, minimumIntervalMs, 60 * 60_000);
  return {
    enabled: bool(input.enabled, DEFAULT_FOLLOW_BACK_SETTINGS.enabled),
    automatic: bool(input.automatic, DEFAULT_FOLLOW_BACK_SETTINGS.automatic),
    activeSubscribers: bool(input.activeSubscribers, DEFAULT_FOLLOW_BACK_SETTINGS.activeSubscribers),
    freeSubscribers: bool(input.freeSubscribers, DEFAULT_FOLLOW_BACK_SETTINGS.freeSubscribers),
    paidSubscribers: bool(input.paidSubscribers, DEFAULT_FOLLOW_BACK_SETTINGS.paidSubscribers),
    expiredSubscribers: bool(input.expiredSubscribers, DEFAULT_FOLLOW_BACK_SETTINGS.expiredSubscribers),
    dailyLimit: int(input.dailyLimit, DEFAULT_FOLLOW_BACK_SETTINGS.dailyLimit, 0, 10_000),
    minimumIntervalMs,
    maximumIntervalMs,
    randomJitter: bool(input.randomJitter, DEFAULT_FOLLOW_BACK_SETTINGS.randomJitter),
    maxAttempts: int(input.maxAttempts, DEFAULT_FOLLOW_BACK_SETTINGS.maxAttempts, 1, 10),
    refollowEnabled: bool(input.refollowEnabled, DEFAULT_FOLLOW_BACK_SETTINGS.refollowEnabled),
    refollowCooldownDays: int(input.refollowCooldownDays, DEFAULT_FOLLOW_BACK_SETTINGS.refollowCooldownDays, 1, 365),
    attentionTouchEnabled: bool(input.attentionTouchEnabled, DEFAULT_FOLLOW_BACK_SETTINGS.attentionTouchEnabled),
    likesEnabled: bool(input.likesEnabled, DEFAULT_FOLLOW_BACK_SETTINGS.likesEnabled),
  };
}

function normalizeBumpSettings(value) {
  const input = object(value);
  const minimumIntervalMs = int(input.minimumIntervalMs, DEFAULT_BUMP_SETTINGS.minimumIntervalMs, 15_000, 30 * 60_000);
  const maximumIntervalMs = int(
    input.maximumIntervalMs,
    DEFAULT_BUMP_SETTINGS.maximumIntervalMs,
    Math.max(minimumIntervalMs, DEFAULT_BUMP_SETTINGS.maximumIntervalMs),
    60 * 60_000,
  );
  return {
    enabled: bool(input.enabled, DEFAULT_BUMP_SETTINGS.enabled),
    automatic: bool(input.automatic, DEFAULT_BUMP_SETTINGS.automatic),
    onlineEnabled: bool(input.onlineEnabled, DEFAULT_BUMP_SETTINGS.onlineEnabled),
    hiddenOnlineEnabled: bool(input.hiddenOnlineEnabled, DEFAULT_BUMP_SETTINGS.hiddenOnlineEnabled),
    paidSubscribersEnabled: bool(input.paidSubscribersEnabled, DEFAULT_BUMP_SETTINGS.paidSubscribersEnabled),
    freeSubscribersEnabled: bool(input.freeSubscribersEnabled, DEFAULT_BUMP_SETTINGS.freeSubscribersEnabled),
    subscriptionEventsEnabled: bool(input.subscriptionEventsEnabled, DEFAULT_BUMP_SETTINGS.subscriptionEventsEnabled),
    dailyLimit: int(input.dailyLimit, DEFAULT_BUMP_SETTINGS.dailyLimit, 0, 100_000),
    minimumIntervalMs,
    maximumIntervalMs,
    randomJitter: bool(input.randomJitter, DEFAULT_BUMP_SETTINGS.randomJitter),
    maxAttempts: int(input.maxAttempts, DEFAULT_BUMP_SETTINGS.maxAttempts, 1, 10),
    deleteAfterNoReplyMs: int(input.deleteAfterNoReplyMs, DEFAULT_BUMP_SETTINGS.deleteAfterNoReplyMs, 60_000, 14 * 24 * 60 * 60_000),
    hiddenRetryIntervalMs: int(input.hiddenRetryIntervalMs, DEFAULT_BUMP_SETTINGS.hiddenRetryIntervalMs, 5 * 60_000, 30 * 24 * 60 * 60_000),
    afterReplyCooldownMs: int(input.afterReplyCooldownMs, DEFAULT_BUMP_SETTINGS.afterReplyCooldownMs, 0, 90 * 24 * 60 * 60_000),
    afterSendCooldownMs: int(input.afterSendCooldownMs, DEFAULT_BUMP_SETTINGS.afterSendCooldownMs, 0, 90 * 24 * 60 * 60_000),
    sameTemplateCooldownMs: int(input.sameTemplateCooldownMs, DEFAULT_BUMP_SETTINGS.sameTemplateCooldownMs, 0, 90 * 24 * 60 * 60_000),
    onlineObservationTtlMs: int(input.onlineObservationTtlMs, DEFAULT_BUMP_SETTINGS.onlineObservationTtlMs, 30_000, 60 * 60_000),
    candidateBatchSize: int(input.candidateBatchSize, DEFAULT_BUMP_SETTINGS.candidateBatchSize, 1, 500),
    verifyRecentMessagesLimit: int(input.verifyRecentMessagesLimit, DEFAULT_BUMP_SETTINGS.verifyRecentMessagesLimit, 5, 100),
  };
}

function normalizeFollowAutomationSettings(value) {
  const input = object(value);
  const minimumIntervalMs = int(input.minimumIntervalMs, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.minimumIntervalMs, 15_000, 30 * 60_000);
  const maximumIntervalMs = int(input.maximumIntervalMs, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.maximumIntervalMs, minimumIntervalMs, 60 * 60_000);
  const refollowPauseMinMs = int(input.refollowPauseMinMs, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.refollowPauseMinMs, 15_000, 10 * 60_000);
  const refollowPauseMaxMs = int(input.refollowPauseMaxMs, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.refollowPauseMaxMs, refollowPauseMinMs, 30 * 60_000);
  return {
    enabled: bool(input.enabled, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.enabled),
    automatic: bool(input.automatic, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.automatic),
    refollowEnabled: bool(input.refollowEnabled, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.refollowEnabled),
    dailyLimit: int(input.dailyLimit, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.dailyLimit, 0, 10_000),
    minimumIntervalMs,
    maximumIntervalMs,
    randomJitter: bool(input.randomJitter, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.randomJitter),
    maxAttempts: int(input.maxAttempts, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.maxAttempts, 1, 10),
    recoveryMaxAttempts: int(input.recoveryMaxAttempts, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.recoveryMaxAttempts, 1, 25),
    refollowPauseMinMs,
    refollowPauseMaxMs,
    refollowCooldownDays: int(input.refollowCooldownDays, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.refollowCooldownDays, 1, 365),
    maxNudgesPerFan: int(input.maxNudgesPerFan, DEFAULT_FOLLOW_AUTOMATION_SETTINGS.maxNudgesPerFan, 1, 20),
  };
}

function normalizeLikesSettings(value) {
  const input = object(value);
  const minimumIntervalMs = int(input.minimumIntervalMs, DEFAULT_LIKES_SETTINGS.minimumIntervalMs, 3_000, 30 * 60_000);
  const maximumIntervalMs = int(input.maximumIntervalMs, DEFAULT_LIKES_SETTINGS.maximumIntervalMs, minimumIntervalMs, 60 * 60_000);
  const postsPerFanMin = int(input.postsPerFanMin, DEFAULT_LIKES_SETTINGS.postsPerFanMin, 1, 10);
  const postsPerFanMax = int(input.postsPerFanMax, DEFAULT_LIKES_SETTINGS.postsPerFanMax, postsPerFanMin, 10);
  return {
    enabled: bool(input.enabled, DEFAULT_LIKES_SETTINGS.enabled),
    automatic: bool(input.automatic, DEFAULT_LIKES_SETTINGS.automatic),
    activeSubscribers: bool(input.activeSubscribers, DEFAULT_LIKES_SETTINGS.activeSubscribers),
    freeSubscribers: bool(input.freeSubscribers, DEFAULT_LIKES_SETTINGS.freeSubscribers),
    paidSubscribers: bool(input.paidSubscribers, DEFAULT_LIKES_SETTINGS.paidSubscribers),
    expiredSubscribers: bool(input.expiredSubscribers, DEFAULT_LIKES_SETTINGS.expiredSubscribers),
    dailyLimit: int(input.dailyLimit, DEFAULT_LIKES_SETTINGS.dailyLimit, 0, 100_000),
    minimumIntervalMs,
    maximumIntervalMs,
    randomJitter: bool(input.randomJitter, DEFAULT_LIKES_SETTINGS.randomJitter),
    maxAttempts: int(input.maxAttempts, DEFAULT_LIKES_SETTINGS.maxAttempts, 1, 10),
    postsPerFanMin,
    postsPerFanMax,
    discoveryPostLimit: int(input.discoveryPostLimit, DEFAULT_LIKES_SETTINGS.discoveryPostLimit, 1, 50),
    contentMaxAgeDays: int(input.contentMaxAgeDays, DEFAULT_LIKES_SETTINGS.contentMaxAgeDays, 1, 3650),
    discoveryBatchSize: int(input.discoveryBatchSize, DEFAULT_LIKES_SETTINGS.discoveryBatchSize, 1, 500),
    discoveryFreshnessHours: int(input.discoveryFreshnessHours, DEFAULT_LIKES_SETTINGS.discoveryFreshnessHours, 1, 24 * 30),
    onlyUnliked: bool(input.onlyUnliked, DEFAULT_LIKES_SETTINGS.onlyUnliked),
  };
}

function normalizeModuleSettings(moduleKey, value) {
  if (moduleKey === FOLLOW_BACK_MODULE_KEY) return normalizeFollowBackSettings(value);
  if (moduleKey === BUMPS_MODULE_KEY) return normalizeBumpSettings(value);
  if (moduleKey === LIKES_MODULE_KEY) return normalizeLikesSettings(value);
  if (moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) return normalizeFollowAutomationSettings(value);
  if (moduleKey === SFS_MODULE_KEY) return normalizeSfsSettings(value);
  return object(value);
}

async function requireCreator(agencyId, creatorId, db = prisma) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true, agencyId: true, displayName: true, username: true, status: true },
  });
  if (!creator) throw Object.assign(new Error("Creator not found"), { code: "CREATOR_NOT_FOUND", status: 404 });
  return creator;
}

async function getRows({ agencyId, creatorId, db = prisma }) {
  const scopeKeys = [
    workspaceScopeKey(),
    creatorScopeKey(creatorId),
    moduleScopeKey(creatorId, FOLLOW_BACK_MODULE_KEY),
    moduleScopeKey(creatorId, BUMPS_MODULE_KEY),
    moduleScopeKey(creatorId, LIKES_MODULE_KEY),
    moduleScopeKey(creatorId, FOLLOW_AUTOMATION_MODULE_KEY),
    moduleScopeKey(creatorId, SFS_MODULE_KEY),
  ];
  const rows = await db.automationControlState.findMany({ where: { agencyId, scopeKey: { in: scopeKeys } } });
  return new Map(rows.map((row) => [row.scopeKey, row]));
}

function moduleSnapshot(row, settings, workspaceEnabled, creatorEnabled) {
  const configuredEnabled = row?.enabled === true;
  const enabled = configuredEnabled && settings.enabled === true;
  return {
    enabled,
    configuredEnabled,
    settings: { ...settings, enabled },
    updatedAt: row?.updatedAt || null,
    effectiveEnabled: workspaceEnabled && creatorEnabled && enabled,
  };
}

async function getAutomationControlSnapshot({ agencyId, creatorId, db = prisma }) {
  const creator = await requireCreator(agencyId, creatorId, db);
  const rows = await getRows({ agencyId, creatorId, db });
  const workspace = rows.get(workspaceScopeKey());
  const creatorRow = rows.get(creatorScopeKey(creatorId));
  const followBackRow = rows.get(moduleScopeKey(creatorId, FOLLOW_BACK_MODULE_KEY));
  const bumpsRow = rows.get(moduleScopeKey(creatorId, BUMPS_MODULE_KEY));
  const likesRow = rows.get(moduleScopeKey(creatorId, LIKES_MODULE_KEY));
  const followRow = rows.get(moduleScopeKey(creatorId, FOLLOW_AUTOMATION_MODULE_KEY));
  const sfsRow = rows.get(moduleScopeKey(creatorId, SFS_MODULE_KEY));
  const workspaceSettings = normalizeWorkspaceSettings(workspace?.settings);
  const followBackSettings = normalizeFollowBackSettings(followBackRow?.settings);
  const bumpSettings = normalizeBumpSettings(bumpsRow?.settings);
  const likesSettings = normalizeLikesSettings(likesRow?.settings);
  const followSettings = normalizeFollowAutomationSettings(followRow?.settings);
  const sfsSettings = normalizeSfsSettings(sfsRow?.settings);
  const workspaceEnabled = workspace?.enabled !== false;
  const creatorEnabled = creatorRow?.enabled !== false;
  const followBack = moduleSnapshot(followBackRow, followBackSettings, workspaceEnabled, creatorEnabled);
  const bumps = moduleSnapshot(bumpsRow, bumpSettings, workspaceEnabled, creatorEnabled);
  const likes = moduleSnapshot(likesRow, likesSettings, workspaceEnabled, creatorEnabled);
  const follow = moduleSnapshot(followRow, followSettings, workspaceEnabled, creatorEnabled);
  const sfs = moduleSnapshot(sfsRow, sfsSettings, workspaceEnabled, creatorEnabled);
  return {
    creator,
    workspace: { enabled: workspaceEnabled, settings: workspaceSettings, updatedAt: workspace?.updatedAt || null },
    creatorControl: { enabled: creatorEnabled, settings: object(creatorRow?.settings), updatedAt: creatorRow?.updatedAt || null },
    modules: {
      [FOLLOW_BACK_MODULE_KEY]: followBack,
      [BUMPS_MODULE_KEY]: bumps,
      [LIKES_MODULE_KEY]: likes,
      [FOLLOW_AUTOMATION_MODULE_KEY]: follow,
      [SFS_MODULE_KEY]: sfs,
    },
    effective: {
      workspaceEnabled,
      creatorEnabled,
      followBackEnabled: followBack.effectiveEnabled,
      bumpsEnabled: bumps.effectiveEnabled,
      likesEnabled: likes.effectiveEnabled,
      followEnabled: follow.effectiveEnabled,
      sfsEnabled: sfs.effectiveEnabled,
    },
  };
}


async function projectControlDeliveryState(db, delivery, status, failureCode = null) {
  if (!delivery) return;
  const staleFence = { OR: [{ latestDeliveryId: null }, { latestDeliveryId: delivery.id }] };
  if (delivery.moduleKey === FOLLOW_BACK_MODULE_KEY) {
    await db.followBackCandidate.updateMany({
      where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.targetId || delivery.fanId, ...staleFence },
      data: { state: status, latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status, latestError: failureCode },
    });
  }
  if (delivery.moduleKey === LIKES_MODULE_KEY) {
    const contentId = delivery.targetId || (delivery.payload && typeof delivery.payload === "object" ? delivery.payload.postId : null);
    if (contentId) await db.automationContentCandidate.updateMany({
      where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, contentType: "post", contentId: String(contentId), ...staleFence },
      data: { state: status, latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status, latestError: failureCode },
    });
  }
  if (delivery.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) {
    const fanId = delivery.targetId || delivery.fanId;
    if (fanId) await db.followAutomationCandidate.updateMany({
      where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId, ...staleFence },
      data: { latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status, latestError: failureCode },
    });
  }
  if (delivery.moduleKey === SFS_MODULE_KEY) {
    const candidateId = delivery.payload && typeof delivery.payload === "object" ? delivery.payload.candidateId : null;
    if (candidateId) await db.sfsTargetCandidate.updateMany({
      where: { id: String(candidateId), agencyId: delivery.agencyId, creatorId: delivery.creatorId, ...staleFence },
      data: { latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status, latestError: failureCode },
    });
  }
}

async function pauseDeliveriesForControl({ agencyId, creatorId = null, moduleKey = null, reason, failureCode, db = prisma }) {
  const now = new Date();
  const rows = await db.automationDelivery.findMany({
    where: {
      agencyId, originKind: "AUTOMATION", status: { in: ACTIVE_DELIVERY_STATUSES }, ...(creatorId ? { creatorId } : {}), ...(moduleKey ? { moduleKey } : {}),
      AND: [
        { NOT: { moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, actionType: UNFOLLOW_FAN_ACTION_TYPE, status: "RUNNING" } },
        ...(moduleKey === FOLLOW_AUTOMATION_MODULE_KEY ? [{ NOT: { moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, actionType: FOLLOW_FAN_ACTION_TYPE } }] : []),
        ...(moduleKey === SFS_MODULE_KEY ? [{ NOT: { moduleKey: SFS_MODULE_KEY, actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE } }] : []),
      ],
    },
    take: 10000,
  });
  let changed = 0;
  for (const row of rows) {
    const applied = await runDbTransaction(db, async (tx) => {
      const updated = await tx.automationDelivery.updateMany({
        where: { id: row.id, originKind: "AUTOMATION", status: row.status, leaseRevision: row.leaseRevision },
        data: {
          status: "PAUSED", failureCode, lastError: reason, claimedByDeviceId: null, claimedAt: null,
          claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 }, lastCheckedAt: now,
        },
      });
      if (!updated.count) return false;
      const current = await tx.automationDelivery.findUnique({ where: { id: row.id } });
      await projectControlDeliveryState(tx, current, "PAUSED", failureCode);
      return true;
    });
    if (applied) changed += 1;
  }
  return changed;
}

function effectiveModuleEnabled(snapshot, moduleKey) {
  if (moduleKey === FOLLOW_BACK_MODULE_KEY) return snapshot.effective.followBackEnabled;
  if (moduleKey === BUMPS_MODULE_KEY) return snapshot.effective.bumpsEnabled;
  if (moduleKey === LIKES_MODULE_KEY) return snapshot.effective.likesEnabled;
  if (moduleKey === FOLLOW_AUTOMATION_MODULE_KEY) return snapshot.effective.followEnabled;
  if (moduleKey === SFS_MODULE_KEY) return snapshot.effective.sfsEnabled;
  return snapshot.effective.workspaceEnabled && snapshot.effective.creatorEnabled;
}

async function resumeDeliveriesForControl({ agencyId, creatorId = null, moduleKey = null, db = prisma }) {
  const enabled = new Map();
  const rows = await db.automationDelivery.findMany({
    where: { agencyId, originKind: "AUTOMATION", status: "PAUSED", ...(creatorId ? { creatorId } : {}), ...(moduleKey ? { moduleKey } : {}) },
    orderBy: { id: "asc" }, take: 10000,
  });
  let resumed = 0;
  for (const row of rows) {
    const key = `${row.creatorId}:${row.moduleKey}`;
    if (!enabled.has(key)) {
      try { const snapshot = await getAutomationControlSnapshot({ agencyId, creatorId: row.creatorId, db }); enabled.set(key, effectiveModuleEnabled(snapshot, row.moduleKey)); }
      catch { enabled.set(key, false); }
    }
    if (!enabled.get(key)) continue;
    const applied = await runDbTransaction(db, async (tx) => {
      const updated = await tx.automationDelivery.updateMany({ where: { id: row.id, originKind: "AUTOMATION", status: "PAUSED", leaseRevision: row.leaseRevision }, data: { status: "QUEUED", failureCode: null, lastError: null, lastCheckedAt: new Date() } });
      if (!updated.count) return false;
      const current = await tx.automationDelivery.findUnique({ where: { id: row.id } });
      await projectControlDeliveryState(tx, current, "QUEUED", null);
      return true;
    });
    if (applied) resumed += 1;
  }
  return resumed;
}

async function cancelAutomationJobsForControl({ agencyId, creatorId = null, moduleKey = null, reason, failureCode, db = prisma }) {
  // Keep the domain failure projector off the module-load path. Automation control
  // settings are imported by lightweight planning/tests that do not bootstrap Prisma.
  const { recordJobFailure } = require("./job-result-service");
  const jobKeys = moduleKey === LIKES_MODULE_KEY ? [LIKES_DISCOVERY_JOB_KEY]
    : moduleKey === SFS_MODULE_KEY ? [SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY]
      : moduleKey ? [] : [LIKES_DISCOVERY_JOB_KEY, SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY];
  if (!jobKeys.length) return 0;
  const rows = await db.jobInstance.findMany({
    where: { agencyId, ...(creatorId ? { creatorId } : {}), jobKey: { in: jobKeys }, status: { in: ["SCHEDULED", "CLAIMED"] } },
    take: 10000,
  });
  const now = new Date();
  let changed = 0;
  for (const job of rows) {
    const applied = await runDbTransaction(db, async (tx) => {
      const updated = await tx.jobInstance.updateMany({
        where: { id: job.id, status: job.status, leaseRevision: job.leaseRevision },
        data: {
          status: "CANCELLED", claimedAt: null, claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, workId: null,
          leaseRevision: { increment: 1 }, completedAt: now, lastError: reason,
          result: { controlFailureCode: failureCode, canceledAt: now.toISOString() },
        },
      });
      if (!updated.count) return false;
      await recordJobFailure({ db: tx, job, error: reason || failureCode || "control_cancelled", terminal: true });
      return true;
    });
    if (applied) changed += 1;
  }
  return changed;
}

async function setAutomationControl({ agencyId, userId, scope, creatorId = null, moduleKey = null, enabled, settings, db = prisma, _commitFenceHeld = false }) {
  if (!_commitFenceHeld && typeof db.$transaction === "function") {
    return db.$transaction((tx) => setAutomationControl({
      agencyId, userId, scope, creatorId, moduleKey, enabled, settings, db: tx, _commitFenceHeld: true,
    }), { timeout: 30_000 });
  }
  await lockAutomationWriteCommitFence({ db, agencyId });

  const normalizedScope = clean(scope, 40);
  if (!normalizedScope || !["workspace", "creator", "module"].includes(normalizedScope)) {
    throw Object.assign(new Error("Invalid automation control scope"), { code: "INVALID_CONTROL_SCOPE", status: 400 });
  }
  if (normalizedScope !== "workspace") await requireCreator(agencyId, creatorId, db);
  if (normalizedScope === "module" && !SUPPORTED_MODULE_KEYS.has(moduleKey)) {
    throw Object.assign(new Error("Unsupported module key"), { code: "UNSUPPORTED_MODULE", status: 400 });
  }

  const scopeKey = normalizedScope === "workspace"
    ? workspaceScopeKey()
    : normalizedScope === "creator"
      ? creatorScopeKey(creatorId)
      : moduleScopeKey(creatorId, moduleKey);
  const existing = await db.automationControlState.findUnique({ where: { agencyId_scopeKey: { agencyId, scopeKey } } });
  const nextSettings = normalizedScope === "workspace"
    ? normalizeWorkspaceSettings(settings === undefined ? existing?.settings : settings)
    : normalizedScope === "module"
      ? normalizeModuleSettings(moduleKey, settings === undefined ? existing?.settings : settings)
      : object(settings === undefined ? existing?.settings : settings);
  const nextEnabled = enabled === undefined ? existing?.enabled !== false : enabled === true;
  if (normalizedScope === "module") nextSettings.enabled = nextEnabled;

  const row = await db.automationControlState.upsert({
    where: { agencyId_scopeKey: { agencyId, scopeKey } },
    create: {
      agencyId,
      scopeKey,
      creatorId: normalizedScope === "workspace" ? null : creatorId,
      moduleKey: normalizedScope === "module" ? moduleKey : null,
      enabled: nextEnabled,
      settings: nextSettings,
      updatedByUserId: userId || null,
    },
    update: {
      enabled: nextEnabled,
      settings: nextSettings,
      updatedByUserId: userId || null,
    },
  });

  const deliveryScope = normalizedScope === "workspace"
    ? { agencyId, creatorId: null, moduleKey: null }
    : normalizedScope === "creator"
      ? { agencyId, creatorId, moduleKey: null }
      : { agencyId, creatorId, moduleKey };
  const disableCode = normalizedScope === "workspace"
    ? "workspace_disabled"
    : normalizedScope === "creator"
      ? "creator_disabled"
      : "module_disabled";
  const changedDeliveries = nextEnabled
    ? await resumeDeliveriesForControl({ ...deliveryScope, db })
    : await pauseDeliveriesForControl({
        ...deliveryScope,
        reason: `${scopeKey} disabled`,
        failureCode: disableCode,
        db,
      });
  const changedJobs = nextEnabled
    ? 0
    : await cancelAutomationJobsForControl({
        ...deliveryScope,
        reason: `${scopeKey} disabled`,
        failureCode: disableCode,
        db,
      });

  return {
    ok: true,
    control: row,
    changedDeliveries,
    changedJobs,
    snapshot: creatorId ? await getAutomationControlSnapshot({ agencyId, creatorId, db }) : null,
  };
}

async function assertAutomationEnabled({ agencyId, creatorId, moduleKey, db = prisma }) {
  const snapshot = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  if (!snapshot.effective.workspaceEnabled) throw Object.assign(new Error("Automation workspace is disabled"), { code: "workspace_disabled", status: 409 });
  if (!snapshot.effective.creatorEnabled) throw Object.assign(new Error("Creator automation is disabled"), { code: "creator_disabled", status: 409 });
  if (!effectiveModuleEnabled(snapshot, moduleKey)) {
    throw Object.assign(new Error(`${moduleKey || "Automation module"} is disabled`), { code: "module_disabled", status: 409 });
  }
  return snapshot;
}

module.exports = {
  FOLLOW_BACK_MODULE_KEY,
  BUMPS_MODULE_KEY,
  LIKES_MODULE_KEY,
  FOLLOW_AUTOMATION_MODULE_KEY,
  SFS_MODULE_KEY,
  SUPPORTED_MODULE_KEYS,
  ACTIVE_DELIVERY_STATUSES,
  QUEUED_DELIVERY_STATUSES,
  DEFAULT_WORKSPACE_SETTINGS,
  DEFAULT_FOLLOW_BACK_SETTINGS,
  DEFAULT_BUMP_SETTINGS,
  DEFAULT_LIKES_SETTINGS,
  DEFAULT_FOLLOW_AUTOMATION_SETTINGS,
  DEFAULT_SFS_SETTINGS,
  normalizeWorkspaceSettings,
  normalizeFollowBackSettings,
  normalizeBumpSettings,
  normalizeLikesSettings,
  normalizeFollowAutomationSettings,
  normalizeSfsSettings,
  getAutomationControlSnapshot,
  setAutomationControl,
  assertAutomationEnabled,
  requireCreator,
};
