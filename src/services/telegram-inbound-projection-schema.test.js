"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260905133000_telegram_inbound_projection_authority/migration.sql"), "utf8");
const scheduler = fs.readFileSync(path.join(root, "src/services/job-scheduler.js"), "utf8");
const deliveryAuthority = fs.readFileSync(path.join(root, "src/services/telegram-delivery-authority-service.js"), "utf8");
const retryFairnessMigration = fs.readFileSync(path.join(root, "prisma/migrations/20260906165000_telegram_inbound_retry_fairness/migration.sql"), "utf8");
const confirmedProjectionMigration = fs.readFileSync(path.join(root, "prisma/migrations/20260906234500_telegram_confirmed_projection_observability/migration.sql"), "utf8");

function modelBlock(name) {
  const start = schema.indexOf(`model ${name} {`);
  assert.notEqual(start, -1, `missing Prisma model ${name}`);
  const end = schema.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated Prisma model ${name}`);
  return schema.slice(start, end + 2);
}

test("TelegramInboundEvent schema owns durable server projection lifecycle", () => {
  const inbound = modelBlock("TelegramInboundEvent");
  assert.match(inbound, /projectionState\s+String\s+@default\("PENDING"\)/);
  assert.match(inbound, /projectionReason\s+String\?/);
  assert.match(inbound, /projectionAttempts\s+Int\s+@default\(0\)/);
  assert.match(inbound, /projectedAt\s+DateTime\?/);
  assert.match(inbound, /@@index\(\[agencyId, projectionState, observedAt\]\)/);
});

test("projection migration is additive and backfills only already-proven terminal observations", () => {
  for (const column of ["projectionState", "projectionReason", "projectionAttempts", "projectedAt"]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`));
  }
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "TelegramInboundEvent_agencyId_projectionState_observedAt_idx"/);
  assert.match(migration, /SET "projectionState" = 'APPLIED'.*"submissionId" IS NOT NULL/s);
  assert.match(migration, /SET "projectionState" = 'SKIPPED'.*"hasMedia" = false/s);
  assert.doesNotMatch(migration, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
});


test("inbound projection retry is backend-scheduled and no longer piggybacks Desktop delivery polling", () => {
  assert.match(scheduler, /TELEGRAM_INBOUND_PROJECTION_INTERVAL_MS\s*=\s*30\s*\*\s*1000/);
  assert.match(scheduler, /runTelegramInboundProjectionSweep/);
  assert.match(scheduler, /retryPendingInboundProjections/);
  assert.match(scheduler, /telegramInboundProjectionTimer\s*=\s*setInterval/);
  assert.doesNotMatch(deliveryAuthority, /retryPendingInboundProjections/);
});


test("confirmed Telegram receipt projection debt is repaired by the backend recurring scheduler", () => {
  assert.match(scheduler, /runTelegramConfirmedProjectionSweep/);
  assert.match(scheduler, /repairConfirmedTelegramDeliveryProjections/);
  assert.match(scheduler, /repairCustomModelCommunicationConvergence/);
  assert.match(scheduler, /scanAllById\(\{[\s\S]*delegate:\s*prisma\.agency[\s\S]*deletedAt:\s*null/);
  assert.match(scheduler, /telegramConfirmedProjection\s*=\s*await runTelegramConfirmedProjectionSweep/);
  assert.match(deliveryAuthority, /repairConfirmedTelegramDeliveryProjections/);
  assert.match(scheduler, /report\.reminderScheduleScanned\s*\+=\s*Number\(result\?\.reminderScheduleScanned/);
  assert.match(scheduler, /report\.reminderScheduleFailed\s*\+=\s*Number\(result\?\.reminderScheduleFailed/);
  assert.match(scheduler, /report\.reminderScheduleFailed\s*>\s*0/);
});


test("retryable inbound fairness has an indexed scheduler order", () => {
  const inbound = modelBlock("TelegramInboundEvent");
  assert.match(inbound, /@@index\(\[agencyId, projectionState, updatedAt\]\)/);
  assert.match(retryFairnessMigration, /TelegramInboundEvent_agencyId_projectionState_updatedAt_idx/);
  assert.match(retryFairnessMigration, /\("agencyId", "projectionState", "updatedAt"\)/);
  assert.doesNotMatch(retryFairnessMigration, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
});

test("confirmed provider receipt commits before derived projection and REFERENCE projection is row-serialized + repairable", () => {
  const confirmStart = deliveryAuthority.indexOf("async function confirmTelegramDeliveryIntent");
  const repairStart = deliveryAuthority.indexOf("async function repairConfirmedTelegramDeliveryProjections", confirmStart);
  assert.notEqual(confirmStart, -1);
  assert.notEqual(repairStart, -1);
  const confirmBlock = deliveryAuthority.slice(confirmStart, repairStart);

  const settleStart = confirmBlock.indexOf("const settle = async (tx) =>");
  const transactionCall = confirmBlock.indexOf("await client.$transaction(settle)", settleStart);
  const projectionCall = confirmBlock.indexOf("await projectConfirmedIntentObserved({ row: confirmed", transactionCall);
  assert.notEqual(settleStart, -1);
  assert.notEqual(transactionCall, -1);
  assert.notEqual(projectionCall, -1);
  assert.doesNotMatch(confirmBlock.slice(settleStart, transactionCall), /projectConfirmedIntent/,
    "derived CustomOrder projection must not be part of the canonical provider-receipt transaction");
  assert.ok(projectionCall > transactionCall, "derived projection must run only after CONFIRMED provider fact commits");

  const appendStart = deliveryAuthority.indexOf("async function appendConfirmedReferenceMessageId");
  const projectStart = deliveryAuthority.indexOf("async function projectConfirmedIntent", appendStart);
  assert.notEqual(appendStart, -1);
  assert.notEqual(projectStart, -1);
  const appendBlock = deliveryAuthority.slice(appendStart, projectStart);
  assert.match(appendBlock, /CustomOrder[\s\S]*FOR UPDATE/,
    "REFERENCE scalar-list projection must serialize on the exact CustomOrder row");
  assert.match(deliveryAuthority, /kind:\s*"REFERENCE"[\s\S]*state:\s*"CONFIRMED"[\s\S]*REFERENCE_PROJECTION_DEBT/,
    "backend repair must cursor-discover missing REFERENCE projections from canonical confirmed receipts");
  assert.match(deliveryAuthority, /MANUAL_REMINDER[\s\S]*AUTO_REMINDER[\s\S]*state:\s*"CONFIRMED"[\s\S]*REMINDER_PROJECTION_DEBT/,
    "backend repair must cursor-discover confirmed reminder effects whose business projection is missing");
  assert.match(deliveryAuthority, /kind:\s*"TASK"[\s\S]*state:\s*"CONFIRMED"[\s\S]*TASK_PROJECTION_DEBT/,
    "backend repair must discover TASK projection debt independently of the CustomOrder current lifecycle state");
});


test("confirmed projection failures are operational state beside immutable CONFIRMED provider truth", () => {
  const delivery = modelBlock("TelegramDeliveryIntent");
  assert.match(delivery, /projectionBlockedCode\s+String\?/);
  assert.match(delivery, /projectionBlockedAt\s+DateTime\?/);
  assert.match(delivery, /projectionLastAttemptAt\s+DateTime\?/);
  assert.match(delivery, /projectionAttempts\s+Int\s+@default\(0\)/);
  assert.match(delivery, /@@index\(\[agencyId, state, projectionBlockedAt\]\)/);
  for (const column of ["projectionBlockedCode", "projectionBlockedAt", "projectionLastAttemptAt", "projectionAttempts"]) {
    assert.match(confirmedProjectionMigration, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`));
  }
  assert.doesNotMatch(confirmedProjectionMigration, /\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
  assert.match(deliveryAuthority, /listTelegramConfirmedProjectionBlockedQueue/);
  assert.match(deliveryAuthority, /retryTelegramConfirmedProjection/);
  assert.match(deliveryAuthority, /externalEffectConfirmed:\s*true/);
});
