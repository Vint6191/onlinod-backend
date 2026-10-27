"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMaintenanceProgressDiagnostics } = require("./maintenance-progress-diagnostics");
test("an in-flight lane stays observable while the pump has not returned", () => {
  let now = 0; const rows = [];
  const d = createMaintenanceProgressDiagnostics({ now: () => now, emit: (...row) => rows.push(row) });
  d.begin(); d.admitted(["subscriberDirectoryMaintenance"]); d.startLane("subscriberDirectoryMaintenance");
  now = 120_000; d.observe();
  const state = rows.at(-1)[2];
  assert.equal(state.stage, "LANE_RUNNING"); assert.equal(state.currentLane, "subscriberDirectoryMaintenance");
  assert.equal(state.laneRunningForMs, 120_000);
  assert.equal(state.lanes.subscriberDirectoryMaintenance.lastCompletedAt, null);
  d.finishLane("subscriberDirectoryMaintenance", { ok: true, processedSignals: 1, advancedSteps: 0 }); d.finish();
  assert.equal(d.snapshot().stage, "IDLE");
  assert.equal(d.snapshot().lanes.subscriberDirectoryMaintenance.result.advancedSteps, 0);
});
test("admission failure and never-dispatched subscriber lane are distinguishable", () => {
  const d = createMaintenanceProgressDiagnostics(); d.begin(); d.finish(Object.assign(Error("private SQL"), { code: "P2028" }));
  const state = d.snapshot();
  assert.equal(state.stage, "ADMISSION_FAILED"); assert.equal(state.lastError.code, "P2028");
  assert.equal(state.lanes.subscriberDirectoryMaintenance.turns, 0); assert.doesNotMatch(JSON.stringify(state), /private SQL/);
});
test("notification capacity wait and recovered quarantine remain visible in the periodic log", () => {
  const d = createMaintenanceProgressDiagnostics();
  d.finishLane("notificationConsequences", { ok: true, reason: "FAN_DATA_REFRESH_BACKLOG_FULL", waiting: 1, backpressured: 1, recovered: 2, failed: 0 });
  const result = d.snapshot().lanes.notificationConsequences.result;
  assert.equal(result.reason, "FAN_DATA_REFRESH_BACKLOG_FULL");
  assert.equal(result.waiting, 1); assert.equal(result.backpressured, 1); assert.equal(result.recovered, 2); assert.equal(result.failed, 0);
});
