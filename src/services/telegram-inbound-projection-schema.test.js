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
