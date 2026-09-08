"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function cacheModule(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const prismaPath = require.resolve("../prisma");
const plannerPath = require.resolve("./analytics-collection-planner");
const orchestratorPath = require.resolve("./creator-analytics-sync-orchestrator");
const dailyPath = require.resolve("./vault-intelligence-daily-service");
const schedulerPath = require.resolve("./job-scheduler");

const creators = Array.from({ length: 7 }, (_, index) => ({
  id: `creator-${String(index + 1).padStart(3, "0")}`,
  agencyId: `agency-${index % 2}`,
  remoteId: `of-${index + 1}`,
  username: `creator_${index + 1}`,
  displayName: `Creator ${index + 1}`,
}));

function pageRows({ where, take }) {
  const after = where?.id?.gt || null;
  const start = after ? creators.findIndex((row) => row.id === after) + 1 : 0;
  return creators.slice(start, start + take);
}

let genericQueries = 0;
let dailyCalls = 0;
let analyticsCalls = 0;
const leaseCalls = [];

cacheModule(prismaPath, {});
cacheModule(plannerPath, {
  async ensureOperationalAnalyticsFreshness() { throw new Error("not expected"); },
  async runAnalyticsCollectionSweep() { return { ok: true, skipped: true, reason: "test" }; },
  async runAnalyticsCollectionDemandSweep() { return { ok: true, skipped: true, reason: "test" }; },
  async claimAnalyticsSweepCycle(input) {
    leaseCalls.push(["claim", input.leaseKey, input.coordinationLockKey]);
    return {
      acquired: true,
      reason: "cycle_created",
      ownerToken: "owner-a",
      cycleKey: "2026-09-08T18:00:00.000Z",
      cycleNow: new Date("2026-09-08T18:05:00.000Z"),
      cursorCreatorId: null,
    };
  },
  async renewAnalyticsSweepLease(input) {
    leaseCalls.push(["renew", input.leaseKey, input.cursorCreatorId || null]);
    return true;
  },
  async completeAnalyticsSweepCycle(input) {
    leaseCalls.push(["complete", input.leaseKey, input.cursorCreatorId || null]);
    return true;
  },
});
cacheModule(orchestratorPath, {
  async creatorAnalyticsInitialSyncReady() { return false; },
  async ensureRecurringCreatorAnalyticsCatchups({ creatorId }) {
    analyticsCalls += 1;
    return { ready: true, initial: { created: false }, created: [], skipped: [`fresh:${creatorId}`] };
  },
});
cacheModule(dailyPath, {
  async ensureDailyVaultIntelligenceCycle() {
    dailyCalls += 1;
    return { ok: true, created: 0 };
  },
});

delete require.cache[schedulerPath];
const { runRecurringCreatorWork, runCreatorAnalyticsCatchupSweep } = require("./job-scheduler");

test("generic recurring READY traversal cursor-pages beyond one bounded page with no 10k horizon", async () => {
  genericQueries = 0;
  dailyCalls = 0;
  const db = {
    creatorAccount: {
      async findMany(input) {
        genericQueries += 1;
        assert.equal(input.take, 3);
        assert.deepEqual(input.orderBy, [{ id: "asc" }]);
        return pageRows(input);
      },
    },
  };

  const result = await runRecurringCreatorWork({ db, now: new Date("2026-09-08T18:05:00.000Z"), pageSize: 3 });
  assert.equal(result.creatorsScanned, 7);
  assert.equal(result.pages, 3);
  assert.equal(genericQueries, 3);
  assert.equal(dailyCalls, 7);
});

test("Creator Analytics catchups have one durable paginated sweep lane separate from generic recurring work", async () => {
  analyticsCalls = 0;
  leaseCalls.length = 0;
  const db = {
    creatorAccount: {
      async findMany(input) {
        assert.equal(input.take, 3);
        return pageRows(input);
      },
    },
  };

  const result = await runCreatorAnalyticsCatchupSweep({ db, now: new Date("2026-09-08T18:05:00.000Z"), pageSize: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.creators, 7);
  assert.equal(result.pages, 3);
  assert.equal(analyticsCalls, 7);
  assert.deepEqual(leaseCalls[0], [
    "claim",
    "creator_analytics_recurring_v1",
    "creator-analytics-recurring-sweep-coordinator",
  ]);
  assert.deepEqual(leaseCalls.at(-1), ["complete", "creator_analytics_recurring_v1", "creator-007"]);
  assert.ok(leaseCalls.some((entry) => entry[0] === "renew" && entry[2] === "creator-003"));
  assert.ok(leaseCalls.some((entry) => entry[0] === "renew" && entry[2] === "creator-006"));
});
