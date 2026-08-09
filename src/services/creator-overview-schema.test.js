"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const service = read("services/creator-overview-service.js");
const routes = read("routes/stats.js");
const retention = read("services/retention-service.js");
const schema = read("../prisma/schema.prisma");
const migration = read("../prisma/migrations/20260809121500_creator_overview_v1/migration.sql");

test("creator overview is a composed read model, not another raw analytics store", () => {
  assert.match(service, /readCreatorLedgerOverview/);
  assert.match(service, /creatorFinancialTransaction\.groupBy/);
  assert.match(service, /creatorCampaignFan\.groupBy/);
  assert.match(service, /transactionStatus/);
  assert.match(service, /status === "undo"/);
  assert.match(service, /status === "loading"/);
  assert.match(routes, /\/creators\/:creatorId\/overview-v2/);
  assert.match(routes, /\/creators\/:creatorId\/current-task/);
  assert.match(routes, /\/creators\/:creatorId\/task-activity/);
});

test("one-year audience range stays locked until six-month backfill has accumulated another half year", () => {
  assert.match(service, /185 \* DAY_MS/);
  assert.match(service, /fullBackfillVerifiedAt/);
  assert.match(service, /fullBackfillVerifiedAt \|\| ledger\.notificationSync\?\.fullBackfillCompletedAt/);
  assert.match(service, /oldestOccurredAt/);
  assert.match(service, /oneYearAvailable/);
  assert.match(service, /365d/);
});

test("task activity is a compact relational 30-day projection with one row per backend job", () => {
  assert.match(schema, /model CreatorTaskActivity/);
  assert.match(schema, /jobId\s+String\s+@unique/);
  assert.doesNotMatch(schema.slice(schema.indexOf("model CreatorTaskActivity"), schema.indexOf("model DeviceCommand")), /\bJson\??/);
  assert.match(migration, /CREATE TABLE "CreatorTaskActivity"/);
  assert.match(migration, /ON CONFLICT \("jobId"\) DO UPDATE/);
  assert.match(migration, /NEW\."id" \|\| ':activity'/);
  assert.match(migration, /status" = 'SCHEDULED'.*startedAt/s);
  assert.doesNotMatch(migration, /CreatorTaskActivity_jobId_fkey/);
  assert.match(migration, /INTERVAL '30 days'/);
  assert.match(migration, /FROM "JobInstance" j/);
});

test("activity retention is fixed at 30 days and independent of temperature heuristics", () => {
  assert.match(service, /ACTIVITY_RETENTION_DAYS = 30/);
  assert.match(retention, /creatorTaskActivity\.30d/);
  assert.match(retention, /daysAgo\(30\)/);
  assert.doesNotMatch(service + retention, /\b(?:HOT|WARM|COLD)\b/);
});

test("activity log records executed work rather than filling history with untouched future schedules", () => {
  assert.match(migration, /NEW\."status" = 'SCHEDULED'/);
  assert.match(migration, /NEW\."startedAt" IS NULL/);
  assert.match(migration, /NEW\."claimedAt" IS NULL/);
  assert.match(service, /status: \{ in: \["CLAIMED", "PAUSED", "DONE", "FAILED", "CANCELLED"\] \}/);
});

test("task activity day index is queried separately so the renderer never needs 2500 rows just to build day filters", () => {
  assert.match(service, /readCreatorTaskActivityDays/);
  assert.match(service, /GROUP BY 1/);
  assert.match(routes, /readCreatorTaskActivityDays/);
  assert.match(routes, /Promise\.all/);
});

test("campaign fan drill-down accepts the overview range and filters money by transaction occurredAt", () => {
  const ledger = read("services/creator-analytics-ledger-service.js");
  assert.match(routes, /INVALID_CAMPAIGN_FAN_RANGE/);
  assert.match(routes, /rangeKey/);
  assert.match(ledger, /rangeKey = null/);
  assert.match(ledger, /event\."occurredAt" >= \$4::timestamptz/);
  assert.match(ledger, /event\."occurredAt" <= \$5::timestamptz/);
});
