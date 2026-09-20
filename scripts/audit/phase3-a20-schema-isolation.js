#!/usr/bin/env node
"use strict";

const prisma = require("../../src/prisma");
const { FAMILY, GENERATION } = require("../../src/services/phase2-work-coverage-authority-service");
const { withPhase3PostgresFixtureAuthority, cleanupPhase3PostgresAgencyFixture, auditSchemaFromDatabaseUrl } = require("./phase3-postgres-proof-fixture-authority");

const mode = String(process.argv[2] || "structural").trim().toLowerCase();

function fail(message, details = undefined) {
  const error = new Error(message);
  error.code = "A20_SCHEMA_ISOLATION_FAILED";
  if (details !== undefined) error.details = details;
  throw error;
}

async function structuralProof(expected) {
  const sessionRows = await prisma.$queryRawUnsafe(`
    SELECT current_schema() AS "currentSchema",
           current_setting('search_path') AS "searchPath",
           current_database() AS "databaseName"
  `);
  const session = sessionRows?.[0] || {};
  if (String(session.currentSchema || "") !== expected) fail("Prisma runtime current_schema does not match audit schema", { expected, session });

  const relationRows = await prisma.$queryRawUnsafe(`
    SELECT x.name, n.nspname AS schema
      FROM (VALUES ('Agency'),('CreatorAccount'),('Phase2WorkCoverage'),('Phase2ReleaseCompatibilityAuthority')) AS x(name)
      LEFT JOIN pg_class c ON c.oid = to_regclass(format('%I', x.name))
      LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
     ORDER BY x.name
  `);
  const wrongRelations = relationRows.filter((row) => String(row.schema || "") !== expected);
  if (wrongRelations.length) fail("Unqualified critical relations do not resolve to the audit schema", { expected, wrongRelations, session });

  const crossSchemaFks = await prisma.$queryRawUnsafe(`
    SELECT con.conname AS "constraintName", child.relname AS "childTable", parent.relname AS "parentTable",
           child_ns.nspname AS "childSchema", parent_ns.nspname AS "parentSchema"
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
     WHERE con.contype='f'
       AND child_ns.nspname=$1
       AND parent_ns.nspname<>$1
     ORDER BY con.conname
  `, expected);
  if (crossSchemaFks.length) fail("Audit schema contains cross-schema foreign keys", { expected, crossSchemaFks });

  const misplacedTriggerFunctions = await prisma.$queryRawUnsafe(`
    SELECT t.tgname AS "triggerName", c.relname AS "tableName", fn_ns.nspname AS "functionSchema"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace table_ns ON table_ns.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN pg_namespace fn_ns ON fn_ns.oid=p.pronamespace
     WHERE NOT t.tgisinternal
       AND table_ns.nspname=$1
       AND fn_ns.nspname<>$1
     ORDER BY t.tgname
  `, expected);
  if (misplacedTriggerFunctions.length) fail("Audit schema trigger points at a function outside the audit schema", { expected, misplacedTriggerFunctions });

  const exactFk = await prisma.$queryRawUnsafe(`
    SELECT child_ns.nspname AS "childSchema", parent_ns.nspname AS "parentSchema"
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
     WHERE con.conname='Phase2WorkCoverage_agencyId_fkey'
       AND child_ns.nspname=$1
  `, expected);
  if (exactFk.length !== 1 || String(exactFk[0].parentSchema) !== expected) fail("Phase2WorkCoverage FK is not schema-local", { expected, exactFk });

  const exactTrigger = await prisma.$queryRawUnsafe(`
    SELECT table_ns.nspname AS "tableSchema", fn_ns.nspname AS "functionSchema"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace table_ns ON table_ns.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN pg_namespace fn_ns ON fn_ns.oid=p.pronamespace
     WHERE NOT t.tgisinternal
       AND t.tgname='Agency_phase2_initial_coverage'
       AND table_ns.nspname=$1
  `, expected);
  if (exactTrigger.length !== 1 || String(exactTrigger[0].functionSchema) !== expected) fail("Agency initial coverage trigger/function is not schema-local", { expected, exactTrigger });

  return { session, relationCount: relationRows.length };
}

async function runtimeFixtureLifecycle(expected) {
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const agencyId = `a24-schema-agency-${nonce}`;
  const creatorId = `a24-schema-creator-${nonce}`;
  let created = false;
  try {
    await withPhase3PostgresFixtureAuthority(prisma, async (tx) => {
      await tx.agency.create({ data: { id: agencyId, name: `A24 schema ${nonce}` } });
      await tx.creatorAccount.create({ data: { id: creatorId, agencyId, displayName: `A24 schema ${nonce}` } });
    });
    created = true;
    const [agencyCount, creatorCount, coverageRows] = await Promise.all([
      prisma.agency.count({ where: { id: agencyId } }),
      prisma.creatorAccount.count({ where: { id: creatorId } }),
      prisma.phase2WorkCoverage.findMany({
        where: { agencyId },
        select: { family: true, generation: true, active: true, enumerationState: true, sourceWatermark: true },
        orderBy: [{ family: "asc" }, { generation: "asc" }],
      }),
    ]);
    const expectedCoverage = Object.values(FAMILY).map((family) => ({ family, generation: GENERATION[family] }))
      .filter((row) => row.generation)
      .sort((a, b) => a.family.localeCompare(b.family) || a.generation.localeCompare(b.generation));
    const actualCoverage = coverageRows.map((row) => ({ family: String(row.family), generation: String(row.generation) }))
      .sort((a, b) => a.family.localeCompare(b.family) || a.generation.localeCompare(b.generation));
    const identitiesMatch = JSON.stringify(actualCoverage) === JSON.stringify(expectedCoverage);
    const stateValid = coverageRows.every((row) => row.active === true
      && String(row.enumerationState) === "COMPLETE"
      && String(row.sourceWatermark || "") === "NEW_AGENCY_AFTER_PHASE2_CUTOVER");
    if (agencyCount !== 1 || creatorCount !== 1 || !identitiesMatch || !stateValid) {
      fail("Authorized audit fixture did not materialize the canonical current Phase2 coverage graph", {
        expected, agencyCount, creatorCount, expectedCoverage, coverageRows,
      });
    }
    await cleanupPhase3PostgresAgencyFixture(prisma, agencyId);
    created = false;
    const [agencyAfter, creatorAfter, coverageAfter] = await Promise.all([
      prisma.agency.count({ where: { id: agencyId } }),
      prisma.creatorAccount.count({ where: { id: creatorId } }),
      prisma.phase2WorkCoverage.count({ where: { agencyId } }),
    ]);
    if (agencyAfter !== 0 || creatorAfter !== 0 || coverageAfter !== 0) {
      fail("Canonical audit fixture cleanup left owned rows behind", { expected, agencyAfter, creatorAfter, coverageAfter });
    }
    return { agencyId, creatorId, coverageRows: coverageRows.length, cleanupVerified: true };
  } finally {
    if (created) { try { await cleanupPhase3PostgresAgencyFixture(prisma, agencyId); } catch (_) {} }
  }
}

async function main() {
  const expected = auditSchemaFromDatabaseUrl();
  if (!expected) fail("A20 schema isolation requires DATABASE_URL?schema=<audit_schema>");
  const structural = await structuralProof(expected);
  const runtime = mode === "runtime" ? await runtimeFixtureLifecycle(expected) : null;
  console.log(`# A20_SCHEMA_ISOLATION_PASS ${JSON.stringify({ expectedSchema: expected, currentSchema: structural.session.currentSchema, searchPath: structural.session.searchPath, relationCount: structural.relationCount, allForeignKeysSchemaLocal: true, allTriggerFunctionsSchemaLocal: true, runtimeFixtureLifecycle: runtime })}`);
}

main()
  .catch((error) => {
    console.error(`# A20_SCHEMA_ISOLATION_FAIL ${error?.stack || error?.message || error}`);
    if (error?.details) console.error(`# A20_SCHEMA_ISOLATION_DETAILS ${JSON.stringify(error.details)}`);
    process.exitCode = 1;
  })
  .finally(async () => { try { await prisma.$disconnect(); } catch (_) {} });
