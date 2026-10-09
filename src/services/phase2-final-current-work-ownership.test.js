"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const scheduler = read("src/services/job-scheduler.js");
const migration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");

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








test("TEAM_READ_SUMMARY coverage cannot activate while a newer DomainWork revision is outstanding", () => {
  const body = block("runTeamReadSummaryCoverageEnumerationUnit", "runTelegramConfirmedCoverageEnumerationUnit");
  assert.match(body, /hasOutstandingDomainWork/);
  assert.match(body, /PHASE2_WORK_CLASS\.TEAM_READ_SUMMARY/);
  assert.match(body, /missing\?\.length[\s\S]*outstanding/);
  assert.ok(body.indexOf("if (Number(missing?.length || 0) > 0 || outstanding)") < body.indexOf("markPhase2CoverageComplete"));
});
