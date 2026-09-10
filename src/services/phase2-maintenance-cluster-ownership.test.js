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

test("Phase2 maintenance ownership: Telegram inbound uses revisioned DomainWork with bounded receipt continuation", () => {
  const direct = functionBlock("runTelegramInboundProjectionSweep", "runTelegramInboundProjectionMaintenanceSweep");
  const lane = functionBlock("runTelegramInboundProjectionMaintenanceSweep", "runTelegramConfirmedProjectionSweep");
  assert.match(direct, /claimDomainWorkBatch\(\{[\s\S]*PHASE2_WORK_CLASS\.TELEGRAM_INBOUND_PROJECTION/);
  assert.match(direct, /perAgencyQuantum:\s*5/);
  assert.match(direct, /perPartitionQuantum:\s*1/);
  assert.match(direct, /reconcilePendingInboundForConfirmedDelivery/);
  assert.match(direct, /yieldDomainWorkClaim/);
  assert.match(direct, /progressCursor:\s*\{\s*lastInboundEventId/);
  assert.match(lane, /runTelegramInboundProjectionSweep\(\{ now, db \}\)/);
  assert.doesNotMatch(lane, /runMaintenanceLane/, "DomainWork claim is the distributed execution authority");
});

test("Phase2 maintenance ownership: confirmed Telegram projection uses exact DomainWork; history is separate per-agency enumeration", () => {
  const direct = functionBlock("runTelegramConfirmedProjectionSweep", "runTelegramConfirmedProjectionMaintenanceSweep");
  const lane = functionBlock("runTelegramConfirmedProjectionMaintenanceSweep", "maybeBackfillTeamPendingProjection");
  const history = functionBlock("runTelegramConfirmedCoverageEnumerationUnit", "runTelegramInboundCoverageEnumerationUnit");
  assert.match(direct, /claimDomainWorkBatch\(\{[\s\S]*PHASE2_WORK_CLASS\.TELEGRAM_CONFIRMED_PROJECTION/);
  assert.match(direct, /repairConfirmedTelegramDeliveryProjectionItem/);
  assert.doesNotMatch(direct, /db\.agency\.findMany|repairCustomModelCommunicationConvergence/);
  assert.match(history, /agencyId:\s*String\(item\.agencyId\)/);
  assert.match(history, /id:\s*\{\s*gt:\s*cursor\s*\}/);
  assert.match(history, /take:\s*100/);
  assert.match(history, /publishDomainWork/);
  assert.match(history, /yieldDomainWorkClaim/);
  assert.match(lane, /runTelegramConfirmedProjectionSweep\(\{ now, db \}\)/);
  assert.doesNotMatch(lane, /runMaintenanceLane/);
});

test("Phase2 maintenance ownership: Team money current execution is DomainWork and history is per-agency coverage", () => {
  const compatibility = functionBlock("maybeReconcileHistoricalTeamMoney", "publishCoverageEnumerationWork");
  const current = functionBlock("runTeamMoneyReconciliationSweep", "runTeamReadSummarySweep");
  const history = functionBlock("runTeamMoneyReconciliationCoverageEnumerationUnit", "runTeamReadSummaryCoverageEnumerationUnit");
  assert.match(compatibility, /maybeSeedPhase2CoverageWork/);
  assert.match(compatibility, /maybeRunPhase2HistoricalEnumeration/);
  assert.doesNotMatch(compatibility, /runMaintenanceLane|reconcileHistoricalTeamMoneyBatch/);
  assert.match(current, /claimDomainWorkBatch\(\{[\s\S]*PHASE2_WORK_CLASS\.TEAM_MONEY_RECONCILIATION/);
  assert.match(current, /repairTeamMoneyReconciliationWorkItem/);
  assert.match(current, /ackDomainWorkClaim/);
  assert.match(history, /agencyId/);
  assert.match(history, /take:\s*100/);
  assert.match(history, /publishDomainWork/);
  assert.match(history, /yieldDomainWorkClaim/);
});


test("Phase2 maintenance ownership: Team dialog projection is exact current work and bounded historical enumeration", () => {
  const compatibility = functionBlock("maybeBackfillTeamPendingProjection", "maybeRepairLegacyTeamPendingBootstrap");
  const current = functionBlock("runTeamDialogProjectionSweep", "runTeamResponseRangeRepairSweep");
  const history = functionBlock("runTeamDialogCoverageEnumerationUnit", "runTeamMoneyRootClassificationUnit");
  assert.match(compatibility, /runTeamDialogProjectionSweep\(\{ db, now \}\)/);
  assert.doesNotMatch(compatibility, /runMaintenanceLane|TEAM_PENDING_PROJECTION_LANE_KEY/);
  assert.match(current, /claimDomainWorkBatch\(\{[\s\S]*TEAM_DIALOG_PROJECTION/);
  assert.match(current, /projectCreatorDialogWorkItem/);
  assert.match(history, /listUnprojectedRelevantDialogEvents/);
  assert.match(history, /limit:\s*100/);
  assert.match(history, /limit:\s*25/);
  assert.match(history, /yieldDomainWorkClaim/);
});

test("Phase2 maintenance pump owns distributed lanes; process-local promises are overlap optimization only", () => {
  const pump = functionBlock("runPhase2MaintenancePump", "runRecurringSweepInternal");
  assert.match(pump, /runTelegramConfirmedProjectionMaintenanceSweep\(\{ now, db \}\)/);
  assert.match(pump, /runTeamMoneyReconciliationSweep\(\{ now, db \}\)/);
  assert.match(pump, /runTeamReadSummarySweep\(\{ now, db \}\)/);
  assert.match(pump, /maybeBackfillTeamPendingProjection\(\{ db, now \}\)/);
  assert.match(pump, /runTelegramInboundProjectionMaintenanceSweep\(\{ now, db \}\)/);
  assert.match(pump, /maybeBackfillProviderOperationalDebt\(\{ db, now \}\)/);
  assert.match(pump, /maybeRepairProviderOperationalDirty\(\{ db, now \}\)/);
  assert.match(scheduler, /PHASE2_MAINTENANCE_PUMP_INTERVAL_MS\s*=\s*5\s*\*\s*1000/);
  assert.match(scheduler, /phase2MaintenanceTimer\s*=\s*setInterval\(phase2MaintenanceTick, PHASE2_MAINTENANCE_PUMP_INTERVAL_MS\)/);
  const recurring = functionBlock("runRecurringSweep", "startRecurringScheduler");
  assert.match(recurring, /recurringSweepPromise/);
  assert.doesNotMatch(recurring, /claimMaintenanceLane|maintenanceLaneState/, "process-local overlap guard must not become cluster authority");
});
