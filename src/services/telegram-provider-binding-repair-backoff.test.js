"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const migration = fs.readFileSync(path.join(root, "prisma", "migrations", "20261009000000_current_baseline", "migration.sql"), "utf8");
const service = fs.readFileSync(path.join(__dirname, "telegram-delivery-authority-service.js"), "utf8");



test("repair lane gates on durable retryAt, exponentially reschedules, and clears on recovered binding", () => {
  assert.match(service, /PROVIDER_BLOCK_RETRY_BASE_MS\s*=\s*60\s*\*\s*1000/);
  assert.match(service, /PROVIDER_BLOCK_RETRY_MAX_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(service, /providerBindingRepairDelayMs\(providerBindingRepairAttempts\)/);
  assert.match(service, /providerBindingRetryAt:\s*\{\s*lte:\s*now\s*\}/);
  assert.match(service, /providerBindingRetryAt:\s*null,\s*updatedAt:\s*\{\s*lte:\s*legacyRetryBefore\s*\}/);
  assert.match(service, /providerBindingRepairAttempts:\s*0,\s*providerBindingRetryAt:\s*null/);
});
