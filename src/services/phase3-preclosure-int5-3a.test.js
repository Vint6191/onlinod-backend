"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { projectFanObservationBatch } = require("./fan-data-authority-service");

function bulkDb() {
  const calls = [];
  const tx = {
    async $executeRawUnsafe(sql, ...args) {
      calls.push({ sql: String(sql), args });
      return 1;
    },
  };
  return {
    calls,
    async $transaction(work) { return work(tx); },
  };
}


function splitSqlCalls(calls) {
  const locks = calls.filter((call) => /pg_advisory_xact_lock/.test(call.sql));
  const writes = calls.filter((call) => !/pg_advisory_xact_lock/.test(call.sql));
  return { locks, writes };
}

function profile(fanId) {
  return {
    onlyFansUserId: fanId,
    relationship: {
      source: "USER_PROFILE",
      observedAt: "2026-09-16T19:00:00.000Z",
      creatorFollowsFan: false,
      canReceiveChatMessage: true,
    },
    value: {
      source: "USER_PROFILE",
      observedAt: "2026-09-16T19:00:00.000Z",
      availability: "AVAILABLE",
      totalSpentCents: 1234,
    },
  };
}

test("INT5.3A action profile provenance uses AutomationDelivery FK, never sourceJobId", async () => {
  const db = bulkDb();
  const result = await projectFanObservationBatch(db, {
    agencyId: "agency-1",
    creatorId: "creator-1",
    sourceDeviceId: "device-1",
    sourceDeliveryId: "delivery-1",
    items: [profile("fan-1")],
    allowedSources: ["USER_PROFILE"],
    observedAtPolicy: "SERVER_GENERATION",
    causalObservedAt: new Date("2026-09-16T19:00:00.000Z"),
    receivedAt: new Date("2026-09-16T19:00:05.000Z"),
  });
  assert.equal(result.projected, 1);
  const { locks, writes } = splitSqlCalls(db.calls);
  assert.equal(locks.length, 1);
  assert.equal(writes.length, 4);

  const relationshipRows = JSON.parse(writes[2].args[0]);
  const valueRows = JSON.parse(writes[3].args[0]);
  assert.equal(relationshipRows[0].sourceDeliveryId, "delivery-1");
  assert.equal(relationshipRows[0].sourceJobId, null);
  assert.equal(valueRows[0].sourceDeliveryId, "delivery-1");
  assert.equal(valueRows[0].sourceJobId, null);
  assert.match(writes[2].sql, /"sourceDeliveryId"/);
  assert.match(writes[3].sql, /"sourceDeliveryId"/);
});

test("INT5.3A malformed ID-only observation is ignored before bulk SQL", async () => {
  const db = bulkDb();
  const result = await projectFanObservationBatch(db, {
    agencyId: "agency-1",
    creatorId: "creator-1",
    items: [{ onlyFansUserId: "fan-empty" }],
    allowedSources: ["USER_PROFILE"],
    observedAtPolicy: "SERVER_GENERATION",
    causalObservedAt: new Date("2026-09-16T19:00:00.000Z"),
    receivedAt: new Date("2026-09-16T19:00:05.000Z"),
  });
  assert.equal(result.projected, 0);
  assert.deepEqual(result.touchedFanIds, []);
  assert.equal(db.calls.length, 0);
});

test("INT5.3A generic bulk rows are ordered by opaque fan id for deterministic lock acquisition", async () => {
  const db = bulkDb();
  await projectFanObservationBatch(db, {
    agencyId: "agency-1",
    creatorId: "creator-1",
    items: [profile("fan-z"), profile("fan-a"), profile("fan-m")],
    allowedSources: ["USER_PROFILE"],
    observedAtPolicy: "SERVER_GENERATION",
    causalObservedAt: new Date("2026-09-16T19:00:00.000Z"),
    receivedAt: new Date("2026-09-16T19:00:05.000Z"),
  });
  const { locks, writes } = splitSqlCalls(db.calls);
  assert.equal(locks.length, 1);
  for (const callIndex of [0, 2, 3]) {
    const ids = JSON.parse(writes[callIndex].args[0]).map((row) => row.onlyFansUserId);
    assert.deepEqual(ids, ["fan-a", "fan-m", "fan-z"]);
  }
});

test("INT5.3A schema and direct route keep job and delivery provenance as distinct authorities", () => {
  const root = path.resolve(__dirname, "../..");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const route = fs.readFileSync(path.join(root, "src/routes/fan-data.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260916222000_phase3_fan_observation_delivery_provenance/migration.sql"), "utf8");

  assert.match(schema, /sourceJob\s+JobInstance\?/);
  assert.match(schema, /sourceDelivery\s+AutomationDelivery\?/);
  assert.match(schema, /CreatorFanRelationshipCurrentCollectedByDelivery/);
  assert.match(schema, /CreatorFanValueCurrentCollectedByDelivery/);
  assert.match(route, /sourceDeliveryId:\s*scope\.delivery\.id/);
  assert.doesNotMatch(route, /sourceJobId:\s*scope\.delivery\.id/);
  assert.match(migration, /REFERENCES "AutomationDelivery"\("id"\)/);
});
