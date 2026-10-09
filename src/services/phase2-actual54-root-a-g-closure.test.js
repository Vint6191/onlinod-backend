"use strict";
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const authority = require("./domain-work-authority-service");
const release = require("./database-write-contract-service");
const { coveragePreflightPasses, runCoveragePreflight } = require("../../scripts/audit/phase2-coverage-preflight-readonly");
const {
  COVERAGE_MANIFEST_VERSION, COVERAGE_SEED_LANE_KEY, COVERAGE_SEED_GENERATION, COVERAGE_MANIFEST, coverageManifestFingerprint,
} = require("./phase2-coverage-manifest");

function productionDb(now) {
  const sql = [];
  let agencySelections = 0;
  let shardSelections = 0;
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; } },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    async $transaction(work) { return work({ ...(db), $transaction: undefined }); },
    async $queryRawUnsafe(statement, ...params) {
      const text = String(statement); sql.push(text);
      if (text.includes('FROM "DomainWorkClaimTopologyState"') && text.includes("FOR SHARE")) {
        return [{ generation: authority.DOMAIN_WORK_CLAIM_TOPOLOGY_ID, activationState: "ACTIVE" }];
      }
      if (text.includes('FROM "Phase2ReleaseCompatibilityAuthority"') && text.includes("FOR SHARE")) {
        return [{ requiredGeneration: release.DOMAIN_WORK_EXECUTOR_GENERATION, activationState: "ACTIVE" }];
      }
      if (text.includes("set_config")) return [{ value: params[1] }];
      if (text.trim() === 'SELECT clock_timestamp() AS "authorityNow"') return [{ authorityNow: now }];
      if (text.includes('UPDATE "DomainWorkClaimAgencyState" a') && text.includes('RETURNING a."agencyId"')) {
        agencySelections += 1;
        return agencySelections === 1 ? [{ agencyId: "agency-1" }] : [];
      }
      if (text.includes('UPDATE "DomainWorkClaimShardState" s') && text.includes('RETURNING s."claimShard"')) {
        shardSelections += 1;
        return shardSelections === 1 ? [{ claimShard: 3 }] : [];
      }
      if (text.includes('SELECT f."partitionKey"') && text.includes('FROM "Phase2WorkBroadClaimPartitionState" f')) {
        return [{ partitionKey: "creator-1" }];
      }
      return [];
    },
  };
  return { db: commitDatabaseFixture(db), sql };
}

test("F54-01/F55-01 creator-scoped claim is direct DWI admission with no ready-head/advisory dependency", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const fx = productionDb(now);
  await authority.claimDomainWorkBatch({
    db: commitDatabaseFixture(fx.db), workClass: authority.WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
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

test("A36 broad claim rotates bounded Agency and shard locators without a hot-prefix workset scan", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const fx = productionDb(now);
  await authority.claimDomainWorkBatch({
    db: commitDatabaseFixture(fx.db), workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
    ownerToken: "broad-worker", limit: 25, perAgencyQuantum: 5, perPartitionQuantum: 2, fallbackNow: now,
  });
  const agencyDispatch = fx.sql.find((entry) => entry.includes('UPDATE "DomainWorkClaimAgencyState" a'));
  const shardDispatch = fx.sql.find((entry) => entry.includes('UPDATE "DomainWorkClaimShardState" s'));
  const partitionDispatch = fx.sql.find((entry) => entry.includes('SELECT f."partitionKey"') && entry.includes('FROM "Phase2WorkBroadClaimPartitionState" f'));
  const claimSql = fx.sql.find((entry) => entry.includes('WITH selected_partitions("partitionKey") AS MATERIALIZED'));
  assert.ok(agencyDispatch);
  assert.ok(shardDispatch);
  assert.ok(partitionDispatch);
  assert.ok(claimSql);
  assert.doesNotMatch(agencyDispatch, /EXISTS \([\s\S]*FROM "DomainWorkItem" d/);
  assert.match(agencyDispatch, /ORDER BY a\."nextDispatchAt",a\."revision",a\."agencyId"/);
  assert.match(shardDispatch, /ORDER BY s\."nextDispatchAt",s\."revision",s\."claimShard"/);
  assert.doesNotMatch(fx.sql.join("\n"), /FROM "Phase2WorkFamilyState" s/);
  assert.match(partitionDispatch, /f\."claimShard"=\$5/);
  assert.match(partitionDispatch, /ORDER BY f\."nextClaimableAt",f\."revision",f\."partitionKey"/);
  assert.match(claimSql, /FOR UPDATE OF d SKIP LOCKED[\s\S]*LIMIT \$5/);
  assert.doesNotMatch(claimSql, /row_number\(\)/i);
  assert.doesNotMatch(claimSql, /partition_heads|DISTINCT ON \(d\."partitionKey"\)/);
  assert.doesNotMatch(claimSql, /LIMIT 4096/i);
  assert.doesNotMatch(claimSql, /DomainWorkReadyAgency|DomainWorkReadyPartition/);
  assert.doesNotMatch(fx.sql.join("\n"), /phase2_lock_domain_work_agency_head/);
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
  await assert.rejects(authority.claimDomainWorkBatch({ db: commitDatabaseFixture(fx.db), workClass: authority.WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
    creatorIds: ["creator-1"], ownerToken: "scoped-no-agency", fallbackNow: now }),
  (error) => error?.code === "DOMAIN_WORK_SCOPED_AGENCY_REQUIRED");
});
