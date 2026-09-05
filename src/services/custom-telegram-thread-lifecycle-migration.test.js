"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260905200000_customs_telegram_thread_source_exception_lifecycle", "migration.sql"), "utf8");

test("Custom Telegram thread/source/exception migration is atomic, additive and fail-closed on outgoing receipt ambiguity", () => {
  assert.match(migration, /^\s*BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /AgencyTelegramMtprotoAccount[\s\S]*lifecycleState[\s\S]*retirementDrainCompletedAt[\s\S]*runtimeClaimGeneration[\s\S]*runtimeDrainedGeneration[\s\S]*runtimeClaimInboundEligible/);
  assert.match(migration, /CustomContentSubmission[\s\S]*sourceAuthority[\s\S]*sourceThreadIntentId[\s\S]*sourceResolutionEventId/);
  assert.match(migration, /TelegramInboundEvent[\s\S]*intakeAuthority[\s\S]*threadResolutionType[\s\S]*resolutionAuthority/);
  assert.match(migration, /TelegramDeliveryIntent[\s\S]*confirmationAuthority/);
  assert.match(migration, /MANUAL_CONFIRMED:%[\s\S]*MANUAL_RECONCILIATION/);
  assert.match(migration, /runtimeClaimGeneration" = GREATEST\("runtimeClaimGeneration", 1\)[\s\S]*runtimeDrainedGeneration" = 0[\s\S]*runtimeClaimedByDeviceId" IS NOT NULL/, "rolling migration must treat a pre-existing runtime owner as explicitly undrained");
  assert.match(migration, /runtimeClaimInboundEligible" = TRUE[\s\S]*CreatorAccount[\s\S]*telegramAccountId/, "rolling migration must preserve current-account inbound capability for a live owner");
  assert.match(migration, /TelegramDeliveryIntent[\s\S]*CustomOrder[\s\S]*kind" = 'TASK'[\s\S]*state" = 'CONFIRMED'[\s\S]*status" = 'PENDING'/, "rolling migration must also preserve a still-active historical TASK thread without widening source-only runtimes");
  assert.match(migration, /LEGACY_PROVEN_TELEGRAM_INBOUND/);
  assert.match(migration, /LEGACY_MANUAL_IMPORT/);
  const conflictAt = migration.indexOf("HAVING COUNT(*) > 1");
  const uniqueAt = migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "TelegramDeliveryIntent_provider_message_key"');
  assert.ok(conflictAt >= 0 && uniqueAt > conflictAt, "duplicate receipt history must be rejected before the unique index is created");
  assert.match(migration, /RAISE EXCEPTION 'Custom Telegram thread cutover blocked:/);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
});
