"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(name) { return fs.readFileSync(path.join(__dirname, name), "utf8"); }

test("provider retirement is current-debt driven and does not import historical retirement scanners", () => {
  const source = read("telegram-provider-capability-control-authority-service.js");
  assert.match(source, /requireProviderOperationalBackfillReady/);
  assert.match(source, /listProviderOperationalDebtForAccount/);
  assert.match(source, /dirtyOrderIdsForAccount/);
  assert.match(source, /assertAccountDirtyWorkDrained/);
  assert.doesNotMatch(source, /reconcileProviderOperationalDebtForOrder/, "retirement must not repair CustomOrder rows while holding the account fence");
  assert.doesNotMatch(source, /findCancelledModelInstructionFollowupDebt/);
  assert.doesNotMatch(source, /scanIncompleteTelegramSources/);
  assert.doesNotMatch(source, /findCustomProviderThreadRetentionBlocker\s*[,}]/);
});

test("confirmed Telegram projection repair consumes operational debt instead of all confirmed history", () => {
  const source = read("telegram-delivery-authority-service.js");
  const start = source.indexOf("async function repairConfirmedTelegramDeliveryProjections");
  const end = source.indexOf("\nasync function ", start + 20);
  const body = source.slice(start, end > start ? end : source.length);
  assert.match(body, /ProviderOperationalDebt|providerOperationalDebt/);
  assert.doesNotMatch(body, /findCancelledModelInstructionFollowupDebt/);
  assert.doesNotMatch(body, /findPendingModelInstructionAnchors/);
  assert.doesNotMatch(body, /kind:\s*"TASK"[^\n]*state:\s*"CONFIRMED"/);
  assert.doesNotMatch(body, /kind:\s*"REFERENCE"[^\n]*state:\s*"CONFIRMED"/);
});

test("provider debt migration installs current-work storage and exact dirty triggers", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260909211500_phase2_current_work_coordination/migration.sql"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "ProviderOperationalDebt"/);
  assert.match(migration, /CustomOrder_provider_operational_work_idx/);
  assert.match(migration, /TelegramDeliveryIntent_provider_operational_dirty/);
  assert.match(migration, /CustomContentSubmission_provider_operational_dirty/);
  assert.match(migration, /CustomOrder_provider_operational_state_dirty/);
  assert.match(migration, /AutomationDelivery_custom_external_projection_debt/);
  assert.match(migration, /CUSTOM_EXTERNAL_PROJECTION_DEBT/);
});

test("historical Custom external-proof discovery is per-agency finite enumeration, not a recurring history scan", () => {
  const source = read("job-scheduler.js");
  const enumerationStart = source.indexOf("async function runExternalCoverageEnumerationUnit");
  const enumerationEnd = source.indexOf("\nasync function ", enumerationStart + 20);
  const enumeration = source.slice(enumerationStart, enumerationEnd > enumerationStart ? enumerationEnd : source.length);
  assert.match(enumeration, /convergeHistoricalCustomExternalProofs/);
  assert.match(enumeration, /item\.agencyId/);
  assert.match(enumeration, /markPhase2CoverageComplete/);
  assert.match(enumeration, /yieldDomainWorkClaim/);
  const hotStart = source.indexOf("async function runCustomExternalProofConvergenceSweep");
  const hotEnd = source.indexOf("\nasync function ", hotStart + 20);
  const hot = source.slice(hotStart, hotEnd > hotStart ? hotEnd : source.length);
  assert.doesNotMatch(hot, /convergeHistoricalCustomExternalProofs/);
  assert.match(hot, /PHASE2_WORK_CLASS\.CUSTOM_EXTERNAL_PROJECTION/);
  assert.match(hot, /repairCustomExternalProjectionWorkItem/);
  assert.match(hot, /claimDomainWorkBatch/);
  assert.doesNotMatch(hot, /repairCurrentCustomExternalProjectionDebt|runMaintenanceLane/);
});

test("Telegram runtime eligibility uses current provider worksets instead of historical source/model scans", () => {
  const source = read("telegram-execution-runtime.js");
  assert.match(source, /listCurrentIncompleteSourceAccountsForCreators/);
  assert.match(source, /listProviderOperationalAccountsForCreators/);
  assert.doesNotMatch(source, /scanIncompleteTelegramSources/);
  assert.doesNotMatch(source, /findPendingModelInstructionAnchors/);
});


test("hot Custom lifecycle blockers do not cursor-scan completed external-write history", () => {
  const source = read("custom-content-pipeline-authority-service.js");
  const start = source.indexOf("async function creatorCustomPipelineBlockers");
  const body = source.slice(start);
  assert.match(body, /CUSTOM_EXTERNAL_PROJECTION_DEBT/);
  assert.doesNotMatch(body, /findCompletedCustomExternalProjectionDebt/);
  assert.doesNotMatch(body, /status:\s*"COMPLETED"[\s\S]{0,160}CUSTOM_RELAY_SEND/);
});
