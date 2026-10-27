"use strict";
const { emitRuntimeDiagnostic, diagnosticError } = require("./runtime-diagnostic-log");
const { MAINTENANCE_LANE_NAMES } = require("./maintenance-lane-registry");
const OBSERVED = ["subscriberDirectoryMaintenance", "creatorRecurringPlanning", "notificationConsequences", "analyticsFactPublication"];
const COUNTERS = ["processedSignals", "recoverySignals", "recoveredRuns", "advancedSteps", "reconciledJobs", "stateRepairs", "errors", "contended", "poisonedSignals", "processed", "claimed", "created", "failed", "waiting", "backpressured", "recovered", "scannedCreators", "createdJobs", "skippedJobs"];
function createMaintenanceProgressDiagnostics({ now = Date.now, emit = emitRuntimeDiagnostic } = {}) {
  const lanes = new Map(MAINTENANCE_LANE_NAMES.map(name => [name, { turns: 0, lastStartedAt: null, lastCompletedAt: null, result: null }]));
  let cycle = 0, stage = "NOT_STARTED", currentLane = null, startedAt = null, laneStartedAt = null;
  let selected = [], lastCompletedAt = null, lastError = null;
  function snapshot() {
    const at = now();
    return { observedAt: new Date(at).toISOString(), cycle, stage, currentLane,
      startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
      runningForMs: startedAt === null ? null : Math.max(0, at - startedAt),
      laneRunningForMs: laneStartedAt === null ? null : Math.max(0, at - laneStartedAt),
      lastCompletedAt, lastError, selected,
      lanes: Object.fromEntries(OBSERVED.map(name => [name, lanes.get(name)])),
    };
  }
  function observe() { return emit("maintenance progress", "pump", snapshot(), { level: "info" }); }
  return {
    begin() { cycle++; stage = "ADMISSION"; currentLane = null; laneStartedAt = null; startedAt = now(); observe(); },
    admitted(names) { selected = names.filter(name => lanes.has(name)).slice(0, 5); },
    startLane(name) {
      stage = "LANE_RUNNING"; currentLane = name; laneStartedAt = now();
      const row = lanes.get(name); if (row) { row.turns++; row.lastStartedAt = new Date(laneStartedAt).toISOString(); }
    },
    finishLane(name, result) {
      const row = lanes.get(name);
      if (row) {
        const reason = String(result?.reason || "");
        row.lastCompletedAt = new Date(now()).toISOString();
        row.result = { ok: result?.ok !== false, skipped: result?.skipped === true,
          reason: /^[A-Za-z0-9_.:-]{1,160}$/.test(reason) ? reason : null,
          ...Object.fromEntries(COUNTERS.filter(key => Number.isFinite(result?.[key])).map(key => [key, result[key]])),
        };
      }
      stage = "BETWEEN_LANES"; currentLane = null; laneStartedAt = null;
    },
    finish(error = null) {
      lastCompletedAt = new Date(now()).toISOString(); lastError = error ? diagnosticError(error) : null;
      stage = error ? "ADMISSION_FAILED" : "IDLE"; currentLane = null; laneStartedAt = null; startedAt = null;
    },
    observe, snapshot,
  };
}
module.exports = { createMaintenanceProgressDiagnostics };
