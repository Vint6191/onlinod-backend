"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const ledger = read("services/creator-analytics-ledger-service.js");
const repository = read("services/campaign-read-repository.js");
const projection = read("services/campaign-read-projection-service.js");
const temporalSeek = read("../prisma/migrations/20261001170000_campaign_temporal_seek_v3/migration.sql");
const control = read("services/campaign-scan-control-service.js");
const routes = read("routes/stats.js");
const financial = read("services/financial-transactions-service.js");

test("campaign money is derived from atomic financial transactions, not copied onto memberships", () => {
  assert.match(projection, /FINANCIAL: "CreatorFinancialTransaction"/);
  assert.match(projection, /"onlinod_campaign_read_attribution_v3"\(\$2::text,\$1::text,\$3::text,"phase3_utc_timestamp"\(\$4::timestamptz\)\)/);
  assert.match(temporalSeek, /m\."attributedAt"<=t/);
  assert.match(temporalSeek, /ORDER BY m\."attributedAt" DESC,m\."id" DESC LIMIT 1/);
  assert.match(projection, /financialMetrics\(row\)/);
  assert.doesNotMatch(repository, /FROM "CreatorFinancialTransaction"/);
  assert.doesNotMatch(projection, /(?:UPDATE|INSERT INTO) "CreatorFinancialTransaction"/);
  assert.doesNotMatch(ledger, /creatorCampaignFan\.(?:create|update|upsert)[\s\S]{0,500}(?:revenue|amountCents|netCents)/i);
});

test("campaign fan rows expose arrival time and settled/pending money", () => {
  assert.match(repository, /attributedAt:row\.attributedAt/);
  const {financialMetrics}=require('./campaign-read-projection-service');
  const {metricsDto}=require('./campaign-read-repository');
  const m=metricsDto(financialMetrics({amountCents:100,netCents:80,transactionStatus:'done'}));
  assert.equal(m.settledNetCents,80);assert.equal(m.pendingNetCents,0);assert.equal(m.transactionsCount,1);
  assert.match(ledger, /readCampaignFanPage/);assert.match(ledger, /readCampaignPage/);
});

test("manual campaign scanner is isolated and has independent routes", () => {
  assert.match(control, /JOB_KEY = "fetch_campaigns"/);
  assert.match(control, /manualCampaignScan: true/);
  assert.match(control, /authorityNow = await dbAuthorityNow\(\{ db: tx, fallbackNow: now \}\)/);
  assert.match(control, /buildCollectionCommand\(\{ collectorType: COLLECTOR_TYPES\.CAMPAIGNS, collectionMode: "full", reason: MANUAL_REASON, now: authorityNow \}\)/);
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
  assert.doesNotMatch(ledger, /valueSource: text\(item\.valueSource \?\? item\.source/);
  assert.match(ledger, /source: "CAMPAIGN_CLAIMER"/);
  assert.match(ledger, /CAMPAIGN_FAN_VALUE_SCOPE_MISMATCH/);
  assert.match(repository, /platformReportedFanSpendCents/);
  assert.doesNotMatch(schema.slice(schema.indexOf("model CreatorCampaignFan"), schema.indexOf("model CreatorEarningsDaily")), /totalNetCents|messagesNetCents|tipsNetCents/);
});
