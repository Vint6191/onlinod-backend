"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const scheduler = read("src/services/job-scheduler.js");
const migration = read("prisma/migrations/20260910130000_phase2_final_current_work_ownership/migration.sql");

function block(name, next) {
  const start = scheduler.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = next ? scheduler.indexOf(`async function ${next}`, start + 1) : -1;
  return scheduler.slice(start, end > start ? end : undefined);
}

test("CUSTOM_EXTERNAL_PROJECTION current execution is exact AutomationDelivery DomainWork, not debt-table maintenance scan", () => {
  const body = block("runCustomExternalProofConvergenceSweep", "runTelegramInboundProjectionSweep");
  assert.match(body, /claimDomainWorkBatch\(\{[\s\S]*PHASE2_WORK_CLASS\.CUSTOM_EXTERNAL_PROJECTION/);
  assert.match(body, /objectType\) !== "AutomationDelivery"/);
  assert.match(body, /repairCustomExternalProjectionWorkItem/);
  assert.match(body, /ackDomainWorkClaim/);
  assert.match(body, /failDomainWorkClaim/);
  assert.doesNotMatch(body, /runMaintenanceLane|repairCurrentCustomExternalProjectionDebt/);
});

test("AutomationDelivery producer publishes exact external work only after valid Custom debt projection and ordinary automation avoids generic debt lookup", () => {
  assert.match(migration, /'CUSTOM_EXTERNAL_PROJECTION','AutomationDelivery',NEW\."id"/);
  assert.match(migration, /DELETE FROM "ProviderOperationalDebt" WHERE "id"=\('pod_external_' \|\| NEW\."id"\)/);
  assert.match(migration, /IF NEW\."actionType" NOT IN \('CUSTOM_RELAY_SEND','CUSTOM_MANUAL_SEND'\)/);
  assert.doesNotMatch(migration, /DELETE FROM "ProviderOperationalDebt"\s+WHERE "debtClass"='CUSTOM_EXTERNAL_PROJECTION_DEBT'/);
});


test("Claims sweep cannot execute Team money reconciliation inline", () => {
  const claims = read("src/routes/team-claims.js");
  assert.match(claims, /requestPhase2CoverageEnumeration/);
  assert.match(claims, /TEAM_MONEY_RECONCILIATION/);
  assert.match(claims, /PHASE2_DOMAIN_WORK_OWNS_RECONCILIATION/);
  assert.doesNotMatch(claims, /reconcileHistoricalTeamMoneyBatch|migrateLegacyTipsToTipLedger|repairMigratedLegacyTipManualAuthority/);
});


test("Team money canonical producer invalidates on identity and money-attribution changes, not only amount", () => {
  const saleTrigger = migration.match(/CREATE TRIGGER "CreatorSale_phase2_team_money_work"[\s\S]*?ON "CreatorSale" FOR EACH ROW/);
  const tipTrigger = migration.match(/CREATE TRIGGER "CreatorTip_phase2_team_money_work"[\s\S]*?ON "CreatorTip" FOR EACH ROW/);
  assert.ok(saleTrigger, "CreatorSale Team-money producer trigger must exist");
  assert.ok(tipTrigger, "CreatorTip Team-money producer trigger must exist");
  for (const column of ["fanId", "externalNotificationId", "eventFingerprint", "saleType", "messageId", "amountCents", "currency", "purchasedAt", "transactionStatus", "externalTransactionId"]) {
    assert.match(saleTrigger[0], new RegExp(`"${column}"`), `CreatorSale trigger must invalidate on ${column}`);
  }
  for (const column of ["fanId", "externalNotificationId", "eventFingerprint", "messageId", "amountCents", "currency", "tippedAt", "transactionStatus", "externalTransactionId"]) {
    assert.match(tipTrigger[0], new RegExp(`"${column}"`), `CreatorTip trigger must invalidate on ${column}`);
  }
});


test("Team dialog historical verification has a semantic pre-LIMIT partial index", () => {
  assert.match(migration, /TeamActivityEvent_dialog_projection_enumeration_v1_idx/);
  assert.match(migration, /ON "TeamActivityEvent"\("agencyId","id"\)[\s\S]*?dialogProjectionVersion[\s\S]*?FAN_MESSAGE_RECEIVED[\s\S]*?MESSAGE_SEND_CONFIRMED[\s\S]*?MANUAL[\s\S]*?CONFIRMED/);
});


test("TEAM_READ_SUMMARY coverage cannot activate while a newer DomainWork revision is outstanding", () => {
  const body = block("runTeamReadSummaryCoverageEnumerationUnit", "runTelegramConfirmedCoverageEnumerationUnit");
  assert.match(body, /workClass"='TEAM_READ_SUMMARY'/);
  assert.match(body, /requestedRevision/);
  assert.match(body, /completedRevision/);
  assert.match(body, /missing\?\.length[\s\S]*outstanding/);
  assert.ok(body.indexOf("if (Number(missing?.length || 0) > 0 || outstanding)") < body.indexOf("markPhase2CoverageComplete"));
});
