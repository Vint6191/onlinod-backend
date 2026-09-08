"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const servicePath = path.join(__dirname, "retention-service.js");
const migrationPath = path.join(__dirname, "..", "..", "prisma", "migrations", "20260908190000_analytics_observation_authority", "migration.sql");
const schemaPath = path.join(__dirname, "..", "..", "prisma", "schema.prisma");

function loadRetention(prismaMock) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../prisma") return prismaMock;
    if (request === "./team-ppv-ledger-service") return { gcTeamLedgers: async () => ({ deleted: 0 }) };
    if (request === "./automation-history-service") return { compactAutomationDeliveries: async () => ({ deleted: 0 }) };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(servicePath)];
    return require(servicePath);
  } finally {
    Module._load = original;
  }
}

test("analytics execution retention deletes only history backed by durable scan proof", async () => {
  const sqlCalls = [];
  const prisma = {
    systemSetting: { findUnique: async () => null },
    $executeRawUnsafe: async (sql, cutoff, batchSize) => {
      sqlCalls.push({ sql, cutoff, batchSize });
      return sqlCalls.length === 1 ? 3
        : sqlCalls.length === 2 ? 2
          : sqlCalls.length === 3 ? 4
            : sqlCalls.length === 4 ? 5
              : 0;
    },
  };
  const retention = loadRetention(prisma);
  const result = await retention.runAnalyticsExecutionRetentionSweep({
    batchSize: 100,
    analyticsIngestBatchDays: 30,
    analyticsJobInstanceDays: 30,
    analyticsSupersededScanProofDays: 30,
  });

  assert.equal(result.label, "analyticsExecution");
  assert.equal(result.totalDeleted, 14);
  assert.equal(sqlCalls.length, 4);
  assert.match(sqlCalls[0].sql, /DELETE FROM "AnalyticsIngestBatch"/);
  assert.match(sqlCalls[0].sql, /JOIN "AnalyticsScanProof"/);
  assert.match(sqlCalls[0].sql, /p\."scanRunId" = substring/);
  assert.match(sqlCalls[1].sql, /DELETE FROM "JobInstance"/);
  assert.match(sqlCalls[1].sql, /candidate\."jobKey" = 'fetch_earnings'/);
  assert.match(sqlCalls[1].sql, /EXISTS \([\s\S]*"AnalyticsScanProof"/);
  assert.match(sqlCalls[1].sql, /"CreatorEarningsDaily"[\s\S]*"scanProofId" IS NULL/);
  assert.match(sqlCalls[1].sql, /"AnalyticsCoverage"[\s\S]*c\."scanProofId" IS NULL/);
  assert.match(sqlCalls[2].sql, /DELETE FROM "AnalyticsCollectionDemand"/);
  assert.match(sqlCalls[2].sql, /candidate\."completedAt" IS NOT NULL/);
  assert.match(sqlCalls[2].sql, /candidate\."claimToken" IS NULL/);
  assert.match(sqlCalls[3].sql, /DELETE FROM "AnalyticsScanProof"/);
  assert.match(sqlCalls[3].sql, /candidate\."createdAt" < \$1/);
  assert.match(sqlCalls[3].sql, /NOT EXISTS \([\s\S]*"CreatorEarningsDaily"[\s\S]*d\."scanProofId" = candidate\."id"/);
  assert.match(sqlCalls[3].sql, /NOT EXISTS \([\s\S]*"AnalyticsCoverage"[\s\S]*c\."scanProofId" = candidate\."id"/);
});

test("analytics durable proof schema is intentionally independent from JobInstance lifetime", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");
  const proofStart = schema.indexOf("model AnalyticsScanProof");
  const proofEnd = schema.indexOf("\nmodel ", proofStart + 10);
  const proof = schema.slice(proofStart, proofEnd > proofStart ? proofEnd : undefined);
  assert.match(proof, /sourceJobId\s+String\?/);
  assert.doesNotMatch(proof, /sourceJob\s+JobInstance/);
  assert.match(proof, /scanRunId/);
  assert.match(proof, /scanFrom/);
  assert.match(proof, /scanTo/);
  assert.match(proof, /serverReceivedAt/);
  assert.match(proof, /committedAt/);
  assert.match(proof, /@@index\(\[createdAt, id\], map: "AnalyticsScanProof_createdAt_id_idx"\)/);

  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE INDEX "AnalyticsScanProof_createdAt_id_idx" ON "AnalyticsScanProof"\("createdAt", "id"\)/);
});

test("analytics migration backfills durable proof only from canonical earnings ingest evidence", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /INSERT INTO "AnalyticsScanProof"/);
  assert.match(sql, /FROM "AnalyticsIngestBatch" b/);
  assert.match(sql, /LEFT JOIN "JobInstance" j ON j\."id" = b\."sourceJobId"/);
  assert.match(sql, /b\."dataType" = 'EARNINGS'/);
  assert.match(sql, /b\."status"/);
  assert.match(sql, /completion:v4/);
  assert.doesNotMatch(sql, /CreatorEarningsSnapshot/);
  assert.match(sql, /UPDATE "CreatorEarningsDaily" d[\s\S]*"scanProofId"/);
  assert.match(sql, /UPDATE "AnalyticsCoverage" c[\s\S]*"scanProofId"/);
});


test("analytics recurring sweep coordination is durable and has no business-data relation", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");
  const start = schema.indexOf("model AnalyticsCollectionLease");
  const end = schema.indexOf("\nmodel ", start + 10);
  assert.ok(start >= 0, "AnalyticsCollectionLease model must exist");
  const lease = schema.slice(start, end > start ? end : undefined);
  assert.match(lease, /ownerToken\s+String/);
  assert.match(lease, /cycleKey\s+String/);
  assert.match(lease, /cycleNow\s+DateTime/);
  assert.match(lease, /cursorCreatorId\s+String\?/);
  assert.match(lease, /leaseUntil\s+DateTime/);
  assert.match(lease, /completedAt\s+DateTime\?/);
  assert.doesNotMatch(lease, /@relation/);

  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE "AnalyticsCollectionLease"/);
  assert.match(sql, /AnalyticsCollectionLease_cycle_complete_idx/);
  const leaseSqlStart = sql.indexOf('CREATE TABLE "AnalyticsCollectionLease"');
  const leaseSqlEnd = sql.indexOf('ALTER TABLE "AnalyticsCoverage"', leaseSqlStart);
  const leaseSql = sql.slice(leaseSqlStart, leaseSqlEnd);
  assert.doesNotMatch(leaseSql, /FOREIGN KEY/);
});


test("interactive analytics demand is durable operational work with revision, lease and cursor fences", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");
  const start = schema.indexOf("model AnalyticsCollectionDemand");
  const end = schema.indexOf("\nmodel ", start + 10);
  assert.ok(start >= 0, "AnalyticsCollectionDemand model must exist");
  const demand = schema.slice(start, end > start ? end : undefined);
  assert.match(demand, /coverageFrom\s+DateTime\s+@db\.Date/);
  assert.match(demand, /coverageTo\s+DateTime\s+@db\.Date/);
  assert.match(demand, /requestRevision\s+Int/);
  assert.match(demand, /completedRevision\s+Int/);
  assert.match(demand, /claimedRevision\s+Int\?/);
  assert.match(demand, /claimUntil\s+DateTime\?/);
  assert.match(demand, /cursorCreatorId\s+String\?/);
  assert.doesNotMatch(demand, /@relation/);

  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE "AnalyticsCollectionDemand"/);
  assert.match(sql, /AnalyticsCollectionDemand_due_idx/);
  assert.match(sql, /AnalyticsCollectionDemand_agency_requested_idx/);
  assert.match(sql, /"requestedByMemberId" TEXT NOT NULL/);
  assert.match(sql, /"requestedAccessEpoch" INTEGER NOT NULL/);
});
