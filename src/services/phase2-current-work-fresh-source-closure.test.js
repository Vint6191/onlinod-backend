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
  assert.doesNotMatch(direct, /ensureAutomaticReminderIntents/);
  assert.match(direct, /currentBacklog/);
});

test("order-bound live communication uses revision/fence work; historical enumeration only publishes bounded current work", () => {
  const scheduler = read("services/job-scheduler.js");
  const enumeration = block(scheduler, "async function runProviderCoverageEnumerationUnit", "async function runExternalCoverageEnumerationUnit");
  const live = block(scheduler, "async function maybeRepairProviderOperationalDirty", "async function listDependencyFanoutOrders");
  assert.match(enumeration, /reconcileProviderOperationalDebtForOrder/);
  assert.match(enumeration, /publishDomainWork/);
  assert.match(enumeration, /CUSTOM_COMMUNICATION/);
  assert.doesNotMatch(enumeration, /repairCurrentCustomModelCommunicationForOrder/, "historical enumeration must not execute provider communication side effects inline");
  assert.match(live, /claimDomainWorkBatch/);
  assert.match(live, /CUSTOM_COMMUNICATION/);
  assert.match(live, /repairClaimedCustomModelCommunicationWork/);
  assert.doesNotMatch(live, /repairCurrentCustomModelCommunicationForOrder/, "scheduler must not bypass the claimed communication commit authority");
  assert.doesNotMatch(live, /reconcileProviderOperationalDebtForOrder/, "provider projection belongs inside the same claimed transaction");
  assert.match(live, /ackDomainWorkClaim/);
  assert.doesNotMatch(live, /providerOperationalDirty:\s*true/);

  const telegram = read("services/telegram-delivery-authority-service.js");
  const claimedCommit = block(telegram, "async function repairClaimedCustomModelCommunicationWork", "async function repairCurrentCustomModelCommunicationForOrder");
  assert.match(claimedCommit, /lockClaimedCustomCommunicationOrder/);
  assert.match(claimedCommit, /lockDomainWorkClaimForCommit/);
  assert.match(claimedCommit, /authority\.newerRevision/);
  assert.match(claimedCommit, /repairCurrentCustomModelCommunicationForOrder/);
  assert.match(claimedCommit, /reconcileProviderOperationalDebtForOrder/);
});



test("Telegram confirmed current work retries through DomainWork due time on the fast Phase2 pump", () => {
  const scheduler = read("services/job-scheduler.js");
  const domainWork = read("services/domain-work-authority-service.js");
  const live = block(scheduler, "async function runTelegramConfirmedProjectionSweep", "async function runTelegramConfirmedProjectionMaintenanceSweep");
  const lane = block(scheduler, "async function runTelegramConfirmedProjectionMaintenanceSweep", "async function maybeBackfillTeamPendingProjection");
  assert.match(live, /claimDomainWorkBatch/);
  assert.match(live, /TELEGRAM_CONFIRMED_PROJECTION/);
  assert.match(live, /failDomainWorkClaim/);
  assert.match(domainWork, /availableAt:\s*due/);
  assert.match(domainWork, /nextAttemptAt:\s*due/);
  assert.match(scheduler, /PHASE2_MAINTENANCE_PUMP_INTERVAL_MS\s*=\s*5\s*\*\s*1000/);
  assert.match(lane, /return runTelegramConfirmedProjectionSweep\(\{ now, db \}\)/);
  assert.doesNotMatch(lane, /RECURRING_INTERVAL_MS|runMaintenanceLane/, "DomainWork due clock, not an hourly lane, owns retry eligibility");
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



