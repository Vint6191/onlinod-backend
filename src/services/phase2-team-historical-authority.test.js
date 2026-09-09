"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const desktopRoot = path.resolve(root, "../../phase2_desktop");
const readDesktop = (rel) => fs.readFileSync(path.join(desktopRoot, rel), "utf8");

test("Phase2 historical authority has durable schema and proof markers", () => {
  const schema = read("prisma/schema.prisma");
  for (const model of ["TeamHistoricalAnalyticsCoverage", "TeamMemberActivityDaily", "TeamMoneyAttributionFact"]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
  assert.match(schema, /historicalProjectionVersion\s+String\?/);
  assert.match(schema, /historicalFactVersion\s+String\?/);
  assert.match(schema, /@@unique\(\[agencyId, memberId, creatorKey, day\]\)/);
  assert.match(schema, /@@unique\(\[agencyId, sourceType, sourceRowId\]\)/);
});

test("migration projects before raw retention and keeps canonical financial corrections live", () => {
  const sql = read("prisma/migrations/20260909183000_phase2_team_historical_authority/migration.sql");
  assert.match(sql, /TeamActivityEvent_project_historical_v1/);
  assert.match(sql, /BEFORE INSERT ON "TeamActivityEvent"/);
  assert.match(sql, /TeamPpvPurchaseLedger_project_historical_v1/);
  assert.match(sql, /TeamTipLedger_project_historical_v1/);
  assert.match(sql, /team_activity_daily_v1/);
  assert.match(sql, /team_money_fact_v1/);
  assert.match(sql, /CreatorSale_refresh_team_fact_v1/);
  assert.match(sql, /CreatorFinancialTransaction_refresh_team_fact_v1/);
  assert.match(sql, /CreatorTip_refresh_team_fact_v1/);
  assert.match(sql, /COALESCE\(lower\(NEW\."transactionStatus"\), ''\) <> 'undo'/);

  // Rolling-deploy migration safety: live projection triggers must exist before
  // historical backfill starts, and backfill may only claim rows that still lack proof.
  const activityTriggerAt = sql.indexOf('CREATE TRIGGER "TeamActivityEvent_project_historical_v1"');
  const ppvTriggerAt = sql.indexOf('CREATE TRIGGER "TeamPpvPurchaseLedger_project_historical_v1"');
  const tipTriggerAt = sql.indexOf('CREATE TRIGGER "TeamTipLedger_project_historical_v1"');
  const backfillAt = sql.indexOf('-- Backfill compact activity');
  assert.ok(activityTriggerAt >= 0 && activityTriggerAt < backfillAt);
  assert.ok(ppvTriggerAt >= 0 && ppvTriggerAt < backfillAt);
  assert.ok(tipTriggerAt >= 0 && tipTriggerAt < backfillAt);
  assert.match(sql, /e\."historicalProjectionVersion" IS NULL/);
  assert.match(sql, /p\."historicalFactVersion" IS NULL/);
  assert.match(sql, /t\."historicalFactVersion" IS NULL/);
  assert.match(sql, /"TeamMemberActivityDaily"\."sourceEventCount" \+ EXCLUDED\."sourceEventCount"/);
  assert.match(sql, /v_contributes BOOLEAN := FALSE/);
  assert.match(sql, /IF NOT v_contributes THEN[\s\S]*historicalProjectionVersion/);
  assert.match(sql, /e\."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED'[\s\S]*GROUP BY/);
  assert.match(sql, /"TeamMoneyAttributionFact"\."sourceUpdatedAt" <= EXCLUDED\."sourceUpdatedAt"/);

  // Interrupted-deploy recovery: schema/trigger bootstrap is rerunnable, while
  // each additive backfill and its raw-row proof are one atomic retry unit.
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "historicalProjectionVersion"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "historicalFactVersion"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "TeamMemberActivityDaily"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "TeamMoneyAttributionFact"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "TeamMemberActivityDaily_agency_member_creator_day_key"/);
  assert.match(sql, /SELECT 1 FROM pg_trigger[\s\S]*TeamActivityEvent_project_historical_v1/);
  assert.match(sql, /SELECT 1 FROM pg_trigger[\s\S]*TeamPpvPurchaseLedger_project_historical_v1/);
  assert.match(sql, /SELECT 1 FROM pg_trigger[\s\S]*TeamTipLedger_project_historical_v1/);
  assert.match(sql, /BEGIN;[\s\S]*-- Backfill compact activity[\s\S]*UPDATE "TeamActivityEvent"[\s\S]*"historicalProjectionVersion" = 'team_activity_daily_v1'[\s\S]*COMMIT;/);
  assert.match(sql, /BEGIN;[\s\S]*-- Durable money fact backfill[\s\S]*UPDATE "TeamPpvPurchaseLedger"[\s\S]*UPDATE "TeamTipLedger"[\s\S]*COMMIT;/);
});

test("retention is fail-closed on projection proof and owns Team raw horizons centrally", () => {
  const retention = read("src/services/retention-service.js");
  const ppv = read("src/services/team-ppv-ledger-service.js");
  const tip = read("src/services/team-tip-ledger-service.js");
  const claims = read("src/routes/team-claims.js");

  assert.match(retention, /teamCanonicalDetailDays/);
  assert.match(retention, /teamMoneyRawDetailDays/);
  assert.match(retention, /historicalProjectionVersion:\s*"team_activity_daily_v1"/);
  assert.match(retention, /purgeExpiredTipLedger/);
  assert.match(retention, /now:\s*authorityNow/);
  assert.match(ppv, /historicalFactVersion:\s*"team_money_fact_v1"/);
  assert.match(tip, /historicalFactVersion:\s*"team_money_fact_v1"/);
  assert.match(claims, /getRetentionSettings\(\)/);
  assert.match(claims, /dbAuthorityNow\(\{ db: prisma \}\)/);
  assert.match(claims, /now:\s*retentionAuthorityNow/);
  assert.doesNotMatch(claims, /req\.query\.retentionDays\s*\|\|\s*req\.body\?\.retentionDays/);
});

test("Team Analytics reads durable history, bounds raw detail and exposes typed coverage", () => {
  const service = read("src/services/team-analytics-service.js");
  const shared = readDesktop("packages/shared/src/team-analytics.ts");
  const renderer = readDesktop("apps/desktop/renderer/src/features/team-analytics/TeamAnalyticsWorkspace.tsx");

  assert.match(service, /teamHistoricalAnalyticsCoverage/);
  assert.match(service, /teamMemberActivityDaily/);
  assert.match(service, /teamMoneyAttributionFact/);
  assert.match(service, /clampRangeToDetail/);
  assert.match(service, /team_historical_analytics_v1/);
  assert.match(service, /distinctFansAndLegacyActivity/);
  assert.doesNotMatch(service, /teamPpvPurchaseLedger\.groupBy/);
  assert.doesNotMatch(service, /teamTipLedger\.groupBy/);

  assert.match(shared, /TeamAnalyticsCoverageStatus = 'FULL' \| 'PARTIAL' \| 'AVAILABLE_FROM' \| 'UNAVAILABLE'/);
  assert.match(shared, /TeamAnalyticsHistoricalProjection/);
  assert.match(renderer, /incompleteHistoricalFamilies/);
  assert.match(renderer, /missing pre-coverage history is not treated as zero/);
});
