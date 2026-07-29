"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "devices.js"), "utf8");

test("legacy realtime-ping cannot mutate observation coverage", () => {
  const routeStart = source.indexOf('router.post("/realtime-ping"');
  const nextRoute = source.indexOf('router.post("/commands/:id/ack"', routeStart);
  assert.ok(routeStart >= 0 && nextRoute > routeStart);
  const route = source.slice(routeStart, nextRoute);
  assert.match(route, /status\(410\)/);
  assert.match(route, /REALTIME_PING_DEPRECATED/);
  assert.doesNotMatch(route, /recordRealtimeObservationPing/);
});

test("heartbeat can fence contiguous coverage while recovery is unresolved", () => {
  assert.match(source, /shouldPreserveRealtimeCoverage/);
  assert.match(source, /advanceRealtimeCoverage:\s*!shouldPreserveRealtimeCoverage\(decision\)/);
  assert.match(source, /realtimeCoverageFenced/);
});


test("heartbeat validates the inbound frame timestamp and fences poisoned future coverage", () => {
  assert.match(source, /realtimeFrameSampleAt\(account, now\)/);
  assert.match(source, /!lastCoveredAt[\s\S]*hasRealtimeCoverageClockSkew\(lastCoveredAt, now\)/);
  assert.match(source, /realtimeBindings[\s\S]*realtimeFrameSampleAt\(entry\.account, heartbeatAt\)/);
});
