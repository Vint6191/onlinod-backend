"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "prisma/migrations/20261009000000_current_baseline/migration.sql"),
  "utf8",
);
const reliabilityMigration = fs.readFileSync(
  path.join(root, "prisma/migrations/20261009000000_current_baseline/migration.sql"),
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
  assert.match(modelBody("CreatorMediaAsset"), /@@unique\(\[creatorId, mediaId\]\)/);
  assert.match(modelBody("CreatorMediaUsageContribution"), /@@unique\(\[creatorId, sourceKey, mediaId\]\)/);
  assert.match(modelBody("CreatorMediaUsageSourceState"), /@@unique\(\[creatorId, sourceKey\]\)/);
  assert.match(modelBody("DialogReconciliationTarget"), /@@unique\(\[creatorId, dialogId, messageId\]\)/);
});




test("P17.2 persists reconciliation targets and confirmed incremental watermarks", () => {
  assert.match(reliabilityMigration, /CREATE TABLE "DialogReconciliationTarget"/);
  assert.match(reliabilityMigration, /CREATE UNIQUE INDEX "DialogReconciliationTarget_creatorId_dialogId_messageId_key"/);
  assert.match(reliabilityMigration, /"confirmedWatermarkMessageId"/);
  assert.match(reliabilityMigration, /"incrementalGapOpen"/);
});
