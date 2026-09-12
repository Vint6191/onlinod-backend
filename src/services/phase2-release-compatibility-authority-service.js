"use strict";

const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { assertAllLiveAgenciesHaveOperationalOwner, findLiveAgenciesWithoutOperationalOwner } = require("./team-operational-owner-authority-service");

// These generations are DB-enforced rolling-release compatibility identities.
// They are not business authorization by themselves; business/lifecycle services
// must still perform their normal permission and object fencing. Their only job is
// to let migrated PostgreSQL reject incompatible old-binary writer shapes.
const CREATOR_ACCOUNT_WRITER_GENERATION = "phase2_creator_writer_v2_actual56_postcut";
const DOMAIN_WORK_EXECUTOR_GENERATION = "phase2_domain_executor_v4_actual56_postcut";
const TEAM_CONTROL_PLANE_GENERATION = "phase2_team_control_plane_v2_durable_access";
const TEAM_CONTROL_PLANE_SCOPE = "TEAM_CONTROL_PLANE";
const TEAM_CONTROL_PLANE_RELEASE_FENCE_KEY = "phase2:release-activation:TEAM_CONTROL_PLANE";
const TEAM_CONTROL_PLANE_DB_SETTING = "onlinod.phase2_team_control_plane_generation";
const TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION = "phase2_require_team_control_plane_generation";
const TEAM_CONTROL_PLANE_DB_FENCE_TRIGGERS = Object.freeze([
  ["phase2_team_writer_generation_agency_member", "AgencyMember"],
  ["phase2_team_writer_generation_member_function", "TeamMemberFunction"],
  ["phase2_team_writer_generation_custom_role", "AgencyCustomRole"],
  ["phase2_team_writer_generation_role_override", "AgencyRoleOverride"],
  ["phase2_team_writer_generation_subpermission_override", "AgencySubPermissionOverride"],
  ["phase2_team_writer_generation_invitation", "AgencyInvitation"],
  ["phase2_team_writer_generation_user_disabled", "User"],
  ["phase2_team_writer_generation_agency_lifecycle", "Agency"],
]);

const TEAM_CONTROL_PLANE_DB_FENCE_FULL_DML_TRIGGERS = new Set([
  "phase2_team_writer_generation_agency_member",
  "phase2_team_writer_generation_member_function",
  "phase2_team_writer_generation_custom_role",
  "phase2_team_writer_generation_role_override",
  "phase2_team_writer_generation_subpermission_override",
  "phase2_team_writer_generation_invitation",
]);

function normalizeTriggerDefinition(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function triggerCoverageValid(triggerName, definition) {
  const normalized = normalizeTriggerDefinition(definition);
  if (!normalized || !normalized.includes("for each row")) return false;
  const beforeIndex = normalized.indexOf(" before ");
  const onIndex = normalized.indexOf(" on ", beforeIndex + 1);
  if (beforeIndex < 0 || onIndex < 0) return false;
  const eventClause = normalized.slice(beforeIndex + " before ".length, onIndex);
  if (TEAM_CONTROL_PLANE_DB_FENCE_FULL_DML_TRIGGERS.has(triggerName)) {
    return eventClause.includes("insert") && eventClause.includes("update") && eventClause.includes("delete");
  }
  if (triggerName === "phase2_team_writer_generation_user_disabled") {
    return eventClause.includes("update") && eventClause.includes('"disabledat"') && eventClause.includes("delete");
  }
  if (triggerName === "phase2_team_writer_generation_agency_lifecycle") {
    return eventClause.includes("insert") && eventClause.includes("update") && eventClause.includes('"deletedat"') && eventClause.includes("delete");
  }
  return false;
}

async function setLocalGeneration(db, setting, generation) {
  if (typeof db?.$queryRawUnsafe !== "function") return { applied: false, generation };
  // Every release generation in this module is transaction-local by design.
  // A root PrismaClient would execute set_config(..., true) in a one-statement
  // autocommit transaction, discard the token immediately, and make the helper
  // falsely report successful admission. Fail closed before touching PostgreSQL.
  const rootPrismaLike = typeof db?.$transaction === "function"
    && (typeof db?.$connect === "function" || typeof db?.$disconnect === "function");
  if (rootPrismaLike) {
    const error = new Error("Phase2 release generation authorization requires an active database transaction");
    error.code = "PHASE2_RELEASE_TRANSACTION_REQUIRED";
    error.status = 500;
    error.retryable = false;
    error.setting = setting;
    throw error;
  }
  await db.$queryRawUnsafe(`SELECT set_config($1,$2,true) AS value`, setting, generation);
  return { applied: true, generation };
}

async function authorizeCreatorAccountWrite(db) {
  return setLocalGeneration(db, "onlinod.phase2_creator_writer_generation", CREATOR_ACCOUNT_WRITER_GENERATION);
}

async function authorizeDomainWorkExecutor(db) {
  return setLocalGeneration(db, "onlinod.phase2_domain_executor_generation", DOMAIN_WORK_EXECUTOR_GENERATION);
}

function teamControlPlaneUnavailable(row) {
  const state = String(row?.activationState || "").toUpperCase();
  const generation = String(row?.requiredGeneration || "");
  const code = !row
    ? "TEAM_CONTROL_PLANE_RELEASE_AUTHORITY_MISSING"
    : generation !== TEAM_CONTROL_PLANE_GENERATION
      ? "TEAM_CONTROL_PLANE_RELEASE_GENERATION_MISMATCH"
      : "TEAM_CONTROL_PLANE_DRAINING";
  const error = new Error(
    code === "TEAM_CONTROL_PLANE_DRAINING"
      ? "Team control-plane writes are temporarily unavailable during release drain"
      : "Team control-plane release authority is not ready",
  );
  error.code = code;
  error.status = 503;
  error.retryable = true;
  error.releaseState = state || null;
  error.requiredGeneration = generation || null;
  return error;
}

async function readTeamControlPlaneReleaseAuthority(db, { forUpdate = false } = {}) {
  if (typeof db?.$queryRawUnsafe !== "function") return null;
  const suffix = forUpdate ? " FOR UPDATE" : "";
  const rows = await db.$queryRawUnsafe(
    `SELECT "scope","requiredGeneration","activationState","drainStartedAt","activatedAt","activationConfirmedAt"\n       FROM "Phase2ReleaseCompatibilityAuthority"\n      WHERE "scope"=$1${suffix}`,
    TEAM_CONTROL_PLANE_SCOPE,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function teamControlPlaneDbFenceError(status) {
  const error = new Error("Team control-plane PostgreSQL writer fence is incomplete");
  error.code = "TEAM_CONTROL_PLANE_DB_FENCE_INCOMPLETE";
  error.status = 503;
  error.retryable = false;
  error.details = {
    missingTriggers: status?.missingTriggers || [],
    mismatchedTriggers: status?.mismatchedTriggers || [],
    unexpectedTriggers: status?.unexpectedTriggers || [],
    functionProofValid: Boolean(status?.functionProofValid),
  };
  return error;
}

async function readTeamControlPlaneDbFenceStatus(db) {
  if (typeof db?.$queryRawUnsafe !== "function") {
    return {
      supported: false,
      ready: true,
      adapter: true,
      expectedTriggerCount: TEAM_CONTROL_PLANE_DB_FENCE_TRIGGERS.length,
      observedTriggerCount: 0,
      missingTriggers: [],
      mismatchedTriggers: [],
      unexpectedTriggers: [],
      functionProofValid: true,
    };
  }

  const rows = await db.$queryRawUnsafe(`
    SELECT t.tgname AS "triggerName",
           c.relname AS "tableName",
           t.tgenabled AS "enabled",
           p.proname AS "functionName",
           pg_get_functiondef(p.oid) AS "functionDefinition",
           pg_get_triggerdef(t.oid, true) AS "triggerDefinition"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
     WHERE NOT t.tgisinternal
       AND n.nspname=current_schema()
       AND t.tgname LIKE 'phase2_team_writer_generation_%'
     ORDER BY t.tgname ASC
  `);

  const expected = new Map(TEAM_CONTROL_PLANE_DB_FENCE_TRIGGERS);
  const observed = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.triggerName || "");
    if (name) observed.set(name, row);
  }

  const missingTriggers = [];
  const mismatchedTriggers = [];
  for (const [triggerName, tableName] of TEAM_CONTROL_PLANE_DB_FENCE_TRIGGERS) {
    const row = observed.get(triggerName);
    if (!row) {
      missingTriggers.push(triggerName);
      continue;
    }
    const enabled = String(row.enabled || "").toUpperCase();
    const coverageValid = triggerCoverageValid(triggerName, row.triggerDefinition);
    if (String(row.tableName || "") !== tableName
        || String(row.functionName || "") !== TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION
        || !["O", "A"].includes(enabled)
        || !coverageValid) {
      mismatchedTriggers.push({
        triggerName,
        expectedTable: tableName,
        tableName: row.tableName || null,
        functionName: row.functionName || null,
        enabled: row.enabled || null,
        coverageValid,
      });
    }
  }
  const unexpectedTriggers = Array.from(observed.keys()).filter((name) => !expected.has(name)).sort();
  const functionDefinitions = Array.from(observed.values())
    .filter((row) => String(row?.functionName || "") === TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION)
    .map((row) => String(row?.functionDefinition || ""))
    .filter(Boolean);
  const functionProofValid = functionDefinitions.some((definition) =>
    definition.includes(TEAM_CONTROL_PLANE_DB_SETTING)
      && definition.includes(TEAM_CONTROL_PLANE_GENERATION)
      && definition.includes('"activationState"')
      && definition.includes("'ACTIVE'")
      && definition.includes("PHASE2_INCOMPATIBLE_TEAM_CONTROL_PLANE_WRITER")
  );
  const ready = missingTriggers.length === 0
    && mismatchedTriggers.length === 0
    && unexpectedTriggers.length === 0
    && functionProofValid;

  return {
    supported: true,
    ready,
    adapter: false,
    expectedTriggerCount: TEAM_CONTROL_PLANE_DB_FENCE_TRIGGERS.length,
    observedTriggerCount: observed.size,
    missingTriggers,
    mismatchedTriggers,
    unexpectedTriggers,
    functionProofValid,
  };
}

async function assertTeamControlPlaneDbFenceIntegrity(db) {
  const status = await readTeamControlPlaneDbFenceStatus(db);
  if (!status.ready) throw teamControlPlaneDbFenceError(status);
  return status;
}

async function assertTeamControlPlaneWriteAdmission(db) {
  // Prisma transactions always expose the raw methods. Test/fallback adapters do
  // not; preserve those isolated adapters without pretending they are a production
  // release authority implementation.
  if (typeof db?.$executeRawUnsafe !== "function" || typeof db?.$queryRawUnsafe !== "function") {
    return { admitted: true, adapter: true, generation: TEAM_CONTROL_PLANE_GENERATION };
  }
  // set_config(..., true) is transaction-local. Calling this authority on the root
  // Prisma client would run the token-setting SELECT in its own autocommit
  // transaction and silently lose the token before the subsequent Team DML. Fail
  // closed instead of allowing a future caller to create a production-only outage.
  // Prisma TransactionClient intentionally omits $transaction; the root client has it.
  if (typeof db?.$transaction === "function") {
    const error = new Error("Team control-plane write admission requires an active database transaction");
    error.code = "TEAM_CONTROL_PLANE_TRANSACTION_REQUIRED";
    error.status = 500;
    error.retryable = false;
    throw error;
  }

  // This MUST precede Agency lifecycle / topology / Role / Creator / User / Member
  // locks. Activation takes the exclusive form of this same transaction lock.
  await lockDbAdvisoryXact({ db, key: TEAM_CONTROL_PLANE_RELEASE_FENCE_KEY, mode: "shared" });
  const row = await readTeamControlPlaneReleaseAuthority(db);
  if (!row
      || row.requiredGeneration !== TEAM_CONTROL_PLANE_GENERATION
      || String(row.activationState || "").toUpperCase() !== "ACTIVE") {
    throw teamControlPlaneUnavailable(row);
  }
  // DB triggers enforce this same generation on every Team authority table.
  // Old binaries do not set this transaction-local token and are physically
  // unable to mutate Team current-authority state after the v2 migration.
  await setLocalGeneration(db, TEAM_CONTROL_PLANE_DB_SETTING, TEAM_CONTROL_PLANE_GENERATION);
  return { admitted: true, adapter: false, generation: TEAM_CONTROL_PLANE_GENERATION, row };
}

async function preflightTeamControlPlaneMigration(db) {
  const blockerAgencyIds = await findLiveAgenciesWithoutOperationalOwner(db, { limit: 500 });
  if (blockerAgencyIds.length) {
    const error = new Error("Team control-plane migration preflight failed: live Agency without an operational OWNER");
    error.code = "TEAM_CONTROL_PLANE_MIGRATION_PREFLIGHT_FAILED";
    error.status = 409;
    error.details = { blockerAgencyIds, truncated: blockerAgencyIds.length >= 500 };
    throw error;
  }
  return { safe: true, blockerAgencyIds: [] };
}

async function teamControlPlaneActivationDiagnostics(db) {
  const [row, dbFence] = await Promise.all([
    readTeamControlPlaneReleaseAuthority(db),
    readTeamControlPlaneDbFenceStatus(db),
  ]);
  // Diagnostics is an operator-facing activation gate, not a best-effort UI.
  // A failed OWNER-invariant read must never collapse into "zero blockers".
  // Let storage/query failure propagate so the CLI exits non-zero and activation
  // remains fail-closed instead of presenting a false-green diagnostic snapshot.
  const blockerAgencyIds = await findLiveAgenciesWithoutOperationalOwner(db, { limit: 100 });
  return {
    row,
    dbFence,
    expectedGeneration: TEAM_CONTROL_PLANE_GENERATION,
    readyToActivate: Boolean(
      row
      && row.requiredGeneration === TEAM_CONTROL_PLANE_GENERATION
      && String(row.activationState || "").toUpperCase() === "DRAINING"
      && dbFence.ready
      && blockerAgencyIds.length === 0
    ),
    blockerAgencyIds,
  };
}

async function activateTeamControlPlaneAfterDrain(db) {
  if (!db || typeof db.$transaction !== "function") {
    throw Object.assign(new Error("Prisma transaction support is required for Team control-plane activation"), { code: "TEAM_CONTROL_PLANE_ACTIVATION_DB_REQUIRED" });
  }

  return db.$transaction(async (tx) => {
    await lockDbAdvisoryXact({ db: tx, key: TEAM_CONTROL_PLANE_RELEASE_FENCE_KEY, mode: "exclusive" });
    const row = await readTeamControlPlaneReleaseAuthority(tx, { forUpdate: true });
    if (!row) throw teamControlPlaneUnavailable(null);
    if (row.requiredGeneration !== TEAM_CONTROL_PLANE_GENERATION) throw teamControlPlaneUnavailable(row);

    // Activation/idempotent activation is valid only if PostgreSQL itself still
    // carries the complete v2 writer fence. Never let an ACTIVE release-row turn
    // into a success answer after a trigger was removed or disabled.
    await assertTeamControlPlaneDbFenceIntegrity(tx);

    if (String(row.activationState || "").toUpperCase() === "ACTIVE") {
      return { activated: false, alreadyActive: true, generation: TEAM_CONTROL_PLANE_GENERATION, row };
    }

    // DRAINING -> ACTIVE also proves the operational OWNER invariant under the
    // same exclusive release transaction.
    await assertAllLiveAgenciesHaveOperationalOwner({ db: tx });

    const updated = await tx.$queryRawUnsafe(
      `UPDATE "Phase2ReleaseCompatibilityAuthority"
          SET "activationState"='ACTIVE',
              "activatedAt"=CURRENT_TIMESTAMP,
              "activationConfirmedAt"=CURRENT_TIMESTAMP,
              "updatedAt"=CURRENT_TIMESTAMP
        WHERE "scope"=$1
          AND "requiredGeneration"=$2
          AND "activationState"='DRAINING'
      RETURNING "scope","requiredGeneration","activationState","drainStartedAt","activatedAt","activationConfirmedAt"`,
      TEAM_CONTROL_PLANE_SCOPE,
      TEAM_CONTROL_PLANE_GENERATION,
    );
    if (!Array.isArray(updated) || updated.length !== 1) {
      const current = await readTeamControlPlaneReleaseAuthority(tx, { forUpdate: true });
      if (current?.requiredGeneration === TEAM_CONTROL_PLANE_GENERATION
          && String(current?.activationState || "").toUpperCase() === "ACTIVE") {
        return { activated: false, alreadyActive: true, generation: TEAM_CONTROL_PLANE_GENERATION, row: current };
      }
      throw teamControlPlaneUnavailable(current);
    }
    return { activated: true, alreadyActive: false, generation: TEAM_CONTROL_PLANE_GENERATION, row: updated[0] };
  });
}

async function runCreatorAccountWriteTransaction(db, work, options = undefined) {
  if (!db || typeof work !== "function") throw new Error("Creator release write transaction context is required");
  if (typeof db.$transaction === "function") {
    return db.$transaction(async (tx) => {
      await authorizeCreatorAccountWrite(tx);
      return work(tx);
    }, options);
  }
  await authorizeCreatorAccountWrite(db);
  return work(db);
}

module.exports = {
  CREATOR_ACCOUNT_WRITER_GENERATION,
  DOMAIN_WORK_EXECUTOR_GENERATION,
  TEAM_CONTROL_PLANE_GENERATION,
  TEAM_CONTROL_PLANE_SCOPE,
  TEAM_CONTROL_PLANE_RELEASE_FENCE_KEY,
  TEAM_CONTROL_PLANE_DB_SETTING,
  TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION,
  TEAM_CONTROL_PLANE_DB_FENCE_TRIGGERS,
  authorizeCreatorAccountWrite,
  authorizeDomainWorkExecutor,
  readTeamControlPlaneReleaseAuthority,
  readTeamControlPlaneDbFenceStatus,
  assertTeamControlPlaneDbFenceIntegrity,
  assertTeamControlPlaneWriteAdmission,
  preflightTeamControlPlaneMigration,
  teamControlPlaneActivationDiagnostics,
  activateTeamControlPlaneAfterDrain,
  runCreatorAccountWriteTransaction,
};
