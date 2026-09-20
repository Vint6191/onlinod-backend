"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  enqueueUniqueCampaignFanRefreshes,
  recoverFailedCampaignFanRefreshDemands,
  _test,
} = require("./campaign-fan-refresh-queue-service");

function topologyQueueDb(callCounter) {
  const state = {
    creatorId: "c1",
    agencyId: "a1",
    mode: "catchup",
    membershipCoverageStatus: "COMPLETE",
    campaignFrontierFreshnessStatus: "COMPLETE",
    fanValueCoverageScanRunId: null,
    fanValueFreshnessCutoffAt: null,
    fanValueFreshnessStatus: "MISSING",
    fanValueExpected: 0,
    fanValueAlreadyFresh: 0,
    fanValueQueued: 0,
    fanValueSucceeded: 0,
    fanValueUnavailable: 0,
    fanValueFailed: 0,
    fanValueOutstanding: 0,
  };
  const count = (name) => { callCounter.total += 1; callCounter[name] = (callCounter[name] || 0) + 1; };
  const apply = (target, data) => {
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "increment")) target[key] = Number(target[key] || 0) + Number(value.increment || 0);
      else if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "decrement")) target[key] = Number(target[key] || 0) - Number(value.decrement || 0);
      else target[key] = value;
    }
  };
  return {
    async $executeRawUnsafe() { count("execute"); return 1; },
    async $queryRawUnsafe(sql, ...args) {
      count("raw");
      if (/FROM "JobInstance"/.test(sql) && /pendingGlobal/.test(sql)) {
        return [{ pendingGlobal: 0n, pendingCreator: 0n }];
      }
      if (/LEFT JOIN "JobInstance"/.test(sql) && /demand_update AS/.test(sql)) {
        const fanIds = args[1];
        return fanIds.map((fanId, index) => ({
          id: `demand-${index + 1}`,
          onlyFansUserId: fanId,
          requestedRevision: 1,
          activeRefreshJobId: null,
          activeRefreshRevision: null,
        }));
      }
      if (/FROM UNNEST\(\$1::text\[\], \$2::int\[\]\)/.test(sql) && /SELECT d\."id"/.test(sql) && !/work_update AS/.test(sql)) {
        return args[0].map((id, index) => ({ id, requestedRevision: args[1][index], activeRefreshJobId: null }));
      }
      if (/FROM UNNEST\(\$1::text\[\], \$2::int\[\]\)/.test(sql) && /work_update AS/.test(sql)) {
        return [{ demandBound: args[0].length, workBound: 0 }];
      }
      throw new Error(`unexpected raw SQL in A20.3 queue topology harness: ${sql.slice(0, 120)}`);
    },
    creatorCampaignCollectionState: {
      async findUnique() { count("coverage.findUnique"); return { ...state }; },
      async update({ data }) { count("coverage.update"); apply(state, data); return { ...state }; },
      async updateMany({ where, data }) {
        count("coverage.updateMany");
        if (where.fanValueCoverageScanRunId && state.fanValueCoverageScanRunId !== where.fanValueCoverageScanRunId) return { count: 0 };
        apply(state, data); return { count: 1 };
      },
    },
    creatorCampaignFanRefreshWork: {
      async findMany() { count("work.findMany"); return []; },
      async createMany({ data }) { count("work.createMany"); return { count: data.length }; },
      async updateMany() { count("work.updateMany"); return { count: 0 }; },
    },
    creatorFanRefreshDemand: {
      async createMany({ data }) { count("demand.createMany"); return { count: data.length }; },
      async findMany() { count("demand.findMany"); return []; },
      async updateMany() { count("demand.updateMany"); return { count: 0 }; },
    },
    jobInstance: {},
  };
}

for (const fanCount of [1, 20, 50]) {
  test(`A20.3 ordinary Campaign queue keeps bounded DB topology for ${fanCount} stale fans`, async () => {
    const calls = { total: 0 };
    const db = topologyQueueDb(calls);
    const planner = async ({ params }) => ({ job: { id: "refresh-job-1", status: "SCHEDULED", params } });
    const candidates = Array.from({ length: fanCount }, (_, index) => ({ onlyFansUserId: `fan-${index + 1}` }));
    const result = await enqueueUniqueCampaignFanRefreshes({
      db,
      job: { id: "campaign-job-1", agencyId: "a1", creatorId: "c1", priority: 80, params: { campaignFreshnessCoverageVersion: 1 } },
      scanRunId: "run-1",
      scanStartedAt: new Date("2040-01-02T00:00:00.000Z"),
      candidates,
      now: new Date("2040-01-02T00:00:01.000Z"),
      planner,
      collectorVersion: "campaigns-v13",
    });
    assert.equal(result.queued, fanCount);
    assert.equal(result.scheduled, fanCount);
    assert.equal(calls.raw, 4, "revision/lock/capacity/bind SQL topology must be constant");
    assert.equal(calls.execute, 2, "campaign transaction authority + capacity advisory lock remain bounded");
    assert.equal(calls.total, 12, "A20.12 adds one transaction-wide Campaign authority call while keeping queue topology constant");
  });
}


for (const demandCount of [1, 20, 50]) {
  test(`A20.3 scheduled refresh job binds ${demandCount} demand/work rows with constant SQL topology`, async () => {
    const calls = { raw: 0, execute: 0 };
    const rows = Array.from({ length: demandCount }, (_, index) => ({
      fanId: `fan-${index + 1}`,
      revision: index + 1,
      demand: { id: `demand-${index + 1}` },
    }));
    const db = {
      async $executeRawUnsafe() { calls.execute += 1; return 1; },
      async $queryRawUnsafe(sql, ...args) {
        calls.raw += 1;
        if (/FROM "JobInstance"/.test(sql) && /pendingGlobal/.test(sql)) return [{ pendingGlobal: 0n, pendingCreator: 0n }];
        if (/SELECT d\."id"/.test(sql) && /FOR UPDATE OF d/.test(sql) && !/demand_update AS/.test(sql)) {
          return args[0].map((id, index) => ({ id, requestedRevision: args[1][index], activeRefreshJobId: null }));
        }
        if (/demand_update AS/.test(sql) && /work_update AS/.test(sql)) {
          return [{ demandBound: args[0].length, workBound: args[0].length }];
        }
        throw new Error(`unexpected raw SQL in A20.3 binding topology harness: ${sql.slice(0, 120)}`);
      },
      creatorFanRefreshDemand: {
        createMany: async () => ({ count: 0 }),
        updateMany: async () => ({ count: 0 }),
      },
      creatorCampaignFanRefreshWork: {
        createMany: async () => ({ count: 0 }),
        updateMany: async () => ({ count: 0 }),
      },
      creatorCampaignCollectionState: {},
      jobInstance: {},
    };
    const refreshJobId = await _test.scheduleDemandRefreshJob({
      db,
      job: { id: "campaign-job", agencyId: "a1", creatorId: "c1", priority: 80 },
      demands: rows,
      scheduledAt: new Date("2040-01-02T00:00:00.000Z"),
      planner: async () => ({ job: { id: "refresh-job-1", status: "SCHEDULED" } }),
    });
    assert.equal(refreshJobId, "refresh-job-1");
    assert.equal(calls.raw, 3, "lock/capacity/bind query topology must be constant");
    assert.equal(calls.execute, 1, "capacity advisory lock remains bounded");
  });
}

function topologyRecoveryDb(rawResult, counter) {
  return {
    $executeRawUnsafe: async (sql, ...args) => {
      counter.execute = (counter.execute || 0) + 1;
      assert.match(String(sql), /pg_advisory_xact_lock/);
      assert.equal(args[0], "analytics-collector:campaigns:c1");
      return 1;
    },
    creatorFanRefreshDemand: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    creatorCampaignFanRefreshWork: {
      updateMany: async () => ({ count: 0 }),
    },
    creatorCampaignCollectionState: {},
    async $queryRawUnsafe(sql, ...args) {
      counter.calls += 1;
      const [now, force, creatorId, limit] = args;
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      assert.match(sql, /failed_work AS/);
      assert.match(sql, /work_update AS/);
      assert.match(sql, /demand_update AS/);
      assert.match(sql, /coverage_guard AS/);
      assert.match(sql, /coverage_update AS/);
      assert.ok(now instanceof Date);
      assert.equal(force, false);
      assert.equal(creatorId, "c1");
      assert.ok(limit >= 1);
      assert.match(sql, /d\."creatorId" = \$3/);
      assert.doesNotMatch(sql, /ANY\(\$5::text\[\]\)|SELECT DISTINCT d\."creatorId"/);
      return [rawResult];
    },
  };
}

for (const demandCount of [1, 20, 200]) {
  test(`A20.3 failed-demand recovery keeps one production SQL round trip for ${demandCount} demands`, async () => {
    const counter = { calls: 0 };
    const db = topologyRecoveryDb({
      coverageTransitionLost: 0,
      recovered: demandCount,
      requeuedWork: demandCount,
      coverageRunsUpdated: 1,
    }, counter);
    const result = await recoverFailedCampaignFanRefreshDemands({
      db, creatorId: "c1",
      now: new Date("2040-01-02T01:00:00.000Z"),
      maxDemands: demandCount,
    });
    assert.equal(counter.calls, 1);
    assert.equal(counter.execute, 1);
    assert.equal(result.recovered, demandCount);
    assert.equal(result.requeuedWork, demandCount);
    assert.equal(result.topology, "set_based_v3_creator_scoped");
  });
}

test("A20.3 failed-demand recovery fails closed on current coverage counter mismatch", async () => {
  const counter = { calls: 0 };
  const db = topologyRecoveryDb({ coverageTransitionLost: 1, recovered: 0, requeuedWork: 0, coverageRunsUpdated: 0 }, counter);
  await assert.rejects(
    () => recoverFailedCampaignFanRefreshDemands({ db, creatorId: "c1", now: new Date("2040-01-02T01:00:00.000Z"), maxDemands: 20 }),
    /CAMPAIGN_FAN_REFRESH_REQUEUE_COVERAGE_TRANSITION_LOST/,
  );
  assert.equal(counter.calls, 1);
  assert.equal(counter.execute, 1);
});

test("A20.3 source has deterministic set-based queue/recovery locking and no production per-demand binding loop", () => {
  const source = fs.readFileSync(path.join(__dirname, "campaign-fan-refresh-queue-service.js"), "utf8");
  assert.match(source, /advanceCampaignFanRefreshDemandsSetBased[\s\S]*ORDER BY d\."id" ASC[\s\S]*FOR UPDATE OF d/);
  assert.match(source, /recoverFailedCampaignFanRefreshDemandsSetBased[\s\S]*ORDER BY COALESCE[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.match(source, /failed_work AS \([\s\S]*ORDER BY w\."id" ASC[\s\S]*FOR UPDATE OF w/);
  assert.match(source, /bindDemandRefreshJobSetBased[\s\S]*work_update AS/);
  assert.match(source, /supportsSetBasedCampaignFanRefreshQueue\(db\)/);
  assert.match(source, /supportsSetBasedCampaignFanRefreshRecovery\(db\)/);
  const auditScript = fs.readFileSync(path.join(__dirname, "../../scripts/audit/phase3-a20-postgres-proof.js"), "utf8");
  const packageJson = fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8");
  assert.match(auditScript, /phase3-campaign-closure-a20-3\.integration\.test\.js/);
  assert.match(auditScript, /phase3-campaign-closure-a19\.integration\.test\.js/);
  assert.match(packageJson, /audit:phase3-a20-postgres/);
});
