"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  finalizeCampaignFanRefreshJob,
  recordCampaignFanRefreshJobFailure,
  _test,
} = require("./campaign-fan-refresh-queue-service");

function terminalDb(demandCount, rawResult, calls) {
  const demands = Array.from({ length: demandCount }, (_, index) => ({
    id: `demand-${index + 1}`,
    creatorId: "creator-1",
    onlyFansUserId: `fan-${index + 1}`,
    requestedRevision: 1,
    activeRefreshRevision: 1,
    activeRefreshJobId: "refresh-job-1",
    retryAttempts: 0,
  }));
  const count = (key) => {
    calls.total += 1;
    calls[key] = (calls[key] || 0) + 1;
  };
  return {
    async $executeRawUnsafe() { count("execute"); return 1; },
    async $queryRawUnsafe(sql, ...args) {
      count("raw");
      if (/SELECT clock_timestamp\(\)/.test(sql)) return [{ authorityNow: new Date("2040-03-01T00:00:00.000Z") }];
      if (/FROM "CreatorFanRefreshDemand" WHERE "activeRefreshJobId"/.test(sql) && /FOR UPDATE/.test(sql)) return demands.map((row) => ({ id: row.id }));
      if (/INSERT INTO "CampaignFanRefreshPromotionSignal"/.test(sql) && /ON CONFLICT \("creatorId"\)/.test(sql)) {
        assert.match(sql, /LEAST\("CampaignFanRefreshPromotionSignal"\."dueAt", EXCLUDED\."dueAt"\)/);
        assert.match(sql, /RETURNING "dueAt", "revision"/);
        return [{ dueAt: args[3], revision: 1 }];
      }
      if (/transitionCampaignFanRefreshTerminalSetBased/.test("transitionCampaignFanRefreshTerminalSetBased") && /planned_delta AS/.test(sql) && /coverage_update AS/.test(sql)) {
        assert.match(sql, /ORDER BY d\."id" ASC[\s\S]*FOR UPDATE OF d/);
        assert.match(sql, /ORDER BY w\."id" ASC[\s\S]*FOR UPDATE OF w/);
        assert.match(sql, /"retryAttempts" = d\."retryAttempts" \+ 1/);
        assert.match(sql, /'QUARANTINED'/);
        assert.match(sql, /CAMPAIGN_FAN_VALUE_REFRESH_PENDING/);
        assert.match(sql, /CAMPAIGN_FAN_VALUE_REFRESH_PARTIAL/);
        assert.equal(args[0], "refresh-job-1");
        assert.ok(args[1] instanceof Date);
        assert.equal(typeof args[2], "string");
        return [rawResult];
      }
      throw new Error(`unexpected raw SQL in A20.5 terminal topology harness: ${sql.slice(0, 140)}`);
    },
    creatorFanRefreshDemand: {
      async findMany() { count("demand.findMany"); return demands.map((row) => ({ ...row })); },
      async update() { count("demand.update"); throw new Error("production terminal path must not call per-demand update"); },
    },
    creatorCampaignFanRefreshWork: {
      async updateMany() { count("work.updateMany"); throw new Error("production terminal path must not call per-demand work updateMany"); },
    },
    creatorCampaignCollectionState: {},
  };
}

for (const demandCount of [1, 20, 50]) {
  test(`A20.5 finalize keeps bounded terminal topology for ${demandCount} demands`, async () => {
    const calls = { total: 0 };
    const db = terminalDb(demandCount, {
      coverageTransitionLost: 0,
      applied: demandCount,
      workTransitioned: demandCount,
      coverageRunsUpdated: 1,
    }, calls);
    const result = await finalizeCampaignFanRefreshJob({
      db,
      job: { id: "refresh-job-1", jobKey: "fan_data_point_refresh", agencyId: "agency-1", creatorId: "creator-1" },
      result: {},
    });
    assert.equal(result.applied, demandCount);
    assert.equal(result.workTransitioned, demandCount);
    assert.equal(result.topology, "set_based_v1");
    assert.equal(calls.raw, 4, "row lock + DB clock + terminal CTE + durable signal merge must remain constant");
    assert.equal(calls["demand.findMany"], 1);
    assert.equal(calls["demand.update"] || 0, 0);
    assert.equal(calls["work.updateMany"] || 0, 0);
    assert.equal(calls.total, 6, "campaign authority + terminal + durable-signal topology must not grow with demand count");
  });
}

for (const demandCount of [1, 20, 50]) {
  test(`A20.5 terminal failure keeps bounded topology for ${demandCount} demands`, async () => {
    const calls = { total: 0 };
    const db = terminalDb(demandCount, {
      coverageTransitionLost: 0,
      applied: demandCount,
      workTransitioned: demandCount,
      coverageRunsUpdated: 1,
    }, calls);
    const result = await recordCampaignFanRefreshJobFailure({
      db,
      job: { id: "refresh-job-1", jobKey: "fan_data_point_refresh", agencyId: "agency-1", creatorId: "creator-1" },
      error: new Error("provider terminal failure"),
      terminal: true,
    });
    assert.equal(result.applied, demandCount);
    assert.equal(result.workTransitioned, demandCount);
    assert.equal(result.topology, "set_based_v1");
    assert.equal(calls.raw, 4);
    assert.equal(calls.total, 6);
  });
}

test("A20.5 partial 25/50 completion terminalizes only the remaining active demands with bounded topology", async () => {
  const calls = { total: 0 };
  const db = terminalDb(25, {
    coverageTransitionLost: 0,
    applied: 25,
    workTransitioned: 25,
    coverageRunsUpdated: 1,
  }, calls);
  const result = await finalizeCampaignFanRefreshJob({
    db,
    job: { id: "refresh-job-1", jobKey: "fan_data_point_refresh", agencyId: "agency-1", creatorId: "creator-1" },
    result: { items: 25 },
  });
  assert.equal(result.applied, 25);
  assert.equal(result.topology, "set_based_v1");
  assert.equal(calls.total, 6);
});

test("A20.5 terminal transition fails closed when current coverage cannot absorb the planned decrement", async () => {
  const calls = { total: 0 };
  const db = terminalDb(20, {
    coverageTransitionLost: 1,
    applied: 0,
    workTransitioned: 0,
    coverageRunsUpdated: 0,
  }, calls);
  await assert.rejects(
    () => finalizeCampaignFanRefreshJob({
      db,
      job: { id: "refresh-job-1", jobKey: "fan_data_point_refresh", agencyId: "agency-1", creatorId: "creator-1" },
    }),
    /CAMPAIGN_FAN_REFRESH_TERMINAL_COVERAGE_TRANSITION_LOST/,
  );
  assert.equal(calls.raw, 3);
});

test("A20.5 source keeps terminal demand/work locks deterministic and retry/quarantine bounded", () => {
  const source = fs.readFileSync(path.join(__dirname, "campaign-fan-refresh-queue-service.js"), "utf8");
  assert.match(source, /transitionCampaignFanRefreshTerminalSetBased[\s\S]*ORDER BY d\."id" ASC[\s\S]*FOR UPDATE OF d/);
  assert.match(source, /work_before AS \([\s\S]*ORDER BY w\."id" ASC[\s\S]*FOR UPDATE OF w/);
  assert.match(source, /"retryAttempts" = d\."retryAttempts" \+ 1/);
  assert.match(source, /CAMPAIGN_FAN_REFRESH_MAX_RETRIES/);
  assert.match(source, /CAMPAIGN_FAN_REFRESH_TERMINAL_COVERAGE_TRANSITION_LOST/);
  assert.match(source, /supportsSetBasedCampaignFanRefreshTerminal\(db\)/);
  assert.equal(_test.supportsSetBasedCampaignFanRefreshTerminal({
    $queryRawUnsafe() {},
    $executeRawUnsafe() {},
    creatorFanRefreshDemand: { findMany() {} },
    creatorCampaignFanRefreshWork: { updateMany() {} },
    creatorCampaignCollectionState: {},
  }), true);
});

test("A20.5 proof runner includes terminal concurrency and seeded pre-A20.2 rolling backfill verification", () => {
  const runner = fs.readFileSync(path.join(__dirname, "../../scripts/audit/phase3-a20-postgres-proof.js"), "utf8");
  const seeded = fs.readFileSync(path.join(__dirname, "../../scripts/audit/phase3-a20-seeded-rolling-coverage.js"), "utf8");
  assert.match(runner, /phase3-campaign-closure-a20-5\.integration\.test\.js/);
  assert.match(runner, /PRE_A20_2_CUTOFF/);
  assert.match(runner, /seeded-pre-a20-2-data/);
  assert.match(runner, /seeded-a20-2-backfill-verify/);
  assert.match(seeded, /campaigns-v13-wrapped/);
  assert.match(seeded, /campaigns-v13-unwrapped/);
  assert.match(seeded, /superseded historical work must not win/);
  assert.match(seeded, /CURRENT_STATE_FALLBACK_EXPLAIN_SQL/);
  assert.match(runner, /seeded-a20-2-online-preflight/);
});
