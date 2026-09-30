"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createFanObservationToken,
} = require("./fan-observation-token-service");
const FAN_OBSERVATION_CREATOR_CLOCK_SETTING_KEY = "phase3.fanObservationCreatorClockV1";

function loadActivationService() {
  const prismaModule = require.resolve("../prisma");
  require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
  delete require.cache[require.resolve("./fan-observation-clock-activation-service")];
  return require("./fan-observation-clock-activation-service");
}

function millis(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function clockDb({ globalMs = 1_000, creators = {}, active = false, floorMs = null } = {}) {
  const state = {
    globalMs,
    creators: new Map(Object.entries(creators).map(([key, value]) => [key, Number(value)])),
    active,
    floorMs,
  };
  const tokens = [];
  return {
    state,
    tokens,
    async $queryRawUnsafe(sql, creatorId) {
      assert.match(sql, /phase3\.fanObservationCreatorClockV1/);
      assert.match(sql, /FOR SHARE/);
      assert.doesNotMatch(sql, /"FanObservationClock"/);
      assert.match(sql, /RETURNING "lastObservedAt"/);
      const previous = state.creators.get(creatorId);
      let next;
      if (!state.active) return [];
      else {
        assert.ok(Number.isFinite(state.floorMs), "active creator clock requires captured activation floor");
        next = Math.max(state.floorMs + 1, Number.isFinite(previous) ? previous + 1 : -Infinity);
        state.creators.set(creatorId, next);
      }
      return [{ lastObservedAt: new Date(next) }];
    },
    fanObservationToken: {
      async deleteMany() { return { count: 0 }; },
      async create({ data }) { tokens.push(data); return { id: BigInt(tokens.length), ...data }; },
    },
  };
}

async function issue(db, creatorId, id) {
  return createFanObservationToken({
    db,
    job: { id: `job-${id}`, agencyId: "agency-1", creatorId },
    deviceId: "device-1",
    leaseRevision: 1,
    purpose: "fan_data_point_refresh",
    subjects: [`fan-${id}`],
  });
}

test("Phase7 inactive creator clock refuses token publication", async () => {
 const db=clockDb({active:false,globalMs:1000});
 await assert.rejects(issue(db,'creator-1','1'),/FAN_OBSERVATION_CLOCK_UNAVAILABLE/);
 assert.equal(db.tokens.length,0);assert.equal(db.state.globalMs,1000);
});

test("Phase7 unrelated creators advance independently above the captured floor", async () => {
 const db=clockDb({active:true,floorMs:2000,globalMs:2000});
 const a=await issue(db,'a','1'),b=await issue(db,'b','2'),a2=await issue(db,'a','3');
 assert.equal(millis(a.observedAt),2001);assert.equal(millis(b.observedAt),2001);
 assert.equal(millis(a2.observedAt),2002);assert.equal(db.state.globalMs,2000);
});

test("INT5.7A-2 first creator token after activation is strictly greater than the captured legacy floor", async () => {
  const db = clockDb({ globalMs: 5_000, active: true, floorMs: 5_000 });
  const issued = await issue(db, "creator-new", "new");
  assert.equal(millis(issued.observedAt), 5_001);
  assert.equal(db.state.globalMs, 5_000);
});

test("INT5.7A-2 operator activation captures the locked legacy floor and is idempotent", async () => {
  let setting = { active: false, epoch: 3 };
  const updates = [];
  const tx = {
    async $queryRawUnsafe(sql, arg) {
      if (/SystemSetting/.test(sql) && /FOR UPDATE/.test(sql)) {
        assert.equal(arg, FAN_OBSERVATION_CREATOR_CLOCK_SETTING_KEY);
        return [{ value: setting }];
      }
      if (/FanObservationClock/.test(sql) && /FOR UPDATE/.test(sql)) {
        return [{ lastObservedAt: new Date(10_000), dbNow: new Date(10_000) }];
      }
      if (/clock_timestamp/.test(sql)) return [{ dbNow: new Date(10_001) }];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    systemSetting: {
      async update({ data }) {
        updates.push(data.value);
        setting = data.value;
        return { value: setting };
      },
    },
  };
  const db = { async $transaction(fn) { return fn(tx); } };
  const { activateFanObservationCreatorClockV1 } = loadActivationService();
  const result = await activateFanObservationCreatorClockV1({ db, activatedBy: "test-instance" });
  assert.equal(result.active, true);
  assert.equal(result.alreadyActive, false);
  assert.equal(result.epoch, 4);
  assert.equal(result.floorObservedAt, "1970-01-01T00:00:10.000Z");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].floorObservedAt, "1970-01-01T00:00:10.000Z");

  const again = await activateFanObservationCreatorClockV1({ db, activatedBy: "test-instance" });
  assert.equal(again.alreadyActive, true);
  assert.equal(again.epoch, 4);
  assert.equal(updates.length, 1);
});


test("INT5.7A-2 activation waits out small future skew while the barrier and legacy floor are locked", async () => {
  const events = [];
  const tx = {
    async $queryRawUnsafe(sql, arg) {
      if (/SystemSetting/.test(sql) && /FOR UPDATE/.test(sql)) {
        events.push("setting-lock");
        assert.equal(arg, FAN_OBSERVATION_CREATOR_CLOCK_SETTING_KEY);
        return [{ value: { active: false, epoch: 1 } }];
      }
      if (/FanObservationClock/.test(sql) && /FOR UPDATE/.test(sql)) {
        events.push("legacy-lock");
        return [{ lastObservedAt: new Date(10_100), dbNow: new Date(10_000) }];
      }
      if (/pg_sleep/.test(sql)) {
        throw new Error("PostgreSQL void cannot be decoded by Prisma queryRaw");
      }
      if (/clock_timestamp/.test(sql)) {
        events.push("recheck-time");
        return [{ dbNow: new Date(10_102) }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async $executeRawUnsafe(sql, arg) {
      // Transaction-local budget setup is not a domain mutation/lock.
      if (sql === "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('onlinod.phase7_executor_generation', 'phase7_legacy_storage_v1', true)") return 1;

      assert.match(sql, /SELECT pg_sleep/);
      events.push(["sleep", arg]);
      assert.ok(arg >= 0.1);
      return 1;
    },
    systemSetting: {
      async update({ data }) { events.push(["activate", data.value]); return data; },
    },
  };
  const db = { async $transaction(fn) { return fn(tx); } };
  const { activateFanObservationCreatorClockV1 } = loadActivationService();
  const result = await activateFanObservationCreatorClockV1({ db, maxFutureSkewMs: 1_000 });
  assert.equal(result.active, true);
  assert.equal(result.waitedForFutureSkewMs, 100);
  assert.deepEqual(events.slice(0, 4).map((event) => Array.isArray(event) ? event[0] : event), [
    "setting-lock", "legacy-lock", "sleep", "recheck-time",
  ]);
  assert.equal(events.at(-1)[0], "activate");
  assert.equal(events.at(-1)[1].activatedAt, new Date(10_102).toISOString());
});

test("INT5.7A-2 activation fails closed instead of propagating a large future-skewed legacy floor", async () => {
  const tx = {
    async $queryRawUnsafe(sql) {
      if (/SystemSetting/.test(sql)) return [{ value: { active: false, epoch: 0 } }];
      if (/FanObservationClock/.test(sql)) {
        return [{ lastObservedAt: new Date(60_000), dbNow: new Date(0) }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    systemSetting: { async update() { throw new Error("must not activate"); } },
  };
  const db = { async $transaction(fn) { return fn(tx); } };
  const { activateFanObservationCreatorClockV1 } = loadActivationService();
  await assert.rejects(
    () => activateFanObservationCreatorClockV1({ db, maxFutureSkewMs: 5_000 }),
    (error) => error?.message === "FAN_OBSERVATION_CLOCK_ACTIVATION_FUTURE_SKEW"
      && error.futureSkewMs === 60_000,
  );
});

test("INT5.7A-2 source contains an inactive durable bridge and explicit operator activation", () => {
  const service = fs.readFileSync(path.join(__dirname, "fan-observation-token-service.js"), "utf8");
  const activation = fs.readFileSync(path.join(__dirname, "fan-observation-clock-activation-service.js"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260917223000_phase3_observation_clock_bridge_activation/migration.sql"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));

  assert.match(migration, /phase3\.fanObservationCreatorClockV1/);
  assert.match(migration, /"active":false/);
  assert.match(migration, /BEFORE UPDATE ON "FanObservationClock"/);
  assert.match(migration, /FAN_OBSERVATION_LEGACY_CLOCK_RETIRED/);
  assert.match(migration, /COALESCE\(\("value"->>'active'\)::boolean, false\) = true/);
  assert.doesNotMatch(service, /"FanObservationClock"|bridge_global_sync/);
  assert.match(service, /"value"->>'active'='true'/);
  assert.match(service, /floor\+INTERVAL '1 millisecond'/);
  assert.match(activation, /SystemSetting[\s\S]*FOR UPDATE/);
  assert.match(activation, /FanObservationClock[\s\S]*FOR UPDATE/);
  assert.match(activation, /FAN_OBSERVATION_CLOCK_ACTIVATION_FUTURE_SKEW/);
  assert.match(activation, /floorObservedAt/);
  assert.equal(pkg.scripts["phase3:activate-observation-creator-clock-v1"], "node scripts/phase3-activate-observation-creator-clock-v1.js");
});
