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
  assert.match(source, /reconcileProviderOperationalDebtForOrder/);
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

test("historical Custom external-proof discovery is owned by a one-time maintenance generation", () => {
  const source = read("job-scheduler.js");
  assert.match(source, /CUSTOM_EXTERNAL_PROOF_BACKFILL_LANE_KEY/);
  const start = source.indexOf("async function runCustomExternalProofConvergenceSweep");
  const end = source.indexOf("\nasync function ", start + 20);
  const body = source.slice(start, end > start ? end : source.length);
  assert.match(body, /runMaintenanceLane/);
  assert.match(body, /oneTime:\s*true/);
  assert.match(body, /CUSTOM_EXTERNAL_CURRENT_DEBT_LANE_KEY/);
  assert.match(body, /repairCurrentCustomExternalProjectionDebt/);
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
