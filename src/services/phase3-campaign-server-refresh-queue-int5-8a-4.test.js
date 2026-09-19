"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { enqueueUniqueCampaignFanRefreshes, campaignFanRefreshIsFresh, CAMPAIGN_FAN_VALUE_FRESHNESS_MS } = require("./campaign-fan-refresh-queue-service");

const root = path.resolve(__dirname, "../..");

function queueHarness() {
  const work = new Map();
  const demands = new Map();
  const jobsByKey = new Map();
  const coverage = { creatorId: "creator-1", fanValueCoverageScanRunId: null, fanValueFreshnessCutoffAt: null, fanValueFreshnessStatus: "MISSING", fanValueExpected: 0, fanValueAlreadyFresh: 0, fanValueQueued: 0, fanValueSucceeded: 0, fanValueUnavailable: 0, fanValueFailed: 0, fanValueOutstanding: 0, membershipCoverageStatus: "SCANNING", mode: "catchup", activeGeneration: "run-1" };
  let seq = 0;
  const applyData = (target, data) => {
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && "increment" in value) target[key] = Number(target[key] || 0) + Number(value.increment || 0);
      else if (value && typeof value === "object" && "decrement" in value) target[key] = Number(target[key] || 0) - Number(value.decrement || 0);
      else target[key] = value;
    }
    return target;
  };
  const db = {
    creatorCampaignCollectionState: {
      async findUnique() { return { ...coverage }; },
      async update({ data }) { applyData(coverage, data); return { ...coverage }; },
      async updateMany({ where, data }) {
        if (where.fanValueCoverageScanRunId && coverage.fanValueCoverageScanRunId !== where.fanValueCoverageScanRunId) return { count: 0 };
        applyData(coverage, data); return { count: 1 };
      },
    },
    creatorCampaignFanRefreshWork: {
      async findMany({ where }) {
        if (where.demandId) return [...work.values()].filter((row) => row.demandId === where.demandId && row.status === where.status).map((row) => ({ ...row }));
        const ids = new Set(where.onlyFansUserId.in);
        return [...work.values()].filter((row) => row.creatorId === where.creatorId && row.scanRunId === where.scanRunId && ids.has(row.onlyFansUserId));
      },
      async createMany({ data }) {
        let count = 0;
        for (const row of data) {
          const key = `${row.creatorId}|${row.scanRunId}|${row.onlyFansUserId}`;
          if (work.has(key)) continue;
          work.set(key, { id: `work-${++seq}`, ...row });
          count += 1;
        }
        return { count };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of work.values()) {
          const ids = where.id?.in ? new Set(where.id.in) : null;
          if (ids && !ids.has(row.id)) continue;
          if (where.status && row.status !== where.status) continue;
          applyData(row, data); count += 1;
        }
        return { count };
      },
    },
    creatorFanRefreshDemand: {
      async createMany({ data }) {
        let count = 0;
        for (const value of data) {
          const key = `${value.creatorId}|${value.onlyFansUserId}`;
          if (demands.has(key)) continue;
          demands.set(key, { id: `demand-${++seq}`, ...value }); count += 1;
        }
        return { count };
      },
      async findMany({ where }) {
        const ids = where.onlyFansUserId?.in ? new Set(where.onlyFansUserId.in) : null;
        return [...demands.values()].filter((row) => row.creatorId === where.creatorId && (!ids || ids.has(row.onlyFansUserId))).map((row) => ({ ...row, activeRefreshJob: row.activeRefreshJobId ? [...jobsByKey.values()].find((job) => job.id === row.activeRefreshJobId) || null : null }));
      },
      async create({ data }) {
        const row = { id: `demand-${++seq}`, ...data };
        demands.set(`${row.creatorId}|${row.onlyFansUserId}`, row); return { ...row };
      },
      async update({ where, data }) {
        const entry = [...demands.entries()].find(([, row]) => row.id === where.id);
        if (!entry) throw new Error("demand missing");
        applyData(entry[1], data); return { ...entry[1] };
      },
    },
    jobInstance: {
      async createMany({ data }) {
        const row = data[0];
        if (jobsByKey.has(row.idempotencyKey)) return { count: 0 };
        jobsByKey.set(row.idempotencyKey, { id: `refresh-${jobsByKey.size + 1}`, ...row });
        return { count: 1 };
      },
      async findUnique({ where }) { return jobsByKey.get(where.idempotencyKey) || null; },
    },
  };
  const planner = async (input) => {
    const row = {
      id: `refresh-${jobsByKey.size + 1}`,
      jobKey: input.jobKey, scope: input.scope, creatorId: input.creatorId, agencyId: input.agencyId,
      idempotencyKey: input.idempotencyKey, params: input.params, priority: input.priority,
      scheduledAt: input.scheduledAt, nextRunAt: input.nextRunAt, status: "SCHEDULED",
    };
    const existing = jobsByKey.get(input.idempotencyKey);
    if (existing) return { job: existing, created: false, reason: "idempotency_reused" };
    jobsByKey.set(input.idempotencyKey, row);
    return { job: row, created: true, reason: "created" };
  };
  return { db, work, demands, coverage, jobsByKey, planner };
}

test("INT5.8A-4 freshness policy reuses current FanData for six hours across recurring Campaign runs", () => {
  assert.equal(CAMPAIGN_FAN_VALUE_FRESHNESS_MS, 6 * 60 * 60 * 1000);
  const cutoff = new Date("2026-09-17T18:00:00.000Z");
  assert.equal(campaignFanRefreshIsFresh(new Date("2026-09-17T18:00:00.000Z"), cutoff), true);
  assert.equal(campaignFanRefreshIsFresh(new Date("2026-09-17T17:59:59.999Z"), cutoff), false);
  assert.equal(campaignFanRefreshIsFresh(null, cutoff), false);
});

test("INT5.8A-4 one fan in many Campaign memberships creates one durable per-run refresh identity", async () => {
  const { db, work, jobsByKey, planner } = queueHarness();
  const job = { id: "campaign-job", agencyId: "agency-1", creatorId: "creator-1", priority: 80 };
  const scanStartedAt = new Date("2026-09-18T00:00:00.000Z");
  for (let i = 0; i < 100; i += 1) {
    await enqueueUniqueCampaignFanRefreshes({
      db, job, scanRunId: "run-1", scanStartedAt,
      candidates: [{ onlyFansUserId: "fan-shared", valueObservedAt: null }],
      planner,
      now: new Date("2026-09-18T00:00:01.000Z"),
    });
  }
  assert.equal(work.size, 1);
  assert.equal(jobsByKey.size, 1);
  const refreshJob = [...jobsByKey.values()][0];
  assert.deepEqual(refreshJob.params.fanIds, ["fan-shared"]);
  assert.equal(refreshJob.params.campaignRefreshQueueVersion, 2);
  assert.deepEqual(refreshJob.params.campaignRefreshDemandFanIds, ["fan-shared"]);
  assert.equal(refreshJob.params.observationTokenVersion, 1);
  assert.equal(refreshJob.params.observationReadLeaseVersion, 1);
});

test("INT5.8A-4 queue schedules only stale/unknown values and remains bounded to one claimer page", async () => {
  const { db, work, jobsByKey, planner } = queueHarness();
  const job = { id: "campaign-job", agencyId: "agency-1", creatorId: "creator-1", priority: 80 };
  const scanStartedAt = new Date("2026-09-18T00:00:00.000Z");
  const now = new Date("2026-09-18T01:00:00.000Z");
  const candidates = Array.from({ length: 60 }, (_, i) => ({
    onlyFansUserId: `fan-${i}`,
    valueObservedAt: i === 0 ? new Date("2026-09-17T20:00:00.000Z") : null,
  }));
  const result = await enqueueUniqueCampaignFanRefreshes({ db, job, scanRunId: "run-2", scanStartedAt, candidates, planner, now });
  assert.equal(result.fanIds.length, 49);
  assert.equal(result.fanIds.includes("fan-0"), false, "fresh fan is not queued");
  assert.equal(work.size, 50);
  assert.equal(result.alreadyFresh, 1);
  assert.equal(result.queued, 49);
  assert.equal(jobsByKey.size, 1);
});

test("INT5.8A-4 source retains server-refresh compatibility while current Campaign protocol advances", () => {
  const ledger = fs.readFileSync(path.join(root, "src/services/creator-analytics-ledger-service.js"), "utf8");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const route = fs.readFileSync(path.join(root, "src/routes/jobs.js"), "utf8");
  const lease = fs.readFileSync(path.join(root, "src/services/job-lease-service.js"), "utf8");
  const control = fs.readFileSync(path.join(root, "src/services/campaign-scan-control-service.js"), "utf8");
  const freshnessPolicy = fs.readFileSync(path.join(root, "src/services/analytics-freshness-policy.js"), "utf8");
  assert.match(ledger, /CAMPAIGN_COLLECTOR_VERSION = "campaigns-v13"/);
  assert.match(ledger, /"campaigns-v8", "campaigns-v9", "campaigns-v10", "campaigns-v11", "campaigns-v12", CAMPAIGN_COLLECTOR_VERSION/);
  assert.match(ledger, /enqueueUniqueCampaignFanRefreshes/);
  assert.match(ledger, /CAMPAIGN_SERVER_REFRESH_COLLECTOR_VERSIONS\.has\(payload\.collectorVersion\)/);
  assert.match(ledger, /valueCurrent: \{ select: \{ valueObservedAt: true \} \}/);
  assert.match(schema, /model CreatorCampaignFanRefreshWork/);
  assert.match(schema, /@@unique\(\[creatorId, scanRunId, onlyFansUserId\]/);
  assert.match(route, /campaignServerFanRefreshV1/);
  assert.match(route, /serverCapabilities: JOB_SERVER_CAPABILITIES/);
  assert.match(lease, /campaignServerFanRefreshV1 !== true/);
  assert.match(control, /const fanRefreshDelegated = result\.fanRefreshDelegated === true \|\| \["campaigns-v9", "campaigns-v10", "campaigns-v11", "campaigns-v12", "campaigns-v13"\]\.includes\(continuation\.collectorVersion\)/);
  assert.match(freshnessPolicy, /CAMPAIGN_FAN_VALUE_FRESHNESS_MS/);
  assert.match(freshnessPolicy, /CREATOR_ANALYTICS_CAMPAIGN_FAN_VALUE_FRESHNESS_MS/);
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260918023500_phase3_campaign_server_fan_refresh_queue/migration.sql"), "utf8");
  assert.match(migration, /refreshJobId[\s\S]*ON DELETE SET NULL/);
  assert.match(migration, /campaignJobId[\s\S]*ON DELETE CASCADE/);
});
