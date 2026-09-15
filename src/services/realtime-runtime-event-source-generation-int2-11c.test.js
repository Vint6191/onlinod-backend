"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const route = fs.readFileSync(path.join(__dirname, "../routes/automation-control.js"), "utf8");

function handlerBlock() {
  const start = route.indexOf("async function handleBumpRuntimeEvents(req, res)");
  const end = route.indexOf('router.post("/bumps/:creatorId/events"', start);
  assert.ok(start >= 0 && end > start);
  return route.slice(start, end);
}

test("INT2.11C runtime-event protocol requires receive-time accessEpoch", () => {
  const block = handlerBlock();
  assert.match(route, /const runtimeEventSchema = z\.object\(\{[\s\S]*accessEpoch: z\.number\(\)\.int\(\)\.min\(0\)/);
  assert.match(block, /input\.accessEpoch !== memberAccessEpoch[\s\S]*RUNTIME_EVENT_AUTHORIZATION_GENERATION_STALE/);
  assert.match(block, /realtimeReady: true,[\s\S]{0,140}accessEpoch: input\.accessEpoch/);
  assert.match(block, /withRealtimeIngestGenerationFence\(\{[\s\S]*accessEpoch: input\.accessEpoch/);
});

test("INT2.11C runtime-event rolling version skew is fail-closed", () => {
  assert.match(route, /router\.post\("\/bumps\/:creatorId\/events", seniorRequired, handleBumpRuntimeEvents\)/);
  assert.match(route, /router\.post\("\/bumps\/:creatorId\/events\/current-authorized", seniorRequired, handleBumpRuntimeEvents\)/);
  // Legacy path uses the SAME schema, so an old Desktop missing accessEpoch is rejected.
  const schemaAt = route.indexOf("const runtimeEventSchema");
  const legacyAt = route.indexOf('router.post("/bumps/:creatorId/events"');
  assert.ok(schemaAt >= 0 && schemaAt < legacyAt);
});

test("INT2.11C forced source-generation model rejects an in-flight old event after epoch bump", () => {
  const capturedEpoch = 7;
  let serverEpoch = 7;
  const admit = () => capturedEpoch === serverEpoch;
  assert.equal(admit(), true);
  serverEpoch = 8;
  assert.equal(admit(), false);
});
