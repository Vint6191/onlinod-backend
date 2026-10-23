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
let workProgress = null;
const recurringPlans = [], yieldedPlans = [];
const derivedCalls = [];
const subscriberCalls = [];
let claimClockAdvance = null;
let derivedFailure = null;
let analyticsResult = { created: 0, skipped: 0 };
let admissionError = null;

// These scheduling fixtures model stages that have already released independent work.
cacheModule(require.resolve("./initial-collection-readiness-service"), {
  loadInitialCollectionAdmission: async ({ creatorIds }) => new Map(creatorIds.map(id => [id, { financialReleased: true, campaignsReleased: true }])),
  initialCollectionAdmission: () => ({ admitted: true }),
});
cacheModule(prismaPath, {});
cacheModule(require.resolve("./subscriber-directory-service"), {
  async ensureSubscriberScanDue(input) {
    subscriberCalls.push(input);
    return { ok: true, created: false, reason: "fresh" };
  },
});
cacheModule(require.resolve("./analytics-recurring-planning-service"), {
  async planRecurringCreatorAnalytics(input) { analyticsCalls += 1; recurringPlans.push(input); return analyticsResult; },
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
for (const [file, name] of [
  ["follow-back-service", "ensureAutomaticFollowBack"], ["bump-service", "ensureAutomaticBumps"],
  ["likes-service", "ensureAutomaticLikes"], ["follow-automation-service", "ensureAutomaticFollowAutomation"],
  ["sfs-service", "ensureAutomaticSfs"],
]) cacheModule(require.resolve(`./${file}`), {
  [name]: async ({ creatorId }) => {
    derivedCalls.push({ name, creatorId });
    if (derivedFailure && name === "ensureAutomaticFollowBack") throw derivedFailure;
    return { ok: true, created: false, reason: "already_planned" };
  },
});
cacheModule(domainWorkPath, {
  WORK_CLASS: { CREATOR_RECURRING_PLANNING: "CREATOR_RECURRING_PLANNING" },
  async claimDomainWorkBatch(input) {
    assert.equal(input.workClass, "CREATOR_RECURRING_PLANNING");
    claimClockAdvance?.();
    return {
      ownerToken: "planning-owner",
      ...(admissionError ? { admissionError } : {}),
      authorityNow: new Date("2026-09-08T18:05:00.000Z"),
      items: creators.slice(0, input.limit).map((row, index) => ({ id: `work-${index}`, agencyId: row.agencyId, creatorId: row.id, objectId: row.id, progressCursor: workProgress })),
    };
  },
  async heartbeatDomainWorkClaim() { return { renewed: true, authorityNow: new Date("2026-09-08T18:05:00.000Z") }; },
  async ackDomainWorkClaim() { return { acknowledged: true }; },
  async failDomainWorkClaim() { return { failed: true }; },
  async yieldDomainWorkClaim(input) { yieldedPlans.push(input); return { yielded: true }; },
});

for (const hourlyDue of [false, true]) test(`published Subscriber generation plans derived work despite Analytics bootstrap waiting: hourlyDue=${hourlyDue}`, async () => {
  workProgress = { lastFullPlanningAt: hourlyDue ? "2026-09-08T16:00:00.000Z" : "2026-09-08T18:04:00.000Z", lastSubscriberDerivedGeneration: 1, retainedField: "keep" };
  derivedCalls.length = yieldedPlans.length = 0;
  subscriberCalls.length = 0;
  dailyCalls = 0;
  try {
    const db = {
      creatorAccount: { findFirst: async ({ where }) => creators.find(c => c.id === where.id) },
      subscriberDirectoryState: { findUnique: async ({ where }) => ({ agencyId: creators.find(c => c.id === where.creatorId).agencyId,
        currentRunId: "published-run", publishedAt: new Date("2026-09-08T18:05:00Z"), publishedGeneration: 2 }) },
    };
    const r = await runRecurringCreatorWork({ db, pageSize: 1 });
    assert.equal(r.ok, true);
    assert.equal(derivedCalls.length, 5);
    assert.equal(subscriberCalls.length, hourlyDue ? 1 : 0, "bootstrap waiting does not hide independently due Subscriber planning");
    assert.equal(dailyCalls, hourlyDue ? 1 : 0);
    assert.equal(yieldedPlans[0].progressCursor.lastSubscriberDerivedGeneration, 2);
    assert.equal(yieldedPlans[0].progressCursor.retainedField, "keep");
    assert.equal(yieldedPlans[0].preserveProgressOnNewerRevision, true);
    assert.equal(yieldedPlans[0].availableAt.toISOString(), hourlyDue ? "2026-09-08T19:05:00.000Z" : "2026-09-08T19:04:00.000Z");

    workProgress = yieldedPlans[0].progressCursor;
    derivedCalls.length = 0;
    const replay = await runRecurringCreatorWork({ db, pageSize: 1 });
    assert.equal(replay.ok, true);
    assert.equal(derivedCalls.length, 0, "same committed generation does not bypass hourly cadence twice");
  } finally { workProgress = null; }
});

test("a failed derived planner cannot consume the Subscriber generation", async () => {
  workProgress = { lastFullPlanningAt: "2026-09-08T18:04:00.000Z", lastSubscriberDerivedGeneration: 1 };
  derivedFailure = Object.assign(new Error("controlled outage"), { code: "P2024" });
  yieldedPlans.length = derivedCalls.length = 0;
  const db = { creatorAccount: { findFirst: async () => creators[0] }, subscriberDirectoryState: { findUnique: async () => ({
    agencyId: creators[0].agencyId, currentRunId: "published", publishedAt: new Date(), publishedGeneration: 2,
  }) } };
  try {
    const failed = await runRecurringCreatorWork({ db, pageSize: 1 });
    assert.equal(failed.ok, false);
    assert.equal(failed.retried, 1);
    assert.equal(yieldedPlans.length, 0);
    derivedFailure = null;
    const recovered = await runRecurringCreatorWork({ db, pageSize: 1 });
    assert.equal(recovered.ok, true);
    assert.equal(yieldedPlans[0].progressCursor.lastSubscriberDerivedGeneration, 2);
  } finally { workProgress = null; derivedFailure = null; }
});

test("admission exhausting a soft slice still attempts one owned creator and releases the rest", async (t) => {
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  claimClockAdvance = () => { clock += 2000; };
  yieldedPlans.length = 0;
  try {
    const db = { creatorAccount: { findFirst: async ({ where }) => creators.find(c => c.id === where.id) } };
    const r = await runRecurringCreatorWork({ db, pageSize: 3, maxRuntimeMs: 1000 });
    assert.equal(r.creatorsScanned, 1);
    assert.equal(r.yieldedForBudget, 2);
    assert.equal(yieldedPlans.length, 3);
  } finally { claimClockAdvance = null; }
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

test('event wake checks analytics debt and returns healthy creators to the hourly generic deadline', async () => {
  workProgress = { lastFullPlanningAt: '2026-09-08T18:04:00.000Z' };
  recurringPlans.length = yieldedPlans.length = 0;
  dailyCalls = 0;
  try {
    const db = { creatorAccount: { findFirst: async ({ where }) => creators.find(c => c.id === where.id) } };
    const r = await runRecurringCreatorWork({ db, pageSize: 2 });
    assert.equal(r.ok, true); assert.equal(r.creatorsScanned, 2);
    assert.equal(dailyCalls, 0);
    assert.ok(recurringPlans.every(p => p.includeCatchups === true), 'offline catch-up remains eligible between hourly generic planning cycles');
    for (const p of yieldedPlans) {
      assert.equal(p.availableAt.toISOString(), '2026-09-08T19:04:00.000Z');
      assert.equal(p.progressCursor.lastFullPlanningAt, workProgress.lastFullPlanningAt);
    }
  } finally { workProgress = null; }
});

test('known collector retry is scheduled at its backoff deadline without repeating hourly automation', async () => {
  workProgress = { lastFullPlanningAt: '2026-09-08T18:04:00.000Z' };
  analyticsResult = { created: 0, skipped: 1, nextRetryAt: new Date('2026-09-08T18:07:00.000Z'), pendingRecoveryCount: 2 };
  yieldedPlans.length = derivedCalls.length = 0;
  dailyCalls = 0;
  try {
    const db = { creatorAccount: { findFirst: async () => creators[0] } };
    const r = await runRecurringCreatorWork({ db, pageSize: 1 });
    assert.equal(r.ok, true);
    assert.equal(yieldedPlans[0].availableAt.toISOString(), '2026-09-08T18:07:00.000Z');
    assert.equal(yieldedPlans[0].progressCursor.lastFullPlanningAt, workProgress.lastFullPlanningAt);
    assert.equal(derivedCalls.length, 0);
    assert.equal(dailyCalls, 0);
    analyticsResult = { created: 0, skipped: 1, pendingRecoveryCount: 2 };
    yieldedPlans.length = 0;
    await runRecurringCreatorWork({ db, pageSize: 1 });
    assert.equal(yieldedPlans[0].availableAt.toISOString(), '2026-09-08T19:04:00.000Z', 'in-flight debt alone must not cause minute polling');
  } finally { workProgress = null; analyticsResult = { created: 0, skipped: 0 }; }
});

test('partial admission reports its database failure while executing every returned owner', async () => {
  admissionError = { code: 'P2024' };
  yieldedPlans.length = 0;
  try {
    const db = { creatorAccount: { findFirst: async ({ where }) => creators.find(c => c.id === where.id) } };
    const r = await runRecurringCreatorWork({ db, pageSize: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.creatorsScanned, 2);
    assert.equal(r.yielded, 2);
    assert.equal(r.retried, 0);
    assert.equal(r.planningReasons['admission:P2024'], 1);
  } finally { admissionError = null; }
});
