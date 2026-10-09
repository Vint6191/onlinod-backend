"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = read("prisma/schema.prisma");
const originalMigration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const coverageTypeMigration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const v2Migration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const v3Migration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const allBackfillMigration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const manualScannerMigration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const service = read("src/services/notification-facts-service.js");
const observation = read("src/services/team-observation-service.js");
const leaseService = read("src/services/job-lease-service.js");
const jobResultService = read("src/services/job-result-service.js");
const scheduler = read("src/services/job-scheduler.js");
const scanControl = read("src/services/notification-scan-control-service.js");
const analyticsOrchestrator = read("src/services/creator-analytics-sync-orchestrator.js");
const strictDates = read("src/services/strict-date-time.js");

function modelBody(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  assert.ok(match, `missing Prisma model ${name}`);
  return match[1];
}

test("notification facts are typed relational tables without JSON business storage", () => {
  for (const name of ["CreatorSale", "CreatorTip", "CreatorSubscriptionEvent"]) {
    const body = modelBody(name);
    assert.doesNotMatch(body, /\bJson\??\b/);
    assert.match(body, /eventFingerprint\s+String/);
    assert.match(body, /fanRecordId\s+String\?\s+@map\("fanId"\)/);
    assert.match(body, /CreatorAccount\s+@relation\(fields: \[agencyId, creatorId\], references: \[agencyId, id\], onDelete: Cascade\)/);
    assert.match(body, /CreatorFan\?\s+@relation\(fields: \[creatorId, fanRecordId\], references: \[creatorId, id\], onDelete: NoAction\)/);
  }
  assert.match(modelBody("CreatorFan"), /@@unique\(\[creatorId, id\], map: "CreatorFan_creatorId_id_key"\)/);
  assert.match(modelBody("CreatorPostLike"), /onlyFansLikeId\s+String\?/);
  assert.match(modelBody("CreatorPostLike"), /@@unique\(\[creatorId, onlyFansLikeId\]\)/);

  const scanItem = modelBody("CreatorNotificationScanItem");
  assert.doesNotMatch(scanItem, /\bJson\??\b/);
  for (const column of [
    "sourceJobId", "scanRunId", "page", "ordinal", "notificationId",
    "sourceType", "sourceSubType", "factType", "occurredAt",
    "fanOnlyFansUserId", "postId", "commentId", "messageId", "amountCents", "currency", "outcome", "reasonCode",
  ]) {
    assert.match(scanItem, new RegExp(`\\b${column}\\b`));
  }
});





test("ingest is version-fenced, transactional, page-oriented and interval-aware", () => {
  assert.match(service, /const SCHEMA_VERSION = 5/);
  assert.match(service, /const COLLECTOR_VERSION = "notifications-history-v8-known-boundary"/);
  assert.match(service, /const ALL_SCHEMA_VERSION = 4/);
  assert.match(service, /const ALL_COLLECTOR_VERSION = "notifications-all-v5"/);
  assert.match(service, /const LEGACY_SCHEMA_VERSION = 3/);
  assert.match(service, /const LEGACY_COLLECTOR_VERSION = "notifications-catchup-v4"/);
  assert.match(service, /schemaVersion === ALL_SCHEMA_VERSION \? "v5" : "v6"/);
  assert.match(service, /notification-facts:\$\{job\.id\}:\$\{batchKey\}:\$\{protocolSuffix\}/);
  assert.match(service, /runDbTransaction/);
  assert.match(service, /createMany\(\{ data: creates\.map/);
  assert.doesNotMatch(service, /analyticsCoverage\.(?:findMany|createMany|updateMany)/);
  assert.match(service, /Notifications are a cursor\/frontier collector/);
  assert.match(service, /onlyFansLikeId/);
  assert.match(service, /`l:\$\{fact\.likeId\}`/);
  assert.match(service, /NOTIFICATION_TIMEZONE_UNSUPPORTED/);
  assert.match(service, /lockCreatorFacts\(tx, job.agencyId, job.creatorId\)/);
  assert.match(read("src/services/creator-fact-write-authority.js"), /pg_advisory_xact_lock/);
  assert.match(service, /NOTIFICATION_FINALIZE_FLAG_REQUIRED/);
  assert.match(service, /NOTIFICATION_COVERAGE_METADATA_INVALID/);
  assert.match(strictDates, /getUTCDate\(\) !== day/);
  assert.match(jobResultService, /notification_facts_page_all/);
  assert.match(jobResultService, /recordNotificationPageProgress/);
  assert.match(jobResultService, /recordNotificationScanItems/);
  assert.match(jobResultService, /notification_facts_page/);
  assert.match(jobResultService, /schemaVersion: chunkResult\.schemaVersion/);
  assert.match(jobResultService, /finalizeCoverage: false/);
});



test("automatic creator scheduling delegates notification history to the strict analytics pipeline", () => {
  const start = scheduler.indexOf("async function scheduleInitialJobsForCreator");
  const end = scheduler.indexOf("async function ensureSingleJob", start);
  assert.ok(start >= 0 && end > start, "scheduleInitialJobsForCreator body not found");
  const body = scheduler.slice(start, end);
  assert.match(body, /ensureInitialCreatorAnalyticsSync/);
  assert.match(body, /ensureRecurringCreatorAnalyticsCatchups/);
  assert.match(body, /if \(!initial\.ready\)[\s\S]*schedulerPlanningResult\(created, skipped, degraded, outcomes\)/);
  assert.ok(body.indexOf("ensureOperationalAnalyticsFreshness") < body.indexOf("ensureInitialCreatorAnalyticsSync"), "canonical earnings refresh must remain independent of another collector bootstrap");
  assert.match(body, /ensureOperationalAnalyticsFreshness/);
  assert.match(body, /includeEarningsFreshness/);
  assert.doesNotMatch(body, /TRACKED_RANGES/);
  assert.doesNotMatch(body, /jobKey:\s*"fetch_earnings"/);
  assert.doesNotMatch(body, /jobKey:\s*"fetch_campaigns"/);
  assert.match(analyticsOrchestrator, /NOTIFICATION_JOB_KEY = "catchup_notifications_scan"/);
  assert.match(analyticsOrchestrator, /analyticsSyncStage:\s*"notifications"/);
  assert.match(analyticsOrchestrator, /analyticsSyncStage:\s*"financial"/);
  assert.match(analyticsOrchestrator, /analyticsSyncStage:\s*"campaigns"/);
  assert.match(scanControl, /manualNotificationScan:\s*true/);
  assert.match(scanControl, /scheduleJobNow/);
  assert.match(scanControl, /pauseCollectorJob\(\{ db, creatorId, jobKey: JOB_KEY, collectorType: COLLECTOR_TYPES.NOTIFICATIONS/);
});

test("completion preserves run identity, publishes durable consequences and proves exact run page receipts", () => {
  const ledgerAt = observation.indexOf("await ingestNotificationFacts");
  const compatibilityAt = observation.indexOf("publishNotificationConsequences({ db, job })");
  assert.ok(ledgerAt >= 0 && compatibilityAt > ledgerAt);
  assert.match(observation, /batchKey: result\?\.batchKey/);
  assert.match(observation, /notificationCommittedPageProof\(db, job, result\)/);
  assert.doesNotMatch(observation, /iterateCanonicalProjectionFacts|for await \(const fact/);
  assert.doesNotMatch(observation, /NOTIFICATION_COMPATIBILITY_LIMIT/);
  assert.match(observation, /collectionCoverageByType/);
  assert.match(observation, /subscriptionRefundIgnored/);
  assert.match(observation, /notification_scan_partial/);
  assert.match(observation, /sourceTraversalComplete/);
  assert.match(observation, /result\?\.sourceExhausted === true/);
  assert.match(leaseService, /job\.jobKey === "catchup_notifications_scan"/);
  assert.match(leaseService, /job\.params\?\.manualNotificationScan === true/);
  assert.match(leaseService, /notification scan completed with rejected facts/);
  assert.match(leaseService, /leaseRevision: \{ increment: 1 \}/);
  assert.match(leaseService, /notification scan scheduled for repair/);
  assert.match(leaseService, /partialTypes/);
  assert.doesNotMatch(leaseService, /const resumeCursors =/);
  assert.doesNotMatch(leaseService, /notificationRepairPass\s*:/);
  assert.match(leaseService, /status: "SCHEDULED"/);
});


test("notification catch-up has one scheduler owner and page ingest does not rebuild disposable daily cache inside the progress transaction", () => {
  assert.match(observation, /creator_analytics_orchestrator_owned/);
  assert.doesNotMatch(observation, /buildJobIdempotencyKey/);
  assert.doesNotMatch(observation, /jobInstance\.create\(/);
  assert.doesNotMatch(service, /rebuildCreatorDailyMetrics|ownsTransactionBoundary/);
  assert.match(service, /notification-fact-receipt-service/);
});
