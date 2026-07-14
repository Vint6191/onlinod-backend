"use strict";

const prisma = require("../prisma");

const FOLLOW_BACK_MODULE_KEY = "follow_back";
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

async function requireCreator(agencyId, creatorId, db = prisma) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true, agencyId: true, displayName: true, username: true, status: true },
  });
  if (!creator) throw Object.assign(new Error("Creator not found"), { code: "CREATOR_NOT_FOUND", status: 404 });
  return creator;
}

async function getRows({ agencyId, creatorId, db = prisma }) {
  const scopeKeys = [workspaceScopeKey(), creatorScopeKey(creatorId), moduleScopeKey(creatorId, FOLLOW_BACK_MODULE_KEY)];
  const rows = await db.automationControlState.findMany({ where: { agencyId, scopeKey: { in: scopeKeys } } });
  return new Map(rows.map((row) => [row.scopeKey, row]));
}

async function getAutomationControlSnapshot({ agencyId, creatorId, db = prisma }) {
  const creator = await requireCreator(agencyId, creatorId, db);
  const rows = await getRows({ agencyId, creatorId, db });
  const workspace = rows.get(workspaceScopeKey());
  const creatorRow = rows.get(creatorScopeKey(creatorId));
  const followBack = rows.get(moduleScopeKey(creatorId, FOLLOW_BACK_MODULE_KEY));
  const workspaceSettings = normalizeWorkspaceSettings(workspace?.settings);
  const followBackSettings = normalizeFollowBackSettings(followBack?.settings);
  const workspaceEnabled = workspace?.enabled !== false;
  const creatorEnabled = creatorRow?.enabled !== false;
  const moduleEnabled = followBack?.enabled === true && followBackSettings.enabled === true;
  return {
    creator,
    workspace: { enabled: workspaceEnabled, settings: workspaceSettings, updatedAt: workspace?.updatedAt || null },
    creatorControl: { enabled: creatorEnabled, settings: object(creatorRow?.settings), updatedAt: creatorRow?.updatedAt || null },
    modules: {
      [FOLLOW_BACK_MODULE_KEY]: {
        enabled: moduleEnabled,
        configuredEnabled: followBack?.enabled === true,
        settings: { ...followBackSettings, enabled: moduleEnabled },
        updatedAt: followBack?.updatedAt || null,
      },
    },
    effective: {
      workspaceEnabled,
      creatorEnabled,
      followBackEnabled: workspaceEnabled && creatorEnabled && moduleEnabled,
    },
  };
}

async function pauseDeliveriesForControl({ agencyId, creatorId = null, moduleKey = null, reason, failureCode, db = prisma }) {
  const now = new Date();
  const updated = await db.automationDelivery.updateMany({
    where: {
      agencyId,
      status: { in: ACTIVE_DELIVERY_STATUSES },
      ...(creatorId ? { creatorId } : {}),
      ...(moduleKey ? { moduleKey } : {}),
    },
    data: {
      status: "PAUSED",
      failureCode,
      lastError: reason,
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      leaseTokenHash: null,
      leaseRevision: { increment: 1 },
      lastCheckedAt: now,
    },
  });
  return updated.count;
}

async function resumeDeliveriesForControl({ agencyId, creatorId = null, moduleKey = null, db = prisma }) {
  const enabled = new Map();
  let cursorId = null;
  let resumed = 0;
  for (;;) {
    const rows = await db.automationDelivery.findMany({
      where: {
        agencyId,
        status: "PAUSED",
        ...(creatorId ? { creatorId } : {}),
        ...(moduleKey ? { moduleKey } : {}),
      },
      select: { id: true, creatorId: true, moduleKey: true },
      orderBy: { id: "asc" },
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: 1000,
    });
    if (!rows.length) break;

    const resumableIds = [];
    for (const row of rows) {
      const key = `${row.creatorId}:${row.moduleKey}`;
      if (!enabled.has(key)) {
        try {
          const snapshot = await getAutomationControlSnapshot({ agencyId, creatorId: row.creatorId, db });
          enabled.set(key, row.moduleKey === FOLLOW_BACK_MODULE_KEY
            ? snapshot.effective.followBackEnabled
            : snapshot.effective.workspaceEnabled && snapshot.effective.creatorEnabled);
        } catch {
          enabled.set(key, false);
        }
      }
      if (enabled.get(key)) resumableIds.push(row.id);
    }
    if (resumableIds.length) {
      const now = new Date();
      const updated = await db.automationDelivery.updateMany({
        where: { id: { in: resumableIds }, status: "PAUSED" },
        data: {
          status: "QUEUED",
          failureCode: null,
          lastError: null,
          notBefore: now,
          lastCheckedAt: now,
        },
      });
      resumed += updated.count;
    }
    cursorId = rows[rows.length - 1].id;
    if (rows.length < 1000) break;
  }
  return resumed;
}

async function setAutomationControl({ agencyId, userId, scope, creatorId = null, moduleKey = null, enabled, settings, db = prisma }) {
  const normalizedScope = clean(scope, 40);
  if (!normalizedScope || !["workspace", "creator", "module"].includes(normalizedScope)) {
    throw Object.assign(new Error("Invalid automation control scope"), { code: "INVALID_CONTROL_SCOPE", status: 400 });
  }
  if (normalizedScope !== "workspace") await requireCreator(agencyId, creatorId, db);
  if (normalizedScope === "module" && moduleKey !== FOLLOW_BACK_MODULE_KEY) {
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
      ? normalizeFollowBackSettings(settings === undefined ? existing?.settings : settings)
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

  return {
    ok: true,
    control: row,
    changedDeliveries,
    snapshot: creatorId ? await getAutomationControlSnapshot({ agencyId, creatorId, db }) : null,
  };
}

async function assertAutomationEnabled({ agencyId, creatorId, moduleKey, db = prisma }) {
  const snapshot = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  if (!snapshot.effective.workspaceEnabled) throw Object.assign(new Error("Automation workspace is disabled"), { code: "workspace_disabled", status: 409 });
  if (!snapshot.effective.creatorEnabled) throw Object.assign(new Error("Creator automation is disabled"), { code: "creator_disabled", status: 409 });
  if (moduleKey === FOLLOW_BACK_MODULE_KEY && !snapshot.effective.followBackEnabled) {
    throw Object.assign(new Error("Follow Back is disabled"), { code: "module_disabled", status: 409 });
  }
  return snapshot;
}

module.exports = {
  FOLLOW_BACK_MODULE_KEY,
  ACTIVE_DELIVERY_STATUSES,
  QUEUED_DELIVERY_STATUSES,
  DEFAULT_WORKSPACE_SETTINGS,
  DEFAULT_FOLLOW_BACK_SETTINGS,
  normalizeWorkspaceSettings,
  normalizeFollowBackSettings,
  getAutomationControlSnapshot,
  setAutomationControl,
  assertAutomationEnabled,
  requireCreator,
};
