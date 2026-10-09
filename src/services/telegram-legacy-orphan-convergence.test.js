"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const migration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const delivery = read("src/services/telegram-delivery-authority-service.js");
const inbound = read("src/services/telegram-inbound-authority-service.js");
const operatorQueueMigration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const precommitExecutionMigration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");

function section(source, start, end) {
  const a = source.indexOf(start);
  const b = end ? source.indexOf(end, a + start.length) : source.length;
  return a >= 0 ? source.slice(a, b >= 0 ? b : source.length) : "";
}





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



test("manual proven-not-sent orphan resolution is terminal and cannot recreate scheduler poison", () => {
  const block = section(delivery, "async function reconcileTelegramDeliveryIntent", "async function planTaskIntentForCommittedOrder");
  assert.match(block, /PROVEN_NOT_SENT_ORPHAN:/);
  assert.match(block, /state:\s*"CANCELLED"/);
  assert.match(block, /orphanCustomOrder:\s*orphan/);
});
