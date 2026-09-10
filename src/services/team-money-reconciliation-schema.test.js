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

test("Creator Analytics canonical transactions publish exact Team money work instead of running a second inline writer", () => {
  assert.match(notifications, /dispatchTeamMoneyReconciliationForCanonicalFact/);
  assert.match(notifications, /existingFacts\(tx, "creatorSale", job\.creatorId, groups\.sale\)/);
  assert.match(notifications, /dispatchTeamMoneyReconciliationForCanonicalFact\(\{ db: tx,[\s\S]*sourceType: "PPV"/);
  assert.match(notifications, /dispatchTeamMoneyReconciliationForCanonicalFact\(\{ db: tx,[\s\S]*sourceType: "TIP"/);
  assert.doesNotMatch(notifications, /reconcileCreatorSalesToTeam|reconcileCreatorTipsToTeam/);
  assert.match(financial, /const projectedFact = await projectKnownFact\(tx/);
  assert.match(financial, /dispatchTeamMoneyReconciliationForCanonicalFact\(\{ db: tx,[\s\S]*sourceType: "PPV"/);
  assert.match(financial, /dispatchTeamMoneyReconciliationForCanonicalFact\(\{ db: tx,[\s\S]*sourceType: "TIP"/);
  assert.doesNotMatch(financial, /reconcileCreatorSaleToTeam\(\{ db: tx|reconcileCreatorTipToTeam\(\{ db: tx/);
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

test("historical Team money is per-agency coverage driven and Claims only requests that authority", () => {
  const scheduler = read("src/services/job-scheduler.js");
  const claims = read("src/routes/team-claims.js");
  const coverage = read("src/services/phase2-work-coverage-authority-service.js");
  assert.doesNotMatch(reconciliation, /reconcileHistoricalTeamMoneyBatch/, "retired global historical writer must not remain importable after DomainWork cutover");
  assert.match(scheduler, /runTeamMoneyReconciliationCoverageEnumerationUnit/);
  assert.match(scheduler, /PHASE2_WORK_CLASS\.TEAM_MONEY_RECONCILIATION/);
  assert.match(scheduler, /maybeReconcileHistoricalTeamMoney/);
  assert.doesNotMatch(scheduler, /TEAM_MONEY_BACKFILL_BATCH_SIZE/);
  assert.doesNotMatch(scheduler, /await reconcileHistoricalTeamMoneyBatch/);
  assert.match(coverage, /requestPhase2CoverageEnumeration/);
  assert.match(claims, /requestPhase2CoverageEnumeration/);
  assert.match(claims, /PHASE2_DOMAIN_WORK_OWNS_RECONCILIATION/);
  assert.doesNotMatch(claims, /reconcileHistoricalTeamMoneyBatch|migrateLegacyTipsToTipLedger|repairMigratedLegacyTipManualAuthority/);
});
