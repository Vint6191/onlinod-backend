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

test.beforeEach(() => { scheduled = []; });

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
  };
  const tx = {
    async $executeRawUnsafe(sql, key) { locks.push([sql, key]); return 1; },
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
    collectionContractVersion: 1,
    collectionType: "CAMPAIGNS",
    collectionMode: "full",
  });
});
