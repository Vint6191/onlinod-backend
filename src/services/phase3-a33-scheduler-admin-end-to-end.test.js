"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

function cacheModule(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

function installSchedulerDecisionHarness() {
  const prismaPath = require.resolve("../prisma");
  const retentionPath = require.resolve("./retention-service");
  const subscriberPath = require.resolve("./subscriber-directory-service");
  const followBackPath = require.resolve("./follow-back-service");
  const bumpPath = require.resolve("./bump-service");
  const likesPath = require.resolve("./likes-service");
  const followAutomationPath = require.resolve("./follow-automation-service");
  const sfsPath = require.resolve("./sfs-service");
  const analyticsOrchestratorPath = require.resolve("./creator-analytics-sync-orchestrator");
  const dailyPath = require.resolve("./vault-intelligence-daily-service");
  const domainWorkPath = require.resolve("./domain-work-authority-service");
  const schedulerPath = require.resolve("./job-scheduler");

  cacheModule(require.resolve("./analytics-recurring-planning-service"), { planRecurringCreatorAnalytics: async () => ({ created: 0, skipped: 0 }) });
  const degraded = (created = true) => ({ ok: false, created, reason: "fan_refresh_debt_not_durable" });
  const prisma = {
    creatorAccount: {
      async findFirst() {
        return { id: "creator-a33", agencyId: "agency-a33", remoteId: "of-a33", username: "a33", displayName: "A33" };
      },
    },
    jobInstance: {
      async findUnique() { return { id: "traffic-existing", status: "SCHEDULED", completedAt: null }; },
    },
  };

  cacheModule(prismaPath, prisma);
  cacheModule(retentionPath, {
    async runRetentionSweep() { return { totalDeleted: 0 }; },
    async getRetentionSettings() { return { settings: { retentionSweepWindowHours: 24 } }; },
  });
  cacheModule(subscriberPath, { async ensureSubscriberScanDue() { return { ok: true, created: false, reason: "fresh" }; } });
  cacheModule(followBackPath, { async ensureAutomaticFollowBack() { return degraded(true); } });
  cacheModule(bumpPath, { async ensureAutomaticBumps() { return { ...degraded(true), planned: 1 }; } });
  cacheModule(likesPath, { async ensureAutomaticLikes() { return degraded(true); } });
  cacheModule(followAutomationPath, { async ensureAutomaticFollowAutomation() { return degraded(true); } });
  cacheModule(sfsPath, { async ensureAutomaticSfs() { return degraded(true); } });
  cacheModule(analyticsOrchestratorPath, {
    async ensureInitialCreatorAnalyticsSync() { return { created: false, ready: true, stage: "READY", reason: "ready" }; },
    async ensureRecurringCreatorAnalyticsCatchups() { return { created: [], skipped: [] }; },
    async creatorAnalyticsInitialSyncReady() { return true; },
  });
  cacheModule(dailyPath, {
    async ensureDailyVaultIntelligenceCycle() { return { ok: true, created: 0 }; },
  });
  cacheModule(domainWorkPath, {
    WORK_CLASS: { CREATOR_RECURRING_PLANNING: "CREATOR_RECURRING_PLANNING" },
    async claimDomainWorkBatch() {
      return { ownerToken: "owner-a33", authorityNow: new Date(), items: [{ id: "work-a33", agencyId: "agency-a33", creatorId: "creator-a33", objectId: "creator-a33" }] };
    },
    async heartbeatDomainWorkClaim() { return { renewed: true, authorityNow: new Date() }; },
    async ackDomainWorkClaim() { return { acknowledged: true }; },
    async failDomainWorkClaim() { return { failed: true }; },
    async yieldDomainWorkClaim() { return { yielded: true }; },
  });

  delete require.cache[schedulerPath];
  return { scheduler: require("./job-scheduler"), prisma };
}

test("A33 scheduler preserves created work and all five non-durable consumer failures simultaneously", async () => {
  const { scheduler } = installSchedulerDecisionHarness();
  const result = await scheduler.scheduleInitialJobsForCreator({
    creatorId: "creator-a33",
    agencyId: "agency-a33",
    creator: { id: "creator-a33", agencyId: "agency-a33", remoteId: "of-a33" },
    includeCreatorAnalytics: true,
    includeAnalyticsCatchups: false,
    includeEarningsFreshness: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "fan_refresh_debt_not_durable");
  assert.deepEqual(result.degraded.map((row) => row.work), [
    "follow_back_plan", "bumps_plan", "likes_plan", "follow_automation_plan", "sfs_plan",
  ]);
  assert.ok(result.degraded.every((row) => row.reason === "fan_refresh_debt_not_durable" && row.created === true));
  for (const label of ["follow_back_plan", "likes_plan", "follow_automation_plan", "sfs_plan"]) {
    assert.ok(result.created.includes(label), label);
  }
  assert.ok(result.created.includes("bumps_plan:1"));
  assert.equal(result.skipped.some((row) => row.includes("fan_refresh_debt_not_durable")), false);
});

test("A33 recurring creator sweep does not discard degraded scheduler outcomes", async () => {
  const { scheduler, prisma } = installSchedulerDecisionHarness();
  const result = await scheduler.runRecurringCreatorWork({ db: prisma, pageSize: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "derived_planning_degraded");
  assert.equal(result.totalDegraded, 5);
  assert.equal(result.degradedCreators.length, 1);
  assert.equal(result.degradedCreators[0].creatorId, "creator-a33");
  assert.equal(result.degradedCreators[0].issues.length, 5);
  assert.ok(result.totalCreated >= 5);
});

test("A33 SFS top-level result is red when discovery or planning fails even if other work was created", () => {
  const prismaPath = require.resolve("../prisma");
  cacheModule(prismaPath, {});
  delete require.cache[require.resolve("./sfs-service")];
  const { resolveAutomaticSfsResult } = require("./sfs-service")._test;

  const discoveryFailure = resolveAutomaticSfsResult({
    discovery: { ok: false, created: true, reason: "discovery_failed" },
    planning: { ok: true, created: true },
  });
  assert.equal(discoveryFailure.ok, false);
  assert.equal(discoveryFailure.created, true);
  assert.equal(discoveryFailure.reason, "discovery_failed");

  const planningFailure = resolveAutomaticSfsResult({
    discovery: { ok: true, created: true },
    planning: { ok: false, created: false, reason: "planning_failed" },
  });
  assert.equal(planningFailure.ok, false);
  assert.equal(planningFailure.created, true);
  assert.equal(planningFailure.reason, "planning_failed");
});

test("A33 Admin current UI maps canonical fields, preserves UNKNOWN money, and is read-only", () => {
  const data = source("public/admin/modules/admin-data/admin-data.js");
  const detail = source("public/admin/modules/admin-creator-detail/admin-creator-detail.js");
  const shell = source("public/admin/modules/admin-shell/admin-shell.js");

  for (const ui of [data, detail]) {
    assert.match(ui, /v == null \|\| \(row\?\.valueAvailability && row\.valueAvailability !== "AVAILABLE"\)/);
    assert.match(ui, /\{ k: "observedAt", label: "Observed", fmt: fmtDate \}/);
    assert.match(ui, /\{ k: "statusUpdatedAt", label: "Status updated", fmt: fmtDate \}/);
    assert.match(ui, /\{ k: "latestActionType", label: "Action" \}/);
    assert.match(ui, /\{ k: "latestStatus", label: "Delivery status" \}/);
    assert.match(ui, /\{ k: "state", label: "Candidate state" \}/);
    assert.match(ui, /\{ k: "currentEligibility", label: "Eligibility" \}/);
    assert.doesNotMatch(ui, /\{ k: "lastSignalAt", label: "Last signal"/);
  }

  assert.match(data, /const readOnly = !ent\.model/);
  assert.match(data, /if \(readOnly\) \{ updateBulkBtn\(body\); return; \}/);
  assert.match(data, /if \(!ent\.model \|\| !ids\.length\) return/);
  assert.match(detail, /const readOnly = !cfg\.model/);
  assert.match(detail, /if \(readOnly\) return/);
  assert.match(shell, /results\.hiddenOnlineHistoricalCompatibility/);
  assert.match(shell, /Hidden Online — Historical compatibility/);
  assert.doesNotMatch(shell, /grp\("Hidden online", results\.hiddenOnline/);
});
