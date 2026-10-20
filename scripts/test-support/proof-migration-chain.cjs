"use strict";
const { migrations } = require("../../src/services/database-migration-chain");

// Upgrade proofs need the actual older schema and its matching receipts.
// Removing a receipt from a current schema creates an invalid history instead.
function selectProofMigrations(beforeMigration = null) {
  if (beforeMigration == null) return migrations.slice();
  const index = migrations.findIndex(item => item.migration === beforeMigration);
  if (index < 1) throw Object.assign(new Error("A proof upgrade requires a known non-empty predecessor migration chain"), {
    code: "PROOF_MIGRATION_PREFIX_REQUIRED",
  });
  return migrations.slice(0, index);
}

module.exports = { selectProofMigrations };
