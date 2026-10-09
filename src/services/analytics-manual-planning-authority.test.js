"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function cacheModule(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const prismaPath = require.resolve("../prisma");
const schedulerPath = require.resolve("./job-scheduler");
const planningRepoPath = require.resolve("./job-planning-repository");
const financialServicePath = require.resolve("./financial-transactions-service");
const ledgerPath = require.resolve("./creator-analytics-ledger-service");
const financialControlPath = require.resolve("./financial-transaction-scan-control-service");
const campaignControlPath = require.resolve("./campaign-scan-control-service");

let scheduled = [];
let repairs = [];
cacheModule(require.resolve("./campaign-fan-refresh-queue-service"), {
  repairFailedCampaignFanRefreshDemands: async input => { repairs.push(input); return {recovered:0,promotedJobs:0}; },
});
cacheModule(prismaPath, {});
cacheModule(schedulerPath, {
  async scheduleJobNow(input) {
    scheduled.push(input);
    return {
      reason: "created",
      created: true,
      job: {
        id: `planned-${scheduled.length}`,
        jobKey: input.jobKey,
        creatorId: input.creatorId,
        agencyId: input.agencyId,
        status: "SCHEDULED",
        params: input.params,
        priority: input.priority,
      },
    };
  },
});
cacheModule(planningRepoPath, {
  async reschedulePlannedJob({ db, job }) {
    return { job: { ...job, status: "SCHEDULED" }, rescheduled: true, reason: "rescheduled", db };
  },
});
cacheModule(financialServicePath, {
  JOB_KEY: "financial_transactions_scan",
  SCHEMA_VERSION: 1,
  COLLECTOR_VERSION: "payout-transactions-v2-catchup",
  summarizeStatusGroups() { return []; },
});
cacheModule(ledgerPath, {
  async readCampaignsWithRevenue() { return { campaigns: [], pagination: {}, totals: {} }; },
});

delete require.cache[financialControlPath];
delete require.cache[campaignControlPath];
const { startManualFinancialTransactionScan } = require("./financial-transaction-scan-control-service");
const { startManualCampaignScan } = require("./campaign-scan-control-service");

const creator = { id: "creator-1", agencyId: "agency-1" };

function activeAuto(jobKey, status = "CLAIMED") {
  return {
    id: `${jobKey}-auto`, creatorId: creator.id, agencyId: creator.agencyId,
    jobKey, status, priority: 20, createdAt: new Date("2026-09-08T20:00:00.000Z"),
    params: { collectionContractVersion: 1, collectionGeneration: "auto-generation", collectionRequestedAt: "2026-09-08T20:00:00.000Z" },
  };
}

test.beforeEach(() => { scheduled = []; repairs = []; });

test("manual Financial start adopts an already active automatic collector job", async () => {
  const auto = activeAuto("financial_transactions_scan", "CLAIMED");
  const db = {
    jobInstance: { async findMany() { return [auto]; } },
  };
  const result = await startManualFinancialTransactionScan({ db, creator, now: new Date("2026-09-08T21:00:00.000Z") });
  assert.equal(result.action, "already_running");
  assert.equal(result.job.id, auto.id);
  assert.equal(scheduled.length, 0, "manual start must not create a second provider traversal beside automatic work");
});

test("manual Campaign start adopts an already queued automatic collector job", async () => {
  const auto = activeAuto("fetch_campaigns", "SCHEDULED");
  const db = {
    jobInstance: { async findMany() { return [auto]; } },
  };
  const result = await startManualCampaignScan({ db, creator, now: new Date("2026-09-08T21:00:00.000Z") });
  assert.equal(result.action, "already_queued");
  assert.equal(result.job.id, auto.id);
  assert.equal(scheduled.length, 0);
});

test("manual Financial planning is serialized by the collector advisory transaction and uses durable-epoch dedupe", async () => {
  const locks = [];
  const state = {
    activeGeneration: "financial-previous",
    baselineVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    activeRequestedAt: new Date("2026-09-08T20:59:59.500Z"),
  };
  const tx = {
    async $executeRawUnsafe(sql, key) {
      // Transaction-local budget setup is not a domain mutation/lock.
      if (sql === "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('TimeZone', 'UTC', true), set_config('onlinod.campaign_projection_writer', 'campaign_projection_v2', true)") return 1;
 locks.push([sql, key]); return 1; },
    jobInstance: { async findMany() { return []; } },
    creatorFinancialCollectionState: { async findUnique() { return state; } },
  };
  const db = { async $transaction(work) { return work(tx); } };
  const result = await startManualFinancialTransactionScan({ db, creator, now: new Date("2026-09-08T21:00:00.000Z") });

  assert.equal(result.action, "created");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].db, tx, "job creation must stay inside the collector planning transaction");
  assert.deepEqual(scheduled[0].dedupeParams, {
    planningEpoch: "financial-previous:2026-09-01T00:00:00.000Z",
    collectionOrderingAfter: "2026-09-08T20:59:59.500Z",
    collectionContractVersion: 1,
    collectionType: "FINANCIAL",
    collectionMode: "full",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(scheduled[0].dedupeParams, "manualRunToken"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(scheduled[0].dedupeParams, "collectionGeneration"), false);
  assert.equal(locks.length, 1);
  assert.equal(locks[0][1], "analytics-collector:financial:creator-1");
});

test("manual Campaign planning uses the same durable planning identity as automatic FULL for the same state", async () => {
  const state = null;
  const db = {
    jobInstance: { async findMany() { return []; } },
    creatorCampaignCollectionState: { async findUnique() { return state; } },
  };
  await startManualCampaignScan({ db, creator, now: new Date("2026-09-08T21:00:00.000Z") });
  assert.deepEqual(scheduled[0].dedupeParams, {
    planningEpoch: "none:none",
    collectionOrderingAfter: "none",
    collectionContractVersion: 1,
    collectionType: "CAMPAIGNS",
    collectionMode: "full",
  });
});

for (const status of ["QUEUED", "FAILED"]) test(`explicit source START survives unrelated FanData ${status}`, async () => {
  const db = { jobInstance:{findMany:async()=>[]},creatorCampaignCollectionState:{findUnique:async()=>null},
    creatorFanRefreshDemand:{findFirst:async()=>{throw Error("source must not inspect repair debt");}} };
  const result = await startManualCampaignScan({db,creator,intent:"source"});
  assert.equal(result.action,"created");assert.equal(scheduled.length,1);assert.equal(repairs.length,0);
});

test("explicit repair is stable after another worker already repaired debt and while provider work is active", async () => {
  const db = { jobInstance:{findMany:async()=>{throw Error("repair must not inspect/resume provider work");}},
    creatorCampaignCollectionState:{update:async()=>{throw Error("repair must not change directory revision");}} };
  for (let i=0;i<2;i++) {
    const result = await startManualCampaignScan({db,creator,intent:"repair"});
    assert.equal(result.action,"refresh_repair_noop");
  }
  assert.equal(scheduled.length,0);assert.equal(repairs.length,2);assert(repairs.every(r=>r.maxDemands===500));
});

test("old START remains compatible using presence probes, never exact history counts", async () => {
  const db = {jobInstance:{findMany:async()=>[]},creatorFanRefreshDemand:{
    findFirst:async({where})=>where.status==="QUEUED"?{id:"queued"}:null,
    count:async()=>{throw Error("unbounded count");}}};
  assert.equal((await startManualCampaignScan({db,creator})).action,"refresh_pending");
  assert.equal(scheduled.length,0);
});

test("management receipt binds explicit intent and rejects unsupported input", () => {
  const {operation}=require("./operational-command-contract");
  const value={family:"campaign",operation:"start",input:{intent:"repair"},expectedRevision:"a".repeat(64)};
  assert(operation.safeParse(value).success);
  assert(operation.safeParse({...value,input:{intent:"source"}}).success);
  assert(operation.safeParse({...value,input:{}}).success);
  assert(!operation.safeParse({...value,input:{intent:"anything"}}).success);
});
