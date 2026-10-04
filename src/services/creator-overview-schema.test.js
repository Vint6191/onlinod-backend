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
  assert.match(service, /ledger\.financialGroups/);
  assert.doesNotMatch(service, /creatorFinancialTransaction\.groupBy/);
  assert.match(service, /readCampaignPage/);
  assert.doesNotMatch(service, /creatorCampaignFan\.groupBy/);
  assert.match(service, /transactionStatus/);
  assert.match(service, /status === "undo"/);
  assert.match(service, /status === "loading"/);
  assert.match(routes, /\/creators\/:creatorId\/overview-v2/);
  assert.match(routes, /\/creators\/:creatorId\/current-task/);
  assert.match(routes, /\/creators\/:creatorId\/task-activity/);
  assert.match(service, /includeMessages: false, includeCoveragePage: false/);
  assert.doesNotMatch(service, /messagesServer:/);
  assert.doesNotMatch(service, /messagesVerified:/);
});

test("one-year audience range stays locked until six-month backfill has accumulated another half year", () => {
  assert.match(service, /185 \* DAY_MS/);
  assert.match(service, /notificationBaselineAtRaw = ledger\.notificationSync\?\.fullBackfillVerifiedAt \|\| null/);
  assert.match(service, /notificationBaselineAt = trustedCollectionTimestamp\(notificationBaselineAtRaw, now\)/);
  assert.match(service, /baselineCompletedAt: ledger\.notificationSync\?\.fullBackfillCompletedAt/);
  assert.match(service, /baselineVerifiedAt: ledger\.notificationSync\?\.fullBackfillVerifiedAt/);
  assert.match(service, /lastCatchupVerifiedAt/);
  assert.match(service, /notificationVerified: notificationCollection\.proven === true/);
  assert.match(service, /oldestOccurredAt/);
  assert.match(service, /oneYearAvailable = Boolean\(notificationCollection\.proven === true/);
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
  assert.match(retention, /daysAgo\(30, authorityNow\)/);
  assert.match(retention, /const authorityNow = sweepNow\(options\)/);
  assert.doesNotMatch(service + retention, /\b(?:HOT|WARM|COLD)\b/);
});

test("activity log records executed work rather than filling history with untouched future schedules", () => {
  assert.match(migration, /NEW\."status" = 'SCHEDULED'/);
  assert.match(migration, /NEW\."startedAt" IS NULL/);
  assert.match(migration, /NEW\."claimedAt" IS NULL/);
  assert.doesNotMatch(service, /db\.jobInstance\.findMany/);
});

test("task activity day index is queried separately so the renderer never needs 2500 rows just to build day filters", () => {
  assert.match(service, /CreatorTaskActivity Prisma delegate is required by the current Creator Overview contract/);
  const activityStart = service.indexOf("async function readCreatorTaskActivityDays");
  const activityEnd = service.indexOf("async function readCreatorOverview", activityStart);
  const activityBlock = service.slice(activityStart, activityEnd > activityStart ? activityEnd : undefined);
  assert.doesNotMatch(activityBlock, /db\.jobInstance\.findMany|rolling deploy fallback|JobInstance until migration/);
  assert.match(service, /readCreatorTaskActivityDays/);
  assert.match(service, /GROUP BY 1/);
  assert.match(routes, /readCreatorTaskActivityDays/);
  assert.match(routes, /Promise\.all/);
});

test("campaign fan drill-down accepts the overview range and filters money by transaction occurredAt", () => {
  assert.match(routes, /INVALID_CAMPAIGN_FAN_RANGE/);
  const {windowMembership}=require('./campaign-read-projection-service');
  assert.deepEqual(windowMembership(new Date('2026-08-01'),new Date('2026-08-08')).ranges.includes('7d'),false);
  assert.equal(windowMembership(new Date('2026-08-08'),new Date('2026-08-08')).ranges.includes('7d'),true);
  const repository=read('services/campaign-read-repository.js');
  assert.match(repository, /p\."rangeKey"=\$3/);
  assert.match(repository, /CAMPAIGN_RANGE_UNSUPPORTED/);
});

test("campaign overview exposes current OF fan value even when claimer arrival timestamps are unavailable", () => {
  assert.match(service, /campaigns: campaignPage/);
  const projection=read('services/campaign-read-projection-service.js');
  assert.match(projection, /CreatorFanValueCurrent/);
  assert.match(projection, /unknownAttributionFans:row\.attributedAt==null\?1:0/);
  const {valueMetrics}=require('./campaign-read-projection-service');
  const now=new Date('2026-08-08');
  const result=valueMetrics({availability:'AVAILABLE',fetchedAt:now,totalNetCents:123n},now);
  assert.equal(result.metrics.ofValueKnownFans,'1');assert.equal(result.metrics.knownPlatformReportedFanSpendCents,'123');
});


test("collector read states use one COMPLETE PROVEN FRESH vocabulary without collapsing product facts", () => {
  assert.match(service, /evaluateDurableCollectorState/);
  assert.match(service, /NOTIFICATION_COLLECTION_FRESHNESS_MS/);
  assert.match(service, /FINANCIAL_COLLECTION_FRESHNESS_MS/);
  assert.match(service, /evaluateCampaignCollectionState\(campaignCollectionState, now, campaignPage\?\.sourceCoverage\?\.campaigns\?\.refreshDebt\)/);
  assert.match(service, /collectors:\s*\{/);
  assert.match(service, /financial: collectorStatePayload\(financialCollection\)/);
  assert.match(service, /campaigns: collectorStatePayload\(campaignCollection\)/);
});
