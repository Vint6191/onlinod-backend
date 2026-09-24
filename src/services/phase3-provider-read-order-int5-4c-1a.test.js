"use strict";
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  observationScopeHash,
  createFanObservationToken,
  consumeFanObservationToken,
} = require("./fan-observation-token-service");
const { applyFanDataPointRefreshChunk } = require("./fan-data-authority-service");

function projectionDb({ tokenRow = null, authorityNow = new Date("2026-09-17T00:00:10.000Z") } = {}) {
  let fan = null;
  let relationship = null;
  let token = tokenRow ? { ...tokenRow } : null;
  const matches = (row, where = {}) => {
    if (!row) return false;
    for (const [key, value] of Object.entries(where)) {
      if (key === "OR") continue;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (Object.prototype.hasOwnProperty.call(value, "lt")) {
          if (row[key] != null && !(row[key] < value.lt)) return false;
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(value, "in")) {
          if (!value.in.includes(row[key])) return false;
          continue;
        }
        for (const [innerKey, innerValue] of Object.entries(value)) if (row[innerKey] !== innerValue) return false;
        continue;
      }
      if (row[key] !== value) return false;
    }
    if (Array.isArray(where.OR) && !where.OR.some((branch) => matches(row, branch))) return false;
    return true;
  };
  return {
    get relationship() { return relationship; },
    $queryRawUnsafe: async () => [{ authorityNow }],
    fanObservationToken: {
      findUnique: async ({ where }) => token && token.token === where.token ? { ...token } : null,
      updateMany: async ({ where, data }) => {
        if (!token || token.token !== where.token || token.consumedAt) return { count: 0 };
        token = { ...token, ...data };
        return { count: 1 };
      },
    },
    creatorFan: {
      findUnique: async () => fan,
      findMany: async () => fan ? [fan] : [],
      create: async ({ data }) => { fan = { id: "fan-record", ...data }; return fan; },
      updateMany: async ({ where, data }) => {
        if (!matches(fan, where)) return { count: 0 };
        fan = { ...fan, ...data }; return { count: 1 };
      },
    },
    creatorFanRelationshipCurrent: {
      findUnique: async () => relationship,
      create: async ({ data }) => { relationship = { id: "rel", ...data }; return relationship; },
      updateMany: async ({ where, data }) => {
        if (!matches(relationship, where)) return { count: 0 };
        relationship = { ...relationship, ...data }; return { count: 1 };
      },
    },
    creatorFanValueCurrent: { findUnique: async () => null },
  };
}

test("INT5.4C-1A observation token scope hash is deterministic and subject-order independent", () => {
  const a = observationScopeHash({ purpose: "fan_data_point_refresh", subjects: ["fan-b", "fan-a", "fan-a"] });
  const b = observationScopeHash({ purpose: "fan_data_point_refresh", subjects: ["fan-a", "fan-b"] });
  assert.equal(a, b);
});

test("INT5.4C-1A token issuer persists PostgreSQL-owned monotonic observation time", async () => {
  const issuedAt = new Date("2026-09-17T00:00:01.001Z");
  const created = [];
  const db = {
    $queryRawUnsafe: async (sql, creatorId) => {
      assert.match(sql, /FanObservationCreatorClock/);
      assert.match(sql, /ON CONFLICT \("creatorId"\) DO UPDATE/);
      assert.match(sql, /lastObservedAt.*INTERVAL '1 millisecond'/s);
      assert.equal(creatorId, "c1");
      return [{ lastObservedAt: issuedAt }];
    },
    fanObservationToken: { create: async ({ data }) => { created.push(data); return data; } },
  };
  const result = await createFanObservationToken({
    db: commitDatabaseFixture(db),
    job: { id: "job-1", agencyId: "a1", creatorId: "c1" },
    deviceId: "device-1",
    leaseRevision: 7,
    purpose: "fan_data_point_refresh",
    subjects: ["fan-2", "fan-1"],
  });
  assert.equal(result.observedAt.toISOString(), issuedAt.toISOString());
  assert.equal(created.length, 1);
  assert.equal(created[0].observedAt.toISOString(), issuedAt.toISOString());
  assert.equal(created[0].leaseRevision, 7);
});

test("INT5.4C-1A point refresh uses post-read token chronology instead of older job creation order", async () => {
  const tokenObservedAt = new Date("2026-09-17T00:05:00.000Z");
  const purpose = "fan_data_point_refresh";
  const subjects = ["fan-1"];
  const tokenRow = {
    id: 11n,
    token: "token-1",
    jobId: "job-old",
    agencyId: "a1",
    creatorId: "c1",
    deviceId: "device-1",
    leaseRevision: 3,
    purpose,
    scopeHash: observationScopeHash({ purpose, subjects }),
    observedAt: tokenObservedAt,
    consumedAt: null,
  };
  const db = projectionDb({ tokenRow });
  await applyFanDataPointRefreshChunk({
    db: commitDatabaseFixture(db),
    job: {
      id: "job-old",
      agencyId: "a1",
      creatorId: "c1",
      createdAt: new Date("2026-09-17T00:00:00.000Z"),
      leaseRevision: 3,
      params: { fanIds: subjects, observationTokenVersion: 1 },
    },
    deviceId: "device-1",
    chunkResult: {
      kind: "fan_data_point_refresh",
      observationToken: "token-1",
      items: [{ onlyFansUserId: "fan-1", relationship: { creatorFollowsFan: true, source: "USER_PROFILE" } }],
    },
  });
  assert.equal(db.relationship.observedAt.toISOString(), tokenObservedAt.toISOString());
});

test("INT5.4C-1A current point-refresh jobs fail closed on missing/replayed observation token", async () => {
  const db = projectionDb();
  const job = {
    id: "job-current",
    agencyId: "a1",
    creatorId: "c1",
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    leaseRevision: 1,
    params: { fanIds: ["fan-1"], observationTokenVersion: 1 },
  };
  await assert.rejects(() => applyFanDataPointRefreshChunk({
    db: commitDatabaseFixture(db), job, deviceId: "device-1",
    chunkResult: { kind: "fan_data_point_refresh", items: [{ onlyFansUserId: "fan-1", relationship: { creatorFollowsFan: true, source: "USER_PROFILE" } }] },
  }), /FAN_OBSERVATION_TOKEN_REQUIRED|observation token/i);
});

test("INT5.4C-1A backend route and migration expose lease-bound monotonic observation-token authority", () => {
  const backendRoute = fs.readFileSync(path.join(__dirname, "../routes/jobs.js"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260916234500_phase3_provider_observation_token/migration.sql"), "utf8");
  const creatorClockMigration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260917190000_phase3_creator_partitioned_observation_clock/migration.sql"), "utf8");
  const tokenService = fs.readFileSync(path.join(__dirname, "fan-observation-token-service.js"), "utf8");
  assert.match(backendRoute, /\/:id\/observation-token/);
  assert.match(backendRoute, /leaseToken: input\.leaseToken/);
  assert.match(backendRoute, /leaseRevision: input\.leaseRevision/);
  assert.match(migration, /FanObservationClock/);
  assert.match(creatorClockMigration, /FanObservationCreatorClock/);
  assert.match(creatorClockMigration, /"creatorId" TEXT PRIMARY KEY/);
  assert.match(tokenService, /FanObservationCreatorClock/);
  assert.match(tokenService, /INTERVAL '1 millisecond'/);
});
