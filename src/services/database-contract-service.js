"use strict";
const contract = require("./database-contract.json");

function identity(row) { return JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]))); }
function compare(expected, actual, key) {
  const found = new Set(actual.map(identity));
  return expected.filter(row => !found.has(identity(row))).map(row => `${key}:${row.table ? row.table + "." : ""}${row.name}`);
}

// Read-only: startup and probes cannot install indexes, activate releases or
// repair data. The installer owns DDL; runtime owns current domain operations.
async function readDatabaseContract(db) {
  const ledger = await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations"');
  const applied = ledger.filter(row => !row.rolled_back_at);
  const problems = [];
  if (applied.length !== 1 || applied[0].migration_name !== contract.migration
      || applied[0].checksum !== contract.checksum || !applied[0].finished_at) problems.push("BASELINE_REQUIRED");
  for (const key of ["tables", "columns", "enums", "views", "functions", "triggers", "constraints", "indexes"]) {
    const rows = await db.$queryRawUnsafe(contract.queries[key]);
    problems.push(...compare(contract[key], rows, key));
    if (key === "tables") {
      const expected = new Set(contract.tables.map(row => row.name));
      problems.push(...rows.filter(row => row.name !== "_prisma_migrations" && !expected.has(row.name)).map(row => `unexpected-table:${row.name}`));
    }
  }
  const invalid = await db.$queryRawUnsafe(`
    SELECT 'trigger' AS kind,t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled NOT IN ('O','A')
    UNION ALL SELECT 'index',c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (NOT i.indisvalid OR NOT i.indisready)
    UNION ALL SELECT 'constraint',x.conname FROM pg_constraint x JOIN pg_namespace n ON n.oid=x.connamespace
      WHERE n.nspname='public' AND NOT x.convalidated`);
  problems.push(...invalid.map(row => `${row.kind}:${row.name}:inactive`));
  const controls = await db.$queryRawUnsafe(`SELECT
    EXISTS(SELECT 1 FROM "DomainWorkClaimTopologyState" WHERE "id"='phase3_domain_work_claim_topology_a36_v1'
      AND "generation"="id" AND "activationState"='ACTIVE') AS topology,
    EXISTS(SELECT 1 FROM "OfProviderRequestGateState" WHERE "id"='of-global'
      AND "fairnessGeneration"='phase3_provider_gate_fairness_v2_a14' AND "fairnessActivationState"='ACTIVE') AS provider,
    EXISTS(SELECT 1 FROM "SystemSetting" WHERE "key"='phase3.campaignCausalObservationV1'
      AND "value"->>'active'='true' AND "value"->>'writerGenerationActive'='true'
      AND "value"->>'claimGenerationActive'='true' AND ("value"->>'writerGeneration')::int>0) AS campaigns,
    (SELECT array_agg("laneName"::text ORDER BY "ordinal") =
      ARRAY['CAMPAIGN_FACT','CAMPAIGN_VALUE','CAMPAIGN_ATTRIBUTION','CAMPAIGN_CLOCK','CAMPAIGN_BACKFILL']::text[]
      FROM "MaintenanceAdmissionClassState" WHERE "generation"='campaign_projection_execution_v2') AS campaign_dispatch`);
  for (const [key, value] of Object.entries(controls[0] || {})) if (!value) problems.push(`control:${key}`);
  return { ready: problems.length === 0, version: contract.version, problems };
}

async function assertDatabaseContract(db) {
  const result = await readDatabaseContract(db);
  if (!result.ready) throw Object.assign(new Error("Database schema is incomplete; run npm run prisma:migrate on the current clean installation"), {
    code: "DATABASE_CONTRACT_REQUIRED", problems: result.problems,
  });
  return result;
}
module.exports = { readDatabaseContract, assertDatabaseContract };
