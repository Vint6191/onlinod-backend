"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const convergenceName = "20260908224500_analytics_collection_control_convergence";
const sanitationName = "20260909004500_analytics_campaign_migrated_proof_sanitation";
const convergence = fs.readFileSync(path.join(root, "prisma", "migrations", convergenceName, "migration.sql"), "utf8");
const sanitation = fs.readFileSync(path.join(root, "prisma", "migrations", sanitationName, "migration.sql"), "utf8");

test("Campaign migrated state is sanitized after the immutable collection-control migration", () => {
  assert.ok(sanitationName > convergenceName);
  assert.match(convergence, /MIGRATED_COVERAGE:/);
  assert.match(convergence, /lastCatchupGeneration" = 'MIGRATED_JOB:'/);
  assert.match(sanitation, /baselineGeneration" LIKE 'MIGRATED_COVERAGE:%'/);
  assert.match(sanitation, /lastCatchupGeneration" LIKE 'MIGRATED_JOB:%'/);
});

test("generic COMPLETE Campaign coverage cannot masquerade as a migrated FULL baseline", () => {
  const baseline = sanitation.slice(0, sanitation.indexOf('WITH "MigratedCampaignCatchup"'));
  assert.match(baseline, /coverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"/);
  assert.match(baseline, /batchStatus" = 'COMMITTED'::"AnalyticsIngestStatus"/);
  assert.match(baseline, /jobStatus" = 'DONE'/);
  assert.match(baseline, /campaignMode'[\s\S]*<> 'catchup'/);
  assert.match(baseline, /campaignPagesComplete' = 'true'/);
  assert.match(baseline, /claimersComplete' = 'true'/);
  assert.match(baseline, /fanValuesComplete' = 'true'/);
  assert.match(baseline, /truncated' = 'false'/);
  assert.match(baseline, /idempotencyKey" = 'campaigns:'[\s\S]*':completion:v7'/);
  assert.match(baseline, /SET "baselineVerifiedAt" = NULL,[\s\S]*"baselineGeneration" = NULL/);
});

test("migrated Campaign catchup requires its own COMPLETE linked coverage so superseded DONE is not freshness proof", () => {
  const catchup = sanitation.slice(sanitation.indexOf('WITH "MigratedCampaignCatchup"'));
  assert.match(catchup, /campaignMode'[\s\S]*= 'catchup'/);
  assert.match(catchup, /LEFT JOIN "AnalyticsCoverage" c[\s\S]*c\."ingestBatchId" = b\."id"/);
  assert.match(catchup, /coverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"/);
  assert.match(catchup, /batchStatus" = 'COMMITTED'::"AnalyticsIngestStatus"/);
  assert.match(catchup, /campaignPagesComplete' = 'true'/);
  assert.match(catchup, /claimersComplete' = 'true'/);
  assert.match(catchup, /fanValuesComplete' = 'true'/);
  assert.match(catchup, /truncated' = 'false'/);
  assert.match(catchup, /SET "lastCatchupCompletedAt" = NULL,[\s\S]*"lastCatchupGeneration" = NULL/);
});

test("Campaign migration validation fails closed on missing historical joins", () => {
  assert.match(sanitation, /WHERE NOT COALESCE\(\([\s\S]*?\), FALSE\)/);
  assert.match(sanitation, /AND NOT EXISTS \([\s\S]*ValidMigratedCampaignCatchup/);
});
