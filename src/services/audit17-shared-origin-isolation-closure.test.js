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

test("Audit17 admin and retention cannot destroy programmatic idempotency authority", () => {
  const admin = fs.readFileSync(path.join(__dirname, "..", "routes", "admin-data.js"), "utf8");
  const history = read("automation-history-service.js");
  assert.match(admin, /automationDelivery:\s*\{[^}]*deleteProtected:\s*true/);
  assert.match(admin, /ADMIN_DELETE_PROTECTED/);
  assert.match(admin, /purge-deliveries[\s\S]*originKind:\s*"AUTOMATION"[\s\S]*COMPLETED[\s\S]*FAILED[\s\S]*SKIPPED[\s\S]*CANCELED/);
  assert.match(history, /deleteMany\(\{ where: \{ id: \{ in: rows\.map[\s\S]*originKind:\s*"AUTOMATION"/);
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


test("Audit17 operational maintenance scripts cannot delete programmatic write receipts", () => {
  const root = path.join(__dirname, "..", "..");
  for (const relative of ["scripts/maintenance/dedupe-deliveries.js", "scripts/maintenance/purge-stuck-deliveries.js", "dedupe-deliveries.js", "purge-stuck-deliveries.js"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /originKind:\s*"AUTOMATION"/);
    const deletes = source.match(/automationDelivery\.deleteMany\([\s\S]*?\);/g) || [];
    for (const statement of deletes) assert.match(statement, /originKind:\s*"AUTOMATION"/);
    if (relative.includes("dedupe-deliveries")) {
      assert.match(source, /TERMINAL_STATUSES/);
      for (const statement of deletes) assert.match(statement, /status:\s*\{\s*in:\s*TERMINAL_STATUSES\s*\}/);
    }
  }
});


test("Audit17 unresolved-do-not-retry automation receipts survive retention, admin purge and maintenance dedupe", () => {
  const history = read("automation-history-service.js");
  const admin = fs.readFileSync(path.join(__dirname, "..", "routes", "admin-data.js"), "utf8");
  const backendRoot = path.join(__dirname, "..", "..");
  const maintenance = fs.readFileSync(path.join(backendRoot, "scripts", "maintenance", "dedupe-deliveries.js"), "utf8");
  const rootMaintenance = fs.readFileSync(path.join(backendRoot, "dedupe-deliveries.js"), "utf8");
  for (const source of [history, admin, maintenance, rootMaintenance]) {
    assert.match(source, /failureCode:\s*null/);
    assert.match(source, /failureCode:\s*\{\s*not:\s*"outcome_unresolved_do_not_retry"\s*\}/);
  }
  assert.match(history, /OR:\s*\[\{\s*failureCode:\s*null\s*\},\s*\{\s*failureCode:/);
  assert.match(admin, /OR:\s*\[\{\s*failureCode:\s*null\s*\},\s*\{\s*failureCode:/);
});
