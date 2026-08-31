"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260812024500_team_money_reconciliation_v1/migration.sql");
const reconciliation = read("src/services/team-money-reconciliation-service.js");
const notifications = read("src/services/notification-facts-service.js");
const financial = read("src/services/financial-transactions-service.js");
const analytics = read("src/services/team-analytics-service.js");
const tipLedger = read("src/services/team-tip-ledger-service.js");

function modelBody(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  assert.ok(match, `missing Prisma model ${name}`);
  return match[1];
}

test("Team PPV rows bind relationally to CreatorSale and payout transaction", () => {
  const body = modelBody("TeamPpvPurchaseLedger");
  assert.match(body, /creatorSaleId\s+String\?\s+@unique/);
  assert.match(body, /financialTransactionId\s+String\?\s+@unique/);
  assert.match(body, /financialStatus\s+String\?/);
  assert.match(body, /attributionBasis\s+String\?/);
  assert.match(body, /CreatorSale\?\s+@relation\(fields: \[creatorSaleId\]/);
  assert.match(body, /CreatorFinancialTransaction\?\s+@relation\(fields: \[financialTransactionId\]/);
  assert.match(migration, /TeamPpvPurchaseLedger_creatorSaleId_fkey/);
  assert.match(migration, /TeamPpvPurchaseLedger_financialTransactionId_fkey/);
});

test("Creator Analytics notification and payout ingests reconcile Team money inside their transaction", () => {
  assert.match(notifications, /reconcileCreatorSalesToTeam/);
  assert.match(notifications, /reconcileCreatorTipsToTeam/);
  assert.match(notifications, /existingFacts\(tx, "creatorSale", job\.creatorId, groups\.sale\)/);
  assert.match(notifications, /reconcileCreatorSalesToTeam\(\{ db: tx/);
  assert.match(financial, /const projectedFact = await projectKnownFact\(tx/);
  assert.match(financial, /reconcileCreatorSaleToTeam\(\{ db: tx, saleId: projectedFact\.id \}\)/);
  assert.match(financial, /reconcileCreatorTipToTeam\(\{ db: tx, tipId: projectedFact\.id \}\)/);
});

test("PPV reconciliation is exact-message based and has no last-chatter time heuristic", () => {
  assert.match(reconciliation, /creatorId: sale\.creatorId, messageId/);
  assert.match(reconciliation, /EXACT_MESSAGE_MANUAL/);
  assert.match(reconciliation, /EXACT_MESSAGE_NON_HUMAN/);
  assert.match(reconciliation, /MESSAGE_PROVENANCE_MISSING/);
  assert.doesNotMatch(reconciliation, /last chatter|last_chatter|2 \* 60 \* 60|10 \* 60 \* 1000/i);
});


test("Team tips bind to CreatorTip and recent chatter timing is evidence-only", () => {
  const body = modelBody("TeamTipLedger");
  assert.match(body, /creatorTipId\s+String\?\s+@unique/);
  assert.match(body, /financialStatus\s+String\?/);
  assert.match(body, /attributionBasis\s+String\?/);
  assert.match(body, /CreatorTip\?\s+@relation\(fields: \[creatorTipId\]/);
  assert.match(migration, /TeamTipLedger_creatorTipId_fkey/);
  assert.match(reconciliation, /SINGLE_RECENT_CANDIDATE_EVIDENCE_ONLY/);
  assert.match(reconciliation, /MULTIPLE_RECENT_CANDIDATES_EVIDENCE_ONLY/);
  assert.match(reconciliation, /EXACT_MESSAGE_MANUAL/);
  assert.match(reconciliation, /EXACT_MESSAGE_NON_HUMAN/);
  assert.match(reconciliation, /NO_EXACT_MESSAGE_PROVENANCE/);
  assert.doesNotMatch(tipLedger, /function\s+ingestTipEvent|ingestTipEvent\s*,/, "legacy client tip writer must not return");
});

test("payout undo is excluded from Team PPV money without erasing ownership evidence", () => {
  assert.match(reconciliation, /REFUND_STATUSES = new Set\(\["undo"\]\)/);
  assert.match(analytics, /financialStatus:\s*null/);
  assert.match(analytics, /financialStatus:\s*\{ not: "undo" \}/);
  assert.match(analytics, /ppvFinanciallyActive/);
});

test("historical Team money backfill is relation-driven, DB-only, scheduled, and available from Claims maintenance", () => {
  const scheduler = read("src/services/job-scheduler.js");
  const claims = read("src/routes/team-claims.js");
  assert.match(reconciliation, /teamPpvPurchase:\s*\{ is: null \}/);
  assert.match(reconciliation, /teamTipAttribution:\s*\{ is: null \}/);
  assert.match(reconciliation, /saleType: "MESSAGE"/);
  assert.match(reconciliation, /purchasedAt: \{ gte: detailedSince \}/);
  assert.match(reconciliation, /tippedAt: \{ gte: detailedSince \}/);
  assert.match(reconciliation, /reconcileHistoricalTeamMoneyBatch/);
  assert.match(scheduler, /TEAM_MONEY_BACKFILL_BATCH_SIZE = 250/);
  assert.match(scheduler, /maybeReconcileHistoricalTeamMoney/);
  assert.match(scheduler, /const retention = await maybeRunRetentionSweep/);
  assert.match(scheduler, /const teamMoneyBackfill = await maybeReconcileHistoricalTeamMoney/);
  assert.match(scheduler, /reconcileHistoricalTeamMoneyBatch/);
  assert.match(claims, /canonicalMoneyBackfill/);
  assert.match(claims, /reconcileHistoricalTeamMoneyBatch/);
});
