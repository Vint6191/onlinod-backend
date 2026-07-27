"use strict";

const prisma = require("../prisma");
const { restartCreatorDialogPlan } = require("./dialog-intelligence-service");

const OFFLINE_DIALOG_RECOVERY_GAP_MS = 60 * 60 * 1000;
const OFFLINE_DIALOG_RECOVERY_SOURCE = "offline_gap_recovery";
const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING", "PAUSED"];
const UNFINISHED_HISTORY_STATUSES = ["PLANNED", "QUEUED", "RUNNING", "PAUSED", "FAILED", "IDLE", "CANCELLED", "CANCELED"];
const COVERAGE_RELEASE_REASONS = new Set([
  // These are the only decisions that prove there is no unresolved historical
  // hole left to fence. Every scheduling, module-control, race or baseline
  // failure keeps the previous contiguous boundary for a later retry.
  "gap_already_recovered",
  "gap_below_threshold",
  "coverage_unknown",
]);

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
function shouldPreserveRealtimeCoverage(result) {
  if (!result || typeof result !== "object") return false;
  const reason = clean(result.reason, 80);
  return !COVERAGE_RELEASE_REASONS.has(reason);
}

async function completedBaselineSettledAfterGap({ db, agencyId, creatorId, baseline, lastCoveredAt }) {
  const coveredAt = dateOrNull(lastCoveredAt);
  const settledAt = dateOrNull(baseline?.completedAt || baseline?.updatedAt || baseline?.createdAt);
  if (!coveredAt || !settledAt || settledAt.getTime() <= coveredAt.getTime()) return false;
  const generation = Number(baseline?.generation);
  if (!Number.isInteger(generation) || generation < 0 || !db?.dialogScanState?.findFirst) return false;
  const unfinished = await db.dialogScanState.findFirst({
    where: {
      agencyId,
      creatorId,
      generation,
      dialogId: { notIn: ["__dialog_discovery__", "__dialog_history_batch__"] },
      status: { in: UNFINISHED_HISTORY_STATUSES },
    },
    select: { id: true },
  });
  return !unfinished;
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
      select: { id: true, source: true, generation: true, completedAt: true, createdAt: true, updatedAt: true },
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

  // Do not schedule the same historical gap again after a discovery and every
  // history row from that generation have already settled. The heartbeat may
  // now advance the contiguous realtime coverage timestamp safely.
  if (await completedBaselineSettledAfterGap({
    db,
    agencyId: agency,
    creatorId: creator,
    baseline: completedBaseline,
    lastCoveredAt,
  })) {
    return {
      ok: true,
      created: false,
      reason: "gap_already_recovered",
      gapMs,
      runId: completedBaseline.id,
      generation: completedBaseline.generation,
      settledAt: dateOrNull(completedBaseline.completedAt)?.toISOString() || null,
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
  shouldPreserveRealtimeCoverage,
};
