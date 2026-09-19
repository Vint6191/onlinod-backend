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

test("A12 job claim path promotes durable queued campaign demands before choosing fan refresh work", () => {
  const source = fs.readFileSync(path.join(__dirname, "job-lease-service.js"), "utf8");
  assert.match(source, /allowedJobKeys\.includes\("fan_data_point_refresh"\)[\s\S]*promoteQueuedCampaignFanRefreshDemands/);
  const queue = fs.readFileSync(path.join(__dirname, "campaign-fan-refresh-queue-service.js"), "utf8");
  assert.match(queue, /campaignWork:\s*\{\s*some:\s*\{\s*status:\s*WORK_STATUS\.QUEUED/);
  assert.match(queue, /orderBy:\s*\[\{ lastRequestedAt: "asc" \}, \{ id: "asc" \}\]/);
  assert.match(queue, /CAMPAIGN_FAN_REFRESH_JOB_MAX/);
});


test("A12 promoter rematerializes oldest durable debt in creator-fair bounded jobs once capacity returns", async () => {
  const planned = [];
  const demandUpdates = [];
  const workUpdates = [];
  const db = {
    jobInstance: {},
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql) => {
      const text = String(sql);
      if (/WITH ranked AS/.test(text)) return [
        { id: "d-a1", lastRequestedAt: new Date("2038-01-01T00:00:00.000Z") },
        { id: "d-b1", lastRequestedAt: new Date("2038-01-01T00:00:01.000Z") },
        { id: "d-a2", lastRequestedAt: new Date("2038-01-01T00:00:02.000Z") },
        { id: "d-b2", lastRequestedAt: new Date("2038-01-01T00:00:03.000Z") },
      ];
      if (/FROM "JobInstance"/.test(text)) return [{ pendingGlobal: 0n, pendingCreator: 0n }];
      throw new Error(`unexpected SQL: ${text}`);
    },
    creatorFanRefreshDemand: {
      findMany: async () => [
        { id: "d-a1", agencyId: "agency-1", creatorId: "creator-a", onlyFansUserId: "fan-a1", requestedRevision: 2, lastRequestedAt: new Date("2038-01-01T00:00:00.000Z") },
        { id: "d-b1", agencyId: "agency-1", creatorId: "creator-b", onlyFansUserId: "fan-b1", requestedRevision: 1, lastRequestedAt: new Date("2038-01-01T00:00:01.000Z") },
        { id: "d-a2", agencyId: "agency-1", creatorId: "creator-a", onlyFansUserId: "fan-a2", requestedRevision: 1, lastRequestedAt: new Date("2038-01-01T00:00:02.000Z") },
        { id: "d-b2", agencyId: "agency-1", creatorId: "creator-b", onlyFansUserId: "fan-b2", requestedRevision: 3, lastRequestedAt: new Date("2038-01-01T00:00:03.000Z") },
      ],
      update: async (input) => { demandUpdates.push(input); return input; },
    },
    creatorCampaignFanRefreshWork: {
      updateMany: async (input) => { workUpdates.push(input); return { count: 1 }; },
    },
  };
  let seq = 0;
  const result = await promoteQueuedCampaignFanRefreshDemands({
    db,
    now: new Date("2038-02-03T04:05:06.000Z"),
    maxJobs: 2,
    inTransaction: true,
    planner: async (input) => {
      planned.push(input);
      seq += 1;
      return { created: true, job: { id: `refresh-${seq}` } };
    },
  });
  assert.deepEqual(result, { promotedJobs: 2, promotedFans: 4, reason: "promoted" });
  assert.equal(planned.length, 2);
  assert.equal(planned[0].creatorId, "creator-a");
  assert.deepEqual(planned[0].params.fanIds, ["fan-a1", "fan-a2"]);
  assert.equal(planned[1].creatorId, "creator-b");
  assert.deepEqual(planned[1].params.fanIds, ["fan-b1", "fan-b2"]);
  assert.equal(demandUpdates.length, 4);
  assert.equal(workUpdates.length, 4);
});

test("A12 backlog promotion window is capped per creator so one saturated deep backlog cannot hide another creator", async () => {
  const queueSource = fs.readFileSync(path.join(__dirname, "campaign-fan-refresh-queue-service.js"), "utf8");
  assert.match(queueSource, /ROW_NUMBER\(\) OVER \([\s\S]*PARTITION BY d\."creatorId"[\s\S]*WHERE rn <= \$1/);

  const planned = [];
  const aRows = Array.from({ length: 50 }, (_, i) => ({
    id: `d-a-${String(i).padStart(2, "0")}`,
    agencyId: "agency-1",
    creatorId: "creator-a",
    onlyFansUserId: `fan-a-${i}`,
    requestedRevision: 1,
    lastRequestedAt: new Date(`2038-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`),
  }));
  const bRow = {
    id: "d-b-00", agencyId: "agency-1", creatorId: "creator-b", onlyFansUserId: "fan-b-0",
    requestedRevision: 1, lastRequestedAt: new Date("2038-01-02T00:00:00.000Z"),
  };
  const byId = new Map([...aRows, bRow].map((row) => [row.id, row]));
  const db = {
    jobInstance: {},
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql, ...args) => {
      const text = String(sql);
      if (/WITH ranked AS/.test(text)) {
        assert.equal(args[0], 50);
        // Represents a production ranking over >800 creator-A debts: only one
        // job-sized A batch may enter the window, leaving B visible.
        return [...aRows.map((row) => ({ id: row.id, lastRequestedAt: row.lastRequestedAt })), { id: bRow.id, lastRequestedAt: bRow.lastRequestedAt }];
      }
      if (/FROM "JobInstance"/.test(text)) {
        const creatorId = args[0];
        return [{ pendingGlobal: 4n, pendingCreator: creatorId === "creator-a" ? 4n : 0n }];
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    creatorFanRefreshDemand: {
      findMany: async ({ where }) => where?.id?.in.map((id) => byId.get(id)).filter(Boolean),
      update: async ({ where, data }) => ({ ...byId.get(where.id), ...data }),
    },
    creatorCampaignFanRefreshWork: { updateMany: async () => ({ count: 1 }) },
  };

  const result = await promoteQueuedCampaignFanRefreshDemands({
    db,
    now: new Date("2038-02-03T04:05:06.000Z"),
    maxJobs: 1,
    inTransaction: true,
    planner: async (input) => {
      planned.push(input);
      return { created: true, job: { id: "refresh-b" } };
    },
  });
  assert.equal(result.promotedJobs, 1);
  assert.equal(result.promotedFans, 1);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].creatorId, "creator-b");
  assert.deepEqual(planned[0].params.fanIds, ["fan-b-0"]);
});
