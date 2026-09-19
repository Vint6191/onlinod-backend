"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  enqueueUniqueCampaignFanRefreshes,
  recordCampaignFanRefreshChunk,
  finalizeCampaignFanRefreshJob,
  campaignFanValueCoverageFromState,
} = require("./campaign-fan-refresh-queue-service");

const root = path.resolve(__dirname, "../..");

function harness() {
  const works = new Map();
  const demands = new Map();
  const jobs = new Map();
  const state = {
    creatorId: "creator-1", mode: "catchup", activeGeneration: "run-2",
    membershipCoverageStatus: "COMPLETE", membershipCoverageCompletedAt: new Date("2026-09-18T10:00:00.000Z"),
    campaignFrontierFreshnessStatus: "COMPLETE", campaignFrontierDueCount: 0, campaignFrontierTargetCount: 0,
    campaignFrontierCompletedCount: 0, campaignFrontierDeferredCount: 0,
    fanValueCoverageScanRunId: null, fanValueFreshnessStatus: "MISSING", fanValueFreshnessCutoffAt: null,
    fanValueExpected: 0, fanValueAlreadyFresh: 0, fanValueQueued: 0, fanValueSucceeded: 0,
    fanValueUnavailable: 0, fanValueFailed: 0, fanValueOutstanding: 0,
    status: "PARTIAL",
  };
  let seq = 0;
  const apply = (row, data) => {
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "increment")) row[key] = Number(row[key] || 0) + Number(value.increment || 0);
      else if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "decrement")) row[key] = Number(row[key] || 0) - Number(value.decrement || 0);
      else row[key] = value;
    }
    return row;
  };
  let currentValue = null;
  const db = {
    async $queryRawUnsafe() { return [{ authorityNow: new Date("2026-09-18T12:00:00.000Z") }]; },
    creatorCampaignCollectionState: {
      async findUnique() { return { ...state }; },
      async update({ data }) { apply(state, data); return { ...state }; },
      async updateMany({ where, data }) {
        if (where.fanValueCoverageScanRunId && state.fanValueCoverageScanRunId !== where.fanValueCoverageScanRunId) return { count: 0 };
        apply(state, data); return { count: 1 };
      },
    },
    creatorCampaignFanRefreshWork: {
      async findMany({ where }) {
        let rows = [...works.values()];
        if (where.creatorId) rows = rows.filter((row) => row.creatorId === where.creatorId);
        if (where.scanRunId) rows = rows.filter((row) => row.scanRunId === where.scanRunId);
        if (where.demandId) rows = rows.filter((row) => row.demandId === where.demandId);
        if (where.status) rows = rows.filter((row) => row.status === where.status);
        if (where.onlyFansUserId?.in) {
          const ids = new Set(where.onlyFansUserId.in); rows = rows.filter((row) => ids.has(row.onlyFansUserId));
        }
        return rows.map((row) => ({ ...row }));
      },
      async createMany({ data }) {
        let count = 0;
        for (const value of data) {
          const key = `${value.creatorId}|${value.scanRunId}|${value.onlyFansUserId}`;
          if (works.has(key)) continue;
          works.set(key, { id: `work-${++seq}`, ...value }); count += 1;
        }
        return { count };
      },
      async updateMany({ where, data }) {
        const ids = where.id?.in ? new Set(where.id.in) : null;
        let count = 0;
        for (const row of works.values()) {
          if (ids && !ids.has(row.id)) continue;
          if (where.status && row.status !== where.status) continue;
          apply(row, data); count += 1;
        }
        return { count };
      },
    },
    creatorFanRefreshDemand: {
      async createMany({ data }) {
        let count = 0;
        for (const value of data) {
          const existing = [...demands.values()].find((row) => row.creatorId === value.creatorId && row.onlyFansUserId === value.onlyFansUserId);
          if (existing) continue;
          const row = { id: `demand-${++seq}`, ...value };
          demands.set(row.id, row); count += 1;
        }
        return { count };
      },
      async findMany({ where }) {
        let rows = [...demands.values()];
        if (where.creatorId) rows = rows.filter((row) => row.creatorId === where.creatorId);
        if (where.activeRefreshJobId) rows = rows.filter((row) => row.activeRefreshJobId === where.activeRefreshJobId);
        if (where.onlyFansUserId?.in) {
          const ids = new Set(where.onlyFansUserId.in); rows = rows.filter((row) => ids.has(row.onlyFansUserId));
        }
        return rows.map((row) => ({ ...row, activeRefreshJob: row.activeRefreshJobId ? jobs.get(row.activeRefreshJobId) || null : null }));
      },
      async findUnique({ where }) {
        const key = where.creatorId_onlyFansUserId;
        if (!key) return null;
        const row = [...demands.values()].find((value) => value.creatorId === key.creatorId && value.onlyFansUserId === key.onlyFansUserId);
        return row ? { ...row, activeRefreshJob: row.activeRefreshJobId ? jobs.get(row.activeRefreshJobId) || null : null } : null;
      },
      async create({ data }) {
        const row = { id: `demand-${++seq}`, ...data };
        demands.set(row.id, row); return { ...row };
      },
      async update({ where, data }) {
        const row = demands.get(where.id); if (!row) throw new Error("demand missing");
        apply(row, data); return { ...row };
      },
    },
    jobInstance: {},
    creatorFan: {
      async findMany() {
        return currentValue ? [{ id: "fan-record-1", onlyFansUserId: "fan-1", valueCurrent: { ...currentValue } }] : [];
      },
    },
  };
  const planner = async (input) => {
    const existing = [...jobs.values()].find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existing) return { job: existing, created: false };
    const job = { id: `refresh-${jobs.size + 1}`, status: "SCHEDULED", ...input };
    jobs.set(job.id, job); return { job, created: true };
  };
  return {
    db, works, demands, jobs, state, planner,
    setValue(value) { currentValue = value; },
  };
}

test("INT5.9A-1 coalesces the same stale fan across Campaign runs into one active refresh demand", async () => {
  const h = harness();
  const campaignJob = { id: "campaign-job-1", agencyId: "agency-1", creatorId: "creator-1", priority: 80 };
  await enqueueUniqueCampaignFanRefreshes({
    db: h.db, job: campaignJob, scanRunId: "run-1", scanStartedAt: new Date("2026-09-18T10:00:00Z"),
    candidates: [{ onlyFansUserId: "fan-1", valueObservedAt: null }], planner: h.planner, now: new Date("2026-09-18T10:00:01Z"),
  });
  await enqueueUniqueCampaignFanRefreshes({
    db: h.db, job: { ...campaignJob, id: "campaign-job-2" }, scanRunId: "run-2", scanStartedAt: new Date("2026-09-18T11:00:00Z"),
    candidates: [{ onlyFansUserId: "fan-1", valueObservedAt: null }], planner: h.planner, now: new Date("2026-09-18T11:00:01Z"),
  });
  assert.equal(h.jobs.size, 1, "second run must coalesce onto the active point-refresh job");
  assert.equal(h.demands.size, 1, "cross-run demand identity is creator+fan, not creator+run+fan");
  assert.equal(h.works.size, 2, "each Campaign run retains its own coverage row");
  const demand = [...h.demands.values()][0];
  assert.equal(demand.requestedRevision, 2, "newer freshness target advances demand revision instead of scheduling parallel work");
  assert.equal(h.state.fanValueCoverageScanRunId, "run-2");
  assert.equal(h.state.fanValueExpected, 1);
  assert.equal(h.state.fanValueOutstanding, 1);
});

test("INT5.9A-1 one fresh point-refresh observation satisfies every waiting run and promotes current coverage", async () => {
  const h = harness();
  const campaignJob = { id: "campaign-job-1", agencyId: "agency-1", creatorId: "creator-1", priority: 80 };
  await enqueueUniqueCampaignFanRefreshes({ db: h.db, job: campaignJob, scanRunId: "run-1", scanStartedAt: new Date("2026-09-18T10:00:00Z"), candidates: [{ onlyFansUserId: "fan-1" }], planner: h.planner, now: new Date("2026-09-18T10:00:01Z") });
  await enqueueUniqueCampaignFanRefreshes({ db: h.db, job: { ...campaignJob, id: "campaign-job-2" }, scanRunId: "run-2", scanStartedAt: new Date("2026-09-18T11:00:00Z"), candidates: [{ onlyFansUserId: "fan-1" }], planner: h.planner, now: new Date("2026-09-18T11:00:01Z") });
  const refreshJob = [...h.jobs.values()][0];
  h.setValue({ valueObservedAt: new Date("2026-09-18T11:30:00Z"), availability: "AVAILABLE" });
  await recordCampaignFanRefreshChunk({ db: h.db, job: { id: refreshJob.id, jobKey: "fan_data_point_refresh", creatorId: "creator-1" }, chunkResult: { items: [{ onlyFansUserId: "fan-1" }] } });
  const demand = [...h.demands.values()][0];
  assert.equal(demand.status, "COMPLETE");
  assert.equal(demand.satisfiedRevision, demand.requestedRevision);
  assert.equal([...h.works.values()].filter((row) => row.status === "SUCCEEDED").length, 2);
  const coverage = campaignFanValueCoverageFromState(h.state, "run-2");
  assert.equal(coverage.outstanding, 0);
  assert.equal(coverage.succeeded, 1);
  assert.equal(h.state.fanValueFreshnessStatus, "COMPLETE");
  assert.equal(h.state.status, "COMPLETE");
});

test("INT5.9A-1 raised cross-run revision schedules one sequential follow-up only after the older active refresh ends", async () => {
  const h = harness();
  const campaignJob = { id: "campaign-job-1", agencyId: "agency-1", creatorId: "creator-1", priority: 80 };
  await enqueueUniqueCampaignFanRefreshes({ db: h.db, job: campaignJob, scanRunId: "run-1", scanStartedAt: new Date("2026-09-18T10:00:00Z"), candidates: [{ onlyFansUserId: "fan-1" }], planner: h.planner, now: new Date("2026-09-18T10:00:01Z") });
  await enqueueUniqueCampaignFanRefreshes({ db: h.db, job: { ...campaignJob, id: "campaign-job-2" }, scanRunId: "run-2", scanStartedAt: new Date("2026-09-18T11:00:00Z"), candidates: [{ onlyFansUserId: "fan-1" }], planner: h.planner, now: new Date("2026-09-18T11:00:01Z") });
  const demandBefore = [...h.demands.values()][0];
  assert.equal(demandBefore.requestedRevision, 2);
  assert.equal(demandBefore.activeRefreshRevision, 1, "the in-flight job still owns the older demand revision");
  const firstJob = [...h.jobs.values()][0];
  const result = await finalizeCampaignFanRefreshJob({
    db: h.db,
    job: { id: firstJob.id, jobKey: "fan_data_point_refresh", agencyId: "agency-1", creatorId: "creator-1", priority: 85 },
    result: { errors: 0 },
    planner: h.planner,
  });
  assert.equal(result.rescheduled, 1);
  assert.equal(h.jobs.size, 2, "follow-up is created only after the old active refresh ends");
  const demandAfter = [...h.demands.values()][0];
  assert.equal(demandAfter.status, "QUEUED");
  assert.equal(demandAfter.activeRefreshRevision, 2);
  assert.notEqual(demandAfter.activeRefreshJobId, firstJob.id);
  assert.equal([...h.works.values()].filter((row) => row.status === "FAILED").length, 0, "a superseded attempt must not fail waiting Campaign coverage");
});

test("INT5.9A-1 source removes fake delegated completion and makes Campaign/overview value reads freshness-cutoff aware", () => {
  const desktop = fs.readFileSync(path.join(root, "../../desktop/apps/desktop/electron/main/services/backend-jobs/handlers/campaigns-handler.ts"), "utf8");
  const ledger = fs.readFileSync(path.join(root, "src/services/creator-analytics-ledger-service.js"), "utf8");
  const overview = fs.readFileSync(path.join(root, "src/services/creator-overview-service.js"), "utf8");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260918123000_phase3_campaign_freshness_demand_coverage/migration.sql"), "utf8");
  const route = fs.readFileSync(path.join(root, "src/routes/jobs.js"), "utf8");
  const lease = fs.readFileSync(path.join(root, "src/services/job-lease-service.js"), "utf8");
  const queue = fs.readFileSync(path.join(root, "src/services/campaign-fan-refresh-queue-service.js"), "utf8");
  const control = fs.readFileSync(path.join(root, "src/services/campaign-scan-control-service.js"), "utf8");
  assert.match(desktop, /fanValuesComplete:\s*false/);
  assert.doesNotMatch(desktop, /fanValuesComplete:\s*true/);
  assert.match(schema, /model CreatorFanRefreshDemand/);
  assert.match(schema, /activeRefreshRevision\s+Int\?/);
  assert.match(schema, /@@unique\(\[creatorId, onlyFansUserId\]/);
  assert.match(schema, /fanValueOutstanding\s+Int\s+@default\(0\)/);
  assert.match(ledger, /value\."fetchedAt" >= \$2::timestamptz/);
  assert.match(overview, /value\."fetchedAt" >= \$2::timestamptz/);
  assert.match(ledger, /currentMembershipComplete = membershipComplete && frontierFreshnessComplete/);
  assert.match(ledger, /complete = currentMembershipComplete && fanValuesComplete/);
  assert.match(ledger, /CAMPAIGN_COLLECTOR_VERSION = "campaigns-v13"/);
  assert.match(route, /campaignFreshnessCoverageV1:\s*true/);
  assert.match(lease, /capabilities\?\.campaignFreshnessCoverageV1 !== true/);
  assert.match(lease, /campaignFreshnessCoverageVersion: 1/);
  assert.match(queue, /CreatorFanRefreshDemand[\s\S]*FOR UPDATE/);
  assert.match(queue, /activeRefreshJobId[\s\S]*FOR UPDATE/);
  assert.match(queue, /creatorFanRefreshDemand\.createMany/);
  assert.doesNotMatch(queue, /P2002/);
  assert.match(control, /const fanValuesComplete = canonicalCoveragePresent[\s\S]*fanValueFreshnessStatus === "COMPLETE" && campaignFrontierFreshnessStatus === "COMPLETE"[\s\S]*: fanRefreshDelegated \? false/);
  assert.match(control, /collectorStatus[\s\S]*coverageStatus[\s\S]*refreshPending/);
  assert.match(migration, /CAMPAIGN_FRESHNESS_COVERAGE_REBUILD_REQUIRED/);
  assert.doesNotMatch(migration, /Backfill coverage for the currently tracked run only/);
});
