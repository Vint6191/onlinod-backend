"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const ledger = read("services/creator-analytics-ledger-service.js");
const control = read("services/campaign-scan-control-service.js");
const routes = read("routes/stats.js");
const financial = read("services/financial-transactions-service.js");

test("campaign money is derived from atomic financial transactions, not copied onto memberships", () => {
  assert.match(ledger, /FROM "CreatorFinancialTransaction" AS event/);
  assert.match(ledger, /JOIN LATERAL/);
  assert.match(ledger, /link\."attributedAt" <= event\."occurredAt"/);
  assert.match(ledger, /ORDER BY link\."attributedAt" DESC, link\."id" DESC/);
  assert.doesNotMatch(ledger, /creatorCampaignFan\.(?:create|update|upsert)[\s\S]{0,500}(?:revenue|amountCents|netCents)/i);
});

test("campaign fan rows expose arrival time and settled/pending money", () => {
  assert.match(ledger, /attributedAt: row\.attributedAt/);
  assert.match(ledger, /settledNetCents/);
  assert.match(ledger, /pendingNetCents/);
  assert.match(ledger, /transactionsCount/);
  assert.match(ledger, /readCampaignsWithRevenue/);
  assert.match(ledger, /module\.exports[\s\S]*readCampaignsWithRevenue/);
});

test("manual campaign scanner is isolated and has independent routes", () => {
  assert.match(control, /JOB_KEY = "fetch_campaigns"/);
  assert.match(control, /manualCampaignScan: true/);
  assert.match(routes, /\/creators\/:creatorId\/campaign-scan"/);
  assert.match(routes, /\/creators\/:creatorId\/campaign-scan\/start"/);
  assert.match(routes, /\/creators\/:creatorId\/campaign-scan\/stop"/);
  assert.doesNotMatch(control, /catchup_notifications_scan|financial_transactions_scan/);
});

test("payout daily cache rebuild touches only actually changed UTC days", () => {
  assert.match(financial, /const uniqueDays = \[\.\.\.new Set/);
  assert.match(financial, /from: date, to: date/);
  assert.doesNotMatch(financial, /from: normalized\[0\]\.occurredAt, to: normalized\.at\(-1\)\.occurredAt/);
});

test("campaign scanner persists fresh OF fan value as typed current state, not on campaign membership", () => {
  const schema = read("../prisma/schema.prisma");
  const migration = read("../prisma/migrations/20260808184500_creator_fan_value_current_v1/migration.sql");
  assert.match(schema, /model CreatorFanValueCurrent/);
  assert.match(schema, /platformReportedTotalSpendCents\s+BigInt\?\s+@map\("totalNetCents"\)/);
  assert.match(schema, /messagesSpentCents\s+BigInt\?\s+@map\("messagesNetCents"\)/);
  assert.match(schema, /subscriptionsSpentCents\s+BigInt\?\s+@map\("subscriptionsNetCents"\)/);
  assert.match(schema, /tipsSpentCents\s+BigInt\?\s+@map\("tipsNetCents"\)/);
  assert.match(migration, /CREATE TABLE "CreatorFanValueCurrent"/);
  assert.match(migration, /CreatorFanValueCurrent_agencyId_creatorId_fkey/);
  assert.match(migration, /CreatorFanValueCurrent_creatorId_fanId_fkey/);
  assert.match(migration, /CreatorFanValueCurrent_sourceDeviceId_fkey/);
  assert.match(migration, /CreatorFanValueCurrent_sourceJobId_fkey/);
  assert.match(ledger, /ingestCampaignFanValueChunk/);
  assert.match(ledger, /valueSource: text\(item\.valueSource \?\? item\.source, 80\) \|\| "USER_PROFILE"/);
  assert.match(ledger, /platformReportedFanSpendCents/);
  assert.doesNotMatch(schema.slice(schema.indexOf("model CreatorCampaignFan"), schema.indexOf("model CreatorEarningsDaily")), /totalNetCents|messagesNetCents|tipsNetCents/);
});
