"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const workflow = read("src/services/custom-content-workflow-service.js");
const delivery = read("src/services/telegram-delivery-authority-service.js");
const providerDebt = read("src/services/provider-operational-debt-authority-service.js");
const cancellationInstruction = read("src/services/custom-cancellation-instruction-authority-service.js");





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
