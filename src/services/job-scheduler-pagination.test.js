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
const domainWorkPath = require.resolve("./domain-work-authority-service");
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
cacheModule(require.resolve("./analytics-recurring-planning-service"), {
  async planRecurringCreatorAnalytics() { analyticsCalls += 1; return { created: 0, skipped: 0 }; },
});
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
cacheModule(domainWorkPath, {
  WORK_CLASS: { CREATOR_RECURRING_PLANNING: "CREATOR_RECURRING_PLANNING" },
  async claimDomainWorkBatch(input) {
    assert.equal(input.workClass, "CREATOR_RECURRING_PLANNING");
    return {
      ownerToken: "planning-owner",
      authorityNow: new Date("2026-09-08T18:05:00.000Z"),
      items: creators.slice(0, input.limit).map((row, index) => ({ id: `work-${index}`, agencyId: row.agencyId, creatorId: row.id, objectId: row.id })),
    };
  },
  async heartbeatDomainWorkClaim() { return { renewed: true, authorityNow: new Date("2026-09-08T18:05:00.000Z") }; },
  async ackDomainWorkClaim() { return { acknowledged: true }; },
  async failDomainWorkClaim() { return { failed: true }; },
  async yieldDomainWorkClaim() { return { yielded: true }; },
});

delete require.cache[schedulerPath];
const { runRecurringCreatorWork, runCreatorAnalyticsCatchupSweep } = require("./job-scheduler");

test("generic recurring planning claims one bounded durable batch without a READY catalog scan", async () => {
  genericQueries = 0;
  dailyCalls = 0;
  const db = {
    creatorAccount: {
      async findFirst(input) {
        genericQueries += 1;
        return creators.find((row) => row.id === input.where.id) || null;
      },
    },
  };

  const result = await runRecurringCreatorWork({ db, now: new Date("2026-09-08T18:05:00.000Z"), pageSize: 3 });
  assert.equal(result.creatorsScanned, 3);
  assert.equal(result.selected, 3);
  assert.equal(result.pages, 1);
  assert.equal(genericQueries, 3);
  assert.equal(dailyCalls, 3);
});

test("Creator Analytics compatibility entry uses the same bounded durable lane", async () => {
  analyticsCalls = 0;
  leaseCalls.length = 0;
  const db = { creatorAccount: {
    async findMany() { throw new Error("global catalog traversal retired"); },
    async findFirst({ where }) { return creators.find((row) => row.id === where.id); },
  } };
  const result = await runCreatorAnalyticsCatchupSweep({ db, pageSize: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.selected, 3);
  assert.equal(result.creatorsScanned, 3);
  assert.equal(analyticsCalls, 3);
  assert.deepEqual(leaseCalls, []);
});
