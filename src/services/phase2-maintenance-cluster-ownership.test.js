"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");

function functionBlock(name, nextName) {
  const start = scheduler.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = nextName ? scheduler.indexOf(`async function ${nextName}`, start + 1) : -1;
  return scheduler.slice(start, end > start ? end : undefined);
}

test("Phase2 maintenance ownership: Telegram inbound is a cluster-owned bounded lane", () => {
  const direct = functionBlock("runTelegramInboundProjectionSweep", "runTelegramInboundProjectionMaintenanceSweep");
  const lane = functionBlock("runTelegramInboundProjectionMaintenanceSweep", "runTelegramConfirmedProjectionSweep");
  assert.match(direct, /retryPendingInboundProjections\(\{[\s\S]*limit:\s*TELEGRAM_INBOUND_PROJECTION_BATCH_SIZE[\s\S]*db,/);
  assert.match(lane, /runMaintenanceLane\(\{/);
  assert.match(lane, /TELEGRAM_INBOUND_MAINTENANCE_LANE_KEY/);
  assert.match(lane, /runTelegramInboundProjectionSweep\(\{ now, db \}\)/);
});

test("Phase2 maintenance ownership: Telegram/custom convergence is paged by durable Agency cursor", () => {
  const direct = functionBlock("runTelegramConfirmedProjectionSweep", "runTelegramConfirmedProjectionMaintenanceSweep");
  const lane = functionBlock("runTelegramConfirmedProjectionMaintenanceSweep", "maybeBackfillTeamPendingProjection");
  assert.match(direct, /db\.agency\.findMany\(\{/);
  assert.match(direct, /id:\s*\{\s*gt:\s*normalizedCursor\s*\}/);
  assert.match(direct, /take:\s*size/);
  assert.doesNotMatch(direct, /scanAllById/);
  assert.match(direct, /repairConfirmedTelegramDeliveryProjections\(\{ agencyId, now, db \}\)/);
  assert.match(direct, /repairCustomModelCommunicationConvergence\(\{ agencyId, now, db \}\)/);
  assert.match(lane, /claim\?\.cursor\?\.lastAgencyId/);
  assert.match(lane, /cursor:\s*\{\s*lastAgencyId:/);
  assert.match(lane, /modelCommunicationCurrentBacklog/);
  assert.match(lane, /retryFast \? 1_000 : RECURRING_INTERVAL_MS/);
});

test("Phase2 maintenance ownership: Team money is cluster-owned and drains backlog without hourly starvation", () => {
  const lane = functionBlock("maybeReconcileHistoricalTeamMoney", "maybeBackfillProviderOperationalDebt");
  assert.match(lane, /runMaintenanceLane\(\{/);
  assert.match(lane, /TEAM_MONEY_MAINTENANCE_LANE_KEY/);
  assert.match(lane, /reconcileHistoricalTeamMoneyWork\(\{ db \}\)/);
  assert.match(lane, /likelyMore/);
  assert.match(lane, /likelyMore \? 1_000 : RECURRING_INTERVAL_MS/);
});


test("Phase2 maintenance ownership: Team pending projection drains a full bounded batch promptly", () => {
  const lane = functionBlock("maybeBackfillTeamPendingProjection", "maybeRepairLegacyTeamPendingBootstrap");
  assert.match(lane, /TEAM_PENDING_PROJECTION_LANE_KEY/);
  assert.match(lane, /selected >= TEAM_PENDING_BACKFILL_BATCH_SIZE/);
  assert.match(lane, /likelyMore \? 1_000 : RECURRING_INTERVAL_MS/);
  assert.match(lane, /PENDING_PROJECTION_BACKLOG_CONTINUES/);
});

test("Phase2 maintenance pump owns distributed lanes; process-local promises are overlap optimization only", () => {
  const pump = functionBlock("runPhase2MaintenancePump", "runRecurringSweepInternal");
  assert.match(pump, /runTelegramConfirmedProjectionMaintenanceSweep\(\{ now, db \}\)/);
  assert.match(pump, /maybeReconcileHistoricalTeamMoney\(\{ db, now \}\)/);
  assert.match(pump, /runTelegramInboundProjectionMaintenanceSweep\(\{ now, db \}\)/);
  assert.match(pump, /maybeBackfillProviderOperationalDebt\(\{ db, now \}\)/);
  assert.match(pump, /maybeRepairProviderOperationalDirty\(\{ db, now \}\)/);
  assert.match(scheduler, /PHASE2_MAINTENANCE_PUMP_INTERVAL_MS\s*=\s*5\s*\*\s*1000/);
  assert.match(scheduler, /phase2MaintenanceTimer\s*=\s*setInterval\(phase2MaintenanceTick, PHASE2_MAINTENANCE_PUMP_INTERVAL_MS\)/);
  const recurring = functionBlock("runRecurringSweep", "startRecurringScheduler");
  assert.match(recurring, /recurringSweepPromise/);
  assert.doesNotMatch(recurring, /claimMaintenanceLane|maintenanceLaneState/, "process-local overlap guard must not become cluster authority");
});
