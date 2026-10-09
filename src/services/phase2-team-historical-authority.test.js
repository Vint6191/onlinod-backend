"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const desktopRoot = path.resolve(process.env.ONLINOD_DESKTOP_ROOT || path.join(root, "../desktop"));
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



test("retention is fail-closed on projection proof and owns Team raw horizons centrally", () => {
  const retention = read("src/services/retention-service.js");
  const ppv = read("src/services/team-ppv-ledger-service.js");
  const tip = read("src/services/team-tip-ledger-service.js");
  const claims = read("src/routes/team-claims.js");

  assert.match(retention, /teamCanonicalDetailDays/);
  assert.match(retention, /teamMoneyRawDetailDays/);
  assert.match(retention, /historicalProjectionVersion:\s*"team_activity_contribution_v2"/);
  assert.doesNotMatch(retention, /historicalProjectionVersion:\s*"team_activity_daily_v1"/);
  assert.match(retention, /purgeExpiredTipLedger/);
  assert.match(retention, /now:\s*authorityNow/);
  assert.match(ppv, /historicalFactVersion:\s*"team_money_fact_v2"/);
  assert.match(ppv, /teamPpvPurchaseLedger\.updateMany/);
  assert.match(tip, /historicalFactVersion:\s*"team_money_fact_v2"/);
  assert.match(tip, /teamTipLedger\.updateMany/);
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
