"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const convergenceName = "20260908224500_analytics_collection_control_convergence";
const sanitationName = "20260909003000_analytics_financial_migrated_proof_sanitation";
const convergence = fs.readFileSync(path.join(root, "prisma", "migrations", convergenceName, "migration.sql"), "utf8");
const sanitation = fs.readFileSync(path.join(root, "prisma", "migrations", sanitationName, "migration.sql"), "utf8");

test("financial migrated readiness is sanitized after the immutable collection-control migration", () => {
  assert.ok(sanitationName > convergenceName, "sanitation must execute after the original collection-control migration");
  assert.match(convergence, /MIGRATED_JOB:/, "fixture must exercise the historical migrated-proof path");
  assert.match(sanitation, /baselineGeneration" LIKE 'MIGRATED_JOB:%'/);
  assert.match(sanitation, /lastCatchupGeneration" LIKE 'MIGRATED_JOB:%'/);
  assert.match(sanitation, /Job status is execution history, not durable business proof/);
});

test("migrated FULL financial proof is re-proven from traversal result and canonical reconciliation", () => {
  assert.match(sanitation, /jobResult"->>'sourceBoundaryReached' = 'true'/);
  assert.match(sanitation, /jobResult"->>'scannerRejected' = '0'/);
  assert.match(sanitation, /NULLIF\(j\."result"->>'scanRunId', ''\)/);
  assert.match(sanitation, /CreatorFinancialTransaction/);
  assert.match(sanitation, /CreatorEarningsTotal/);
  assert.match(sanitation, /totalSourceJobId" = b\."resolvedJobId"/);
  assert.match(sanitation, /totalScanRunId" = b\."scanRunId"/);
  assert.match(sanitation, /LOWER\(TRIM\(COALESCE\(f\."transactionStatus", ''\)\)\) <> 'undo'/);
  assert.match(sanitation, /chartTransactionsCount"::BIGINT = COALESCE\(f\."earningsTransactionsCount", 0\)/);
  assert.match(sanitation, /chartGrossCents"::BIGINT = COALESCE\(f\."earningsGrossCents", 0\)/);
  assert.match(sanitation, /chartNetCents"::BIGINT = COALESCE\(f\."earningsNetCents", 0\)/);
});

test("missing or malformed historical evidence fails closed instead of surviving SQL NULL semantics", () => {
  const failClosedChecks = sanitation.match(/WHERE NOT COALESCE\(\([\s\S]*?\), FALSE\)/g) || [];
  assert.equal(failClosedChecks.length, 2, "both baseline and catchup validation must turn SQL NULL into invalid proof");
  assert.match(sanitation, /SET "baselineVerifiedAt" = NULL,[\s\S]*"baselineGeneration" = NULL/);
  assert.match(sanitation, /"status" IN \('COMPLETE'::"AnalyticsCoverageStatus", 'PARTIAL'::"AnalyticsCoverageStatus"\)[\s\S]*THEN 'MISSING'/);
  assert.match(sanitation, /SET "lastCatchupCompletedAt" = NULL,[\s\S]*"lastCatchupGeneration" = NULL/);
});

test("migrated catchup accepts empty source traversal only with explicit successful boundary proof", () => {
  const catchup = sanitation.slice(sanitation.indexOf('WITH "MigratedFinancialCatchup"'));
  assert.match(catchup, /financialMode'[\s\S]*= 'catchup'/);
  assert.match(catchup, /sourceBoundaryReached' = 'true'/);
  assert.match(catchup, /scannerRejected' = '0'/);
  assert.match(catchup, /scanRunId" IS NOT NULL/);
  assert.doesNotMatch(catchup, /CreatorFinancialTransaction/, "empty catchups are valid and must not require a transaction row");
});
