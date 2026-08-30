"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = read("prisma/schema.prisma");
const enumMigration = read("prisma/migrations/20260808101000_creator_analytics_data_types_v2/migration.sql");
const foundationMigration = read("prisma/migrations/20260808101500_creator_analytics_relational_foundation_v2/migration.sql");
const projection = read("src/services/creator-analytics-projection-service.js");
const ledger = read("src/services/creator-analytics-ledger-service.js");
const notifications = read("src/services/notification-facts-service.js");
const routes = read("src/routes/stats.js");

function modelBody(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  assert.ok(match, `missing Prisma model ${name}`);
  return match[1];
}

test("creator analytics V2 keeps every business fact in typed relational models", () => {
  const primaryModels = [
    "CreatorFan",
    "CreatorMessagesDaily",
    "CreatorPostLike",
    "CreatorPostComment",
    "CreatorSubscriptionEvent",
    "CreatorSubscriptionState",
    "CreatorPaidSubscription",
    "CreatorSale",
    "CreatorTip",
    "CreatorCampaign",
    "CreatorCampaignFan",
    "CreatorEarningsDaily",
    "CreatorDailyMetrics",
    "AnalyticsCoverage",
    "AnalyticsIngestBatch",
    "CreatorLocalMessageCoverage",
    "CreatorFanLocalCoverage",
  ];
  for (const model of primaryModels) {
    assert.doesNotMatch(modelBody(model), /\bJson\??\b/, `${model} must not store business JSON`);
  }
  assert.doesNotMatch(schema, /model CreatorActivityEvent\b/);
});

test("subscription state and money are separate relational projections", () => {
  const state = modelBody("CreatorSubscriptionState");
  const paid = modelBody("CreatorPaidSubscription");
  assert.match(state, /@@unique\(\[creatorId, fanRecordId\]\)/);
  assert.match(state, /updatedFromEventId\s+String\?\s+@unique/);
  assert.match(paid, /paymentType\s+CreatorPaidSubscriptionPaymentType/);
  assert.match(paid, /amountCents\s+Int/);
  assert.match(paid, /subscriptionEventId\s+String\?\s+@unique/);
  assert.match(paid, /source\s+CreatorFactSource/);
  assert.match(projection, /REFUNDED is a financial fact/);
  assert.match(projection, /PAID_EVENT_TYPES/);
});

test("daily metrics are explicitly a rebuildable relational cache", () => {
  const metrics = modelBody("CreatorDailyMetrics");
  for (const column of [
    "incomingMessages", "outgoingMessages", "uniqueDialogs", "likes", "comments",
    "newSubscribers", "renewals", "expiredSubscribers", "messageSales", "postSales",
    "tipsCount", "tipsCents", "paidSubscriptions", "paidSubscriptionsCents",
    "salesCents", "totalObservedRevenueCents", "dataVersion",
  ]) assert.match(metrics, new RegExp(`\\b${column}\\b`));
  assert.match(projection, /rebuildCreatorDailyMetrics/);
  assert.match(ledger, /disposable read cache/);
  assert.match(notifications, /disposable read cache/);
});

test("local message coverage stores only metadata and never message bodies", () => {
  const coverage = modelBody("CreatorLocalMessageCoverage");
  const fanCoverage = modelBody("CreatorFanLocalCoverage");
  for (const column of ["deviceId", "oldestMessageAt", "newestMessageAt", "dialogsCovered", "messagesIndexed", "coverageStatus", "lastVerifiedAt"]) {
    assert.match(coverage, new RegExp(`\\b${column}\\b`));
  }
  assert.match(fanCoverage, /@@unique\(\[creatorId, fanRecordId, deviceId\]\)/);
  assert.doesNotMatch(`${coverage}\n${fanCoverage}`, /messageText|bodyText|content|payload/i);
  assert.match(routes, /messagesIndexed/);
  assert.match(routes, /oldestMessageAt/);
  assert.match(routes, /newestMessageAt/);
});

test("V2 migrations split enum additions from relational table use and contain no JSON business columns", () => {
  assert.match(enumMigration, /ADD VALUE IF NOT EXISTS 'SALES'/);
  assert.match(enumMigration, /ADD VALUE IF NOT EXISTS 'PAID_SUBSCRIPTIONS'/);
  assert.doesNotMatch(foundationMigration, /ALTER TYPE "AnalyticsDataType" ADD VALUE/);
  for (const table of ["CreatorSubscriptionState", "CreatorPaidSubscription", "CreatorDailyMetrics", "CreatorLocalMessageCoverage", "CreatorFanLocalCoverage"]) {
    assert.match(foundationMigration, new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.doesNotMatch(foundationMigration, /\bJSONB?\b/i);
  assert.match(foundationMigration, /DELETE FROM "AnalyticsCoverage" AS coverage[\s\S]*"oldestOccurredAt"/);
});

test("full notification coverage is fenced to the observed rolling source boundary", () => {
  assert.match(notifications, /limitToSourceBoundary: notificationMode === "full"/);
  assert.match(notifications, /creatorNotificationSyncState\.findUnique/);
  assert.match(notifications, /oldestOccurredAt/);
  assert.match(notifications, /calendar timestamp from which to claim historical availability/);
});
