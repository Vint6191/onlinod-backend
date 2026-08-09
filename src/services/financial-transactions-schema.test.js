"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260808152000_financial_transactions_v1/migration.sql");
const targetConstraintMigration = read("prisma/migrations/20260808163500_financial_sale_partial_target_v1/migration.sql");
const service = read("src/services/financial-transactions-service.js");
const control = read("src/services/financial-transaction-scan-control-service.js");
const results = read("src/services/job-result-service.js");
const routes = read("src/routes/stats.js");
const catalog = read("src/services/job-catalog.js");

function modelBody(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  assert.ok(match, `missing Prisma model ${name}`);
  return match[1];
}

test("all-time financial source ledger is relational, typed and user-optional", () => {
  const body = modelBody("CreatorFinancialTransaction");
  assert.doesNotMatch(body, /\bJson\??\b/);
  assert.match(body, /fanId\s+String\?/);
  assert.match(body, /fanOnlyFansUserId\s+String\?/);
  assert.match(body, /externalTransactionId\s+String/);
  assert.match(body, /transactionType\s+String/);
  assert.match(body, /amountCents\s+Int/);
  assert.match(body, /feeCents\s+Int\?/);
  assert.match(body, /netCents\s+Int\?/);
  assert.match(body, /@@unique\(\[creatorId, externalTransactionId\]\)/);
  assert.match(body, /CreatorFan\?\s+@relation\(fields: \[creatorId, fanId\]/);
  assert.match(schema, /FINANCIAL_TRANSACTIONS/);
  assert.match(schema, /enum CreatorFinancialTransactionFactType/);
  assert.match(schema, /enum CreatorFinancialTransactionProjectionStatus/);
});

test("migration preserves signed source money and never introduces raw JSON", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "CreatorFinancialTransaction"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "CreatorEarningsTotal"/);
  assert.match(migration, /CreatorFinancialTransaction_creatorId_externalTransactionId_key/);
  assert.match(migration, /Monetary fields in the source transaction ledger are intentionally signed/);
  assert.doesNotMatch(migration, /CreatorFinancialTransaction_amount_nonnegative_check/);
  assert.doesNotMatch(migration, /\bJSONB\b/i);
});

test("payout MESSAGE/POST sales may be typed before their target id is known", () => {
  assert.match(targetConstraintMigration, /DROP CONSTRAINT IF EXISTS "CreatorSale_target_consistency_check"/);
  assert.match(targetConstraintMigration, /"saleType" = 'MESSAGE'[\s\S]*"postId" IS NULL[\s\S]*"messageId" IS NOT NULL OR "externalTransactionId" IS NOT NULL/);
  assert.match(targetConstraintMigration, /"saleType" = 'POST'[\s\S]*"messageId" IS NULL[\s\S]*"postId" IS NOT NULL OR "externalTransactionId" IS NOT NULL/);
  assert.match(targetConstraintMigration, /ADD CONSTRAINT "CreatorSale_target_consistency_check"/);
});

test("ingest keeps unavailable-user and unknown-type transactions as durable facts", () => {
  assert.match(service, /if \(!row\.fanOnlyFansUserId\) return null/);
  assert.match(service, /projectionStatus: "STORED_ONLY"/);
  assert.match(service, /reasonCode: "unmapped_transaction_type"/);
  assert.match(service, /nonpositive_transaction_not_projected/);
  assert.match(service, /creatorFinancialTransaction\.create/);
  assert.match(service, /creatorFinancialTransaction\.update/);
  assert.match(service, /creatorId_externalTransactionId/);
  assert.match(service, /uniqueLegacyProjectionCandidate/);
  assert.match(service, /acceptedByTransactionId = new Map/);
  assert.match(service, /externalTransactionId: null/);
  assert.match(service, /purchasedAt: \{ gte, lte \}/);
  assert.match(service, /tippedAt: \{ gte, lte \}/);
  const saleUpdate = service.slice(service.indexOf('if (row.factType === "SALE")'), service.indexOf('if (row.factType === "TIP")'));
  assert.doesNotMatch(saleUpdate, /messageId:\s*null.*data:\s*update/s, "payout updates must not erase an existing message target");
  const sourceWrite = service.indexOf("creatorFinancialTransaction.create");
  const projection = service.indexOf("projectKnownFact", sourceWrite);
  assert.ok(sourceWrite >= 0 && projection > sourceWrite, "source transaction must be durable before business projection");
});

test("financial ingest is safe when job lease passes a Prisma TransactionClient", () => {
  assert.match(service, /typeof db\.\$transaction === "function"/);
  assert.match(service, /return callback\(db\)/);
  assert.match(service, /await runInTransaction\(db, async \(tx\) =>/);
  const ingestStart = service.indexOf("async function ingestFinancialTransactionsChunk");
  const chartStart = service.indexOf("async function ingestFinancialChartChunk", ingestStart);
  const ingestBody = service.slice(ingestStart, chartStart);
  assert.doesNotMatch(ingestBody, /await db\.\$transaction\(/, "lease TransactionClient must not be nested in another transaction");
});

test("completion reconciles OF earnings after undo refunds while keeping loading as payout pending", () => {
  assert.match(service, /REFUND_TRANSACTION_STATUSES = new Set\(\["undo"\]\)/);
  assert.match(service, /PAYOUT_PENDING_TRANSACTION_STATUSES = new Set\(\["loading"\]\)/);
  assert.match(service, /earningsTransactionsCount = Math\.max\(0, count - statusTotals\.refundTransactionsCount\)/);
  assert.match(service, /earningsGrossCents = grossCents - statusTotals\.refundGrossCents/);
  assert.match(service, /earningsNetCents = netCents - statusTotals\.refundNetCents/);
  assert.match(service, /countMatched = chartReady \? earningsTransactionsCount/);
  assert.match(service, /sourceBoundaryReached/);
  assert.match(service, /scannerRejected === 0/);
  assert.match(service, /chartTotal\.sourceJobId === job\.id/);
  assert.match(service, /chartTotal\.scanRunId === scanRunId/);
  assert.match(control, /statusSummary/);
  assert.match(control, /refundTransactionsCount/);
});

test("financial scanner has its own manual job and endpoints, independent of notifications", () => {
  assert.match(catalog, /financial_transactions_scan/);
  assert.match(control, /manualFinancialTransactionScan:\s*true/);
  assert.match(control, /const snapshotMarker = Math\.floor\(now\.getTime\(\) \/ 1000\)/);
  assert.match(control, /initialMarker:\s*snapshotMarker/);
  assert.match(control, /endDate:\s*onlyFansUtcDateTime\(new Date\(snapshotMarker \* 1000\)\)/);
  assert.match(control, /status:\s*"PAUSED"/);
  assert.match(routes, /financial-transaction-scan\/start/);
  assert.match(routes, /financial-transaction-scan\/stop/);
  const financialBlockStart = routes.indexOf("Manual all-time payout transaction scanner");
  const liveNotificationsStart = routes.indexOf('router.post("/creators/:creatorId/notifications/live"', financialBlockStart);
  const financialBlock = routes.slice(financialBlockStart, liveNotificationsStart);
  assert.doesNotMatch(financialBlock, /startManualNotificationScan|notification-scan\/start/);
  assert.match(financialBlock, /requireEarningsPermission\(res, ctx\.member\)/);
});

test("job result routing persists every page and chart before completion", () => {
  assert.match(results, /financial_transactions_page/);
  assert.match(results, /ingestFinancialTransactionsChunk/);
  assert.match(results, /financial_chart_total/);
  assert.match(results, /ingestFinancialChartChunk/);
  assert.match(results, /completeFinancialTransactionsScan/);
});
