"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
// The source archive intentionally has no installed node_modules. Inject only the
// default Prisma singleton so the control module can be loaded; every test passes
// an explicit production-shaped db adapter and never uses this stub.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../prisma" || request.endsWith("/prisma")) return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { readManualCampaignScan } = require("./campaign-scan-control-service");
Module._load = originalLoad;
const { deriveCampaignPresentationStatus } = require("./campaign-scan-status-authority");

const creator = { id: "creator-1", agencyId: "agency-1" };

function manualJob({ id = "manual-job", status = "DONE", runId = "manual-run", result = {} } = {}) {
  return {
    id,
    creatorId: creator.id,
    agencyId: creator.agencyId,
    jobKey: "fetch_campaigns",
    status,
    params: { manualCampaignScan: true, manualCampaignScanVersion: 1 },
    continuation: { collectorVersion: "campaigns-v13", scanRunId: runId },
    result: { scanRunId: runId, campaignPagesComplete: true, claimersComplete: true, truncated: false, campaignScannerRejected: 0, claimerScannerRejected: 0, ...result },
    createdAt: new Date("2026-09-19T12:00:00Z"),
  };
}

function automaticJob({ id = "auto-job", status = "DONE", runId = "auto-run", result = {} } = {}) {
  return {
    id,
    creatorId: creator.id,
    agencyId: creator.agencyId,
    jobKey: "fetch_campaigns",
    status,
    params: { campaignFreshnessCoverageVersion: 1 },
    continuation: { collectorVersion: "campaigns-v13", scanRunId: runId },
    result: { scanRunId: runId, campaignPagesComplete: true, claimersComplete: true, truncated: false, campaignScannerRejected: 0, claimerScannerRejected: 0, ...result },
    createdAt: new Date("2026-09-19T13:00:00Z"),
  };
}

function coverageState(runId, overrides = {}) {
  return {
    creatorId: creator.id,
    agencyId: creator.agencyId,
    status: "PARTIAL",
    mode: "catchup",
    activeGeneration: runId,
    fanValueCoverageScanRunId: runId,
    fanValueCoverageDelegated: true,
    fanValueCoverageOwnerKind: "AUTOMATIC",
    fanValueCoverageCollectorVersion: "campaigns-v13",
    fanValueCoverageSourceJobId: `${runId}-job`,
    fanValueFreshnessStatus: "QUEUED",
    fanValueExpected: 20,
    fanValueAlreadyFresh: 0,
    fanValueQueued: 20,
    fanValueSucceeded: 0,
    fanValueUnavailable: 0,
    fanValueFailed: 0,
    fanValueOutstanding: 20,
    membershipCoverageStatus: "COMPLETE",
    campaignFrontierFreshnessStatus: "COMPLETE",
    campaignFrontierDueCount: 0,
    campaignFrontierTargetCount: 0,
    campaignFrontierCompletedCount: 0,
    campaignFrontierDeferredCount: 0,
    campaignDirectoryDiscoveryRequestedRevision: 0,
    campaignDirectoryDiscoveryCompletedRevision: 0,
    ...overrides,
  };
}

function dbForReader({ manualJobs = [], states, jobsById = {} }) {
  const sequence = Array.isArray(states) ? states.slice() : [states];
  let stateRead = 0;
  return {
    get stateReads() { return stateRead; },
    jobInstance: {
      findMany: async () => manualJobs,
      findUnique: async ({ where }) => jobsById[where.id] || null,
    },
    creatorCampaignCollectionState: {
      findUnique: async () => {
        const row = sequence[Math.min(stateRead, sequence.length - 1)] || null;
        stateRead += 1;
        return row;
      },
    },
    creatorCampaign: { findMany: async () => [], count: async () => 0 },
    creatorCampaignFan: { count: async () => 0 },
    deviceCreatorBinding: { count: async () => 1 },
  };
}

test("A20.2 current automatic delegated debt is visible without any manual job", async () => {
  const state = coverageState("auto-run-1", { fanValueCoverageSourceJobId: "auto-job-1" });
  const db = dbForReader({
    states: [state, state],
    jobsById: { "auto-job-1": automaticJob({ id: "auto-job-1", runId: "auto-run-1" }) },
  });
  const result = await readManualCampaignScan({ db, creator });
  assert.equal(result.manual, false);
  assert.equal(result.status, "REFRESH_PENDING");
  assert.equal(result.refreshPending, true);
  assert.equal(result.fanRefreshDelegated, true);
  assert.equal(result.currentCoverageOwnerKind, "AUTOMATIC");
  assert.equal(result.currentCoverageScanRunId, "auto-run-1");
  assert.equal(result.fanValuesOutstanding, 20);
});

test("A20.2 stale manual FAILED cannot override newer automatic COMPLETE coverage", async () => {
  const manual = manualJob({ status: "FAILED", runId: "manual-run-1" });
  const state = coverageState("auto-run-2", {
    status: "COMPLETE",
    fanValueCoverageSourceJobId: "auto-job-2",
    fanValueFreshnessStatus: "COMPLETE",
    fanValueExpected: 20,
    fanValueQueued: 20,
    fanValueSucceeded: 20,
    fanValueOutstanding: 0,
  });
  const db = dbForReader({
    manualJobs: [manual], states: [state, state],
    jobsById: { "auto-job-2": automaticJob({ id: "auto-job-2", runId: "auto-run-2" }) },
  });
  const result = await readManualCampaignScan({ db, creator });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.refreshPending, false);
  assert.equal(result.manualCollectorStatus, "FAILED");
  assert.equal(result.currentCoverageCollectorStatus, "COMPLETE");
  assert.equal(result.manualGenerationSuperseded, true);
  assert.equal(result.coverageMatchesManualGeneration, false);
});

test("A20.2 superseded manual generation exposes current automatic RUNNING generation", async () => {
  const manual = manualJob({ status: "DONE", runId: "manual-run-old" });
  const state = coverageState("auto-run-queued", { fanValueCoverageSourceJobId: "auto-job-running" });
  const db = dbForReader({
    manualJobs: [manual], states: [state, state],
    jobsById: { "auto-job-running": automaticJob({ id: "auto-job-running", status: "CLAIMED", runId: "auto-run-queued" }) },
  });
  const result = await readManualCampaignScan({ db, creator });
  assert.equal(result.status, "RUNNING");
  assert.equal(result.collectorStatus, "RUNNING");
  assert.equal(result.refreshPending, true);
  assert.equal(result.manualGenerationSuperseded, true);
  assert.equal(result.currentCoverageScanRunId, "auto-run-queued");
});

test("A20.2 reader retries when current coverage generation changes during the read", async () => {
  const run1 = coverageState("auto-run-1", { fanValueCoverageSourceJobId: "auto-job-1" });
  const run2 = coverageState("auto-run-2", { fanValueCoverageSourceJobId: "auto-job-2", fanValueExpected: 7, fanValueQueued: 7, fanValueOutstanding: 7 });
  const db = dbForReader({
    // first call: start run1 -> end run2; retry: start run2 -> end run2
    states: [run1, run2, run2, run2],
    jobsById: {
      "auto-job-1": automaticJob({ id: "auto-job-1", runId: "auto-run-1" }),
      "auto-job-2": automaticJob({ id: "auto-job-2", runId: "auto-run-2" }),
    },
  });
  const result = await readManualCampaignScan({ db, creator });
  assert.equal(result.currentCoverageScanRunId, "auto-run-2");
  assert.equal(result.fanValuesOutstanding, 7);
  assert.ok(db.stateReads >= 4);
});

test("A20.2 terminal collector outcomes keep delegated debt live and current COMPLETE stops polling", () => {
  for (const collectorStatus of ["PARTIAL", "FAILED", "CANCELLED", "IDLE"]) {
    const pending = deriveCampaignPresentationStatus({
      collectorStatus,
      fanRefreshDelegated: true,
      membershipCoverageStatus: "COMPLETE",
      campaignFrontierFreshnessStatus: "COMPLETE",
      fanValuesComplete: false,
      fanValuesOutstanding: 3,
      fanValueFreshnessStatus: "QUEUED",
      currentCoverageAuthoritative: true,
    });
    assert.equal(pending.status, "REFRESH_PENDING", collectorStatus);
    assert.equal(pending.collectorStatus, collectorStatus);
    assert.equal(pending.refreshPending, true);
  }
  const complete = deriveCampaignPresentationStatus({
    collectorStatus: "FAILED",
    fanRefreshDelegated: true,
    membershipCoverageStatus: "COMPLETE",
    campaignFrontierFreshnessStatus: "COMPLETE",
    fanValuesComplete: true,
    fanValuesOutstanding: 0,
    fanValueFreshnessStatus: "COMPLETE",
    currentCoverageAuthoritative: true,
  });
  assert.equal(complete.status, "COMPLETE");
  assert.equal(complete.refreshPending, false);
  assert.equal(complete.collectorStatus, "FAILED");
});

test("A20.2 production set-based healing has deterministic demand/work row lock order and adapter capability fence", () => {
  const source = fs.readFileSync(path.join(__dirname, "campaign-fan-refresh-queue-service.js"), "utf8");
  assert.match(source, /ORDER BY d\."id"\s+FOR UPDATE OF d/);
  assert.match(source, /ORDER BY w\."id"\s+FOR UPDATE OF w/);
  assert.match(source, /const productionSetBasedAdapter = typeof db\?\.\$queryRawUnsafe === "function"[\s\S]*creatorFanRefreshDemand\?\.findMany[\s\S]*creatorCampaignFanRefreshWork[\s\S]*creatorCampaignCollectionState/);
});

test("A20.2 migration installs and backfills durable current-coverage generation authority", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260919173000_phase3_campaign_coverage_generation_authority_v1/migration.sql"), "utf8");
  for (const field of ["fanValueCoverageDelegated", "fanValueCoverageOwnerKind", "fanValueCoverageCollectorVersion", "fanValueCoverageSourceJobId"]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS "${field}"`));
  }
  assert.match(migration, /CreatorCampaignFanRefreshWork/);
  assert.match(migration, /s\."fanValueCoverageScanRunId" = coverage_job\."scanRunId"/);
  assert.match(migration, /campaignFreshnessCoverageVersion/);
});
