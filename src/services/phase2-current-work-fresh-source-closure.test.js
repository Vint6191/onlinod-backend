"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function block(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `missing ${start}`);
  const b = end ? source.indexOf(end, a + start.length) : source.length;
  assert.ok(b > a, `missing end ${end}`);
  return source.slice(a, b);
}

test("hourly Agency model convergence owns only indexed provider-binding retry work", () => {
  const source = read("services/telegram-delivery-authority-service.js");
  const direct = block(source, "async function repairCustomModelCommunicationConvergence", "async function markTelegramDeliveryProvenNotSent");
  assert.match(direct, /repairPrecommitProviderBlockedIntents/);
  assert.doesNotMatch(direct, /scanAllById/);
  assert.doesNotMatch(direct, /ensureInitialTaskIntents/);
  assert.doesNotMatch(direct, /ensureRevisionRequestIntents/);
  assert.doesNotMatch(direct, /reprojectCustomReminderSchedule/);
  assert.match(direct, /currentBacklog/);
});

test("order-bound model communication repair is owned by bounded provider dirty/backfill lanes", () => {
  const scheduler = read("services/job-scheduler.js");
  const backfill = block(scheduler, "async function maybeBackfillProviderOperationalDebt", "async function maybeRepairProviderOperationalDirty");
  const dirty = block(scheduler, "async function maybeRepairProviderOperationalDirty", "async function runCustomExternalProofConvergenceSweep");
  for (const lane of [backfill, dirty]) {
    assert.match(lane, /repairCurrentCustomModelCommunicationForOrder/);
    assert.match(lane, /reconcileProviderOperationalDebtForOrder/);
    assert.match(lane, /markClean:\s*communication\?\.ok !== false/);
  }
});

test("creator/provider binding changes reopen only affected pending Custom work", () => {
  const migration = read("../prisma/migrations/20260909211500_phase2_current_work_coordination/migration.sql");
  assert.match(migration, /CreatorAccount_provider_operational_dirty/);
  assert.match(migration, /AFTER UPDATE OF "telegramContact", "telegramUserId", "telegramAccountId", "status", "deletedAt"/);
  assert.match(migration, /AgencyTelegramMtprotoAccount_provider_operational_dirty/);
  assert.match(migration, /AFTER UPDATE OF "lifecycleState"/);
  assert.match(migration, /"providerOperationalDirty" = TRUE/);
});

test("Telegram/custom maintenance retries quickly when indexed current retry backlog remains", () => {
  const scheduler = read("services/job-scheduler.js");
  const lane = block(scheduler, "async function runTelegramConfirmedProjectionMaintenanceSweep", "async function maybeBackfillTeamPendingProjection");
  assert.match(lane, /modelCommunicationCurrentBacklog/);
  assert.match(lane, /retryFast \? 1_000 : RECURRING_INTERVAL_MS/);
});

test("provider-thread retirement candidates are indexed by this account current debt", () => {
  const source = read("services/custom-provider-thread-retention-authority-service.js");
  const candidate = block(source, "async function candidateCurrentOrderIdsForAccount", "async function findCustomProviderThreadRetentionBlockerForOrder");
  assert.match(candidate, /providerOperationalDebt/);
  assert.match(candidate, /CURRENT_PROVIDER_THREAD_CAPABILITY/);
  assert.doesNotMatch(candidate, /customOrder\.findMany/);
  assert.doesNotMatch(candidate, /status:\s*"PENDING"/);
});


test("execution account discovery projects distinct current provider accounts without a 5000-row truncation", () => {
  const runtime = read("services/telegram-execution-runtime.js");
  assert.match(runtime, /listCurrentIncompleteSourceAccountsForCreators/);
  assert.match(runtime, /listProviderOperationalAccountsForCreators/);
  assert.doesNotMatch(runtime, /limit:\s*5000/);
  const authority = read("services/provider-operational-debt-authority-service.js");
  const sourceAccounts = block(authority, "async function listCurrentIncompleteSourceAccountsForCreators", "async function listProviderOperationalAccountsForCreators");
  const debtAccounts = block(authority, "async function listProviderOperationalAccountsForCreators", "async function countProviderOperationalDebt");
  assert.match(sourceAccounts, /SELECT DISTINCT "creatorId", "telegramSourceAccountId"/);
  assert.doesNotMatch(sourceAccounts, /LIMIT 5000/);
  assert.match(debtAccounts, /SELECT DISTINCT "creatorId", "accountId", "debtClass"/);
  assert.doesNotMatch(debtAccounts, /LIMIT 5000/);
});

test("retired provider/current-work compatibility authorities cannot be reintroduced as production exports", () => {
  const exact = read("services/telegram-exact-authority-scan-service.js");
  const delivery = read("services/telegram-delivery-authority-service.js");
  const operational = read("services/provider-operational-debt-authority-service.js");
  assert.doesNotMatch(exact, /findPendingModelInstructionAnchors|findPendingTaskAnchors|findCancelledModelInstructionFollowupDebt|findCancelledTaskFollowupDebt|findConfirmedTelegramProjectionDebt|scanIncompleteTelegramSources/);
  assert.doesNotMatch(delivery, /async function ensureInitialTaskIntents|async function ensureRevisionRequestIntents/);
  assert.doesNotMatch(operational, /async function listCurrentIncompleteSourcesForCreators|async function listProviderOperationalDebtForCreators/);
});
