"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("Actual60 migration rehearsal: runner exposes explicit migration gate and requires an isolated audit database", () => {
  const gate = read("scripts/audit/actual59-auth-lifecycle-gate.js");
  assert.match(gate, /new Set\(\["source", "migration", "pg", "scale", "all"\]\)/);
  assert.match(gate, /function migrationGate\(\)/);
  assert.match(gate, /resolveAuditDatabase\("migration"\)/);
  assert.match(gate, /ONLINOD_AUDIT_DATABASE_URL/);
  assert.match(gate, /refusing to run mutating audit against DATABASE_URL/);
  assert.match(gate, /actual60-migration-rehearsal\.js/);
  assert.match(gate, /DATABASE_URL:\s*auditDatabaseUrl/);
  assert.match(gate, /ONLINOD_ACTUAL60_MIGRATION_REHEARSAL:\s*"1"/);
});

test("Actual60 migration rehearsal: uses a disposable PostgreSQL schema and a real pre-lineage -> prerequisite -> F60 sequence", () => {
  const source = read("scripts/audit/actual60-migration-rehearsal.js");
  assert.match(source, /CREATE SCHEMA/);
  assert.match(source, /DROP SCHEMA IF EXISTS/);
  assert.match(source, /lineageMigration/);
  assert.match(source, /name < lineageMigration/);
  assert.match(source, /deploy-pre-lineage/);
  assert.match(source, /name < scaleMigration/);
  assert.match(source, /deploy-pre-scale-prerequisites/);
  assert.match(source, /20260916014500_actual60_refreshsession_current_write_history_scale/);
  assert.match(source, /20260916034500_actual60_int60_8_authorization_boundary_destructive_fence/);
  assert.match(source, /copyMigrationSet\(fullWorkspace, \(name\) => name <= throughMigration\)/);
  assert.match(source, /deploy-through-int60\.10-schema-first/);
  assert.match(source, /redeploy-idempotence-schema/);
  assert.match(source, /redeploy-idempotence-online-index-ensure/);
});

test("Actual60 migration rehearsal: legacy row is physically seeded before authorizationSessionId exists and survives as NULL lineage", () => {
  const source = read("scripts/audit/actual60-migration-rehearsal.js");
  assert.match(source, /INSERT INTO "RefreshSession"/);
  assert.doesNotMatch(
    source.slice(source.indexOf('INSERT INTO "RefreshSession"'), source.indexOf('deploy-pre-scale-prerequisites')),
    /authorizationSessionId/,
    "pre-lineage seed must not rely on the future lineage column",
  );
  assert.match(source, /legacyAfterPrereqs\.authorizationSessionId !== null/);
  assert.match(source, /legacy NULL-lineage row was reclassified/);
});

test("Actual60 migration rehearsal: seeds long retained rotation history plus expired-unrevoked history", () => {
  const source = read("scripts/audit/actual60-migration-rehearsal.js");
  assert.match(source, /authorizationSessionId:\s*lineage/);
  assert.match(source, /for \(let i = 0; i < 2_000; i \+= 1\)/);
  assert.match(source, /for \(let i = 0; i < 1_000; i \+= 1\)/);
  assert.match(source, /historical state changed across migration/);
  assert.match(source, /lineage rotation history changed/);
  assert.match(source, /expiredUnrevoked/);
  assert.match(source, /unexpired/);
});

test("Actual60 migration rehearsal: populated Prisma scale migrations do not build indexes; online ensure owns physical index creation", () => {
  const source = read("scripts/audit/actual60-migration-rehearsal.js");
  assert.match(source, /prematureIndexes/);
  assert.match(source, /populated-table F60 migration built indexes before online ensure/);
  assert.ok(
    source.indexOf("deploy-through-int60.10-schema-first") < source.indexOf("await proveOnlineIndexEnsure("),
    "schema migration must finish before online index ensure",
  );
});

test("Actual60 migration rehearsal: proves cumulative indexes and boundary triggers are healthy and singular after two-stage redeploy", () => {
  const source = read("scripts/audit/actual60-migration-rehearsal.js");
  assert.match(source, /RefreshSession_live_authorization_lookup_idx/);
  assert.match(source, /RefreshSession_live_lineage_lookup_idx/);
  assert.match(source, /RefreshSession_authorization_history_idx/);
  assert.match(source, /RefreshSession_live_user_lookup_idx/);
  assert.match(source, /RefreshSession_live_agency_lookup_idx/);
  assert.match(source, /RefreshSession_user_history_created_idx/);
  assert.match(source, /AgencyMember_capture_access_epoch_boundary/);
  assert.match(source, /RefreshSession_capture_authorization_boundary/);
  assert.match(source, /AgencyCreatorCatalogState_capture_generation_boundary/);
  assert.match(source, /index duplication detected/);
  assert.match(source, /trigger duplication detected/);
  assert.match(source, /indisvalid/);
  assert.match(source, /indisready/);
  assert.match(source, /migration ledger mismatch/);
  assert.match(source, /recover-missing-online-index/);
  assert.match(source, /DROP INDEX CONCURRENTLY IF EXISTS "RefreshSession_user_history_created_idx"/);
  assert.match(source, /missing-index recovery failed/);
});

test("Actual60 migration rehearsal: never runs destructive rehearsal operations against primary schema directly", () => {
  const source = read("scripts/audit/actual60-migration-rehearsal.js");
  assert.match(source, /withSchema\(databaseUrl, schemaName\)/);
  assert.match(source, /new PrismaClient\(\{ datasources: \{ db: \{ url: rehearsalUrl \} \} \}\)/);
  assert.doesNotMatch(source, /DROP DATABASE/);
  assert.doesNotMatch(source, /TRUNCATE/);
});


test("Actual60 migration rehearsal: includes INT60.8 authorization-boundary destructive fences in runtime proof", () => {
  const source = read("scripts/audit/actual60-migration-rehearsal.js");
  assert.match(source, /phase2_non_fk_tenant_insert_fence/);
  assert.match(source, /AuthorizationSessionBoundary/);
  assert.match(source, /AgencyMemberAccessEpochBoundary/);
  assert.match(source, /AgencyCreatorCatalogGenerationBoundary/);
  assert.match(source, /authorization boundary destructive fence mismatch/);
});


test("Actual60 migration rehearsal: INT60.8 destructive boundary fences are behaviorally enforced, not only present in pg_trigger", () => {
  const source = read("scripts/audit/actual60-migration-rehearsal.js");
  assert.match(source, /DESTRUCTIVE_AGENCY_CLEANUP/);
  assert.match(source, /Phase2AgencyDestructiveCleanup/);
  assert.match(source, /authorization boundary destructive fence did not block/);
  assert.match(source, /PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS/);
  assert.match(source, /authorization boundary destructive fence leaked rows/);
  for (const table of [
    "AuthorizationSessionBoundary",
    "AgencyMemberAccessEpochBoundary",
    "AgencyCreatorCatalogGenerationBoundary",
  ]) assert.match(source, new RegExp(table));
});
