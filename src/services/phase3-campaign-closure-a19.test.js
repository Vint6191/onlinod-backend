"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  recoverFailedCampaignFanRefreshDemands,
  reconcileCampaignFanRefreshDemandsFromCanonicalObservations,
  _test: refreshTest,
} = require("./campaign-fan-refresh-queue-service");
const { deriveCampaignPresentationStatus, deriveManualCampaignStartDebtAction } = require("./campaign-scan-status-authority");
const { providerScaleContract } = require("./provider-capacity-sla-service");

const root = path.resolve(__dirname, "../..");
const desktopRoot = path.resolve(root, "../../desktop");

test("A19 end-to-end Campaign status follows live delegated coverage, not frozen job.result fanValuesComplete", () => {
  const pending = deriveCampaignPresentationStatus({
    collectorStatus: "COMPLETE",
    fanRefreshDelegated: true,
    membershipCoverageStatus: "COMPLETE",
    campaignFrontierFreshnessStatus: "COMPLETE",
    fanValuesComplete: false,
    fanValuesOutstanding: 3,
    fanValueFreshnessStatus: "QUEUED",
  });
  assert.equal(pending.status, "REFRESH_PENDING");
  assert.equal(pending.collectorStatus, "COMPLETE");
  assert.equal(pending.coverageStatus, "PENDING");
  assert.equal(pending.refreshPending, true);

  const complete = deriveCampaignPresentationStatus({
    collectorStatus: "COMPLETE",
    fanRefreshDelegated: true,
    membershipCoverageStatus: "COMPLETE",
    campaignFrontierFreshnessStatus: "COMPLETE",
    fanValuesComplete: true,
    fanValuesOutstanding: 0,
    fanValueFreshnessStatus: "COMPLETE",
  });
  assert.equal(complete.status, "COMPLETE");
  assert.equal(complete.coverageStatus, "COMPLETE");
  assert.equal(complete.refreshPending, false);

  const retryBackoff = deriveCampaignPresentationStatus({
    collectorStatus: "COMPLETE",
    fanRefreshDelegated: true,
    membershipCoverageStatus: "COMPLETE",
    campaignFrontierFreshnessStatus: "COMPLETE",
    fanValuesComplete: false,
    fanValuesOutstanding: 0,
    fanValueFreshnessStatus: "PARTIAL",
    retryableFailedDemands: 1,
  });
  assert.equal(retryBackoff.status, "REFRESH_PENDING", "bounded retry debt remains pollable while collector is already DONE");

  const quarantined = deriveCampaignPresentationStatus({
    collectorStatus: "COMPLETE",
    fanRefreshDelegated: true,
    membershipCoverageStatus: "COMPLETE",
    campaignFrontierFreshnessStatus: "COMPLETE",
    fanValuesComplete: false,
    fanValuesOutstanding: 0,
    fanValueFreshnessStatus: "PARTIAL",
    retryableFailedDemands: 0,
  });
  assert.equal(quarantined.status, "PARTIAL");
  assert.equal(quarantined.refreshPending, false);

  const legacyIncomplete = deriveCampaignPresentationStatus({
    collectorStatus: "COMPLETE",
    fanRefreshDelegated: false,
    membershipCoverageStatus: "COMPLETE",
    campaignFrontierFreshnessStatus: "COMPLETE",
    fanValuesComplete: false,
  });
  assert.equal(legacyIncomplete.status, "PARTIAL", "pre-delegation collector must preserve terminal inline FanData semantics");
  assert.equal(legacyIncomplete.coverageStatus, "PARTIAL");
});

test("A19 manual refresh repair is lost-response idempotent and never falls through to full Campaign traversal while debt is open", () => {
  assert.equal(deriveManualCampaignStartDebtAction({ failedDebt: 1, queuedDebt: 0 }), "repair");
  assert.equal(deriveManualCampaignStartDebtAction({ failedDebt: 0, queuedDebt: 1 }), "refresh_pending", "repeat after committed repair response-loss must not start full scan");
  assert.equal(deriveManualCampaignStartDebtAction({ failedDebt: 0, queuedDebt: 0 }), "full");
});

test("A19 scale contract explicitly rejects universal 4000 creators / 72h under one audited fleet-global gate", () => {
  const contract = providerScaleContract({ creatorCount: 4000, minimumCampaignCount: 1, targetMs: 72 * 60 * 60 * 1000 });
  assert.equal(contract.universalDirectorySlaGuaranteed, false);
  assert.equal(contract.policy, "BEST_EFFORT_OVERDUE_VISIBLE");
  assert.equal(contract.reason, "FLEET_GLOBAL_CAPACITY_INSUFFICIENT");
  assert.equal(contract.noUnauditedSharding, true);
  assert.ok(contract.feasibility.requiredHours > contract.feasibility.targetHours);
});

test("A19 failed FanData demand has bounded DB-time backoff and same-revision terminal JobInstance is resettable", () => {
  const now = new Date("2040-01-01T00:00:00.000Z");
  const first = refreshTest.campaignFanRefreshFailurePlan({ retryAttempts: 0 }, now);
  assert.equal(first.retryAttempts, 1);
  assert.equal(first.quarantined, false);
  assert.equal(first.nextRetryAt.toISOString(), "2040-01-01T00:01:00.000Z");

  const terminal = refreshTest.campaignFanRefreshFailurePlan({ retryAttempts: 4 }, now);
  assert.equal(terminal.retryAttempts, 5);
  assert.equal(terminal.quarantined, true);
  assert.equal(terminal.nextRetryAt, null);
  assert.equal(terminal.quarantinedAt.toISOString(), now.toISOString());

  assert.equal(refreshTest.shouldResetCampaignRefreshJob({ status: "DONE" }), true);
  assert.equal(refreshTest.shouldResetCampaignRefreshJob({ status: "FAILED" }), true);
  assert.equal(refreshTest.shouldResetCampaignRefreshJob({ status: "CANCELLED" }), true);
  assert.equal(refreshTest.shouldResetCampaignRefreshJob({ status: "SCHEDULED" }), false);
  assert.equal(refreshTest.shouldResetCampaignRefreshJob({ status: "CLAIMED" }), false);
});

test("A19 due failed debt requeues atomically from failed to outstanding under bounded recovery", async () => {
  const now = new Date("2040-01-01T01:00:00.000Z");
  const demand = {
    id: "d1", agencyId: "a1", creatorId: "c1", onlyFansUserId: "f1", status: "FAILED",
    requestedRevision: 3, retryAttempts: 1, nextRetryAt: new Date("2040-01-01T00:59:00.000Z"), quarantinedAt: null,
  };
  const demandUpdates = [];
  const workUpdates = [];
  const coverageUpdates = [];
  const db = {
    creatorFanRefreshDemand: {
      findMany: async () => [demand],
      update: async ({ data }) => { demandUpdates.push(data); return { ...demand, ...data }; },
    },
    creatorCampaignFanRefreshWork: {
      findMany: async () => [{ id: "w1", scanRunId: "run1" }],
      updateMany: async ({ data }) => { workUpdates.push(data); return { count: 1 }; },
    },
    creatorCampaignCollectionState: {
      updateMany: async ({ data }) => { coverageUpdates.push(data); return { count: 1 }; },
    },
  };
  const result = await recoverFailedCampaignFanRefreshDemands({ db, creatorId: "c1", now, maxDemands: 10 });
  assert.equal(result.recovered, 1);
  assert.equal(result.requeuedWork, 1);
  assert.equal(workUpdates[0].status, "QUEUED");
  assert.deepEqual(coverageUpdates[0].fanValueFailed, { decrement: 1 });
  assert.deepEqual(coverageUpdates[0].fanValueOutstanding, { increment: 1 });
  assert.equal(demandUpdates[0].status, "QUEUED");
  assert.equal(demandUpdates[0].nextRetryAt, null);
  assert.equal(demandUpdates[0].lastRetryAt.toISOString(), now.toISOString());
});

test("A19 current-generation recovery fails closed if work CAS wins but aggregate coverage counters cannot transition", async () => {
  const now = new Date("2040-01-01T01:30:00.000Z");
  const demand = {
    id: "d-lost", agencyId: "a1", creatorId: "c1", onlyFansUserId: "f-lost", status: "FAILED",
    requestedRevision: 2, retryAttempts: 1, nextRetryAt: new Date("2040-01-01T01:00:00.000Z"), quarantinedAt: null,
  };
  const db = {
    creatorFanRefreshDemand: {
      findMany: async () => [demand],
      update: async ({ data }) => ({ ...demand, ...data }),
    },
    creatorCampaignFanRefreshWork: {
      findMany: async () => [{ id: "w-lost", scanRunId: "run-current" }],
      updateMany: async () => ({ count: 1 }),
    },
    creatorCampaignCollectionState: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ creatorId: "c1", fanValueCoverageScanRunId: "run-current" }),
    },
  };
  await assert.rejects(
    () => recoverFailedCampaignFanRefreshDemands({ db, creatorId: "c1", now, maxDemands: 10 }),
    /CAMPAIGN_FAN_REFRESH_REQUEUE_COVERAGE_TRANSITION_LOST/,
  );
});

test("A19 later canonical fresh observation heals previously FAILED Campaign debt without replaying Campaign traversal", async () => {
  const now = new Date("2040-01-01T02:00:00.000Z");
  const cutoff = new Date("2040-01-01T00:00:00.000Z");
  const observedAt = new Date("2040-01-01T01:30:00.000Z");
  const demand = {
    id: "d1", agencyId: "a1", creatorId: "c1", onlyFansUserId: "f1", status: "FAILED",
    requestedRevision: 2, satisfiedRevision: 0, requestedFreshnessCutoffAt: cutoff, retryAttempts: 4,
  };
  const state = {
    creatorId: "c1", fanValueCoverageScanRunId: "run1", fanValueFreshnessStatus: "PARTIAL",
    fanValueExpected: 1, fanValueAlreadyFresh: 0, fanValueQueued: 1, fanValueSucceeded: 0,
    fanValueUnavailable: 0, fanValueFailed: 1, fanValueOutstanding: 0,
    membershipCoverageStatus: "COMPLETE", campaignFrontierFreshnessStatus: "COMPLETE", mode: "full",
    activeGeneration: "run1",
  };
  const demandUpdates = [];
  const workUpdates = [];
  const stateUpdates = [];
  const db = {
    creatorFanRefreshDemand: {
      findMany: async () => [demand],
      update: async ({ data }) => { demandUpdates.push(data); Object.assign(demand, data); return demand; },
    },
    creatorFan: {
      findMany: async () => [{ onlyFansUserId: "f1", valueCurrent: { valueObservedAt: observedAt, availability: "AVAILABLE" } }],
    },
    creatorCampaignFanRefreshWork: {
      findMany: async () => [{ id: "w1", creatorId: "c1", scanRunId: "run1", status: "FAILED", freshnessCutoffAt: cutoff }],
      updateMany: async ({ data }) => { workUpdates.push(data); return { count: 1 }; },
    },
    creatorCampaignCollectionState: {
      updateMany: async ({ data }) => {
        stateUpdates.push(data);
        if (data.fanValueFailed?.decrement) state.fanValueFailed -= data.fanValueFailed.decrement;
        if (data.fanValueSucceeded?.increment) state.fanValueSucceeded += data.fanValueSucceeded.increment;
        return { count: 1 };
      },
      findUnique: async () => state,
      update: async ({ data }) => { Object.assign(state, data); return state; },
    },
  };
  const result = await reconcileCampaignFanRefreshDemandsFromCanonicalObservations({ db, creatorId: "c1", fanIds: ["f1"], now });
  assert.equal(result.healed, 1);
  assert.equal(demandUpdates[0].status, "COMPLETE");
  assert.equal(demandUpdates[0].satisfiedRevision, 2);
  assert.equal(demandUpdates[0].retryAttempts, 0);
  assert.equal(demandUpdates[0].quarantinedAt, null);
  assert.equal(workUpdates[0].status, "SUCCEEDED");
  assert.deepEqual(stateUpdates[0].fanValueFailed, { decrement: 1 });
  assert.deepEqual(stateUpdates[0].fanValueSucceeded, { increment: 1 });
  assert.equal(state.fanValueFreshnessStatus, "COMPLETE");
  assert.equal(state.status, "COMPLETE");
});

test("A19 source contracts keep recovery multi-replica safe, sample capacity before admission, and poll delegated Desktop work", () => {
  const queue = fs.readFileSync(path.join(root, "src/services/campaign-fan-refresh-queue-service.js"), "utf8");
  const scheduler = fs.readFileSync(path.join(root, "src/services/job-scheduler.js"), "utf8");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260919113000_phase3_campaign_refresh_recovery_status_v1/migration.sql"), "utf8");
  const shared = fs.readFileSync(path.join(desktopRoot, "packages/shared/src/creator-analytics.ts"), "utf8");
  const normalizer = fs.readFileSync(path.join(desktopRoot, "apps/desktop/electron/main/services/creator-analytics/creator-analytics-service.ts"), "utf8");
  const ui = fs.readFileSync(path.join(desktopRoot, "apps/desktop/renderer/src/features/creator-analytics/CampaignScanner.tsx"), "utf8");
  const fanAuthority = fs.readFileSync(path.join(root, "src/services/fan-data-authority-service.js"), "utf8");
  const scanControl = fs.readFileSync(path.join(root, "src/services/campaign-scan-control-service.js"), "utf8");

  assert.match(queue, /FOR UPDATE SKIP LOCKED/);
  assert.match(queue, /nextRetryAt/);
  assert.match(queue, /quarantinedAt/);
  assert.match(queue, /ensurePlannedJob/);
  assert.match(queue, /shouldResetCampaignRefreshJob/);
  assert.match(queue, /assertCoverageMutationNotLost/);
  assert.match(fanAuthority, /reconcileCampaignFanRefreshDemandsFromCanonicalObservations/);
  assert.match(schema, /retryAttempts\s+Int\s+@default\(0\)/);
  assert.match(schema, /nextRetryAt\s+DateTime\?/);
  assert.match(schema, /quarantinedAt\s+DateTime\?/);
  assert.match(migration, /CreatorFanRefreshDemand_retry_due_idx/);

  const sweepStart = scheduler.indexOf("async function runCreatorAnalyticsCatchupSweep");
  const sweep = scheduler.slice(sweepStart, scheduler.indexOf("async function runRecurringCreatorWork", sweepStart));
  const sample = sweep.indexOf("refreshProviderCapacityDebtSnapshot");
  const admit = sweep.indexOf("selectCampaignDirectoryDiscoveryAdmissions");
  assert.ok(sample >= 0 && admit > sample, "capacity must be sampled before directory admission");
  assert.match(sweep, /sampleError/);

  assert.match(shared, /'REFRESH_PENDING'/);
  assert.match(shared, /campaignFrontierFreshnessStatus/);
  assert.match(shared, /campaignDirectoryDiscoveryOverdueByMs/);
  assert.match(normalizer, /CAMPAIGN_SCAN_STATUSES/);
  assert.match(normalizer, /refreshRecoveryAvailable/);
  assert.match(normalizer, /refreshLastFailureMessage/);
  assert.match(ui, /data\?\.refreshPending !== true/);
  assert.match(ui, /RETRY FAILED REFRESH/);
  assert.match(ui, /refreshLastFailureMessage/);
  assert.match(ui, /QUARANTINED/);
  assert.match(ui, /COLLECTOR \/ COVERAGE/);
  assert.match(ui, /DIRECTORY PROOF/);
  assert.match(ui, /DIRECTORY OVERDUE/);
  assert.match(ui, /campaignFrontierOldestDueAt/);
  assert.match(ui, /campaignDirectoryDiscoveryPending/);
  assert.match(ui, /campaignDirectoryDiscoveryTargetMs/);

  assert.match(scanControl, /queuedDebtBeforeRepair/);
  assert.match(scanControl, /action: "refresh_pending"/);
  assert.match(scanControl, /Never fall through to FULL scan/);
});


test("A19 migration makes pre-existing FAILED refresh debt immediately retryable", () => {
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260919113000_phase3_campaign_refresh_recovery_status_v1/migration.sql"), "utf8");
  assert.match(migration, /UPDATE\s+"CreatorFanRefreshDemand"[\s\S]*SET\s+"nextRetryAt"\s*=\s*CURRENT_TIMESTAMP[\s\S]*"status"\s*=\s*'FAILED'[\s\S]*"activeRefreshJobId"\s+IS\s+NULL[\s\S]*"nextRetryAt"\s+IS\s+NULL/i);
});
