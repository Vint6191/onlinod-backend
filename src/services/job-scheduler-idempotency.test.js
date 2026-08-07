"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function cacheModule(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const prismaPath = require.resolve("../prisma");
const retentionPath = require.resolve("./retention-service");
const subscriberPath = require.resolve("./subscriber-directory-service");
const followBackPath = require.resolve("./follow-back-service");
const bumpPath = require.resolve("./bump-service");
const likesPath = require.resolve("./likes-service");
const followAutomationPath = require.resolve("./follow-automation-service");
const sfsPath = require.resolve("./sfs-service");
const schedulerPath = require.resolve("./job-scheduler");

const state = {
  findUnique: async () => null,
  findMany: async () => [],
  createMany: async () => ({ count: 1 }),
  updateMany: async () => ({ count: 1 }),
};

cacheModule(prismaPath, {
  jobInstance: {
    findUnique: (...args) => state.findUnique(...args),
    findMany: (...args) => state.findMany(...args),
    createMany: (...args) => state.createMany(...args),
    updateMany: (...args) => state.updateMany(...args),
  },
});
cacheModule(retentionPath, {
  async runRetentionSweep() { return { totalDeleted: 0 }; },
  async getRetentionSettings() { return { settings: { retentionSweepWindowHours: 24 } }; },
});
cacheModule(subscriberPath, { async ensureSubscriberScanDue() { return { created: false }; } });
cacheModule(followBackPath, { async ensureAutomaticFollowBack() { return { created: false, reason: "disabled" }; } });
cacheModule(bumpPath, { async ensureAutomaticBumps() { return { created: false, reason: "disabled" }; } });
cacheModule(likesPath, { async ensureAutomaticLikes() { return { created: false, reason: "disabled" }; } });
cacheModule(followAutomationPath, { async ensureAutomaticFollowAutomation() { return { created: false, reason: "disabled" }; } });
cacheModule(sfsPath, { async ensureAutomaticSfs() { return { reason: "disabled" }; } });

delete require.cache[schedulerPath];
const { ensureSingleJob, scheduleJobNow } = require("./job-scheduler");

function resetState() {
  state.findUnique = async () => null;
  state.findMany = async () => [];
  state.createMany = async () => ({ count: 1 });
  state.updateMany = async () => ({ count: 1 });
}

test.beforeEach(resetState);

test("ensureSingleJob treats a terminal row in the same idempotency bucket as owned without another insert", async () => {
  let createManyCalls = 0;
  state.findUnique = async () => ({ id: "job-failed", status: "FAILED", completedAt: new Date("2026-08-07T17:00:00Z") });
  state.createMany = async () => { createManyCalls += 1; return { count: 1 }; };

  const result = await ensureSingleJob({
    jobKey: "fetch_campaigns",
    creatorId: "creator-1",
    agencyId: "agency-1",
    params: {},
    priority: 30,
    now: new Date("2026-08-07T17:46:00Z"),
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, "same_bucket_failed");
  assert.equal(result.jobId, "job-failed");
  assert.equal(createManyCalls, 0);
});

test("ensureSingleJob closes a true create race with skipDuplicates instead of a P2002 exception", async () => {
  let findUniqueCalls = 0;
  let createManyArgs = null;
  state.findUnique = async () => {
    findUniqueCalls += 1;
    if (findUniqueCalls === 1) return null;
    return { id: "job-race", status: "SCHEDULED" };
  };
  state.createMany = async (args) => {
    createManyArgs = args;
    return { count: 0 };
  };

  const result = await ensureSingleJob({
    jobKey: "fetch_earnings",
    creatorId: "creator-1",
    agencyId: "agency-1",
    params: { rangeKey: "7d" },
    priority: 30,
    now: new Date("2026-08-07T18:05:00Z"),
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, "idempotency_race");
  assert.equal(result.jobId, "job-race");
  assert.equal(createManyArgs.skipDuplicates, true);
  assert.equal(createManyArgs.data.length, 1);
});

test("scheduleJobNow creates through createMany(skipDuplicates) and reads the stored row", async () => {
  let findUniqueCalls = 0;
  let createManyArgs = null;
  state.findUnique = async () => {
    findUniqueCalls += 1;
    if (findUniqueCalls === 1) return null;
    return { id: "job-new", status: "SCHEDULED" };
  };
  state.createMany = async (args) => {
    createManyArgs = args;
    return { count: 1 };
  };

  const result = await scheduleJobNow({
    jobKey: "catchup_notifications_scan",
    creatorId: "creator-1",
    agencyId: "agency-1",
    params: { notificationMode: "full" },
    now: new Date("2026-08-07T18:06:00Z"),
  });

  assert.equal(result.created, true);
  assert.equal(result.reason, "created");
  assert.equal(result.job.id, "job-new");
  assert.equal(createManyArgs.skipDuplicates, true);
});
