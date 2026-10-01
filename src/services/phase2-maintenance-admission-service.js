"use strict";

const { runRootCommit } = require("./db-commit-kernel");

const MAINTENANCE_ADMISSION_GENERATION = "phase6_maintenance_campaign_read_v3";
const MAINTENANCE_LANE_NAMES = Object.freeze([
  "providerCapacityProjection", "messageLibraryTrash", "adminBillingPricing",
  "notificationHistoryRepair", "notificationConsequences", "agencyDestructiveCleanup",
  "creatorDestructiveCleanup", "providerOperationalBackfill", "subscriberDirectoryMaintenance",
  "creatorRecurringPlanning", "campaignFanRefreshPromotion", "dependencyFanout",
  "customReminderWork", "providerOperationalDirty", "telegramConfirmedProjection",
  "telegramInboundProjection", "customExternalProofConvergence", "teamMoneyReconciliation",
  "teamReadSummary", "teamPendingBackfill", "teamResponseRangeRepair", "teamLegacyPendingRepair",
  "analyticsPublication", "trafficProjection", "campaignReadProjection",
]);
const MAX_MAINTENANCE_LANES_PER_TICK = 5;
const MAX_CATALOG_ROWS = 64;

function failure(code) { return Object.assign(new Error(code), { code }); }
function validateMaintenanceLaneNames(laneNames) {
  if (!Array.isArray(laneNames) || laneNames.length !== MAINTENANCE_LANE_NAMES.length) throw failure("MAINTENANCE_ADMISSION_CATALOG_MISMATCH");
  const names = new Set(laneNames);
  if (names.size !== laneNames.length || MAINTENANCE_LANE_NAMES.some((name) => !names.has(name))) throw failure("MAINTENANCE_ADMISSION_CATALOG_MISMATCH");
}

function validateStoredCatalog(catalog) {
  if (catalog.length !== MAINTENANCE_LANE_NAMES.length || catalog.some((row, i) =>
    row.laneName !== MAINTENANCE_LANE_NAMES[i] || Number(row.ordinal) !== i)) {
    throw failure("MAINTENANCE_ADMISSION_SCHEMA_CATALOG_MISMATCH");
  }
}

async function readMaintenanceAdmissionProgress({ db } = {}) {
  if (typeof db?.$queryRawUnsafe !== "function") throw failure("MAINTENANCE_ADMISSION_READ_CLIENT_REQUIRED");
  const rows = await db.$queryRawUnsafe(`SELECT "laneName","ordinal","turnCount","lastAdmittedAt"
    FROM "MaintenanceAdmissionClassState" WHERE "generation"=$1
    ORDER BY "ordinal" LIMIT $2`, MAINTENANCE_ADMISSION_GENERATION, MAX_CATALOG_ROWS + 1);
  validateStoredCatalog(rows);
  const turns = rows.map((row) => BigInt(row.turnCount));
  const minimum = turns.reduce((a, b) => a < b ? a : b);
  const maximum = turns.reduce((a, b) => a > b ? a : b);
  return {
    generation: MAINTENANCE_ADMISSION_GENERATION,
    readOnly: true,
    meaning: "dispatch_opportunities_not_completed_work",
    totalLanes: rows.length,
    minimumTurns: String(minimum), maximumTurns: String(maximum), spread: String(maximum - minimum),
    lanes: rows.map((row) => ({ name: row.laneName, turn: String(row.turnCount), lastAdmittedAt: row.lastAdmittedAt })),
  };
}

async function selectPhase2MaintenanceLanes({ db, laneNames, lanesPerTick = MAX_MAINTENANCE_LANES_PER_TICK } = {}) {
  validateMaintenanceLaneNames(laneNames);
  const requested = Number(lanesPerTick);
  const quantum = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_MAINTENANCE_LANES_PER_TICK, Math.floor(requested)))
    : MAX_MAINTENANCE_LANES_PER_TICK;
  // The progress counter records a dispatch opportunity, NOT a domain claim or
  // successful business effect. A crash after this commit loses only an offer:
  // canonical work/leases remain with each lane and the class is admitted again.
  // Require its own root: joining a caller transaction could retain these class
  // locks during business execution and report offers before their commit.
  return runRootCommit(db, async ({ tx }) => {
    const catalog = await tx.$queryRawUnsafe(`SELECT "laneName","ordinal"
      FROM "MaintenanceAdmissionClassState" WHERE "generation"=$1
      ORDER BY "ordinal" LIMIT $2`, MAINTENANCE_ADMISSION_GENERATION, MAX_CATALOG_ROWS + 1);
    validateStoredCatalog(catalog);
    // Per-class row locks only. No singleton cursor/clock lock and no lock held
    // while executing a lane. Slow/failed callbacks consume their turn instead
    // of resetting the fleet to a wall-clock phase after every restart.
    const rows = await tx.$queryRawUnsafe(`WITH candidates AS MATERIALIZED (
      SELECT "generation","laneName","ordinal","turnCount"
      FROM "MaintenanceAdmissionClassState"
      WHERE "generation"=$1
      ORDER BY "turnCount","ordinal"
      LIMIT $2 FOR UPDATE SKIP LOCKED
    ), advanced AS (
      UPDATE "MaintenanceAdmissionClassState" state SET
        "turnCount"=state."turnCount"+1, "lastAdmittedAt"=clock_timestamp()
      FROM candidates c
      WHERE state."generation"=c."generation" AND state."laneName"=c."laneName"
      RETURNING state."laneName",state."turnCount",state."lastAdmittedAt",c."ordinal",c."turnCount" AS "previousTurn"
    ) SELECT * FROM advanced ORDER BY "previousTurn","ordinal"`, MAINTENANCE_ADMISSION_GENERATION, quantum);
    if (rows.length > quantum || new Set(rows.map((row) => row.laneName)).size !== rows.length ||
      rows.some((row) => !MAINTENANCE_LANE_NAMES.includes(row.laneName))) throw failure("MAINTENANCE_ADMISSION_RESULT_INVALID");
    return {
      ok: true,
      generation: MAINTENANCE_ADMISSION_GENERATION,
      policy: "least_admitted_class",
      lanesPerTick: quantum,
      totalLanes: MAINTENANCE_LANE_NAMES.length,
      selected: rows.map((row) => row.laneName),
      turns: rows.map((row) => ({ name: row.laneName, turn: String(row.turnCount), admittedAt: row.lastAdmittedAt })),
      contended: quantum - rows.length,
      skipped: rows.length === 0,
      reason: rows.length === 0 ? "maintenance_admission_contended" : null,
    };
  }, { maxWait: 1500, timeout: 3000, deadlineMs: 5000, lockTimeoutMs: 1000, statementTimeoutMs: 2000, maxAttempts: 2 });
}

module.exports = { selectPhase2MaintenanceLanes, readMaintenanceAdmissionProgress, validateMaintenanceLaneNames, MAINTENANCE_ADMISSION_GENERATION, MAINTENANCE_LANE_NAMES, MAX_MAINTENANCE_LANES_PER_TICK };
