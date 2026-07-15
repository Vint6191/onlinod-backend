"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "prisma/migrations/20260715213000_p17_unified_dialog_intelligence_core/migration.sql"),
  "utf8",
);
const reliabilityMigration = fs.readFileSync(
  path.join(root, "prisma/migrations/20260715224500_p17_2_dialog_intelligence_reliability/migration.sql"),
  "utf8",
);

function modelBody(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  assert.ok(match, `missing Prisma model ${name}`);
  return match[1];
}

test("dialog and purchase ledgers have DB-backed idempotency constraints", () => {
  assert.match(modelBody("DialogScanState"), /@@unique\(\[creatorId, dialogId\]\)/);
  assert.match(modelBody("DialogScanChunkCommit"), /@@unique\(\[runId, chunkKey\]\)/);
  assert.match(modelBody("DialogMessageLedger"), /@@unique\(\[creatorId, messageId\]\)/);
  assert.match(modelBody("DialogMessageMedia"), /@@unique\(\[messageLedgerId, mediaId\]\)/);
  assert.match(modelBody("DialogPurchaseSignal"), /idempotencyKey\s+String\s+@unique/);
  assert.match(modelBody("VaultPurchaseLedger"), /idempotencyKey\s+String\s+@unique/);
  assert.match(modelBody("VaultPurchaseMedia"), /@@unique\(\[purchaseId, mediaId\]\)/);
  assert.match(modelBody("VaultAssetSalesAggregate"), /@@unique\(\[creatorId, assetId\]\)/);
  assert.match(modelBody("DialogReconciliationTarget"), /@@unique\(\[creatorId, dialogId, messageId\]\)/);
});

test("migration fences one active scan run per creator/dialog and keeps chunk commits unique", () => {
  assert.match(migration, /CREATE UNIQUE INDEX "DialogScanRun_one_active_per_dialog_idx"/);
  assert.match(migration, /WHERE "status" IN \('QUEUED', 'RUNNING', 'PAUSED'\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "DialogScanChunkCommit_runId_chunkKey_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX "DialogMessageLedger_creatorId_messageId_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX "VaultPurchaseMedia_purchaseId_mediaId_key"/);
});


test("P17.2 persists reconciliation targets and confirmed incremental watermarks", () => {
  assert.match(reliabilityMigration, /CREATE TABLE "DialogReconciliationTarget"/);
  assert.match(reliabilityMigration, /CREATE UNIQUE INDEX "DialogReconciliationTarget_creatorId_dialogId_messageId_key"/);
  assert.match(reliabilityMigration, /ADD COLUMN IF NOT EXISTS "confirmedWatermarkMessageId"/);
  assert.match(reliabilityMigration, /ADD COLUMN IF NOT EXISTS "incrementalGapOpen"/);
});
