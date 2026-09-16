"use strict";

const { lockDbAdvisoryXact } = require("./db-transaction-service");

const AUTH_HISTORY_PURGE_SCOPE = "AUTHORIZATION_HISTORY_PURGE";
const AUTH_HISTORY_PUBLISHER_GENERATION = "actual60_auth_history_publisher_v1";
const AUTH_HISTORY_RELEASE_FENCE_KEY = "actual60:release-activation:AUTHORIZATION_HISTORY_PURGE";
const AUTH_HISTORY_DB_SETTING = "onlinod.actual60_auth_history_generation";
const AUTH_HISTORY_DB_FENCE_FUNCTION = "actual60_require_auth_history_publisher_generation";
const AUTH_HISTORY_DB_FENCE_TRIGGERS = Object.freeze([
  ["actual60_auth_history_refresh_insert", "RefreshSession"],
  ["actual60_auth_history_refresh_adoption", "RefreshSession"],
]);

function releaseUnavailable(row) {
  const state = String(row?.activationState || "").toUpperCase();
  const generation = String(row?.requiredGeneration || "");
  const error = new Error("Authorization-history raw purge is not activated for this backend generation");
  error.code = !row
    ? "AUTH_HISTORY_PURGE_RELEASE_AUTHORITY_MISSING"
    : generation !== AUTH_HISTORY_PUBLISHER_GENERATION
      ? "AUTH_HISTORY_PURGE_RELEASE_GENERATION_MISMATCH"
      : "AUTH_HISTORY_PURGE_DRAINING";
  error.status = 503;
  error.retryable = true;
  error.releaseState = state || null;
  error.requiredGeneration = generation || null;
  return error;
}

async function readAuthorizationHistoryReleaseAuthority(db, { forUpdate = false } = {}) {
  if (typeof db?.$queryRawUnsafe !== "function") return null;
  const suffix = forUpdate ? " FOR UPDATE" : "";
  const rows = await db.$queryRawUnsafe(
    `SELECT "scope","requiredGeneration","activationState","drainStartedAt","activatedAt","activationConfirmedAt"
       FROM "Phase2ReleaseCompatibilityAuthority"
      WHERE "scope"=$1${suffix}`,
    AUTH_HISTORY_PURGE_SCOPE,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function authorizationHistoryPurgeActivationStatus(db) {
  if (typeof db?.$queryRawUnsafe !== "function") {
    return { active: true, adapter: true, row: null, generation: AUTH_HISTORY_PUBLISHER_GENERATION };
  }
  const row = await readAuthorizationHistoryReleaseAuthority(db);
  return {
    active: Boolean(
      row
      && row.requiredGeneration === AUTH_HISTORY_PUBLISHER_GENERATION
      && String(row.activationState || "").toUpperCase() === "ACTIVE"
    ),
    adapter: false,
    row,
    generation: AUTH_HISTORY_PUBLISHER_GENERATION,
  };
}

async function authorizeAuthorizationHistoryPublisher(db) {
  if (typeof db?.$queryRawUnsafe !== "function" || typeof db?.$executeRawUnsafe !== "function") {
    return { admitted: true, adapter: true, generation: AUTH_HISTORY_PUBLISHER_GENERATION };
  }
  // set_config(..., true) must live in the same transaction as RefreshSession DML.
  if (typeof db?.$transaction === "function") {
    const error = new Error("Authorization-history publisher generation requires an active database transaction");
    error.code = "AUTH_HISTORY_PUBLISHER_TRANSACTION_REQUIRED";
    error.status = 500;
    throw error;
  }
  // Shared release lock makes new publishers monotonic with DRAINING -> ACTIVE.
  // Old publishers do not take this lock, but once ACTIVE the DB trigger below
  // physically rejects their lineaged INSERT/adoption statement.
  await lockDbAdvisoryXact({ db, key: AUTH_HISTORY_RELEASE_FENCE_KEY, mode: "shared" });
  await db.$queryRawUnsafe(
    `SELECT set_config($1,$2,true) AS value`,
    AUTH_HISTORY_DB_SETTING,
    AUTH_HISTORY_PUBLISHER_GENERATION,
  );
  return { admitted: true, adapter: false, generation: AUTH_HISTORY_PUBLISHER_GENERATION };
}

async function readAuthorizationHistoryDbFenceStatus(db) {
  if (typeof db?.$queryRawUnsafe !== "function") {
    return { supported: false, ready: true, adapter: true, missingTriggers: [], mismatchedTriggers: [], functionProofValid: true };
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
       AND t.tgname LIKE 'actual60_auth_history_refresh_%'
     ORDER BY t.tgname ASC
  `);
  const observed = new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row.triggerName || ""), row]));
  const missingTriggers = [];
  const mismatchedTriggers = [];
  for (const [triggerName, tableName] of AUTH_HISTORY_DB_FENCE_TRIGGERS) {
    const row = observed.get(triggerName);
    if (!row) { missingTriggers.push(triggerName); continue; }
    const enabled = String(row.enabled || "").toUpperCase();
    if (String(row.tableName || "") !== tableName
        || String(row.functionName || "") !== AUTH_HISTORY_DB_FENCE_FUNCTION
        || !["O", "A"].includes(enabled)) {
      mismatchedTriggers.push(triggerName);
    }
  }
  const defs = Array.from(observed.values()).map((row) => String(row.functionDefinition || ""));
  const functionProofValid = defs.some((definition) =>
    definition.includes(AUTH_HISTORY_DB_SETTING)
      && definition.includes(AUTH_HISTORY_PUBLISHER_GENERATION)
      && definition.includes(AUTH_HISTORY_PURGE_SCOPE)
      && definition.includes("ACTIVE")
      && definition.includes("ACTUAL60_INCOMPATIBLE_AUTH_HISTORY_PUBLISHER")
  );
  return {
    supported: true,
    ready: missingTriggers.length === 0 && mismatchedTriggers.length === 0 && functionProofValid,
    adapter: false,
    missingTriggers,
    mismatchedTriggers,
    functionProofValid,
  };
}

async function authorizationHistoryActivationDiagnostics(db) {
  const [row, dbFence] = await Promise.all([
    readAuthorizationHistoryReleaseAuthority(db),
    readAuthorizationHistoryDbFenceStatus(db),
  ]);
  return {
    row,
    dbFence,
    expectedGeneration: AUTH_HISTORY_PUBLISHER_GENERATION,
    readyToActivate: Boolean(
      row
      && row.requiredGeneration === AUTH_HISTORY_PUBLISHER_GENERATION
      && String(row.activationState || "").toUpperCase() === "DRAINING"
      && dbFence.ready
    ),
  };
}

async function activateAuthorizationHistoryPurgeAfterDrain(db) {
  if (!db || typeof db.$transaction !== "function") {
    throw Object.assign(new Error("Prisma transaction support is required for authorization-history activation"), { code: "AUTH_HISTORY_PURGE_ACTIVATION_DB_REQUIRED" });
  }
  return db.$transaction(async (tx) => {
    await lockDbAdvisoryXact({ db: tx, key: AUTH_HISTORY_RELEASE_FENCE_KEY, mode: "exclusive" });
    const row = await readAuthorizationHistoryReleaseAuthority(tx, { forUpdate: true });
    if (!row || row.requiredGeneration !== AUTH_HISTORY_PUBLISHER_GENERATION) throw releaseUnavailable(row);
    const fence = await readAuthorizationHistoryDbFenceStatus(tx);
    if (!fence.ready) {
      const error = new Error("Authorization-history PostgreSQL publisher fence is incomplete");
      error.code = "AUTH_HISTORY_PURGE_DB_FENCE_INCOMPLETE";
      error.status = 503;
      error.details = fence;
      throw error;
    }
    if (String(row.activationState || "").toUpperCase() === "ACTIVE") {
      return { activated: false, alreadyActive: true, generation: AUTH_HISTORY_PUBLISHER_GENERATION, row };
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE "Phase2ReleaseCompatibilityAuthority"
          SET "activationState"='ACTIVE',
              "activatedAt"=clock_timestamp(),
              "activationConfirmedAt"=clock_timestamp(),
              "updatedAt"=clock_timestamp()
        WHERE "scope"=$1
          AND "requiredGeneration"=$2
          AND "activationState"='DRAINING'
      RETURNING "scope","requiredGeneration","activationState","drainStartedAt","activatedAt","activationConfirmedAt"`,
      AUTH_HISTORY_PURGE_SCOPE,
      AUTH_HISTORY_PUBLISHER_GENERATION,
    );
    if (!Array.isArray(updated) || updated.length !== 1) throw releaseUnavailable(await readAuthorizationHistoryReleaseAuthority(tx, { forUpdate: true }));
    return { activated: true, alreadyActive: false, generation: AUTH_HISTORY_PUBLISHER_GENERATION, row: updated[0] };
  });
}

module.exports = {
  AUTH_HISTORY_PURGE_SCOPE,
  AUTH_HISTORY_PUBLISHER_GENERATION,
  AUTH_HISTORY_RELEASE_FENCE_KEY,
  AUTH_HISTORY_DB_SETTING,
  AUTH_HISTORY_DB_FENCE_FUNCTION,
  AUTH_HISTORY_DB_FENCE_TRIGGERS,
  readAuthorizationHistoryReleaseAuthority,
  authorizationHistoryPurgeActivationStatus,
  authorizeAuthorizationHistoryPublisher,
  readAuthorizationHistoryDbFenceStatus,
  authorizationHistoryActivationDiagnostics,
  activateAuthorizationHistoryPurgeAfterDrain,
};
