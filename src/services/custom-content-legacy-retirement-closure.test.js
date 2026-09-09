"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260906133000_legacy_retired_custom_order_telegram_closure/migration.sql");
const workflow = read("src/services/custom-content-workflow-service.js");
const delivery = read("src/services/telegram-delivery-authority-service.js");
const providerDebt = read("src/services/provider-operational-debt-authority-service.js");
const cancellationInstruction = read("src/services/custom-cancellation-instruction-authority-service.js");

test("legacy retired Custom closure records cancellation waiver as control truth, never provider confirmation", () => {
  const order = schema.match(/model CustomOrder \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(order, /telegramCancellationWaivedAt\s+DateTime\?/);
  assert.match(order, /telegramCancellationWaiverReason\s+String\?/);
  assert.match(migration, /telegramCancellationWaivedAt/);
  assert.match(migration, /task\."state" = 'CONFIRMED'/);
  assert.match(migration, /task\."remoteMessageId" IS NOT NULL/);
  assert.match(migration, /o\."telegramTaskMessageId" IS NULL OR o\."telegramTaskMessageId" = task\."remoteMessageId"/);
  assert.match(migration, /cancellation\."state" IN \('COMMITTING', 'RECONCILE_REQUIRED', 'CONFIRMED'\)/);
  assert.doesNotMatch(migration, /SET[\s\S]{0,240}"state"\s*=\s*'CONFIRMED'/);
});

test("legacy retired Custom closure terminalizes only proven-precommit Telegram work", () => {
  assert.match(migration, /i\."state" IN \('PLANNED', 'CLAIMED', 'FAILED_PRECOMMIT'\)/);
  assert.match(migration, /i\."commitStartedAt" IS NULL/);
  const precommitUpdate = migration.slice(migration.indexOf('UPDATE "TelegramDeliveryIntent"'), migration.indexOf('-- A Custom that was already CANCELLED'));
  assert.doesNotMatch(precommitUpdate, /IN \([^)]*COMMITTING/);
  assert.doesNotMatch(precommitUpdate, /IN \([^)]*RECONCILE_REQUIRED/);
  assert.doesNotMatch(precommitUpdate, /IN \([^)]*CONFIRMED/);
});

test("legacy retired pending-order resolver is audited, lifecycle-locked and refuses unknown TASK outcome", () => {
  const start = workflow.indexOf("async function resolveRetiredCreatorPendingCustomOrder");
  const end = workflow.indexOf("async function resolveUnassignedCustomContentSubmission", start);
  const block = workflow.slice(start, end);
  assert.match(block, /scope\?\.broad/);
  assert.match(block, /lockAgencyPipelineLifecycle/);
  assert.match(block, /lockCreatorPipelineLifecycle[\s\S]*allowDeleted:\s*true/);
  assert.match(block, /CUSTOM_RETIRED_ORDER_TASK_OUTCOME_UNRESOLVED/);
  assert.match(block, /state:\s*"CANCELLED"/);
  assert.match(block, /telegramCancellationWaivedAt/);
  assert.match(block, /adjudicateCustomOrderCancellation/);
  assert.match(block, /required:\s*true/);
});

test("waived cancellation is excluded from current debt projection and can never be reactivated", () => {
  assert.match(providerDebt, /String\(order\?\.status \|\| ""\)\.toUpperCase\(\) === "CANCELLED" && !order\?\.telegramCancellationWaivedAt/);
  assert.match(delivery, /&& !order\.telegramCancellationWaivedAt/);
  assert.match(delivery, /String\(settledOrder\.status\) === "CANCELLED" && !settledOrder\.telegramCancellationWaivedAt/);
  assert.match(delivery, /String\(order\.status\) !== "CANCELLED" \|\| order\.telegramCancellationWaivedAt/);
  assert.match(delivery, /CUSTOM_CANCELLATION_MODEL_INSTRUCTION_NOT_DELIVERED/);
  assert.match(delivery, /CUSTOM_CANCELLATION_INSTRUCTION_OUTCOME_UNRESOLVED/);
  assert.match(cancellationInstruction, /state:\s*"CONFIRMED_REVISION"/);
  assert.match(cancellationInstruction, /anchorKind:\s*String\(instruction.kind\)/);
});
