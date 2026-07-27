"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const stubs = [
  ["../prisma", {}],
  ["./job-idempotency", { buildJobIdempotencyKey: () => "key" }],
  ["./team-ppv-ledger-service", { upsertPurchaseFromEvent: async () => ({}) }],
  ["./team-tip-ledger-service", { ingestTipEvent: async () => ({}) }],
  ["./traffic-service", {
    ingestSubscriptionEvent: async () => ({}),
    markTrafficFanValueDirty: async () => ({}),
  }],
  ["./bump-service", { processRuntimeEvents: async () => ({}) }],
];
for (const [request, exports] of stubs) {
  const id = require.resolve(request);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
delete require.cache[require.resolve("./team-observation-service")];
const { recordRealtimeObservationPing } = require("./team-observation-service");

function dbFixture() {
  const calls = [];
  return {
    calls,
    creatorAccount: {
      async findFirst() {
        return { id: "creator-1", username: "model", remoteId: "42", displayName: "Model" };
      },
    },
    teamObservationState: {
      async upsert(args) {
        calls.push(args);
        return { id: "state-1", ...args.create };
      },
    },
  };
}

test("healthy WS can be recorded without erasing an unresolved historical gap", async () => {
  const db = dbFixture();
  const now = new Date("2026-07-27T12:00:00.000Z");
  const result = await recordRealtimeObservationPing({
    agencyId: "agency-1",
    deviceId: "device-1",
    account: { creatorId: "creator-1" },
    now,
    advanceRealtimeCoverage: false,
    db,
  });
  assert.equal(result.ok, true);
  assert.equal(result.coverageAdvanced, false);
  assert.equal(db.calls.length, 1);
  assert.equal(Object.hasOwn(db.calls[0].create, "lastRealtimeEventAt"), false);
  assert.equal(Object.hasOwn(db.calls[0].update, "lastRealtimeEventAt"), false);
  assert.equal(db.calls[0].update.lastObservedAt, now);
  assert.equal(db.calls[0].update.lastHeartbeatAt, now);
});

test("settled coverage advances the contiguous realtime boundary", async () => {
  const db = dbFixture();
  const now = new Date("2026-07-27T12:05:00.000Z");
  const result = await recordRealtimeObservationPing({
    agencyId: "agency-1",
    deviceId: "device-1",
    account: { creatorId: "creator-1" },
    now,
    advanceRealtimeCoverage: true,
    db,
  });
  assert.equal(result.coverageAdvanced, true);
  assert.equal(db.calls[0].create.lastRealtimeEventAt, now);
  assert.equal(db.calls[0].update.lastRealtimeEventAt, now);
});
