"use strict";

const { runRootCommit } = require("./db-commit-kernel");

const { MAINTENANCE_ADMISSION_GENERATION, MAINTENANCE_LANE_NAMES } = require("./maintenance-lane-registry");
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
  const rows = await db.$queryRawUnsafe(`SELECT "laneName","ordinal","turnCount","admissionSequence","lastAdmittedAt"
    FROM "MaintenanceAdmissionClassState" WHERE "generation"=$1
    ORDER BY "ordinal" LIMIT $2`, MAINTENANCE_ADMISSION_GENERATION, MAX_CATALOG_ROWS + 1);
  validateStoredCatalog(rows);
  const turns = rows.map((row) => BigInt(row.turnCount));
  const minimum = turns.reduce((a, b) => a < b ? a : b);
  const maximum = turns.reduce((a, b) => a > b ? a : b);
  const sequences = rows.map((row) => BigInt(row.admissionSequence));
  return {
    generation: MAINTENANCE_ADMISSION_GENERATION,
    readOnly: true,
    meaning: "dispatch_opportunities_not_completed_work",
    totalLanes: rows.length,
    minimumTurns: String(minimum), maximumTurns: String(maximum), spread: String(maximum - minimum),
    policy: "bounded_fair_sequence",
    sequenceMeaning: "dispatch_order_not_lifetime_count_or_wall_clock",
    minimumSequence: String(sequences.reduce((a, b) => a < b ? a : b)),
    maximumSequence: String(sequences.reduce((a, b) => a > b ? a : b)),
    lanes: rows.map((row) => ({ name: row.laneName, turn: String(row.turnCount),
      admissionSequence: String(row.admissionSequence), lastAdmittedAt: row.lastAdmittedAt })),
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
  // This bounded unit includes configuration, the <=65-row catalog check and
  // one <=5-row claim. Its root budget must cover all transport round trips:
  // three seconds could expire before the second query on a healthy but slow
  // connection and prevent every maintenance lane from running. Short SQL
  // lock/statement limits stay separate from the transaction's headroom.
  return runRootCommit(db, async ({ tx }) => {
    const catalog = await tx.$queryRawUnsafe(`SELECT "laneName","ordinal"
      FROM "MaintenanceAdmissionClassState" WHERE "generation"=$1
      ORDER BY "ordinal" LIMIT $2`, MAINTENANCE_ADMISSION_GENERATION, MAX_CATALOG_ROWS + 1);
    validateStoredCatalog(catalog);
    // Lifetime counts cannot order an evolving catalog: a newly installed lane
    // at zero would monopolize dispatch until it caught up with years of old
    // offers. Give every selected row a ticket after the observed frontier.
    // New lanes get one early opportunity, then join the back of the queue.
    // Sequence is independent of clock changes; turnCount stays an actual count.
    // Distinct positions preserve order within a mixed batch at the round edge.
    // Independent concurrent batches may share tickets; ordinal breaks those
    // ties, and a stale frontier can never move a selected row backwards.
    // Per-class row locks only, never a singleton lock or a business-work lease.
    const rows = await tx.$queryRawUnsafe(`WITH candidates AS MATERIALIZED (
      SELECT "generation","laneName","ordinal","admissionSequence"
      FROM "MaintenanceAdmissionClassState"
      WHERE "generation"=$1
      ORDER BY "admissionSequence","ordinal"
      LIMIT $2 FOR UPDATE SKIP LOCKED
    ), frontier AS MATERIALIZED (
      SELECT COALESCE(MAX("admissionSequence"),0) AS sequence
      FROM "MaintenanceAdmissionClassState" WHERE "generation"=$1
    ), ranked AS (
      SELECT c.*,ROW_NUMBER() OVER (ORDER BY c."admissionSequence",c."ordinal") AS position
      FROM candidates c
    ), advanced AS (
      UPDATE "MaintenanceAdmissionClassState" state SET
        "turnCount"=state."turnCount"+1,
        "admissionSequence"=GREATEST(state."admissionSequence",f.sequence)+c.position,
        "lastAdmittedAt"=clock_timestamp()
      FROM ranked c CROSS JOIN frontier f
      WHERE state."generation"=c."generation" AND state."laneName"=c."laneName"
      RETURNING state."laneName",state."turnCount",state."admissionSequence",state."lastAdmittedAt",
        c."ordinal",c."admissionSequence" AS "previousSequence"
    ) SELECT * FROM advanced ORDER BY "previousSequence","ordinal"`, MAINTENANCE_ADMISSION_GENERATION, quantum);
    if (rows.length > quantum || new Set(rows.map((row) => row.laneName)).size !== rows.length ||
      rows.some((row) => !MAINTENANCE_LANE_NAMES.includes(row.laneName))) throw failure("MAINTENANCE_ADMISSION_RESULT_INVALID");
    return {
      ok: true,
      generation: MAINTENANCE_ADMISSION_GENERATION,
      policy: "bounded_fair_sequence",
      lanesPerTick: quantum,
      totalLanes: MAINTENANCE_LANE_NAMES.length,
      selected: rows.map((row) => row.laneName),
      turns: rows.map((row) => ({ name: row.laneName, turn: String(row.turnCount),
        admissionSequence: String(row.admissionSequence), admittedAt: row.lastAdmittedAt })),
      contended: quantum - rows.length,
      skipped: rows.length === 0,
      reason: rows.length === 0 ? "maintenance_admission_contended" : null,
    };
  }, { maxWait: 1500, timeout: 15000, deadlineMs: 20000, lockTimeoutMs: 1000, statementTimeoutMs: 2000, maxAttempts: 2 });
}

module.exports = { selectPhase2MaintenanceLanes, readMaintenanceAdmissionProgress, validateMaintenanceLaneNames, MAINTENANCE_ADMISSION_GENERATION, MAINTENANCE_LANE_NAMES, MAX_MAINTENANCE_LANES_PER_TICK };
