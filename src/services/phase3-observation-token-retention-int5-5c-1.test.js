"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  observationScopeHash,
  consumeFanObservationToken,
  cleanupStaleFanObservationTokens,
  FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS,
} = require("./fan-observation-token-service");

function matches(row, where = {}) {
  for (const [key, expected] of Object.entries(where)) {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, "lt")) {
        if (!(row[key] < expected.lt)) return false;
        continue;
      }
    }
    if ((row[key] ?? null) !== (expected ?? null)) return false;
  }
  return true;
}

function tokenDb(rows) {
  const state = rows.map((row) => ({ ...row }));
  return {
    state,
    fanObservationToken: {
      findUnique: async ({ where }) => {
        const row = state.find((item) => item.token === where.token);
        return row ? { ...row } : null;
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        for (let index = state.length - 1; index >= 0; index -= 1) {
          if (!matches(state[index], where)) continue;
          state.splice(index, 1);
          count += 1;
        }
        return { count };
      },
    },
  };
}

test("INT5.5C-1 consumed observation tokens are physically removed and replay fails closed", async () => {
  const purpose = "fan_data_point_refresh";
  const subjects = ["fan-1"];
  const db = tokenDb([{
    id: 1n,
    token: "token-1",
    jobId: "job-1",
    deliveryId: null,
    deviceId: "device-1",
    leaseRevision: 2,
    purpose,
    scopeHash: observationScopeHash({ purpose, subjects }),
    observedAt: new Date("2026-09-17T10:00:00.000Z"),
    consumedAt: null,
    createdAt: new Date("2026-09-17T10:00:00.000Z"),
  }]);

  const job = { id: "job-1" };
  const consumed = await consumeFanObservationToken({
    db, job, deviceId: "device-1", leaseRevision: 2,
    token: "token-1", purpose, subjects,
  });
  assert.equal(consumed.observedAt.toISOString(), "2026-09-17T10:00:00.000Z");
  assert.equal(db.state.length, 0, "production consume must not retain an audit row forever");

  await assert.rejects(() => consumeFanObservationToken({
    db, job, deviceId: "device-1", leaseRevision: 2,
    token: "token-1", purpose, subjects,
  }), /FAN_OBSERVATION_TOKEN_INVALID/);
});

test("INT5.5C-1 abandoned token cleanup is time bounded and preserves live tokens", async () => {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const db = tokenDb([
    { token: "stale", createdAt: new Date(now.getTime() - FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS - 1) },
    { token: "edge", createdAt: new Date(now.getTime() - FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS) },
    { token: "live", createdAt: new Date(now.getTime() - 60_000) },
  ]);
  const result = await cleanupStaleFanObservationTokens(db, { now, force: true });
  assert.equal(result.deleted, 1);
  assert.deepEqual(db.state.map((row) => row.token).sort(), ["edge", "live"]);
});

test("INT5.5C-1 token retention has a createdAt index and remains one authority table", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260917113000_phase3_observation_token_retention/migration.sql"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "fan-observation-token-service.js"), "utf8");
  assert.match(schema, /model FanObservationToken[\s\S]*@@index\(\[createdAt\]\)/);
  assert.match(migration, /FanObservationToken_createdAt_idx/);
  assert.match(service, /deleteMany\(\{ where: consumeWhere \}\)/);
  assert.match(service, /FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS\s*=\s*24\s*\*\s*60\s*\*\s*60_000/);
});
