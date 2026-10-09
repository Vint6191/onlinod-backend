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

test("INT5.5C-1 mint never performs global retention; compatibility cleanup requires its own transaction", async () => {
  await assert.rejects(cleanupStaleFanObservationTokens(tokenDb([])), { code: "DB_COMMIT_ROOT_REQUIRED" });
  const source = fs.readFileSync(path.join(__dirname, "fan-observation-token-service.js"), "utf8");
  const mint = source.slice(source.indexOf("async function createScopedFanObservationToken"), source.indexOf("async function consumeScopedFanObservationToken"));
  assert.doesNotMatch(mint, /cleanupStale|deleteMany|Retention/);
  assert.equal(FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS, 86400000);
});

test("INT5.5C-1 token retention has a createdAt index and remains one authority table", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20261009000000_current_baseline/migration.sql"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "fan-observation-token-service.js"), "utf8");
  assert.match(schema, /model FanObservationToken[\s\S]*@@index\(\[createdAt\]\)/);
  assert.match(migration, /FanObservationToken_createdAt_idx/);
  assert.match(service, /deleteMany\(\{ where: consumeWhere \}\)/);
  assert.match(schema, /@@index\(\[createdAt, id\], map: "FanObservationToken_expiry_id_idx"\)/);
});
