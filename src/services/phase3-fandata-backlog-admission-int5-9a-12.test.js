"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FAN_DATA_REFRESH_MAX_PENDING_JOBS,
  FAN_DATA_REFRESH_MAX_PENDING_JOBS_PER_CREATOR,
  FAN_DATA_REFRESH_SCHEDULE_LOCK_KEY,
  fanDataRefreshScheduleAvailable,
} = require("./provider-capacity-authority-service");
const { promoteQueuedCampaignFanRefreshDemands, _test } = require("./campaign-fan-refresh-queue-service");

function capacityDb({ pendingGlobal, pendingCreator }) {
  const locks = [];
  return {
    locks,
    $executeRawUnsafe: async (sql, key) => { locks.push({ sql: String(sql), key }); return 1; },
    $queryRawUnsafe: async (sql, creatorId) => {
      assert.match(String(sql), /status" IN \('SCHEDULED','CLAIMED'\)/);
      assert.equal(creatorId, "creator-a");
      return [{ pendingGlobal: BigInt(pendingGlobal), pendingCreator: BigInt(pendingCreator) }];
    },
  };
}

test("A12 fan refresh schedule backlog is globally bounded under an advisory transaction lock", async () => {
  const db = capacityDb({ pendingGlobal: FAN_DATA_REFRESH_MAX_PENDING_JOBS, pendingCreator: 0 });
  const result = await fanDataRefreshScheduleAvailable(db, "creator-a");
  assert.equal(result.available, false);
  assert.equal(result.globalFull, true);
  assert.equal(db.locks.length, 1);
  assert.equal(db.locks[0].key, FAN_DATA_REFRESH_SCHEDULE_LOCK_KEY);
});

test("A12 one creator cannot occupy the whole scheduled refresh backlog", async () => {
  const db = capacityDb({ pendingGlobal: 1, pendingCreator: FAN_DATA_REFRESH_MAX_PENDING_JOBS_PER_CREATOR });
  const result = await fanDataRefreshScheduleAvailable(db, "creator-a");
  assert.equal(result.available, false);
  assert.equal(result.globalFull, false);
  assert.equal(result.creatorFull, true);
});

test("A12 saturated campaign refresh scheduling preserves durable demand and work instead of dropping it", async () => {
  const demandUpdates = [];
  const workUpdates = [];
  let plannerCalls = 0;
  const db = {
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql) => {
      if (/FROM "JobInstance"/.test(String(sql))) return [{ pendingGlobal: BigInt(FAN_DATA_REFRESH_MAX_PENDING_JOBS), pendingCreator: 0n }];
      throw new Error(`unexpected SQL: ${String(sql)}`);
    },
    creatorFanRefreshDemand: {
      updateMany: async (input) => { demandUpdates.push(input); return { count: 2 }; },
    },
    creatorCampaignFanRefreshWork: {
      updateMany: async (input) => { workUpdates.push(input); return { count: 2 }; },
    },
  };
  const jobId = await _test.scheduleDemandRefreshJob({
    db,
    job: { id: "campaign-job", agencyId: "agency-1", creatorId: "creator-a", priority: 90 },
    demands: [
      { fanId: "fan-1", revision: 2, demand: { id: "d1" } },
      { fanId: "fan-2", revision: 1, demand: { id: "d2" } },
    ],
    scheduledAt: new Date("2038-02-03T04:05:06.000Z"),
    planner: async () => { plannerCalls += 1; return { job: { id: "should-not-exist" }, created: true }; },
  });
  assert.equal(jobId, null);
  assert.equal(plannerCalls, 0);
  assert.equal(demandUpdates.length, 1);
  assert.deepEqual(demandUpdates[0].data, { activeRefreshJobId: null, activeRefreshRevision: null, status: "QUEUED" });
  assert.equal(workUpdates.length, 1);
  assert.deepEqual(workUpdates[0].data, { refreshJobId: null });
});

test("A12/final cut job claim never runs global Campaign promotion; bounded maintenance owns durable signals", () => {
  const leaseSource = fs.readFileSync(path.join(__dirname, "job-lease-service.js"), "utf8");
  const schedulerSource = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  const queue = fs.readFileSync(path.join(__dirname, "campaign-fan-refresh-queue-service.js"), "utf8");
  assert.doesNotMatch(leaseSource, /promoteQueuedCampaignFanRefreshDemands|runCampaignFanRefreshPromotionMaintenance/);
  assert.match(schedulerSource, /campaignFanRefreshPromotion[\s\S]*runCampaignFanRefreshPromotionMaintenance/);
  assert.match(queue, /FOR UPDATE OF s SKIP LOCKED[\s\S]*LIMIT 1/);
  assert.match(queue, /claimToken[\s\S]*claimUntil/);
});

test("A12/final cut creator-scoped promoter rematerializes bounded oldest debt only for its creator", async () => {
  const planned = [];
  const demandUpdates = [];
  const workUpdates = [];
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `d-${i}`, agencyId: "agency-1", creatorId: "creator-a", onlyFansUserId: `fan-${i}`,
    requestedRevision: 1, lastRequestedAt: new Date(1_000 + i),
  }));
  const db = {
    jobInstance: {},
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql, creatorId) => {
      if (/FROM "JobInstance"/.test(String(sql))) {
        assert.equal(creatorId, "creator-a");
        return [{ pendingGlobal: 0n, pendingCreator: 0n }];
      }
      throw new Error(`unexpected SQL: ${String(sql)}`);
    },
    creatorFanRefreshDemand: {
      findMany: async ({ where, take, orderBy }) => {
        assert.equal(where.creatorId, "creator-a");
        assert.equal(take, 100);
        assert.deepEqual(orderBy, [{ lastRequestedAt: "asc" }, { id: "asc" }]);
        return rows;
      },
      update: async (input) => { demandUpdates.push(input); return input; },
    },
    creatorCampaignFanRefreshWork: {
      updateMany: async (input) => { workUpdates.push(input); return { count: 1 }; },
    },
  };
  let seq = 0;
  const result = await promoteQueuedCampaignFanRefreshDemands({
    db, creatorId: "creator-a", now: new Date("2038-02-03T04:05:06.000Z"), maxJobs: 2,
    inTransaction: true, _campaignLockHeld: true,
    planner: async (input) => { planned.push(input); seq += 1; return { created: true, job: { id: `refresh-${seq}` } }; },
  });
  assert.deepEqual(result, { promotedJobs: 2, promotedFans: 60, reason: "promoted" });
  assert.equal(planned.length, 2);
  assert.equal(planned[0].creatorId, "creator-a");
  assert.equal(planned[0].params.fanIds.length, 50);
  assert.equal(planned[1].params.fanIds.length, 10);
  assert.equal(demandUpdates.length, 60);
  assert.equal(workUpdates.length, 60);
});

test("A12/final cut removes global creator-fair debt scans in favor of one creator per durable maintenance claim", () => {
  const queueSource = fs.readFileSync(path.join(__dirname, "campaign-fan-refresh-queue-service.js"), "utf8");
  assert.doesNotMatch(queueSource, /ROW_NUMBER\(\) OVER \([\s\S]*PARTITION BY d\."creatorId"/);
  assert.doesNotMatch(queueSource, /SELECT DISTINCT d\."creatorId"/);
  assert.match(queueSource, /promoteQueuedCampaignFanRefreshDemands\(\{ db, creatorId/);
  assert.match(queueSource, /claimCampaignFanRefreshPromotionSignal[\s\S]*FOR UPDATE OF s SKIP LOCKED[\s\S]*LIMIT 1/);
  assert.match(queueSource, /runCampaignFanRefreshPromotionMaintenance[\s\S]*acquireCampaignTransactionLock\(tx, creatorId\)/);
});
