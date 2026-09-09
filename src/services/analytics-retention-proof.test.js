"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const servicePath = path.join(__dirname, "retention-service.js");
const migrationPath = path.join(__dirname, "..", "..", "prisma", "migrations", "20260908190000_analytics_observation_authority", "migration.sql");
const schemaPath = path.join(__dirname, "..", "..", "prisma", "schema.prisma");
const collectionMigrationPath = path.join(__dirname, "..", "..", "prisma", "migrations", "20260908224500_analytics_collection_control_convergence", "migration.sql");
const distributedClosureMigrationPath = path.join(__dirname, "..", "..", "prisma", "migrations", "20260909113000_distributed_collection_retention_runtime_closure", "migration.sql");
const schedulerPath = path.join(__dirname, "job-scheduler.js");

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

test("analytics execution retention separates canonical proof from bounded operational histories", async () => {
  const sqlCalls = [];
  const deletedByCall = [3, 2, 1, 4, 5, 6, 4, 2, 5];
  const prisma = {
    systemSetting: { findUnique: async () => null },
    $executeRawUnsafe: async (sql, cutoff, batchSize) => {
      const index = sqlCalls.length;
      sqlCalls.push({ sql, cutoff, batchSize });
      return deletedByCall[index] || 0;
    },
  };
  const retention = loadRetention(prisma);
  const result = await retention.runAnalyticsExecutionRetentionSweep({
    batchSize: 100,
    analyticsIngestBatchDays: 30,
    analyticsJobInstanceDays: 30,
    analyticsDemandHistoryDays: 90,
    analyticsSupersededScanProofDays: 30,
    analyticsNonEarningsJobDays: 30,
    analyticsNonEarningsIngestBatchDays: 30,
    analyticsNotificationScanAuditDays: 30,
  });

  assert.equal(result.label, "analyticsExecution");
  assert.equal(result.totalDeleted, deletedByCall.reduce((sum, value) => sum + value, 0));
  assert.equal(sqlCalls.length, 9);

  assert.match(sqlCalls[0].sql, /DELETE FROM "AnalyticsIngestBatch"/);
  assert.match(sqlCalls[0].sql, /JOIN "AnalyticsScanProof"/);
  assert.match(sqlCalls[0].sql, /p\."scanRunId" = substring/);

  assert.match(sqlCalls[1].sql, /DELETE FROM "JobInstance"/);
  assert.match(sqlCalls[1].sql, /candidate\."jobKey" = 'fetch_earnings'/);
  assert.match(sqlCalls[1].sql, /EXISTS \([\s\S]*"AnalyticsScanProof"/);
  assert.match(sqlCalls[1].sql, /"CreatorEarningsDaily"[\s\S]*"scanProofId" IS NULL/);

  assert.match(sqlCalls[2].sql, /fetch_earnings/);
  assert.match(sqlCalls[2].sql, /NOT EXISTS \(SELECT 1 FROM "AnalyticsScanProof"/);
  assert.match(sqlCalls[2].sql, /FAILED/);

  assert.match(sqlCalls[3].sql, /DELETE FROM "CreatorNotificationScanItem"/);
  assert.match(sqlCalls[3].sql, /candidate\."createdAt" < \$1/);
  assert.match(sqlCalls[3].sql, /source_job\."id" = candidate\."sourceJobId"/);
  assert.match(sqlCalls[3].sql, /source_job\."status" IN \('DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED'\)/);

  assert.match(sqlCalls[4].sql, /DELETE FROM "AnalyticsIngestBatch"/);
  assert.match(sqlCalls[4].sql, /candidate\."dataType" IN/);
  assert.match(sqlCalls[4].sql, /'FINANCIAL_TRANSACTIONS'::"AnalyticsDataType"/);
  assert.match(sqlCalls[4].sql, /candidate\."sourceJobId" IS NULL/);
  assert.match(sqlCalls[4].sql, /source_job\."status" IN \('DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED'\)/);
  assert.doesNotMatch(sqlCalls[4].sql, /baselineVerifiedAt|fullBackfillCompletedAt/);

  assert.match(sqlCalls[5].sql, /DELETE FROM "JobInstance"/);
  assert.match(sqlCalls[5].sql, /financial_transactions_scan/);
  assert.doesNotMatch(sqlCalls[5].sql, /CreatorFinancialCollectionState|CreatorCampaignCollectionState|CreatorNotificationSyncState/);
  assert.match(sqlCalls[5].sql, /candidate\."status" IN \('DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED'\)/);
  assert.match(sqlCalls[5].sql, /NOT EXISTS \([\s\S]*"CreatorNotificationScanItem" scan_item[\s\S]*scan_item\."sourceJobId" = candidate\."id"/);

  assert.match(sqlCalls[6].sql, /DELETE FROM "AnalyticsCollectionDemand"/);
  assert.match(sqlCalls[6].sql, /candidate\."completedAt" IS NOT NULL/);
  assert.match(sqlCalls[6].sql, /pg_try_advisory_xact_lock\(hashtext\('analytics-demand:' \|\| candidate\."key"\)\)/);
  assert.match(sqlCalls[6].sql, /d\."completedAt" IS NOT NULL/);
  assert.equal(sqlCalls[6].cutoff.getTime() < Date.now() - 80 * 24 * 60 * 60 * 1000, true);

  assert.match(sqlCalls[7].sql, /DELETE FROM "AnalyticsCollectionDemand"/);
  assert.match(sqlCalls[7].sql, /candidate\."completedAt" IS NULL/);
  assert.match(sqlCalls[7].sql, /candidate\."quarantinedAt" IS NOT NULL/);
  assert.match(sqlCalls[7].sql, /candidate\."quarantinedAt" < \$1/);
  assert.match(sqlCalls[7].sql, /candidate\."claimToken" IS NULL/);
  assert.match(sqlCalls[7].sql, /pg_try_advisory_xact_lock\(hashtext\('analytics-demand:' \|\| candidate\."key"\)\)/);
  assert.match(sqlCalls[7].sql, /d\."quarantinedAt" IS NOT NULL/);
  assert.match(sqlCalls[7].sql, /ORDER BY candidate\."quarantinedAt" ASC, candidate\."key" ASC/);

  assert.match(sqlCalls[8].sql, /DELETE FROM "AnalyticsScanProof"/);
  assert.match(sqlCalls[8].sql, /NOT EXISTS \([\s\S]*"CreatorEarningsDaily"/);
  assert.match(sqlCalls[8].sql, /NOT EXISTS \([\s\S]*"AnalyticsCoverage"/);
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


test("non-earnings and failed-job retention has deterministic indexed terminal-age access paths", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");
  assert.match(schema, /@@index\(\[jobKey, status, updatedAt, id\], map: "JobInstance_analytics_terminal_updated_retention_idx"\)/);
  assert.match(schema, /@@index\(\[createdAt, id\], map: "CreatorNotificationScanItem_retention_idx"\)/);
  assert.match(schema, /@@index\(\[dataType, completedAt, id\], map: "AnalyticsIngestBatch_retention_idx"\)/);

  const sql = fs.readFileSync(collectionMigrationPath, "utf8");
  assert.match(sql, /JobInstance_analytics_terminal_updated_retention_idx/);
  assert.match(sql, /CreatorNotificationScanItem_retention_idx/);
  assert.match(sql, /AnalyticsIngestBatch_retention_idx/);

  const source = fs.readFileSync(servicePath, "utf8");
  assert.doesNotMatch(source, /COALESCE\(candidate\."completedAt", candidate\."updatedAt"\)/);
  assert.match(source, /candidate\."updatedAt" < \$1/);
  assert.match(source, /ORDER BY candidate\."updatedAt" ASC, candidate\."id" ASC/);
  assert.match(source, /candidate\."sourceJobId" IS NULL/);
  assert.match(source, /source_job\."status" IN \('DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED'\)/);
  assert.doesNotMatch(source, /candidate\."dataType" = 'CAMPAIGNS'[\s\S]{0,300}baselineVerifiedAt/);
  const nonEarningsJobBlockStart = source.indexOf('candidate."jobKey" IN (\'catchup_notifications_scan\', \'financial_transactions_scan\', \'fetch_campaigns\')');
  assert.ok(nonEarningsJobBlockStart >= 0);
  const nonEarningsJobBlock = source.slice(nonEarningsJobBlockStart, nonEarningsJobBlockStart + 1200);
  assert.doesNotMatch(nonEarningsJobBlock, /baselineVerifiedAt|fullBackfillCompletedAt|CreatorFinancialCollectionState|CreatorCampaignCollectionState|CreatorNotificationSyncState/);
  assert.match(nonEarningsJobBlock, /CreatorNotificationScanItem/);
  assert.match(nonEarningsJobBlock, /scan_item\."sourceJobId" = candidate\."id"/);
  assert.match(source, /analyticsDemandHistoryDays:[\s\S]*ONLINOD_ANALYTICS_DEMAND_HISTORY_DAYS/);
  assert.match(source, /analyticsCollectionDemand\.quarantined_/);
});

test("collection-control migration never upgrades ambiguous Campaign coverage into durable COMPLETE proof", () => {
  const sql = fs.readFileSync(collectionMigrationPath, "utf8");
  const start = sql.indexOf('INSERT INTO "CreatorCampaignCollectionState"');
  const end = sql.indexOf('UPDATE "CreatorCampaignCollectionState"', start);
  const campaignBackfill = sql.slice(start, end > start ? end : undefined);
  assert.match(campaignBackfill, /JOIN "AnalyticsIngestBatch" b/);
  assert.match(campaignBackfill, /b\."status" = 'COMMITTED'/);
  assert.match(campaignBackfill, /b\."completedAt" IS NOT NULL/);
  assert.match(campaignBackfill, /JOIN "JobInstance" j/);
  assert.match(campaignBackfill, /j\."status" = 'DONE'/);
  assert.match(campaignBackfill, /j\."completedAt" IS NOT NULL/);
  assert.doesNotMatch(campaignBackfill, /LEFT JOIN "AnalyticsIngestBatch"/);
  assert.doesNotMatch(campaignBackfill, /COALESCE\(b\."completedAt", b\."startedAt", c\."updatedAt"\)/);
});

test("notification catchup verification migration never upgrades a legacy partial catchup later marked COMPLETE by realtime", () => {
  const sql = fs.readFileSync(collectionMigrationPath, "utf8");
  const marker = 'SET "lastCatchupVerifiedAt" = "lastCatchupCompletedAt"';
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, "notification catchup verification backfill must exist");
  const block = sql.slice(start, start + 500);
  assert.match(block, /"lastCatchupCompletedAt" IS NOT NULL/);
  assert.match(block, /"status" = 'COMPLETE'::"AnalyticsCoverageStatus"/);
  assert.match(block, /"lastErrorCode" IS NULL/);
});

test("notification sync state stores server collection generation separately from legacy scan identity", () => {
  const sql = fs.readFileSync(collectionMigrationPath, "utf8");
  const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
  assert.match(sql, /ALTER TABLE "CreatorNotificationSyncState"[\s\S]*"activeGeneration" TEXT[\s\S]*"activeRequestedAt" TIMESTAMP\(3\)[\s\S]*"retryAfterAt" TIMESTAMP\(3\)/);
  assert.match(schema, /model CreatorNotificationSyncState \{[\s\S]*activeGeneration\s+String\?[\s\S]*activeRequestedAt\s+DateTime\?[\s\S]*retryAfterAt\s+DateTime\?/);
});

test("collection-control migration retires only unfinished pre-v1 Financial/Campaign/Notification jobs that cannot satisfy the new command contract", () => {
  const sql = fs.readFileSync(collectionMigrationPath, "utf8");
  const marker = "retired_analytics_collection_contract_pre_v1";
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, "legacy collection-job retirement must exist");
  const blockStart = sql.lastIndexOf('UPDATE "JobInstance"', start);
  const block = sql.slice(blockStart, start + 1200);
  assert.match(block, /"jobKey" IN \('financial_transactions_scan', 'fetch_campaigns', 'catchup_notifications_scan'\)/);
  assert.match(block, /"status" IN \('SCHEDULED', 'CLAIMED', 'PAUSED'\)/);
  assert.match(block, /COALESCE\("params"->>'collectionContractVersion', ''\) <> '1'/);
  assert.match(block, /"status" = 'CANCELLED'/);
  assert.match(block, /"leaseRevision" = "leaseRevision" \+ 1/);
  assert.doesNotMatch(block, /"status" IN \('DONE'/);
});


test("distributed closure migration adopts legacy analytics ordering onto DB-owned job creation time", () => {
  const sql = fs.readFileSync(distributedClosureMigrationPath, "utf8");
  assert.match(sql, /CREATE TABLE "RetentionSweepLease"/);
  assert.match(sql, /\{authorityRequestedAt\}/);
  assert.match(sql, /\{collectionAuthorityRequestedAt\}/);
  assert.match(sql, /to_jsonb\(to_char\("createdAt"/);
  assert.match(sql, /UPDATE "CreatorFinancialCollectionState" AS s[\s\S]*s\."sourceJobId" = j\."id"[\s\S]*activeGeneration/);
  assert.match(sql, /UPDATE "CreatorCampaignCollectionState" AS s/);
  assert.match(sql, /UPDATE "CreatorNotificationSyncState" AS s/);
  assert.match(sql, /UPDATE "CreatorEarningsDaily" AS d[\s\S]*d\."sourceJobId" = j\."id"/);
  assert.match(sql, /clock_timestamp\(\) - INTERVAL '1 millisecond'/);
  // Source-window adoption must never rewrite an already CLAIMED contract under
  // the same lease. CLAIMED work is fenced and restarted. PAUSED work must keep
  // the operator pause while dropping stale traversal state so a later explicit
  // resume starts from the DB-owned boundary. Earnings calendar windows are
  // recomputed by the planner instead of SQL guessing.
  const financialStart = sql.indexOf(`WHERE "jobKey" = 'financial_transactions_scan'\n  AND "status" = 'SCHEDULED';`);
  const financialEnd = sql.indexOf(`WHERE "jobKey" = 'catchup_notifications_scan'\n  AND "status" = 'SCHEDULED';`);
  assert.ok(financialStart >= 0 && financialEnd > financialStart, "financial adoption blocks must exist");
  const financialBlocks = sql.slice(financialStart, financialEnd);
  assert.match(financialBlocks, /"status" = 'SCHEDULED'[\s\S]*WHERE "jobKey" = 'financial_transactions_scan'[\s\S]*"status" = 'CLAIMED'/);
  assert.match(financialBlocks, /"leaseRevision" = "leaseRevision" \+ 1/);
  const financialPaused = financialBlocks.slice(financialBlocks.indexOf("-- A PAUSED job"));
  assert.match(financialPaused, /WHERE "jobKey" = 'financial_transactions_scan'\n  AND "status" = 'PAUSED';/);
  assert.match(financialPaused, /"continuation" = NULL[\s\S]*"progress" = NULL/);
  assert.match(financialPaused, /analytics_db_time_contract_adopted_paused/);
  assert.doesNotMatch(financialPaused, /SET "status" = 'SCHEDULED'/);

  const notificationStart = sql.indexOf(`WHERE "jobKey" = 'catchup_notifications_scan'\n  AND "status" = 'SCHEDULED';`);
  const earningsStart = sql.indexOf("-- Earnings ranges are calendar windows computed by the planner");
  assert.ok(notificationStart >= 0 && earningsStart > notificationStart, "notification adoption blocks must exist");
  const notificationBlocks = sql.slice(notificationStart, earningsStart);
  assert.match(notificationBlocks, /"status" = 'SCHEDULED'[\s\S]*WHERE "jobKey" = 'catchup_notifications_scan'[\s\S]*"status" = 'CLAIMED'/);
  assert.match(notificationBlocks, /"leaseRevision" = "leaseRevision" \+ 1/);
  const notificationPaused = notificationBlocks.slice(notificationBlocks.indexOf("UPDATE \"JobInstance\"", notificationBlocks.indexOf("AND \"status\" = 'CLAIMED'")));
  assert.match(notificationPaused, /WHERE "jobKey" = 'catchup_notifications_scan'\n  AND "status" = 'PAUSED';/);
  assert.match(notificationPaused, /"continuation" = NULL[\s\S]*"progress" = NULL/);
  assert.match(notificationPaused, /analytics_db_time_contract_adopted_paused/);
  assert.doesNotMatch(notificationPaused, /SET "status" = 'SCHEDULED'/);

  assert.match(sql, /"jobKey" = 'fetch_earnings'[\s\S]*"status" IN \('SCHEDULED', 'CLAIMED', 'PAUSED'\)[\s\S]*"status" = 'CANCELLED'/);
  assert.match(sql, /UPDATE "AnalyticsCollectionLease"[\s\S]*"leaseUntil" = clock_timestamp\(\) - INTERVAL '1 millisecond'[\s\S]*"leaseUntil" > clock_timestamp\(\) \+ INTERVAL '20 minutes'/);
});

test("retention coordinator is durable, fail-closed and uses one DB-authority cutoff clock", () => {
  const source = fs.readFileSync(servicePath, "utf8");
  const schema = fs.readFileSync(schemaPath, "utf8");
  assert.match(schema, /model RetentionSweepLease[\s\S]*ownerToken\s+String[\s\S]*leaseUntil\s+DateTime[\s\S]*completedAt\s+DateTime\?/);
  assert.match(source, /RETENTION_COORDINATION_SCHEMA_UNAVAILABLE/);
  assert.match(source, /reason: "coordination_failed"/);
  assert.match(source, /db_lease_failed_closed/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /renewRetentionSweepLease/);
  assert.match(source, /const authorityNow = lease\?\.startedAt instanceof Date \? lease\.startedAt : sweepNow\(options\)/);
  assert.match(source, /const laneOptions = \{ \.\.\.options, authorityNow \}/);
  assert.doesNotMatch(source, /pg_try_advisory_lock\(/);
  assert.doesNotMatch(source, /pg_advisory_unlock\(/);
});



test("scheduler never uses process-local wall clock as retention cadence authority", () => {
  const scheduler = fs.readFileSync(schedulerPath, "utf8");
  const start = scheduler.indexOf("async function maybeRunRetentionSweep");
  const end = scheduler.indexOf("\nasync function ", start + 1);
  const block = scheduler.slice(start, end > start ? end : undefined);
  assert.ok(start >= 0);
  assert.match(block, /runRetentionSweep\(\{ minIntervalMs: force \? 0 : retentionWindowMs \}\)/);
  assert.doesNotMatch(block, /lastRetentionSweepAt/);
  assert.doesNotMatch(block, /reason:\s*"fresh"/);
  assert.match(block, /Date\.now\(\) - startedAt/, "process clock may remain observability-only for duration logging");
});
test("durable retention lease serializes replicas, reclaims expiry and fences stale owners", async () => {
  let authorityNow = new Date("2026-09-09T09:00:00.000Z");
  let row = null;
  const db = {
    async $transaction(work) { return work(this); },
    async $executeRawUnsafe(sql, key) {
      assert.match(String(sql), /pg_advisory_xact_lock/);
      assert.equal(key, "retention-sweep-coordinator");
      return 1;
    },
    async $queryRawUnsafe(sql) {
      assert.match(String(sql), /clock_timestamp\(\)/);
      return [{ authorityNow }];
    },
    retentionSweepLease: {
      async findUnique() { return row ? { ...row } : null; },
      async upsert({ create, update }) {
        row = row ? { ...row, ...update } : { ...create };
        return { ...row };
      },
      async updateMany({ where, data }) {
        if (!row || row.key !== where.key || row.ownerToken !== where.ownerToken || row.completedAt !== null) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
    },
  };
  const retention = loadRetention(db);

  const first = await retention.claimRetentionSweepLease({ db, ownerToken: "replica-a", leaseMs: 60_000 });
  assert.equal(first.acquired, true);
  assert.equal(first.startedAt.toISOString(), "2026-09-09T09:00:00.000Z");

  authorityNow = new Date("2026-09-09T09:00:30.000Z");
  const held = await retention.claimRetentionSweepLease({ db, ownerToken: "replica-b", leaseMs: 60_000 });
  assert.equal(held.acquired, false);
  assert.equal(held.reason, "lease_held");
  assert.equal(held.ownerToken, "replica-a");

  authorityNow = new Date("2026-09-09T09:01:01.000Z");
  const reclaimed = await retention.claimRetentionSweepLease({ db, ownerToken: "replica-b", leaseMs: 60_000 });
  assert.equal(reclaimed.acquired, true);
  assert.equal(row.ownerToken, "replica-b");

  await assert.rejects(
    retention.renewRetentionSweepLease({ db, ownerToken: "replica-a", leaseMs: 60_000 }),
    (error) => error?.code === "RETENTION_COORDINATION_OWNERSHIP_LOST"
  );
  const renewed = await retention.renewRetentionSweepLease({ db, ownerToken: "replica-b", leaseMs: 60_000 });
  assert.equal(renewed.renewed, true);
  assert.equal(await retention.finalizeRetentionSweepLease({ db, ownerToken: "replica-a", outcome: "COMPLETE" }), false);

  authorityNow = new Date("2026-09-09T09:01:10.000Z");
  assert.equal(await retention.finalizeRetentionSweepLease({ db, ownerToken: "replica-b", outcome: "COMPLETE" }), true);
  assert.equal(row.completedAt.toISOString(), authorityNow.toISOString());
  assert.equal(row.lastOutcome, "COMPLETE");

  authorityNow = new Date("2026-09-09T09:30:00.000Z");
  const tooSoon = await retention.claimRetentionSweepLease({ db, ownerToken: "replica-c", leaseMs: 60_000, minIntervalMs: 60 * 60 * 1000 });
  assert.equal(tooSoon.acquired, false);
  assert.equal(tooSoon.reason, "recently_completed");
  assert.equal(tooSoon.completedAt.toISOString(), "2026-09-09T09:01:10.000Z");
  assert.equal(tooSoon.nextDueAt.toISOString(), "2026-09-09T10:01:10.000Z");

  authorityNow = new Date("2026-09-09T10:01:11.000Z");
  const nextCycle = await retention.claimRetentionSweepLease({ db, ownerToken: "replica-c", leaseMs: 60_000, minIntervalMs: 60 * 60 * 1000 });
  assert.equal(nextCycle.acquired, true);
  assert.equal(row.ownerToken, "replica-c");
});
