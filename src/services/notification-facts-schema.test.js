"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = read("prisma/schema.prisma");
const originalMigration = read("prisma/migrations/20260806112000_notification_facts_v1/migration.sql");
const coverageTypeMigration = read("prisma/migrations/20260806130000_notification_coverage_types/migration.sql");
const v2Migration = read("prisma/migrations/20260806140000_notification_facts_v1_audited_v2/migration.sql");
const v3Migration = read("prisma/migrations/20260806160000_notification_facts_v1_audited_v3/migration.sql");
const service = read("src/services/notification-facts-service.js");
const observation = read("src/services/team-observation-service.js");
const leaseService = read("src/services/job-lease-service.js");
const jobResultService = read("src/services/job-result-service.js");
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
    assert.match(body, /CreatorAccount @relation\(fields: \[agencyId, creatorId\], references: \[agencyId, id\], onDelete: Cascade\)/);
    assert.match(body, /CreatorFan\?\s+@relation\(fields: \[creatorId, fanId\], references: \[creatorId, id\], onDelete: NoAction\)/);
  }
  assert.match(modelBody("CreatorFan"), /@@unique\(\[creatorId, id\], map: "CreatorFan_creatorId_id_key"\)/);
});

test("external identities remain traceable without collapsing subscription lifecycle events", () => {
  for (const name of ["CreatorSale", "CreatorTip", "CreatorSubscriptionEvent"]) {
    const body = modelBody(name);
    assert.match(body, /@@unique\(\[creatorId, eventFingerprint\]\)/);
    assert.match(body, /@@unique\(\[creatorId, externalNotificationId\]\)/);
    assert.match(body, /sourceDeviceId\s+String\?/);
    assert.match(body, /sourceJobId\s+String\?/);
  }
  assert.match(modelBody("CreatorSale"), /@@unique\(\[creatorId, externalTransactionId\]\)/);
  assert.match(modelBody("CreatorTip"), /@@unique\(\[creatorId, externalTransactionId\]\)/);
  assert.match(modelBody("CreatorSubscriptionEvent"), /@@index\(\[creatorId, externalTransactionId\]\)/);
  assert.doesNotMatch(modelBody("CreatorSubscriptionEvent"), /@@unique\(\[creatorId, externalTransactionId\]\)/);
  assert.match(originalMigration, /REFERENCES "WorkerDevice"\("id"\) ON DELETE SET NULL/);
  assert.match(originalMigration, /REFERENCES "JobInstance"\("id"\) ON DELETE SET NULL/);
});

test("upgrade migrations purge untrusted protocols and enforce database invariants", () => {
  assert.match(coverageTypeMigration, /NOTIFICATION_PURCHASES/);
  assert.match(v2Migration, /NOTIFICATION_V1_RESCAN_REQUIRED/);
  assert.match(v2Migration, /CreatorSale_amount_positive_check/);
  assert.match(v2Migration, /CreatorTip_amount_positive_check/);
  assert.match(v2Migration, /CreatorSale_target_consistency_check/);
  assert.match(v3Migration, /"schemaVersion" < 3/);
  assert.match(v3Migration, /DELETE FROM "AnalyticsIngestBatch"/);
  assert.match(v3Migration, /AnalyticsIngestBatch_notification_schema_check/);
  assert.match(v3Migration, /"dataType" <> 'NOTIFICATIONS' OR "schemaVersion" >= 3/);
  assert.match(v3Migration, /DELETE FROM "CreatorSale"/);
  assert.match(v3Migration, /DELETE FROM "CreatorTip"/);
  assert.match(v3Migration, /DELETE FROM "CreatorSubscriptionEvent"/);
  assert.match(v3Migration, /CreatorSale_creatorId_fanId_fkey/);
  assert.match(v3Migration, /CreatorTip_creatorId_fanId_fkey/);
  assert.match(v3Migration, /CreatorSubscriptionEvent_creatorId_fanId_fkey/);
  assert.match(v3Migration, /coverageDate\"::timestamp/);
  assert.match(v3Migration, /timezone\('UTC', CURRENT_TIMESTAMP\)/);
  assert.match(v3Migration, /AnalyticsCoverage_notification_complete_day_check/);
  assert.match(v3Migration, /NOTIFICATION_DAY_INTERVAL_INVALIDATED/);
  assert.match(v3Migration, /"coveredFromAt" <= "coveredToAt"/);
});

test("ingest is version-fenced, transactional, page-oriented and interval-aware", () => {
  assert.match(service, /const SCHEMA_VERSION = 3/);
  assert.match(service, /const COLLECTOR_VERSION = "notifications-catchup-v4"/);
  assert.match(service, /notification-facts:\$\{job\.id\}:\$\{batchKey\}:v4/);
  assert.match(service, /db\.\$transaction/);
  assert.match(service, /createMany\(\{ data: creates\.map/);
  assert.match(service, /analyticsCoverage\.updateMany/);
  assert.match(service, /NOTIFICATION_PURCHASES/);
  assert.match(service, /NOTIFICATION_TIPS/);
  assert.match(service, /NOTIFICATION_SUBSCRIPTIONS/);
  assert.match(service, /NOTIFICATION_TIMEZONE_UNSUPPORTED/);
  assert.match(service, /persistCoverageRows/);
  assert.match(service, /dayBounds/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /NOTIFICATION_RESUME_CURSOR_UNVERIFIED/);
  assert.match(service, /NOTIFICATION_FINALIZE_FLAG_REQUIRED/);
  assert.match(service, /NOTIFICATION_COVERAGE_METADATA_INVALID/);
  assert.match(strictDates, /getUTCDate\(\) !== day/);
  assert.match(jobResultService, /notification_facts_page/);
  assert.match(jobResultService, /schemaVersion: chunkResult\.schemaVersion/);
  assert.match(jobResultService, /finalizeCoverage: false/);
});

test("completion preserves run identity, streams compatibility facts and repairs partial jobs", () => {
  const ledgerAt = observation.indexOf("await ingestNotificationFacts");
  const compatibilityAt = observation.indexOf("for await (const raw of iterateLedgerCompatibilityEvents");
  assert.ok(ledgerAt >= 0 && compatibilityAt > ledgerAt);
  assert.match(observation, /batchKey: result\?\.batchKey/);
  assert.match(observation, /sourceJobId: job\.id/);
  assert.match(observation, /NOTIFICATION_COMPATIBILITY_PAGE_SIZE = 500/);
  assert.doesNotMatch(observation, /NOTIFICATION_COMPATIBILITY_LIMIT/);
  assert.match(observation, /analyticsCoverageByType/);
  assert.match(observation, /subscriptionRefundIgnored/);
  assert.match(observation, /notification_scan_partial/);
  assert.match(leaseService, /job\.jobKey === "catchup_notifications_scan"/);
  assert.match(leaseService, /leaseRevision: \{ increment: 1 \}/);
  assert.match(leaseService, /notification scan scheduled for repair/);
  assert.match(leaseService, /partialTypes/);
  assert.match(leaseService, /resumeCursors/);
  assert.match(leaseService, /status: "SCHEDULED"/);
});
