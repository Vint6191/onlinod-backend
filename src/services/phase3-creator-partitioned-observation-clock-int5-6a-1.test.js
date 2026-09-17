"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createFanObservationToken,
  createActionFanObservationToken,
} = require("./fan-observation-token-service");

function tokenDb(start = "2026-09-17T18:00:00.000Z") {
  const clocks = new Map();
  const queries = [];
  const tokens = [];
  return {
    queries,
    tokens,
    async $queryRawUnsafe(sql, creatorId) {
      queries.push({ sql, creatorId });
      assert.match(sql, /INSERT INTO "FanObservationCreatorClock"/);
      assert.match(sql, /ON CONFLICT \("creatorId"\) DO UPDATE/);
      assert.match(sql, /clock_mode/);
      assert.match(sql, /active_creator_step/);
      const previous = clocks.get(creatorId) || new Date(start);
      const next = new Date(previous.getTime() + 1);
      clocks.set(creatorId, next);
      return [{ lastObservedAt: next }];
    },
    fanObservationToken: {
      async deleteMany() { return { count: 0 }; },
      async create({ data }) { tokens.push(data); return { id: BigInt(tokens.length), ...data }; },
    },
  };
}

test("INT5.6A-1 observation chronology is keyed by creator instead of one platform-global row", async () => {
  const db = tokenDb();
  const c1 = await createFanObservationToken({
    db,
    job: { id: "job-c1", agencyId: "agency-a", creatorId: "creator-1" },
    deviceId: "device-1",
    leaseRevision: 1,
    purpose: "fan_data_point_refresh",
    subjects: ["fan-1"],
  });
  const c2 = await createFanObservationToken({
    db,
    job: { id: "job-c2", agencyId: "agency-b", creatorId: "creator-2" },
    deviceId: "device-2",
    leaseRevision: 1,
    purpose: "subscriber_directory_page",
    subjects: ["fan-2"],
  });
  const c1Again = await createActionFanObservationToken({
    db,
    delivery: { id: "delivery-c1", agencyId: "agency-a", creatorId: "creator-1" },
    deviceId: "device-3",
    leaseRevision: 4,
    purpose: "action_user_profile",
    subjects: ["fan-3"],
  });

  assert.deepEqual(db.queries.map((query) => query.creatorId), ["creator-1", "creator-2", "creator-1"]);
  assert.equal(c1.observedAt.toISOString(), "2026-09-17T18:00:00.001Z");
  assert.equal(c2.observedAt.toISOString(), "2026-09-17T18:00:00.001Z");
  assert.equal(c1Again.observedAt.toISOString(), "2026-09-17T18:00:00.002Z");
  assert.deepEqual(db.tokens.map((row) => row.creatorId), ["creator-1", "creator-2", "creator-1"]);
});

test("INT5.6A-1 current observation token issue fails closed without creator scope", async () => {
  const db = tokenDb();
  await assert.rejects(() => createFanObservationToken({
    db,
    job: { id: "job-no-creator", agencyId: "agency-a", creatorId: null },
    deviceId: "device-1",
    leaseRevision: 1,
    purpose: "fan_data_point_refresh",
    subjects: ["fan-1"],
  }), /FAN_OBSERVATION_TOKEN_SCOPE_INVALID/);
  assert.equal(db.queries.length, 0);
});

test("INT5.6A-1 creator clock remains the steady-state writer behind the explicit rolling bridge", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260917190000_phase3_creator_partitioned_observation_clock/migration.sql"), "utf8");
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "fan-observation-token-service.js"), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "FanObservationCreatorClock"/);
  assert.match(migration, /"creatorId" TEXT PRIMARY KEY/);
  assert.doesNotMatch(migration, /DROP TABLE.*FanObservationClock/i);
  assert.match(schema, /model FanObservationCreatorClock[\s\S]*creatorId\s+String\s+@id/);
  assert.match(schema, /model LegacyFanObservationClock[\s\S]*@@map\("FanObservationClock"\)/);
  assert.match(service, /INSERT INTO "FanObservationCreatorClock"/);
  assert.match(service, /active_creator_step/);
  assert.match(service, /phase3\.fanObservationCreatorClockV1/);
  assert.match(service, /normalizedCreatorId/);
  assert.match(service, /m\."active" = true/);
});
