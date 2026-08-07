"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const migrationPaths = [
  "prisma/migrations/20260806170000_creator_analytics_data_types/migration.sql",
  "prisma/migrations/20260806180000_creator_analytics_relational_v1/migration.sql",
  "prisma/migrations/20260806190000_creator_analytics_relational_hardening/migration.sql",
  "prisma/migrations/20260806220000_notification_all_backfill_v1/migration.sql",
  "prisma/migrations/20260806221000_subscription_unknown_price/migration.sql",
  "prisma/migrations/20260807143000_notification_scanner_manual_v1/migration.sql",
];
const migrations = migrationPaths.map((relative) => ({ relative, text: fs.readFileSync(path.join(root, relative), "utf8") }));
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");

test("creator analytics enum values commit before relational tables use them", () => {
  for (const value of ["NOTIFICATION_LIKES", "NOTIFICATION_COMMENTS", "CAMPAIGNS", "MESSAGES_DAILY"]) {
    assert.match(migrations[0].text, new RegExp(`ADD VALUE IF NOT EXISTS '${value}'`));
  }
  assert.doesNotMatch(migrations[1].text, /ADD VALUE/i);
  assert.doesNotMatch(migrations[2].text, /ADD VALUE/i);
  assert.doesNotMatch(migrations[3].text, /ADD VALUE/i);
  assert.match(migrations[4].text, /ADD VALUE IF NOT EXISTS 'SUBSCRIBED_UNKNOWN'/);
});

test("new migration object names are unique and fit PostgreSQL's identifier limit", () => {
  const seen = new Map();
  const patterns = [
    /(?:CONSTRAINT|ADD CONSTRAINT)\s+"([^"]+)"/gi,
    /CREATE(?: UNIQUE)? INDEX\s+"([^"]+)"/gi,
  ];
  for (const migration of migrations) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(migration.text); match; match = pattern.exec(migration.text)) {
        const name = match[1];
        assert.ok(Buffer.byteLength(name, "utf8") <= 63, `${name} exceeds PostgreSQL's 63-byte identifier limit`);
        assert.equal(seen.has(name), false, `${name} is created twice (${seen.get(name)} and ${migration.relative})`);
        seen.set(name, migration.relative);
      }
    }
  }
});

test("Prisma schema and SQL agree on scan-run identity and relational tables", () => {
  const tableSql = migrations[1].text;
  const hardeningSql = migrations[2].text;
  for (const table of ["CreatorPostLike", "CreatorPostComment", "CreatorEarningsDaily", "CreatorCampaign", "CreatorCampaignFan", "CreatorMessagesDaily"]) {
    assert.match(tableSql, new RegExp(`CREATE TABLE "${table}"`));
    assert.match(schema, new RegExp(`model ${table} \\{`));
  }
  assert.match(tableSql, /"CreatorEarningsDaily"[\s\S]*"sourceScanRunId" TEXT/);
  assert.match(hardeningSql, /ALTER TABLE "CreatorCampaign"[\s\S]*ADD COLUMN "sourceScanRunId" TEXT/);
  assert.match(hardeningSql, /ALTER TABLE "CreatorCampaignFan"[\s\S]*ADD COLUMN "sourceScanRunId" TEXT/);
  for (const model of ["CreatorEarningsDaily", "CreatorCampaign", "CreatorCampaignFan"]) {
    assert.match(schema, new RegExp(`model ${model} \\{[\\s\\S]*sourceScanRunId\\s+String\\?`));
  }
});


test("notification ALL migration keeps resumable sync state relational and typed", () => {
  const sql = migrations[3].text;
  assert.match(sql, /CREATE TABLE "CreatorNotificationSyncState"/);
  assert.match(sql, /"nextCursor" TEXT/);
  assert.match(sql, /"headNotificationId" TEXT/);
  assert.match(sql, /"fullBackfillCompletedAt" TIMESTAMP\(3\)/);
  assert.match(sql, /"fullBackfillVerifiedAt" TIMESTAMP\(3\)/);
  assert.match(sql, /CreatorNotificationSyncState_mode_check/);
  assert.match(sql, /WHERE "jobKey" = 'catchup_notifications_scan'/);
  assert.match(sql, /"leaseRevision" = "leaseRevision" \+ 1/);
  assert.match(sql, /superseded_by_notification_all_v4/);
  assert.match(schema, /model CreatorNotificationSyncState \{/);
  assert.doesNotMatch(sql, /payloadJson|rawJson|eventJson/i);
});

test("manual notification scanner audit is relational and fences old automatic jobs", () => {
  const sql = migrations[5].text;
  assert.match(sql, /CREATE TABLE "CreatorNotificationScanItem"/);
  assert.match(sql, /"sourceJobId" TEXT NOT NULL/);
  assert.match(sql, /"outcome" "CreatorNotificationScanOutcome" NOT NULL/);
  assert.match(sql, /"amountCents" INTEGER/);
  assert.match(sql, /"currency" TEXT/);
  assert.match(sql, /"reasonCode" TEXT/);
  assert.match(sql, /notification_scan_manual_only_v1/);
  assert.match(sql, /WHERE "jobKey" = 'catchup_notifications_scan'/);
  assert.doesNotMatch(sql, /\bJSONB?\b/i);
  assert.match(schema, /model CreatorNotificationScanItem \{/);
});

test("analytics migrations contain no message bodies or JSON business payloads", () => {
  const allSql = migrations.map((item) => item.text).join("\n");
  assert.doesNotMatch(allSql, /messageText|bodyText|contentJson|payloadJson|rawJson/i);
  assert.match(allSql, /"CreatorMessagesDaily"/);
  assert.match(allSql, /"incomingMessages" INTEGER NOT NULL/);
  assert.match(allSql, /"outgoingMessages" INTEGER NOT NULL/);
});
