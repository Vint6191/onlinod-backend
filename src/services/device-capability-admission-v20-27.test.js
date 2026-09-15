"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("heartbeat keeps liveness distinct from capability while committing agency-scoped device state under current membership", () => {
  const source = read("routes/devices.js");
  const heartbeatStart = source.indexOf('router.post("/heartbeat"');
  const block = source.slice(heartbeatStart);
  const authDeviceAt = block.indexOf("requireAuthDevice(req, input.deviceId");
  const generationAt = block.indexOf("const capabilityCommit = await withHeartbeatMemberGeneration");
  const upsertAt = block.indexOf("tx.workerDevice.upsert", generationAt);
  const scopeAt = block.indexOf("allowedCreatorScope({ agencyId, member, db: tx })", upsertAt);
  const syncAt = block.indexOf("syncDeviceCreatorBindings({", scopeAt);
  assert.ok(authDeviceAt >= 0 && generationAt > authDeviceAt, "device identity must be bound before the membership generation transaction");
  assert.ok(upsertAt > generationAt, "agency-scoped device liveness mutation must occur inside current membership generation");
  assert.ok(scopeAt > upsertAt && syncAt > scopeAt, "creator capability telemetry follows current member scope in the same transaction");
  assert.match(block.slice(generationAt, syncAt + 400), /currentAccessEpoch: accessEpoch[\s\S]*db: tx/);
  assert.match(source, /const generationCurrent = expectedAccessEpoch !== null && accessEpoch === expectedAccessEpoch/);
  assert.match(source, /const realtimeReady = generationCurrent && account\?\.realtimeHealthy === true/);
  assert.match(source, /allowedCreatorIds && !allowedCreatorIds\.has\(creator\.id\)/);
  assert.doesNotMatch(source, /status\s*&&\s*status\s*!==\s*["']READY["']/);
});

test("DeviceCreatorBinding is presence + typed capability telemetry, not universal READY", () => {
  const source = read("routes/devices.js");
  const schema = fs.readFileSync(path.resolve(root, "../prisma/schema.prisma"), "utf8");
  for (const field of ["sessionReadReady", "sessionWriteReady", "realtimeReady", "pageLocalReady", "browserMaterialized", "browserPresentable", "sessionProofEpoch", "canonicalRevision", "networkRevision", "lastCapabilityAt"]) {
    assert.match(source, new RegExp(field));
    assert.match(schema, new RegExp(`\\b${field}\\b`));
  }
  assert.match(source, /status: "STALE",[\s\S]{0,240}sessionReadReady: false,[\s\S]{0,160}sessionWriteReady: false/);
});

test("readonly leases require SESSION_READ while automation actions require SESSION_WRITE", () => {
  const jobs = read("services/job-lease-service.js");
  const actions = read("services/automation-action-delivery-service.js");
  assert.match(jobs, /sessionReadReady: true/);
  assert.doesNotMatch(jobs, /sessionWriteReady: true/);
  assert.match(actions, /sessionWriteReady: true/);
  assert.match(jobs, /Current member access is checked independently above/);
});

test("jobs and automation device ids are fenced to the authenticated token device", () => {
  const jobs = read("routes/jobs.js");
  const automation = read("routes/automation-control.js");
  assert.match(jobs, /requireAuthDevice\(req, suppliedDeviceId/);
  assert.match(jobs, /JOB_DEVICE_IDENTITY_MISMATCH/);
  assert.match(automation, /requireAuthDevice\(req, suppliedDeviceId/);
  assert.match(automation, /AUTOMATION_DEVICE_IDENTITY_MISMATCH/);
});

test("OF request gate independently checks creator access on every request and uses binding only for SESSION_READ capability", () => {
  const route = read("routes/of-request-gate.js");
  const service = read("services/of-request-gate-service.js");
  assert.equal((route.match(/requireAuthDevice\(req, input\.deviceId/g) || []).length, 3);
  assert.match(route, /OF_GATE_DEVICE_IDENTITY_MISMATCH/);
  const requireGateStart = service.indexOf("async function requireGateAccess");
  const gateBlock = service.slice(requireGateStart, service.indexOf("function waitUntil", requireGateStart));
  const creatorAccessAt = gateBlock.indexOf("requireCreatorAccess");
  const cacheAt = gateBlock.indexOf("accessCache.get");
  assert.ok(creatorAccessAt >= 0 && cacheAt > creatorAccessAt, "member access must be rechecked before capability cache");
  assert.match(gateBlock, /sessionReadReady: true/);
  assert.match(gateBlock, /DeviceCreatorBinding is capability telemetry only and can never grant creator access/);
});

test("realtime event ingest requires REALTIME capability rather than generic binding activity", () => {
  const automation = read("routes/automation-control.js");
  assert.match(automation, /status: "ACTIVE",[\s\S]{0,120}realtimeReady: true/);
});

test("Prisma migration adds capability columns without destructive binding replacement", () => {
  const migration = fs.readFileSync(path.resolve(root, "../prisma/migrations/20260828162000_device_creator_capability_telemetry/migration.sql"), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "sessionReadReady" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "sessionWriteReady" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "DeviceCreatorBinding_deviceId_sessionReadReady_lastSeenAt_idx"/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN/);
});


test("stats realtime reporter is token-device bound and retired daily reporter cannot re-enter current telemetry", () => {
  const stats = read("routes/stats.js");
  const liveStart = stats.indexOf('router.post("/creators/:creatorId/notifications/live"');
  assert.ok(liveStart >= 0);
  const liveEnd = stats.indexOf("\nrouter.", liveStart + 1);
  const live = stats.slice(liveStart, liveEnd === -1 ? stats.length : liveEnd);
  assert.match(live, /requireAuthDevice\(req, input\.deviceId/);
  assert.match(live, /realtimeReady: true/);
  assert.match(stats, /router\.post\("\/creators\/:creatorId\/messages-daily", legacyStatsGone\)/);
});
