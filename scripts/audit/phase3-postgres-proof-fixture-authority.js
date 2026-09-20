"use strict";

const {
  assertTeamControlPlaneWriteAdmission,
  authorizeCreatorAccountWrite,
} = require("../../src/services/phase2-release-compatibility-authority-service");

// PostgreSQL integration proofs run against a fully migrated schema where the
// Phase-2 DB writer fences are intentionally ACTIVE. Test fixtures must therefore
// use the same transaction-local release generations as production writers.
// Never disable triggers or mutate compatibility-authority rows to seed a proof.
async function withPhase3PostgresFixtureAuthority(db, work, options = undefined) {
  if (!db || typeof db.$transaction !== "function" || typeof work !== "function") {
    const error = new Error("Phase3 PostgreSQL fixture authority requires a root PrismaClient and work callback");
    error.code = "PHASE3_POSTGRES_FIXTURE_TRANSACTION_REQUIRED";
    throw error;
  }
  return db.$transaction(async (tx) => {
    await assertTeamControlPlaneWriteAdmission(tx);
    await authorizeCreatorAccountWrite(tx);
    return work(tx);
  }, options);
}

module.exports = {
  withPhase3PostgresFixtureAuthority,
};
