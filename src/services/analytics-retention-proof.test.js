"use strict";
const { withTransactionClient } = require("../../scripts/test-support/transaction-client-fixture");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const servicePath = path.join(__dirname, "retention-service.js");
const migrationPath = path.join(__dirname, "..", "..", "prisma", "migrations", "20261009000000_current_baseline", "migration.sql");
const schemaPath = path.join(__dirname, "..", "..", "prisma", "schema.prisma");
const collectionMigrationPath = path.join(__dirname, "..", "..", "prisma", "migrations", "20261009000000_current_baseline", "migration.sql");
const distributedClosureMigrationPath = path.join(__dirname, "..", "..", "prisma", "migrations", "20261009000000_current_baseline", "migration.sql");
const schedulerPath = path.join(__dirname, "job-scheduler.js");

function loadRetention(prismaMock) {
  withTransactionClient(prismaMock);
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












test("non-earnings and failed-job retention has deterministic indexed terminal-age access paths", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");
  assert.match(schema, /@@index\(\[jobKey, status, updatedAt, id\], map: "JobInstance_analytics_terminal_updated_retention_idx"\)/);
  assert.match(schema, /@@index\(\[createdAt, id\], map: "CreatorNotificationScanItem_retention_idx"\)/);
  assert.match(schema, /@@index\(\[dataType, completedAt, id\], map: "AnalyticsIngestBatch_retention_idx"\)/);

  const sql = fs.readFileSync(collectionMigrationPath, "utf8");
  assert.match(sql, /JobInstance_analytics_terminal_updated_retention_idx/);
  assert.match(sql, /CreatorNotificationScanItem_retention_idx/);
  assert.match(sql, /AnalyticsIngestBatch_retention_idx/);

  const source = fs.readFileSync(path.join(__dirname, "retention-policy-definition.js"), "utf8") + fs.readFileSync(servicePath, "utf8");
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












test("retention coordinator is durable, fail-closed and uses one DB-authority cutoff clock", () => {
  const source = fs.readFileSync(path.join(__dirname, "retention-policy-definition.js"), "utf8") + fs.readFileSync(servicePath, "utf8");
  const schema = fs.readFileSync(schemaPath, "utf8");
  assert.match(schema, /model RetentionSweepLease[\s\S]*ownerToken\s+String[\s\S]*leaseUntil\s+DateTime[\s\S]*completedAt\s+DateTime\?/);
  assert.match(source, /RETENTION_COORDINATION_SCHEMA_UNAVAILABLE/);
  assert.match(source, /reason: "coordination_failed"/);
  assert.match(source, /db_lease_failed_closed/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /renewRetentionSweepLease/);
  assert.match(source, /const authorityNow = lease\?\.startedAt instanceof Date \? lease\.startedAt : sweepNow\(options\)/);
  assert.match(source, /const laneOptions = \{ \.\.\.options, authorityNow, retentionOwnerToken: lease\?\.acquired \? lease.ownerToken : null \}/);
  assert.match(source, /commitGuard: options.retentionOwnerToken \? async tx => [\s\S]*?options.actorGuard[\s\S]*?await lockRetentionCommit/);
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
      if (String(sql).includes('FROM "RetentionSweepLease"')) { assert.match(String(sql), /FOR UPDATE$/); return row ? [{key:row.key}] : []; }
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
        if (!row || row.key !== where.key || row.ownerToken !== where.ownerToken || row.completedAt !== null || (where.leaseUntil?.gt && row.leaseUntil <= where.leaseUntil.gt)) return { count: 0 };
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
