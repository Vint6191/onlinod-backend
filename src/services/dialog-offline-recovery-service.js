"use strict";

const prisma = require("../prisma");
const { restartCreatorDialogPlan } = require("./dialog-intelligence-service");

const OFFLINE_DIALOG_RECOVERY_GAP_MS = 60 * 60 * 1000;
const OFFLINE_DIALOG_RECOVERY_SOURCE = "offline_gap_recovery";
const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING", "PAUSED"];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function clean(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function historyControlState(run) {
  const control = object(object(run?.continuation).historyControl);
  return clean(control.state, 40)?.toUpperCase() || "";
}
function offlineGapMs(lastCoveredAt, now = new Date()) {
  const coveredAt = dateOrNull(lastCoveredAt);
  const current = dateOrNull(now) || new Date();
  if (!coveredAt) return null;
  return Math.max(0, current.getTime() - coveredAt.getTime());
}
function hasLongOfflineGap(lastCoveredAt, now = new Date(), thresholdMs = OFFLINE_DIALOG_RECOVERY_GAP_MS) {
  const gap = offlineGapMs(lastCoveredAt, now);
  return gap !== null && gap >= Math.max(1, Number(thresholdMs) || OFFLINE_DIALOG_RECOVERY_GAP_MS);
}

async function scheduleOfflineDialogRecovery({
  agencyId,
  creatorId,
  lastCoveredAt,
  now = new Date(),
  thresholdMs = OFFLINE_DIALOG_RECOVERY_GAP_MS,
  db = prisma,
  schedule = restartCreatorDialogPlan,
} = {}) {
  const agency = clean(agencyId, 160);
  const creator = clean(creatorId, 160);
  const gapMs = offlineGapMs(lastCoveredAt, now);
  if (!agency || !creator) return { ok: false, created: false, reason: "missing_scope", gapMs };
  if (gapMs === null) return { ok: true, created: false, reason: "coverage_unknown", gapMs: null };
  if (gapMs < thresholdMs) return { ok: true, created: false, reason: "gap_below_threshold", gapMs };

  const [latestDiscovery, completedBaseline, activeDiscovery] = await Promise.all([
    db.dialogScanRun.findFirst({
      where: { agencyId: agency, creatorId: creator, dialogId: "__dialog_discovery__" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, continuation: true, createdAt: true, updatedAt: true },
    }),
    db.dialogScanRun.findFirst({
      where: { agencyId: agency, creatorId: creator, dialogId: "__dialog_discovery__", status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      select: { id: true, generation: true, completedAt: true },
    }),
    db.dialogScanRun.findFirst({
      where: {
        agencyId: agency,
        creatorId: creator,
        dialogId: "__dialog_discovery__",
        status: { in: ACTIVE_RUN_STATUSES },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, source: true, generation: true },
    }),
  ]);

  if (!completedBaseline) {
    return { ok: true, created: false, reason: "baseline_missing", gapMs };
  }
  const controlState = historyControlState(latestDiscovery);
  if (controlState === "PAUSED") {
    return { ok: true, created: false, reason: "history_paused", gapMs };
  }
  if (["CANCELLED", "CANCELED"].includes(controlState)) {
    return { ok: true, created: false, reason: "history_cancelled", gapMs };
  }
  if (activeDiscovery) {
    return {
      ok: true,
      created: false,
      reason: "already_in_flight",
      gapMs,
      runId: activeDiscovery.id,
      status: activeDiscovery.status,
    };
  }

  const result = await schedule({
    agencyId: agency,
    creatorId: creator,
    childMode: "incremental",
    forceChildFull: false,
    source: OFFLINE_DIALOG_RECOVERY_SOURCE,
    generation: null,
    pageLimit: 50,
    overlapPages: 2,
    maxPages: 10_000,
    priority: 80,
    knownMessageThreshold: 1,
    userId: null,
  });
  return {
    ...result,
    ok: result?.ok !== false,
    gapMs,
    offlineSince: dateOrNull(lastCoveredAt)?.toISOString() || null,
    recoverySource: OFFLINE_DIALOG_RECOVERY_SOURCE,
  };
}

module.exports = {
  OFFLINE_DIALOG_RECOVERY_GAP_MS,
  OFFLINE_DIALOG_RECOVERY_SOURCE,
  offlineGapMs,
  hasLongOfflineGap,
  scheduleOfflineDialogRecovery,
};
