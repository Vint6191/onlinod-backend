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
const { recordRealtimeObservationPing, realtimeFrameSampleAt } = require("./team-observation-service");

function dbFixture({ existing = null } = {}) {
  const calls = { upsert: [], updateMany: [], findUnique: [] };
  let state = existing;
  return {
    calls,
    creatorAccount: {
      async findFirst() {
        return { id: "creator-1", username: "model", remoteId: "42", displayName: "Model" };
      },
    },
    teamObservationState: {
      async upsert(args) {
        calls.upsert.push(args);
        if (!state) state = { id: "state-1", ...args.create };
        else state = { ...state, ...args.update };
        return state;
      },
      async updateMany(args) {
        calls.updateMany.push(args);
        const candidate = args.data.lastRealtimeEventAt;
        const previous = state?.lastRealtimeEventAt ? new Date(state.lastRealtimeEventAt) : null;
        const now = new Date("2026-07-27T12:05:00.000Z");
        const poisonedFuture = previous && previous.getTime() > now.getTime() + 30_000;
        if (!previous || previous < candidate || poisonedFuture) {
          state = { ...state, lastRealtimeEventAt: candidate };
          return { count: 1 };
        }
        return { count: 0 };
      },
      async findUnique(args) {
        calls.findUnique.push(args);
        return state;
      },
    },
  };
}

test("healthy WS can be recorded without erasing an unresolved historical gap", async () => {
  const db = dbFixture();
  const now = new Date("2026-07-27T12:00:00.000Z");
  const frameAt = new Date(now.getTime() - 5_000);
  const result = await recordRealtimeObservationPing({
    agencyId: "agency-1",
    deviceId: "device-1",
    account: { creatorId: "creator-1", realtimeHealthy: true, lastWsFrameAt: frameAt.toISOString() },
    now,
    advanceRealtimeCoverage: false,
    db,
  });
  assert.equal(result.ok, true);
  assert.equal(result.coverageAdvanced, false);
  assert.equal(db.calls.upsert.length, 1);
  assert.equal(Object.hasOwn(db.calls.upsert[0].create, "lastRealtimeEventAt"), false);
  assert.equal(Object.hasOwn(db.calls.upsert[0].update, "lastRealtimeEventAt"), false);
  assert.equal(db.calls.updateMany.length, 0);
});

test("settled coverage advances only to the actual inbound frame timestamp", async () => {
  const db = dbFixture();
  const now = new Date("2026-07-27T12:05:00.000Z");
  const frameAt = new Date(now.getTime() - 7_000);
  const result = await recordRealtimeObservationPing({
    agencyId: "agency-1",
    deviceId: "device-1",
    account: { creatorId: "creator-1", realtimeHealthy: true, lastWsFrameAt: frameAt.toISOString() },
    now,
    advanceRealtimeCoverage: true,
    db,
  });
  assert.equal(result.coverageAdvanced, true);
  assert.equal(result.coverageAt, frameAt.toISOString());
  assert.equal(db.calls.upsert[0].create.lastRealtimeEventAt.toISOString(), frameAt.toISOString());
  assert.equal(Object.hasOwn(db.calls.upsert[0].update, "lastRealtimeEventAt"), false);
});

test("stale or far-future frame samples cannot advance durable coverage", async () => {
  const now = new Date("2026-07-27T12:05:00.000Z");
  assert.equal(realtimeFrameSampleAt({ lastWsFrameAt: new Date(now.getTime() - 181_000) }, now), null);
  assert.equal(realtimeFrameSampleAt({ lastWsFrameAt: new Date(now.getTime() + 31_000) }, now), null);

  const db = dbFixture();
  const result = await recordRealtimeObservationPing({
    agencyId: "agency-1",
    deviceId: "device-1",
    account: { creatorId: "creator-1", realtimeHealthy: true, lastWsFrameAt: new Date(now.getTime() - 181_000).toISOString() },
    now,
    advanceRealtimeCoverage: true,
    db,
  });
  assert.equal(result.coverageAdvanced, false);
  assert.equal(result.coverageAt, null);
  assert.equal(db.calls.updateMany.length, 0);
});

test("a delayed older device sample cannot move a newer creator-wide boundary backwards", async () => {
  const now = new Date("2026-07-27T12:05:00.000Z");
  const newer = new Date(now.getTime() - 2_000);
  const older = new Date(now.getTime() - 20_000);
  const db = dbFixture({ existing: { id: "state-1", lastRealtimeEventAt: newer } });
  await recordRealtimeObservationPing({
    agencyId: "agency-1",
    deviceId: "device-old",
    account: { creatorId: "creator-1", realtimeHealthy: true, lastWsFrameAt: older.toISOString() },
    now,
    advanceRealtimeCoverage: true,
    db,
  });
  assert.equal(db.calls.updateMany.length, 1);
  assert.equal(db.calls.updateMany[0].data.lastRealtimeEventAt.toISOString(), older.toISOString());
  const where = db.calls.updateMany[0].where.OR;
  assert.deepEqual(where[1], { lastRealtimeEventAt: { lt: older } });
});
