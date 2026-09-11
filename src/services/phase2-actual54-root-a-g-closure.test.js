"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const authority = require("./domain-work-authority-service");
const { coveragePreflightPasses, runCoveragePreflight } = require("../../scripts/audit/phase2-coverage-preflight-readonly");
const {
  COVERAGE_MANIFEST_VERSION, COVERAGE_SEED_LANE_KEY, COVERAGE_SEED_GENERATION, COVERAGE_MANIFEST, coverageManifestFingerprint,
} = require("./phase2-coverage-manifest");

function productionDb(now) {
  const sql = [];
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; } },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    async $transaction(work) { return work(db); },
    async $queryRawUnsafe(statement) {
      sql.push(String(statement));
      if (String(statement).includes("clock_timestamp")) return [{ authorityNow: now }];
      return [];
    },
  };
  return { db, sql };
}

test("F54-01 creator-scoped claim constrains physical discovery before unrelated ready heads", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const fx = productionDb(now);
  await authority.claimDomainWorkBatch({
    db: fx.db,
    workClass: authority.WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
    agencyId: "agency-1",
    creatorIds: ["creator-91", "creator-92", "creator-93", "creator-94", "creator-95"],
    objectType: "CustomContentSubmission",
    ownerToken: "scoped-worker",
    limit: 15,
    perPartitionQuantum: 3,
    fallbackNow: now,
  });
  const claimSql = fx.sql.find((entry) => entry.includes('UPDATE "DomainWorkItem"'));
  assert.ok(claimSql);
  assert.match(claimSql, /WITH scoped_creators\("creatorId"\) AS/);
  assert.match(claimSql, /d\."creatorId"=c\."creatorId"/);
  assert.match(claimSql, /CROSS JOIN LATERAL/);
  assert.match(claimSql, /LIMIT \$6/);
  assert.doesNotMatch(claimSql, /DomainWorkReadyAgency/);
  assert.doesNotMatch(claimSql, /DomainWorkReadyPartition/);
  const agencyLockIndex = fx.sql.findIndex((entry) => entry.includes('phase2_lock_domain_work_agency_head'));
  const claimIndex = fx.sql.findIndex((entry) => entry.includes('UPDATE "DomainWorkItem"'));
  assert.ok(agencyLockIndex >= 0 && claimIndex > agencyLockIndex, "creator-scoped claim must acquire tenant head authority before DWI row locks");
});

test("F54-02 ready-head migration serializes tenant before partition and avoids multi-row claim lock cycles", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911004500_phase2_actual54_root_a_g_closure", "migration.sql"), "utf8");
  assert.match(migration, /phase2_lock_domain_work_partition_head/);
  assert.match(migration, /phase2_lock_domain_work_agency_head/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION "phase2_lock_domain_work_mutation_scope"/);
  assert.match(migration, /CREATE TRIGGER "trg_00_phase2_domain_work_mutation_scope"[\s\S]*BEFORE INSERT OR UPDATE OR DELETE ON "DomainWorkItem"/,
    "tenant authority must be acquired before family-state/ready-head AFTER triggers for every DWI mutation");
  assert.match(migration, /phase2:dwra-scope:/, "agency head authority must be tenant-scoped across work classes");
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended/);
  const partitionRefresh = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_refresh_domain_work_partition_head"'),
    migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_domain_work_ready_head_trigger"'),
  );
  assert.ok(partitionRefresh.indexOf('phase2_lock_domain_work_agency_head') < partitionRefresh.indexOf('phase2_lock_domain_work_partition_head'),
    "partition refresh must globally order tenant authority before partition authority");
  const trigger = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_domain_work_ready_head_trigger"'),
    migration.indexOf('-- F54-02 cutover barrier:'),
  );
  assert.match(trigger, /agencyId\/workClass authority identity is immutable/);
  assert.ok(trigger.indexOf('phase2_lock_domain_work_agency_head') < trigger.indexOf('IF TG_OP=\'UPDATE\' AND OLD."partitionKey"'),
    "row trigger must acquire tenant authority before partition transition locks");
  assert.match(trigger, /IF old_key <= new_key THEN/);
  assert.match(trigger, /PERFORM "phase2_refresh_domain_work_partition_head"\(OLD/);
  assert.match(trigger, /PERFORM "phase2_refresh_domain_work_partition_head"\(NEW/);
  assert.match(migration, /phase2_repair_domain_work_partition_head_once/);
  assert.match(migration, /pg_advisory_lock\(v_lock\)/);
  assert.match(migration, /pg_advisory_unlock\(v_lock\)/);
  assert.match(migration, /FROM "DomainWorkReadyPartition" p[\s\S]*UNION[\s\S]*FROM "DomainWorkItem" d/);
  assert.match(migration, /phase2_repair_domain_work_agency_head_once/);
  assert.match(migration, /DROP FUNCTION "phase2_repair_domain_work_partition_head_once"/);
  assert.match(migration, /DROP FUNCTION "phase2_repair_domain_work_agency_head_once"/);
  const repairLoop = migration.slice(migration.indexOf('DO $phase2_repair_partition_heads$'), migration.indexOf('$phase2_repair_partition_heads$;', migration.indexOf('DO $phase2_repair_partition_heads$')) + '$phase2_repair_partition_heads$;'.length);
  assert.equal((repairLoop.match(/PERFORM "phase2_repair_domain_work_partition_head_once"/g) || []).length, 1,
    "migration must revalidate each partition head once, not duplicate lock/recompute work");
});

test("F54-02 production broad claim never mutates more than one agency per DB transaction", () => {
  const source = fs.readFileSync(path.join(__dirname, "domain-work-authority-service.js"), "utf8");
  const start = source.indexOf('Production broad claims are intentionally split into one agency per DB');
  const end = source.indexOf('// Adapter/unit fallback.', start);
  assert.ok(start >= 0 && end > start);
  const broad = source.slice(start, end);
  assert.match(broad, /runDbTransaction\(db, async \(tx\) =>/);
  assert.match(broad, /SELECT a\."agencyId"[\s\S]*LIMIT 1/);
  assert.match(broad, /phase2_lock_domain_work_agency_head/);
  assert.match(broad, /d\."agencyId"=\$4/);
  assert.doesNotMatch(broad, /WITH agencies AS/, "one SQL UPDATE must not aggregate multiple agency lock domains");
});

test("F54-01 scoped current-work index is partial and creator-addressable", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911004500_phase2_actual54_root_a_g_closure", "migration.sql"), "utf8");
  assert.match(migration, /DomainWorkItem_scoped_creator_due_current_idx/);
  assert.match(migration, /"agencyId","workClass","activeGeneration","creatorId","availableAt","id"/);
  assert.match(migration, /WHERE "isOutstanding"=TRUE AND "creatorId" IS NOT NULL/);
});

test("F54-06 preflight cannot be green when coverage is explicitly not converged", () => {
  assert.equal(coveragePreflightPasses({ currentSeedComplete: true, manifestSeeded: true, convergenceComplete: false }), false);
  assert.equal(coveragePreflightPasses({ currentSeedComplete: true, manifestSeeded: true, convergenceComplete: true }), true);
  assert.equal(coveragePreflightPasses({ currentSeedComplete: false, manifestSeeded: true, convergenceComplete: true }), false);
});

test("F54-06 behavioral preflight exits non-zero when seed and manifest exist but coverage is not converged", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const fingerprint = coverageManifestFingerprint();
  const db = {
    agency: {
      async findUnique() { return { id: "agency-1", deletedAt: null }; },
      async findMany() { return [{ id: "agency-1" }]; },
    },
    maintenanceLaneState: {
      async findUnique({ where }) {
        if (where.key !== COVERAGE_SEED_LANE_KEY) return null;
        return {
          key: COVERAGE_SEED_LANE_KEY, generation: COVERAGE_SEED_GENERATION, activeGeneration: COVERAGE_SEED_GENERATION,
          completedAt: now, ownerToken: null, leaseUntil: null, cursor: null,
          progress: { manifestVersion: COVERAGE_MANIFEST_VERSION, manifestFingerprint: fingerprint },
          lastOutcome: "COMPLETE", lastError: null, updatedAt: now,
        };
      },
    },
    phase2WorkCoverage: {
      async findMany() {
        return COVERAGE_MANIFEST.map(([family, generation], index) => ({
          agencyId: "agency-1", family, generation, active: true,
          enumerationState: index === 0 ? "RUNNING" : "COMPLETE",
          enumeratedThrough: null, projectedThrough: null, unresolvedCount: 0,
          completedAt: index === 0 ? null : now, updatedAt: now,
        }));
      },
    },
  };
  const previousExitCode = process.exitCode;
  let output = "";
  try {
    process.exitCode = undefined;
    const report = await runCoveragePreflight({
      prisma: db,
      env: { ONLINOD_PHASE2_COVERAGE_PREFLIGHT: "1", ONLINOD_PHASE2_COVERAGE_PREFLIGHT_AGENCY_ID: "agency-1" },
      stdout: { write(chunk) { output += String(chunk); } },
    });
    assert.equal(report.coverage.manifestSeeded, true);
    assert.equal(report.coverage.convergenceComplete, false);
    assert.equal(report.ok, false);
    assert.equal(process.exitCode, 2);
    assert.match(output, /CURRENT_MANIFEST_COVERAGE_NOT_CONVERGED/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("F54-02 migration cutover table barrier prevents old uncommitted trigger generations from racing head revalidation", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911004500_phase2_actual54_root_a_g_closure", "migration.sql"), "utf8");
  const begin = migration.indexOf("BEGIN;");
  const barrier = migration.indexOf('LOCK TABLE "DomainWorkItem" IN SHARE ROW EXCLUSIVE MODE');
  const repair = migration.indexOf('phase2_repair_domain_work_partition_head_once');
  const commit = migration.lastIndexOf("COMMIT;");
  assert.ok(begin >= 0 && barrier > begin && repair > barrier && commit > repair,
    "DWI writers must be quiesced in the same explicit migration transaction before legacy heads are revalidated");
});

test("Root A historical enumeration exception path uses the actual DomainWork owner token", () => {
  const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  const start = scheduler.indexOf("async function maybeRunPhase2HistoricalEnumeration");
  const end = scheduler.indexOf("async function maybeBackfillProviderOperationalDebt", start);
  assert.ok(start >= 0 && end > start);
  const body = scheduler.slice(start, end);
  assert.match(body, /markPhase2CoverageFailed\(\{ db, workItem: item, ownerToken: claim\.ownerToken,/);
  assert.doesNotMatch(body, /markPhase2CoverageFailed\(\{ db, workItem: item, ownerToken, agencyId:/,
    "historical enumeration catch must not reference an undefined ownerToken and strand the claim until lease expiry");
});

test("F54-02 broad logical batch preserves throughput via bounded one-agency transactions", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  let transactions = 0;
  let agencySelections = 0;
  let lockedAgency = null;
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; } },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    async $transaction(work) { transactions += 1; return work(db); },
    async $queryRawUnsafe(statement, ...args) {
      const text = String(statement);
      if (text.includes("clock_timestamp")) return [{ authorityNow: now }];
      if (text.includes('SELECT a."agencyId"') && text.includes('FROM "DomainWorkReadyAgency"')) {
        agencySelections += 1;
        if (agencySelections === 1) return [{ agencyId: "agency-a" }];
        if (agencySelections === 2) return [{ agencyId: "agency-b" }];
        return [];
      }
      if (text.includes('phase2_lock_domain_work_agency_head')) { lockedAgency = String(args[0]); return []; }
      if (text.includes('SELECT 1 AS ok FROM "DomainWorkReadyAgency"')) return [{ ok: 1 }];
      if (text.includes('UPDATE "DomainWorkItem"')) {
        return [{ id: `work-${lockedAgency}`, agencyId: lockedAgency, ownerToken: "multi-agency-worker", state: "CLAIMED" }];
      }
      return [];
    },
  };
  const result = await authority.claimDomainWorkBatch({
    db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
    ownerToken: "multi-agency-worker", limit: 2, perAgencyQuantum: 1, perPartitionQuantum: 1, fallbackNow: now,
  });
  assert.deepEqual(result.items.map((row) => row.agencyId), ["agency-a", "agency-b"]);
  assert.equal(transactions, 2, "logical batch should span agencies without sharing their DB transaction/lock domain");
  assert.equal(result.ownerToken, "multi-agency-worker");
});

test("F54-01 creator-scoped raw claim is fail-closed without tenant agency scope", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const fx = productionDb(now);
  await assert.rejects(
    authority.claimDomainWorkBatch({
      db: fx.db, workClass: authority.WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
      creatorIds: ["creator-1"], ownerToken: "scoped-no-agency", fallbackNow: now,
    }),
    (error) => error?.code === "DOMAIN_WORK_SCOPED_AGENCY_REQUIRED",
  );
});
