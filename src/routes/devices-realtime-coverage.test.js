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


test("heartbeat capability publication and creator-wide coverage use commit-time AgencyMember generation fences", () => {
  assert.match(source, /withHeartbeatMemberGeneration\(\{/);
  assert.match(source, /work: async \(\{ tx, member, accessEpoch \}\) => \{/);
  assert.match(source, /syncDeviceCreatorBindings\(\{[\s\S]*currentAccessEpoch: accessEpoch,[\s\S]*db: tx/);
  assert.match(source, /expectedAccessEpoch: currentAccessEpoch/);
  assert.match(source, /updateObservationFromHeartbeat\(\{[\s\S]*db: tx/);
  assert.match(source, /recordRealtimeObservationPing\(\{[\s\S]*db: tx/);
  assert.match(source, /const accessEpoch = optionalNonNegativeInt\(account\?\.accessEpoch\)/);
  assert.match(source, /const generationCurrent = expectedAccessEpoch !== null && accessEpoch === expectedAccessEpoch/);
  assert.match(source, /const realtimeReady = generationCurrent && account\?\.realtimeHealthy === true/);
});

test("missing/null reported accessEpoch cannot coerce to epoch zero", () => {
  assert.match(source, /function optionalNonNegativeInt\(value\)[\s\S]*value === null \|\| value === undefined \|\| value === ""[\s\S]*return null;[\s\S]*Number\(value\)/);
  assert.doesNotMatch(source, /Number\.isInteger\(Number\(account\?\.accessEpoch\)\)/);
});

test("cross-agency device-row mutation is inside the same current-membership generation transaction", () => {
  const agencySelection = source.indexOf("const agencyId = input.agencyId || input.activeAgencyId || req.auth.agencyId");
  const capabilityFence = source.indexOf("const capabilityCommit = await withHeartbeatMemberGeneration", agencySelection);
  const deviceMutation = source.indexOf("tx.workerDevice.upsert", capabilityFence);
  const scopeRead = source.indexOf("allowedCreatorScope({ agencyId, member, db: tx })", deviceMutation);
  assert.ok(agencySelection >= 0);
  assert.ok(capabilityFence > agencySelection);
  assert.ok(deviceMutation > capabilityFence, "device.agencyId must not change before current target membership is locked and reread");
  assert.ok(scopeRead > deviceMutation);
  assert.doesNotMatch(source.slice(agencySelection, capabilityFence), /workerDevice\.(upsert|update|updateMany|create)/,
    "no target-agency device mutation may occur before the generation fence");
});

test("current manifest generation fence completes before device commands are marked delivered", () => {
  const manifestFence = source.indexOf("const manifestRows = await withHeartbeatMemberGeneration");
  const commandsRead = source.indexOf("const commands = await prisma.deviceCommand.findMany");
  const commandsDelivered = source.indexOf("await prisma.deviceCommand.updateMany", commandsRead);
  const response = source.indexOf("return res.json({", commandsDelivered);
  assert.ok(manifestFence >= 0);
  assert.ok(commandsRead > manifestFence, "commands must not be consumed before the final authorization-sensitive manifest fence succeeds");
  assert.ok(commandsDelivered > commandsRead);
  assert.ok(response > commandsDelivered);
});
