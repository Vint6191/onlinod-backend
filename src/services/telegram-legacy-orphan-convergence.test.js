"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const migration = read("prisma/migrations/20260906213000_telegram_legacy_orphan_convergence/migration.sql");
const delivery = read("src/services/telegram-delivery-authority-service.js");
const inbound = read("src/services/telegram-inbound-authority-service.js");
const operatorQueueMigration = read("prisma/migrations/20260906220000_telegram_operator_queue_indexes/migration.sql");
const precommitExecutionMigration = read("prisma/migrations/20260906223000_telegram_precommit_execution_observability/migration.sql");

function section(source, start, end) {
  const a = source.indexOf(start);
  const b = end ? source.indexOf(end, a + start.length) : source.length;
  return a >= 0 ? source.slice(a, b >= 0 ? b : source.length) : "";
}

test("legacy orphan migration terminalizes only proven-precommit Telegram intents and preserves provider outcome evidence", () => {
  assert.match(migration, /i\."state" IN \('PLANNED', 'CLAIMED', 'FAILED_PRECOMMIT'\)/);
  assert.match(migration, /i\."commitStartedAt" IS NULL/);
  assert.match(migration, /NOT EXISTS \([\s\S]*FROM "CustomOrder"/);
  const intentUpdate = section(migration, 'UPDATE "TelegramDeliveryIntent"', '-- Unknown/confirmed outcomes');
  assert.doesNotMatch(intentUpdate, /COMMITTING/);
  assert.doesNotMatch(intentUpdate, /RECONCILE_REQUIRED/);
  assert.doesNotMatch(intentUpdate, /CONFIRMED/);
});

test("historical orphan inbound is routed to audited review rather than erased or retried forever", () => {
  assert.match(migration, /"projectionState" = 'REVIEW_REQUIRED'/);
  assert.match(migration, /LEGACY_ORPHAN_BUSINESS_CONTEXT/);
  assert.match(migration, /e\."submissionId" IS NULL/);
  assert.match(migration, /NOT EXISTS \([\s\S]*FROM "CreatorAccount"/);
  assert.match(migration, /NOT EXISTS \([\s\S]*FROM "CustomOrder"/);
  assert.match(inbound, /LEGACY_ORPHAN_BUSINESS_CONTEXT/);
});

test("executable Telegram work excludes unknown-outcome reconciliation backlog", () => {
  const block = section(delivery, "async function listTelegramDeliveryWork", "async function claimTelegramDeliveryIntent");
  assert.match(block, /state:\s*\{\s*in:\s*\["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"\]\s*\}/);
  assert.doesNotMatch(block, /in:\s*\[[^\]]*RECONCILE_REQUIRED/);
});

test("provider/runtime precommit failures share one visible proven-no-effect queue", () => {
  const block = section(delivery, "async function listTelegramDeliveryPrecommitBlockedQueue", "async function listTelegramReminderPlanningBlockedQueue");
  assert.match(block, /PRECOMMIT_PROVIDER_UNAVAILABLE:/);
  assert.match(block, /FAILED_PRECOMMIT:/);
  assert.match(block, /externalEffectStarted:\s*false/);
  assert.match(block, /state:\s*"PLANNED"/);
  assert.match(block, /state:\s*"FAILED_PRECOMMIT"/);
  assert.match(block, /commitStartedAt:\s*null/);
});


test("due reminder planning blockage is visible without fabricating a Telegram delivery intent", () => {
  const block = section(delivery, "async function listTelegramReminderPlanningBlockedQueue", "async function reconcileTelegramDeliveryIntent");
  assert.match(block, /externalEffectStarted:\s*false/);
  assert.match(block, /AUTO_REMINDER/);
  assert.match(block, /CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED/);
  assert.match(block, /CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING/);
  assert.doesNotMatch(block, /createOrReadIntent\s*\(/);
});

test("Telegram operator exception queues have partial production indexes", () => {
  assert.match(operatorQueueMigration, /TelegramDeliveryIntent_precommit_provider_blocked_queue_idx/);
  assert.match(operatorQueueMigration, /WHERE "state" = 'PLANNED'/);
  assert.match(operatorQueueMigration, /"commitStartedAt" IS NULL/);
  assert.match(operatorQueueMigration, /PRECOMMIT_PROVIDER_UNAVAILABLE:%/);
  assert.match(operatorQueueMigration, /TelegramDeliveryIntent_reconciliation_queue_idx/);
  assert.match(operatorQueueMigration, /WHERE "state" = 'RECONCILE_REQUIRED'/);
  const precommitBackfill = section(
    precommitExecutionMigration,
    'UPDATE "TelegramDeliveryIntent"',
    '-- Keep the operator read model index-backed',
  );
  assert.match(precommitBackfill, /SET "state" = 'FAILED_PRECOMMIT'/);
  assert.match(precommitBackfill, /WHERE "state" = 'PLANNED'/);
  assert.match(precommitBackfill, /"commitStartedAt" IS NULL/);
  assert.match(precommitBackfill, /"outcomeReason" LIKE 'FAILED_PRECOMMIT:%'/);
  assert.doesNotMatch(precommitBackfill, /COMMITTING|RECONCILE_REQUIRED|CONFIRMED/);
  assert.match(precommitExecutionMigration, /TelegramDeliveryIntent_failed_precommit_queue_idx/);
  assert.match(precommitExecutionMigration, /WHERE "state" = 'FAILED_PRECOMMIT'/);
  assert.match(precommitExecutionMigration, /"commitStartedAt" IS NULL/);
});

test("manual proven-not-sent orphan resolution is terminal and cannot recreate scheduler poison", () => {
  const block = section(delivery, "async function reconcileTelegramDeliveryIntent", "async function planTaskIntentForCommittedOrder");
  assert.match(block, /PROVEN_NOT_SENT_ORPHAN:/);
  assert.match(block, /state:\s*"CANCELLED"/);
  assert.match(block, /orphanCustomOrder:\s*orphan/);
});
