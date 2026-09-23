"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");

test("Audit17 automation product control is origin-isolated while shared write lane remains global", () => {
  const action = read("automation-action-delivery-service.js");
  const control = read("automation-control-service.js");
  const history = read("automation-history-service.js");
  const pacing = read("automation-pacing-service.js");
  const server = read("automation-server-service.js");
  assert.match(action, /listActionDeliveries[\s\S]*originKind:\s*"AUTOMATION"/);
  assert.match(action, /retryActionDelivery[\s\S]*id:\s*deliveryId, agencyId, originKind:\s*"AUTOMATION"/);
  assert.match(action, /retrySafeFailures[\s\S]*originKind:\s*"AUTOMATION"/);
  assert.match(action, /requireLease[\s\S]*originKind !== "AUTOMATION"[\s\S]*DELIVERY_WRONG_AUTHORITY/);
  assert.match(control, /pauseDeliveriesForControl[\s\S]*originKind:\s*"AUTOMATION"/);
  assert.match(control, /resumeDeliveriesForControl[\s\S]*originKind:\s*"AUTOMATION"/);
  assert.match(history, /compactAutomationDeliveries[\s\S]*originKind:\s*"AUTOMATION"/);
  assert.match(history, /getAutomationMetrics[\s\S]*originKind:\s*"AUTOMATION"/);
  assert.match(pacing, /latestWriteState[\s\S]*originKind:\s*"AUTOMATION"/);
  assert.match(server, /listActivity[\s\S]*originKind:\s*"AUTOMATION"/);
  assert.match(action, /CREATOR_WRITE_LANE_STATUSES/);
  assert.doesNotMatch(action, /creatorId\s*\+\s*originKind/);
});

test("Audit17 generic admin mutations are retired and typed archive is origin-isolated", () => {
  const admin = fs.readFileSync(path.join(__dirname, "..", "routes", "admin-data.js"), "utf8");
  const history = read("automation-history-service.js");
  for (const route of ['/record/:model/:id','/bulk-delete','/purge-deliveries']) assert.ok(admin.includes('"' + route + '", retiredMutation'));
  assert.match(admin, /status\(410\)/); assert.doesNotMatch(admin, /deleteMany|updateMany/);
  assert.match(history, /DELETE FROM "AutomationDelivery"[\s\S]*originKind" = 'AUTOMATION'[\s\S]*status" IN \('COMPLETED','FAILED','SKIPPED','CANCELED'\)/);
  assert.match(history, /RETURNING d\.\*/);
});

test("Audit17 origin isolation never splits the global creator physical-write lane", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260831140000_execution_commit_authority_closure2", "migration.sql"), "utf8");
  assert.match(migration, /CREATE UNIQUE INDEX "AutomationDelivery_creator_write_lease_unique"[\s\S]*\("creatorId"\)[\s\S]*CLAIMED[\s\S]*RUNNING[\s\S]*COMMITTING[\s\S]*RECONCILE_REQUIRED/);
  assert.doesNotMatch(migration, /AutomationDelivery_creator_write_lease_unique[\s\S]{0,240}originKind/);
});


test("Audit17 programmatic semantic IDs stay typed instead of overloading AutomationDelivery.messageId", () => {
  const service = read("programmatic-of-write-authority-service.js");
  assert.match(service, /actualMessageId = new Set\(\["VAULT_RELAY_SEND", "CUSTOM_RELAY_SEND"\]\)/);
  assert.doesNotMatch(service, /result\.queueId\s*\|\|\s*result\.folderId/);
});


test("Audit17 operational purge and dedupe entrypoints fail closed without a DB connection", () => {
  const root = path.join(__dirname, "..", "..");
  for (const relative of ["scripts/maintenance/dedupe-deliveries.js", "scripts/maintenance/purge-stuck-deliveries.js", "dedupe-deliveries.js", "purge-stuck-deliveries.js"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /LEGACY_DELIVERY_CLEANUP_RETIRED/);
    assert.match(source, /process.exitCode = 1/);
    assert.doesNotMatch(source, /require\(|PrismaClient|deleteMany|\.delete\(/);
  }
});

test("Phase3 lifecycle protections remain at the shared archive delete fence", () => {
  const history = read("automation-history-service.js");
  assert.match(history, /failureCode" IS DISTINCT FROM 'outcome_unresolved_do_not_retry'/);
  assert.match(history, /remoteLifecycleState" IS NULL OR d\."remoteLifecycleState" = 'SETTLED'/);
  assert.match(history, /actionType" <> 'MASS_QUEUE_CREATE' OR d\."intentAcknowledgedAt" IS NOT NULL/);
  assert.match(history, /partitionAutomationDeliveryHardDeleteCandidates\(\{ db: tx/);
  assert.match(history, /knownCandidates.has\(sfsCandidateId\(row\)\)/);
  const guard = read("automation-delivery-hard-delete-guard.js");
  assert.match(guard, /followEffectOwnership === "OWNED"/);
  assert.match(guard, /followEffectDeliveryId/);
  assert.match(guard, /metadata\.legacyMigration === true/);
});
