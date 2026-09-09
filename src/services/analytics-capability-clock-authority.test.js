"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function functionSlice(source, name, next = "\nasync function ") {
  const start = source.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `${name} missing`);
  const end = source.indexOf(next, start + 15);
  return source.slice(start, end < 0 ? source.length : end);
}

test("device heartbeat stamps WorkerDevice and DeviceCreatorBinding freshness from PostgreSQL receipt time", () => {
  const source = read("routes/devices.js");
  const heartbeat = source.slice(source.indexOf('router.post("/heartbeat"'));
  assert.match(heartbeat, /heartbeatAt = await dbAuthorityNow\(\{ db: prisma/);
  assert.match(heartbeat, /lastSeenAt: heartbeatAt/);
  assert.match(heartbeat, /syncDeviceCreatorBindings\([\s\S]{0,220}now: heartbeatAt/);
  assert.doesNotMatch(heartbeat.slice(0, heartbeat.indexOf("const commands =")), /lastSeenAt: new Date\(\)/);
});

test("Analytics manual worker availability never derives freshness from process Date.now", () => {
  for (const rel of [
    "services/financial-transaction-scan-control-service.js",
    "services/campaign-scan-control-service.js",
    "services/notification-scan-control-service.js",
  ]) {
    const source = read(rel);
    const block = functionSlice(source, "countOnlineBindings");
    assert.match(block, /dbAuthorityNow/);
    assert.match(block, /capabilityFreshnessWindow\(authorityNow, 2 \* 60 \* 1000\)/);
    assert.match(block, /lastSeenAt: freshnessWindow/);
    assert.doesNotMatch(block, /Date\.now\(\)/);
  }
});

test("manual Financial and Campaign planning/resume uses PostgreSQL authority inside collector lock", () => {
  for (const [rel, fn] of [
    ["services/financial-transaction-scan-control-service.js", "startManualFinancialTransactionScan"],
    ["services/campaign-scan-control-service.js", "startManualCampaignScan"],
  ]) {
    const block = functionSlice(read(rel), fn);
    assert.match(block, /authorityNow = await dbAuthorityNow\(\{ db: tx/);
    assert.match(block, /scheduledAt: authorityNow, nextRunAt: authorityNow/);
    assert.match(block, /now: authorityNow/);
  }
});


test("live Notification fact reporter gates REALTIME capability against PostgreSQL freshness", () => {
  const source = read("routes/stats.js");
  const start = source.indexOf('router.post("/creators/:creatorId/notifications/live"');
  assert.ok(start >= 0);
  const block = source.slice(start);
  assert.match(block, /authorityNow = await dbAuthorityNow\(\{ db: prisma/);
  assert.match(block, /freshnessWindow = capabilityFreshnessWindow\(authorityNow, 10 \* 60 \* 1000\)/);
  assert.match(block, /lastSeenAt: freshnessWindow/);
  assert.match(block, /realtimeReady: true/);
  assert.doesNotMatch(block.slice(0, block.indexOf("const grouped =")), /Date\.now\(\)/);
  assert.match(block, /ingestNotificationFacts/);
  assert.match(block, /recordNotificationSocketEvent/);
});
