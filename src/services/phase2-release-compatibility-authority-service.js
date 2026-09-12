"use strict";

const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { assertAllLiveAgenciesHaveOperationalOwner } = require("./team-operational-owner-authority-service");

// These generations are DB-enforced rolling-release compatibility identities.
// They are not business authorization by themselves; business/lifecycle services
// must still perform their normal permission and object fencing. Their only job is
// to let migrated PostgreSQL reject incompatible old-binary writer shapes.
const CREATOR_ACCOUNT_WRITER_GENERATION = "phase2_creator_writer_v2_actual56_postcut";
const DOMAIN_WORK_EXECUTOR_GENERATION = "phase2_domain_executor_v4_actual56_postcut";
const TEAM_CONTROL_PLANE_GENERATION = "phase2_team_control_plane_v1_actual56_postcut";
const TEAM_CONTROL_PLANE_SCOPE = "TEAM_CONTROL_PLANE";
const TEAM_CONTROL_PLANE_RELEASE_FENCE_KEY = "phase2:release-activation:TEAM_CONTROL_PLANE";

async function setLocalGeneration(db, setting, generation) {
  if (typeof db?.$queryRawUnsafe !== "function") return { applied: false, generation };
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

async function assertTeamControlPlaneWriteAdmission(db) {
  // Prisma transactions always expose the raw methods. Test/fallback adapters do
  // not; preserve those isolated adapters without pretending they are a production
  // release authority implementation.
  if (typeof db?.$executeRawUnsafe !== "function" || typeof db?.$queryRawUnsafe !== "function") {
    return { admitted: true, adapter: true, generation: TEAM_CONTROL_PLANE_GENERATION };
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
  return { admitted: true, adapter: false, generation: TEAM_CONTROL_PLANE_GENERATION, row };
}

async function activateTeamControlPlaneAfterDrain(db, { confirmOldBinaryDrained = false } = {}) {
  if (!confirmOldBinaryDrained) {
    const error = new Error("Explicit old-binary drain confirmation is required before Team control-plane activation");
    error.code = "TEAM_CONTROL_PLANE_DRAIN_CONFIRMATION_REQUIRED";
    error.status = 409;
    throw error;
  }
  if (!db || typeof db.$transaction !== "function") {
    throw Object.assign(new Error("Prisma transaction support is required for Team control-plane activation"), { code: "TEAM_CONTROL_PLANE_ACTIVATION_DB_REQUIRED" });
  }

  return db.$transaction(async (tx) => {
    await lockDbAdvisoryXact({ db: tx, key: TEAM_CONTROL_PLANE_RELEASE_FENCE_KEY, mode: "exclusive" });
    const row = await readTeamControlPlaneReleaseAuthority(tx, { forUpdate: true });
    if (!row) throw teamControlPlaneUnavailable(null);
    if (row.requiredGeneration !== TEAM_CONTROL_PLANE_GENERATION) throw teamControlPlaneUnavailable(row);

    if (String(row.activationState || "").toUpperCase() === "ACTIVE") {
      return { activated: false, alreadyActive: true, generation: TEAM_CONTROL_PLANE_GENERATION, row };
    }

    // Old binaries are allowed to drain while the new binary is fail-closed.
    // Before exposing the new Team authority generation, validate that no old
    // writer left a live Agency without an operational OWNER. The exclusive
    // release fence prevents any admitted new Team writer from racing this proof.
    await assertAllLiveAgenciesHaveOperationalOwner({ db: tx });

    const updated = await tx.$queryRawUnsafe(
      `UPDATE "Phase2ReleaseCompatibilityAuthority"\n          SET "activationState"='ACTIVE',\n              "activatedAt"=CURRENT_TIMESTAMP,\n              "activationConfirmedAt"=CURRENT_TIMESTAMP,\n              "updatedAt"=CURRENT_TIMESTAMP\n        WHERE "scope"=$1\n          AND "requiredGeneration"=$2\n          AND "activationState"='DRAINING'\n      RETURNING "scope","requiredGeneration","activationState","drainStartedAt","activatedAt","activationConfirmedAt"`,
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
  authorizeCreatorAccountWrite,
  authorizeDomainWorkExecutor,
  readTeamControlPlaneReleaseAuthority,
  assertTeamControlPlaneWriteAdmission,
  activateTeamControlPlaneAfterDrain,
  runCreatorAccountWriteTransaction,
};
