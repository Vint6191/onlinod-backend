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
  let agencySelections = 0;
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; } },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    async $transaction(work) { return work(db); },
    async $queryRawUnsafe(statement) {
      const text = String(statement); sql.push(text);
      if (text.includes("clock_timestamp")) return [{ authorityNow: now }];
      if (text.includes('FROM "Phase2WorkFamilyState" s')) {
        agencySelections += 1;
        return agencySelections === 1 ? [{ agencyId: "agency-1" }] : [];
      }
      return [];
    },
  };
  return { db, sql };
}

test("F54-01/F55-01 creator-scoped claim is direct DWI admission with no ready-head/advisory dependency", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const fx = productionDb(now);
  await authority.claimDomainWorkBatch({
    db: fx.db, workClass: authority.WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
    agencyId: "agency-1", creatorIds: ["creator-91", "creator-92"],
    objectType: "CustomContentSubmission", ownerToken: "scoped-worker",
    limit: 10, perPartitionQuantum: 2, fallbackNow: now,
  });
  const claimSql = fx.sql.find((entry) => entry.includes('UPDATE "DomainWorkItem"'));
  assert.ok(claimSql);
  assert.match(claimSql, /WITH scoped_creators\("creatorId"\) AS/);
  assert.match(claimSql, /d\."creatorId"=c\."creatorId"/);
  assert.match(claimSql, /FOR UPDATE OF d SKIP LOCKED/);
  assert.doesNotMatch(fx.sql.join("\n"), /phase2_lock_domain_work_agency_head/);
  assert.doesNotMatch(fx.sql.join("\n"), /DomainWorkReadyAgency|DomainWorkReadyPartition/);
});

test("F55/INT7 Root A broad claim rotates Agency through bounded partition catalog without a hot-prefix workset scan", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const fx = productionDb(now);
  await authority.claimDomainWorkBatch({
    db: fx.db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
    ownerToken: "broad-worker", limit: 25, perAgencyQuantum: 5, perPartitionQuantum: 2, fallbackNow: now,
  });
  const discovery = fx.sql.find((entry) => entry.includes('FROM "Phase2WorkFamilyState" s'));
  const claimSql = fx.sql.find((entry) => entry.includes('WITH selected_partitions AS MATERIALIZED'));
  assert.ok(discovery);
  assert.ok(claimSql);
  assert.match(discovery, /"outstandingCount">0/);
  assert.match(discovery, /EXISTS \([\s\S]*FROM "DomainWorkItem" d/);
  assert.match(discovery, /"lastBroadClaimedAt" ASC NULLS FIRST/);
  assert.match(claimSql, /FROM "Phase2WorkBroadClaimPartitionState" f/);
  assert.match(claimSql, /AND EXISTS \([\s\S]*FROM "DomainWorkItem" d/);
  assert.match(claimSql, /ORDER BY f\."lastClaimedAt" ASC NULLS FIRST/);
  assert.match(claimSql, /FOR UPDATE OF d SKIP LOCKED[\s\S]*LIMIT \$6/);
  assert.doesNotMatch(claimSql, /row_number\(\)/i);
  assert.doesNotMatch(claimSql, /partition_heads|DISTINCT ON \(d\."partitionKey"\)/);
  assert.doesNotMatch(claimSql, /LIMIT 4096/i);
  assert.doesNotMatch(claimSql, /DomainWorkReadyAgency|DomainWorkReadyPartition/);
  assert.doesNotMatch(fx.sql.join("\n"), /phase2_lock_domain_work_agency_head/);
});

test("F55 Root A migration retires ready-head execution authority and fences old binaries with v3", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911142000_phase2_actual55_root_a_execution_authority", "migration.sql"), "utf8");
  assert.match(migration, /LOCK TABLE "DomainWorkItem" IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(migration, /DROP TRIGGER IF EXISTS "trg_00_phase2_domain_work_mutation_scope"/);
  assert.match(migration, /DROP TRIGGER IF EXISTS "trg_phase2_domain_work_ready_head"/);
  assert.match(migration, /phase2_domain_work_v3_actual55/);
  assert.match(migration, /DELETE FROM "DomainWorkReadyPartition"/);
  assert.match(migration, /DELETE FROM "DomainWorkReadyAgency"/);
  assert.match(migration, /DomainWorkItem_current_broad_due_v3_idx/);
  assert.match(migration, /Phase2WorkFamilyState_claim_v3_idx/);
});

test("INT5 Root A migration installs durable non-authoritative broad-claim fairness state", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911183000_phase2_actual55_int5_claim_temporal_destructive_closure", "migration.sql"), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "lastBroadClaimedAt"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "Phase2WorkBroadClaimPartitionState"/);
  assert.match(migration, /DomainWorkItem_current_agency_partition_due_v3_idx/);
  assert.match(migration, /Phase2WorkFamilyState_claim_v3_idx/);
});

test("INT7 Root A migration keeps partition catalog derived and non-authoritative", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911190000_phase2_actual55_int7_broad_partition_catalog", "migration.sql"), "utf8");
  assert.match(migration, /phase2_track_domain_work_broad_partition/);
  assert.match(migration, /AFTER INSERT OR UPDATE OF/);
  assert.match(migration, /WHERE d\."isOutstanding"=TRUE/);
  assert.match(migration, /Phase2WorkBroadClaimPartitionState/);
  assert.doesNotMatch(migration, /DomainWorkReadyAgency|DomainWorkReadyPartition/);
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
    agency: { async findUnique() { return { id: "agency-1", deletedAt: null }; }, async findMany() { return [{ id: "agency-1" }]; } },
    maintenanceLaneState: { async findUnique({ where }) {
      if (where.key !== COVERAGE_SEED_LANE_KEY) return null;
      return { key: COVERAGE_SEED_LANE_KEY, generation: COVERAGE_SEED_GENERATION, activeGeneration: COVERAGE_SEED_GENERATION,
        completedAt: now, ownerToken: null, leaseUntil: null, cursor: null,
        progress: { manifestVersion: COVERAGE_MANIFEST_VERSION, manifestFingerprint: fingerprint }, lastOutcome: "COMPLETE", lastError: null, updatedAt: now };
    } },
    phase2WorkCoverage: { async findMany() { return COVERAGE_MANIFEST.map(([family, generation], index) => ({
      agencyId: "agency-1", family, generation, active: true, enumerationState: index === 0 ? "RUNNING" : "COMPLETE",
      enumeratedThrough: null, projectedThrough: null, unresolvedCount: 0, completedAt: index === 0 ? null : now, updatedAt: now,
    })); } },
  };
  const previousExitCode = process.exitCode; let output = "";
  try {
    process.exitCode = undefined;
    const report = await runCoveragePreflight({ prisma: db,
      env: { ONLINOD_PHASE2_COVERAGE_PREFLIGHT: "1", ONLINOD_PHASE2_COVERAGE_PREFLIGHT_AGENCY_ID: "agency-1" },
      stdout: { write(chunk) { output += String(chunk); } } });
    assert.equal(report.coverage.manifestSeeded, true);
    assert.equal(report.coverage.convergenceComplete, false);
    assert.equal(report.ok, false);
    assert.equal(process.exitCode, 2);
    assert.match(output, /CURRENT_MANIFEST_COVERAGE_NOT_CONVERGED/);
  } finally { process.exitCode = previousExitCode; }
});

test("Root A historical enumeration exception path uses the actual DomainWork owner token", () => {
  const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  const start = scheduler.indexOf("async function maybeRunPhase2HistoricalEnumeration");
  const end = scheduler.indexOf("async function maybeBackfillProviderOperationalDebt", start);
  assert.ok(start >= 0 && end > start);
  const body = scheduler.slice(start, end);
  assert.match(body, /markPhase2CoverageFailed\(\{ db, workItem: item, ownerToken: claim\.ownerToken,/);
});

test("F54-01 creator-scoped raw claim is fail-closed without tenant agency scope", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const fx = productionDb(now);
  await assert.rejects(authority.claimDomainWorkBatch({ db: fx.db, workClass: authority.WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
    creatorIds: ["creator-1"], ownerToken: "scoped-no-agency", fallbackNow: now }),
  (error) => error?.code === "DOMAIN_WORK_SCOPED_AGENCY_REQUIRED");
});
