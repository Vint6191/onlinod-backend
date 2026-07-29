"use strict";

const prisma = require("../prisma");
const { restartCreatorDialogPlan } = require("./dialog-intelligence-service");

const OFFLINE_DIALOG_RECOVERY_GAP_MS = 60 * 60 * 1000;
const OFFLINE_DIALOG_RECOVERY_SOURCE = "offline_gap_recovery";
const REALTIME_COVERAGE_CLOCK_SKEW_MS = 30 * 1000;
const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING", "PAUSED"];
const UNFINISHED_HISTORY_STATUSES = ["PLANNED", "QUEUED", "RUNNING", "PAUSED", "FAILED", "IDLE", "CANCELLED", "CANCELED"];
const COVERAGE_RELEASE_REASONS = new Set([
  // These are the only decisions that prove there is no unresolved historical
  // hole left to fence. Every scheduling, module-control, race or baseline
  // failure keeps the previous contiguous boundary for a later retry.
  "gap_already_recovered",
  "gap_below_threshold",
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
function isHistoryControlBlocked(run) {
  return ["PAUSED", "CANCELLED", "CANCELED"].includes(historyControlState(run));
}
function hasRealtimeCoverageClockSkew(lastCoveredAt, now = new Date()) {
  const coveredAt = dateOrNull(lastCoveredAt);
  const current = dateOrNull(now) || new Date();
  return Boolean(coveredAt && coveredAt.getTime() > current.getTime() + REALTIME_COVERAGE_CLOCK_SKEW_MS);
}
function offlineGapMs(lastCoveredAt, now = new Date()) {
  const coveredAt = dateOrNull(lastCoveredAt);
  const current = dateOrNull(now) || new Date();
  if (!coveredAt || hasRealtimeCoverageClockSkew(coveredAt, current)) return null;
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

async function completedRecoverySettledAfterGap({
  db,
  agencyId,
  creatorId,
  baseline,
  latestCompletedDiscovery,
  latestDiscovery,
  lastCoveredAt,
  now,
  thresholdMs,
}) {
  // Only a run created specifically for this offline-gap workflow can prove
  // that the missing realtime interval was reconciled. A manual/full/status
  // discovery may finish after the old boundary without scanning the same gap.
  if (clean(baseline?.source, 80) !== OFFLINE_DIALOG_RECOVERY_SOURCE) return false;
  // DialogScanState is intentionally one mutable row per creator/dialog. A
  // later discovery generation overwrites its generation, so querying an old
  // recovery generation can otherwise return zero unfinished rows and look
  // falsely settled. Only the authoritative latest discovery may release the
  // fence; any later completed, failed, cancelled or active generation keeps it.
  if (!baseline?.id || baseline.id !== latestCompletedDiscovery?.id || baseline.id !== latestDiscovery?.id) return false;
  if (isHistoryControlBlocked(baseline) || isHistoryControlBlocked(latestCompletedDiscovery) || isHistoryControlBlocked(latestDiscovery)) return false;

  const coveredAt = dateOrNull(lastCoveredAt);
  const startedAt = dateOrNull(baseline?.createdAt);
  const settledAt = dateOrNull(baseline?.completedAt || baseline?.updatedAt || baseline?.createdAt);
  const current = dateOrNull(now) || new Date();
  const maximumUncoveredTailMs = Math.max(1, Number(thresholdMs) || OFFLINE_DIALOG_RECOVERY_GAP_MS);
  if (!coveredAt || !startedAt || !settledAt) return false;
  if (startedAt.getTime() < coveredAt.getTime() || settledAt.getTime() <= coveredAt.getTime()) return false;
  // A recovery that settled more than one threshold ago cannot close a newer
  // long outage that happened after it. Schedule another incremental pass
  // instead of jumping the contiguous watermark directly to the current time.
  if (current.getTime() - settledAt.getTime() >= maximumUncoveredTailMs) return false;
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
  if (unfinished) return false;

  // Re-check after reading mutable state. A newer discovery can begin between
  // the initial Promise.all snapshot and the generation query, replacing old
  // DialogScanState rows and making the old generation appear empty.
  const latestAfterStateCheck = await db.dialogScanRun.findFirst({
    where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
    orderBy: { createdAt: "desc" },
    select: { id: true, source: true, generation: true, status: true, continuation: true },
  });
  return latestAfterStateCheck?.id === baseline.id
    && clean(latestAfterStateCheck?.source, 80) === OFFLINE_DIALOG_RECOVERY_SOURCE
    && Number(latestAfterStateCheck?.generation) === Number(baseline.generation)
    && clean(latestAfterStateCheck?.status, 40)?.toUpperCase() === "COMPLETED"
    && !isHistoryControlBlocked(latestAfterStateCheck);
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
  const current = dateOrNull(now) || new Date();
  const explicitCoveredAt = dateOrNull(lastCoveredAt);
  const coverageUnknown = !explicitCoveredAt;
  const coverageClockSkew = hasRealtimeCoverageClockSkew(explicitCoveredAt, current);
  let effectiveLastCoveredAt = coverageClockSkew ? new Date(0) : explicitCoveredAt;
  let gapMs = coverageClockSkew
    ? Math.max(1, Number(thresholdMs) || OFFLINE_DIALOG_RECOVERY_GAP_MS)
    : offlineGapMs(effectiveLastCoveredAt, current);
  if (!agency || !creator) return { ok: false, created: false, reason: "missing_scope", gapMs };
  if (!coverageUnknown && gapMs !== null && gapMs < thresholdMs) {
    return { ok: true, created: false, reason: "gap_below_threshold", gapMs };
  }

  const [latestDiscovery, completedBaseline, completedRecovery, activeDiscovery] = await Promise.all([
    db.dialogScanRun.findFirst({
      where: { agencyId: agency, creatorId: creator, dialogId: "__dialog_discovery__" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, continuation: true, createdAt: true, updatedAt: true },
    }),
    db.dialogScanRun.findFirst({
      where: {
        agencyId: agency,
        creatorId: creator,
        dialogId: "__dialog_discovery__",
        status: "COMPLETED",
      },
      orderBy: { completedAt: "desc" },
      select: { id: true, source: true, generation: true, status: true, continuation: true, completedAt: true, createdAt: true, updatedAt: true },
    }),
    db.dialogScanRun.findFirst({
      where: {
        agencyId: agency,
        creatorId: creator,
        dialogId: "__dialog_discovery__",
        status: "COMPLETED",
        source: OFFLINE_DIALOG_RECOVERY_SOURCE,
      },
      orderBy: { completedAt: "desc" },
      select: { id: true, source: true, generation: true, status: true, continuation: true, completedAt: true, createdAt: true, updatedAt: true },
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
  if (coverageUnknown) {
    // A missing observation row is not proof that the creator was continuously
    // covered before the first heartbeat. Anchor continuity to the latest
    // completed discovery; a recent baseline may establish coverage directly,
    // while an older one requires the same incremental recovery as a known gap.
    effectiveLastCoveredAt = dateOrNull(
      completedBaseline.completedAt || completedBaseline.updatedAt || completedBaseline.createdAt,
    );
    gapMs = offlineGapMs(effectiveLastCoveredAt, current);
    if (gapMs === null) {
      return { ok: true, created: false, reason: "coverage_unknown", gapMs: null };
    }
    if (gapMs < thresholdMs) {
      return { ok: true, created: false, reason: "gap_below_threshold", gapMs, coverageUnknown: true };
    }
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
  if (await completedRecoverySettledAfterGap({
    db,
    agencyId: agency,
    creatorId: creator,
    baseline: completedRecovery,
    latestCompletedDiscovery: completedBaseline,
    latestDiscovery,
    lastCoveredAt: effectiveLastCoveredAt,
    now: current,
    thresholdMs,
  })) {
    return {
      ok: true,
      created: false,
      reason: "gap_already_recovered",
      gapMs,
      runId: completedRecovery.id,
      generation: completedRecovery.generation,
      settledAt: dateOrNull(completedRecovery.completedAt)?.toISOString() || null,
    };
  }

  // The initial snapshot can become stale while mutable child state is checked.
  // Do not launch or release through a creator plan that was paused, cancelled,
  // replaced or restarted in that window; the next heartbeat will retry from the
  // new authoritative state.
  const latestBeforeSchedule = await db.dialogScanRun.findFirst({
    where: { agencyId: agency, creatorId: creator, dialogId: "__dialog_discovery__" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, source: true, generation: true, continuation: true },
  });
  const latestBeforeControl = historyControlState(latestBeforeSchedule);
  if (latestBeforeSchedule?.id !== latestDiscovery?.id) {
    return { ok: true, created: false, reason: "concurrent_creator_plan_won", gapMs, runId: latestBeforeSchedule?.id || null };
  }
  if (latestBeforeControl === "PAUSED") {
    return { ok: true, created: false, reason: "history_paused", gapMs, runId: latestBeforeSchedule?.id || null };
  }
  if (["CANCELLED", "CANCELED"].includes(latestBeforeControl)) {
    return { ok: true, created: false, reason: "history_cancelled", gapMs, runId: latestBeforeSchedule?.id || null };
  }
  if (ACTIVE_RUN_STATUSES.includes(clean(latestBeforeSchedule?.status, 40)?.toUpperCase())) {
    return { ok: true, created: false, reason: "already_in_flight", gapMs, runId: latestBeforeSchedule.id, status: latestBeforeSchedule.status };
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
    offlineSince: coverageClockSkew ? null : (dateOrNull(effectiveLastCoveredAt)?.toISOString() || null),
    coverageClockSkew,
    coverageUnknown,
    recoverySource: OFFLINE_DIALOG_RECOVERY_SOURCE,
  };
}

module.exports = {
  OFFLINE_DIALOG_RECOVERY_GAP_MS,
  OFFLINE_DIALOG_RECOVERY_SOURCE,
  offlineGapMs,
  hasLongOfflineGap,
  hasRealtimeCoverageClockSkew,
  scheduleOfflineDialogRecovery,
  shouldPreserveRealtimeCoverage,
};
