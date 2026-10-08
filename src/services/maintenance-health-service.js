"use strict";
const { MAINTENANCE_LANE_NAMES } = require("./maintenance-lane-registry");

function boundedCount(value) {
  const number = Array.isArray(value) ? value.length : Number(value || 0);
  return Number.isFinite(number) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(number))) : 0;
}
function maintenanceDegradedDetails(result) {
  const degraded = {};
  for (const [name, lane] of Object.entries(result || {})) {
    if (!lane || typeof lane !== "object" || lane.ok !== false) continue;
    degraded[name] = {
      reason: lane.reason ? String(lane.reason).slice(0, 240) : null,
      failed: boundedCount(lane.failed), skipped: lane.skipped === true,
      errors: boundedCount(lane.errors), contended: boundedCount(lane.contended),
      poisonedSignals: boundedCount(lane.poisonedSignals),
      errorDetails: Array.isArray(lane.errorDetails) ? lane.errorDetails.slice(0, 5) : [],
      poisonedSample: Array.isArray(lane.poisonedSample) ? lane.poisonedSample.slice(0, 5) : [],
      error: lane.error ? String(lane.error).slice(0, 500) : null,
    };
  }
  return degraded;
}

function createMaintenanceHealth({ now = () => new Date().toISOString() } = {}) {
  // One fixed record per executable class, not a map of tenants/jobs/errors.
  // This is process-local diagnostic evidence, never distributed work ownership.
  const lanes = new Map(MAINTENANCE_LANE_NAMES.map(name => [name, {
    name, status: "UNKNOWN", lastCompletedAt: null, lastHealthyAt: null, lastFailedAt: null, lastReason: null,
  }]));
  let lastCompletedAt = null, admissionFailure = null, admitted = false;
  function record(result, error = null) {
    if (!error && result?.ok !== false && result?.skipped) return;
    if (!error && (!result || typeof result !== "object")) return;
    const at = now();
    if (error) {
      lastCompletedAt = at;
      admissionFailure = String(error.code || error.message || "maintenance_pump_failed").slice(0, 240);
      return;
    }
    const details = maintenanceDegradedDetails(result);
    const validAdmission = result.admission?.ok === true;
    if (validAdmission) { admissionFailure = null; admitted = true; lastCompletedAt = at; }
    let observedFailure = false;
    for (const [name, previous] of lanes) {
      const lane = result[name];
      if (!lane || typeof lane !== "object") continue;
      const failed = lane.ok === false;
      // An observed canonical one-time completion can recover after another
      // replica finished the generation. Busy/not-due alone proves no recovery.
      const completedElsewhere = lane.skipped === true && lane.reason === "generation_complete"
        && Number.isFinite(Date.parse(lane.completedAt));
      if (!failed && lane.skipped === true && !completedElsewhere) continue;
      observedFailure ||= failed;
      lastCompletedAt = at;
      const reason = details[name]?.reason || details[name]?.error || "maintenance_lane_failed";
      lanes.set(name, { ...previous, status: failed ? "DEGRADED" : "HEALTHY", lastCompletedAt: at,
        lastHealthyAt: failed ? previous.lastHealthyAt : at,
        lastFailedAt: failed ? at : previous.lastFailedAt,
        lastReason: failed ? String(reason).slice(0, 240) : null });
    }
    if (result.ok === false && !observedFailure) {
      lastCompletedAt = at;
      admissionFailure = String(result.reason || result.admission?.reason || "maintenance_pump_failed").slice(0, 240);
    }
  }
  function snapshot() {
    const rows = [...lanes.values()].map(row => ({ ...row }));
    const failures = rows.filter(row => row.status === "DEGRADED");
    const observed = rows.filter(row => row.status !== "UNKNOWN").length;
    return {
      status: admissionFailure || failures.length ? "DEGRADED" : admitted || observed ? "HEALTHY" : "UNKNOWN",
      scope: "PROCESS_OBSERVED_LANES", lastCompletedAt,
      lastReason: [admissionFailure, ...failures.map(row => `${row.name}:${row.lastReason}`)].filter(Boolean).join(",").slice(0, 240) || null,
      admissionFailure, observedLanes: observed, totalLanes: rows.length, lanes: rows,
    };
  }
  return { record, snapshot };
}
module.exports = { createMaintenanceHealth, maintenanceDegradedDetails };
