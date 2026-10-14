"use strict";

const baseline = require("./database-contract.json");
const extension = require("./database-contract-extensions.json");
const migrations = [{
  migration: baseline.migration,
  checksum: baseline.checksum
}, ...extension.migrations];
function currentContract() {
  const result = {
    ...baseline,
    version: extension.version
  };
  for (const key of ["tables", "columns", "enums", "views", "functions", "triggers", "constraints", "indexes"]) {
    // An extension explicitly replaces the identity of an altered schema object.
    const additions = extension.extension[key] || [];
    const identities = new Set(additions.map(row => `${row.table || ""}|${row.name}`));
    result[key] = [...baseline[key].filter(row => !identities.has(`${row.table || ""}|${row.name}`)), ...additions];
  }
  return result;
}
function validMigrationPrefix(rows, complete = false) {
  const active = rows.filter(row => !row.rolled_back_at);
  if (active.length > migrations.length || complete && active.length !== migrations.length) return false;
  return migrations.slice(0, active.length).every(expected => {
    const matches = active.filter(row => row.migration_name === expected.migration);
    return matches.length === 1 && matches[0].checksum === expected.checksum && !!matches[0].finished_at;
  });
}
module.exports = {
  migrations,
  currentContract,
  validMigrationPrefix
};
