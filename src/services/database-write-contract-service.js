"use strict";
const { runDbTransaction } = require("./db-transaction-service");



const CREATOR_ACCOUNT_WRITER_GENERATION = "phase2_creator_writer_v2_actual56_postcut";
const DOMAIN_WORK_EXECUTOR_GENERATION = "phase3_domain_executor_v6_failure_policy";
const DOMAIN_WORK_CLAIM_TOPOLOGY_ID = "phase3_domain_work_claim_topology_a36_v1";
const TEAM_CONTROL_PLANE_GENERATION = "phase2_team_control_plane_v2_durable_access";
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

function assertTransactionLocalGenerationClient(db, setting) {
  // Writer contracts are transaction-local; domain permissions remain mandatory.
  // A root PrismaClient would execute set_config(..., true) in a one-statement
  // autocommit transaction, discard the token immediately, and make the helper
  // falsely report successful admission. Fail closed before touching PostgreSQL.
  const rootPrismaLike = typeof db?.$transaction === "function"
    && (typeof db?.$connect === "function" || typeof db?.$disconnect === "function");
  if (rootPrismaLike) {
    const error = new Error("Database writer authorization requires an active database transaction");
    error.code = "DB_WRITER_TRANSACTION_REQUIRED";
    error.status = 500;
    error.retryable = false;
    error.setting = setting;
    throw error;
  }
}

async function setLocalGeneration(db, setting, generation) {
  if (typeof db?.$queryRawUnsafe !== "function") return { applied: false, generation };
  assertTransactionLocalGenerationClient(db, setting);
  await db.$queryRawUnsafe(`SELECT set_config($1,$2,true) AS value`, setting, generation);
  return { applied: true, generation };
}

async function authorizeCreatorAccountWrite(db) {
  return setLocalGeneration(db, "onlinod.phase2_creator_writer_generation", CREATOR_ACCOUNT_WRITER_GENERATION);
}

async function authorizeDomainWorkExecutor(db) {
  if (typeof db?.$queryRawUnsafe !== "function") {
    return { applied: false, generation: DOMAIN_WORK_EXECUTOR_GENERATION };
  }
  assertTransactionLocalGenerationClient(db, "onlinod.phase2_domain_executor_generation");

  // The optimistic topology read in the scheduler is only a cheap fail-fast
  // check.  Execution authority is proved again in the exact transaction that
  // will reserve/claim work.  A shared topology lock serializes this proof with
  // both initial activation and every later ACTIVE -> BUILDING generation
  // invalidation; a stale precheck can therefore never acquire work after the
  // topology stopped being ACTIVE.
  const topologyRows = await db.$queryRawUnsafe(
    `SELECT "generation","activationState"
       FROM "DomainWorkClaimTopologyState"
      WHERE "id"=$1
      FOR SHARE`,
    DOMAIN_WORK_CLAIM_TOPOLOGY_ID,
  );
  const topology = Array.isArray(topologyRows) ? topologyRows[0] : null;
  if (topology?.generation !== DOMAIN_WORK_CLAIM_TOPOLOGY_ID
      || String(topology.activationState || "").toUpperCase() !== "ACTIVE") {
    throw Object.assign(new Error("DomainWork claim topology is not ACTIVE"), {
      code: "DOMAIN_WORK_CLAIM_TOPOLOGY_NOT_ACTIVE",
      status: 503,
      retryable: true,
      topologyState: topology?.activationState || null,
    });
  }

  return setLocalGeneration(db, "onlinod.phase2_domain_executor_generation", DOMAIN_WORK_EXECUTOR_GENERATION);
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

  await setLocalGeneration(db, TEAM_CONTROL_PLANE_DB_SETTING, TEAM_CONTROL_PLANE_GENERATION);
  return { admitted: true, adapter: false, generation: TEAM_CONTROL_PLANE_GENERATION };
}

async function runCreatorAccountWriteTransaction(db, work, options = undefined) {
  if (!db || typeof work !== "function") throw new Error("Creator release write transaction context is required");
  return runDbTransaction(db, async (tx) => {
    await authorizeCreatorAccountWrite(tx);
    return work(tx);
  }, options);
}

module.exports = {
  CREATOR_ACCOUNT_WRITER_GENERATION, DOMAIN_WORK_EXECUTOR_GENERATION, DOMAIN_WORK_CLAIM_TOPOLOGY_ID,
  TEAM_CONTROL_PLANE_GENERATION, TEAM_CONTROL_PLANE_DB_SETTING,
  TEAM_CONTROL_PLANE_DB_FENCE_FUNCTION, TEAM_CONTROL_PLANE_DB_FENCE_TRIGGERS,
  authorizeCreatorAccountWrite, authorizeDomainWorkExecutor, readTeamControlPlaneDbFenceStatus,
  assertTeamControlPlaneDbFenceIntegrity, assertTeamControlPlaneWriteAdmission, runCreatorAccountWriteTransaction,
};
