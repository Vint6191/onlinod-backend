"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function cacheModule(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const prismaPath = require.resolve("../prisma");
const notificationStatePath = require.resolve("./notification-sync-state-service");
const financialPath = require.resolve("./financial-transactions-service");
const schedulerPath = require.resolve("./job-scheduler");
const orchestratorPath = require.resolve("./creator-analytics-sync-orchestrator");

let notificationState = null;
let scheduled = [];

cacheModule(prismaPath, {});
cacheModule(notificationStatePath, {
  async loadNotificationSyncState() { return notificationState; },
  buildNotificationScanParams({ state, now = new Date(), reason, analyticsRangeKey }) {
    const verifiedAt = state?.fullBackfillVerifiedAt ? new Date(state.fullBackfillVerifiedAt) : null;
    const trustedBaseline = Boolean(verifiedAt && Number.isFinite(verifiedAt.getTime()) && verifiedAt.getTime() <= now.getTime() + 5 * 60 * 1000);
    return {
      from: "2016-01-01T00:00:00.000Z",
      to: "2026-08-09T12:00:00.000Z",
      types: ["purchases", "tips", "subscriptions", "likes", "comments"],
      notificationMode: trustedBaseline ? "catchup" : "full",
      pageLimit: 10,
      reason,
      analyticsRangeKey,
      ...(trustedBaseline && state?.headNotificationId ? { stopAtNotificationId: state.headNotificationId } : {}),
    };
  },
});
cacheModule(financialPath, {
  JOB_KEY: "financial_transactions_scan",
  SCHEMA_VERSION: 1,
  COLLECTOR_VERSION: "payout-transactions-v2-catchup",
});
cacheModule(schedulerPath, {
  async scheduleJobNow(input) {
    scheduled.push(input);
    return { created: true, reason: "created", job: { id: `job-${scheduled.length}`, ...input, status: "SCHEDULED" } };
  },
});

delete require.cache[orchestratorPath];
const {
  ensureInitialCreatorAnalyticsSync,
  ensureRecurringCreatorAnalyticsCatchups,
  advanceCreatorAnalyticsInitialSyncAfterCompletion,
} = require("./creator-analytics-sync-orchestrator");

function dbFixture({
  financialReady = false, campaignReady = false, active = [], financialCatchupAt = null, campaignCatchupAt = null,
  financialStatus = "COMPLETE", campaignStatus = "COMPLETE", financialRetryAfterAt = null, campaignRetryAfterAt = null,
  campaignMembershipStatus = "COMPLETE", campaignFanFreshnessStatus = "COMPLETE", campaignFanOutstanding = 0, campaignSourceJobId = null,
} = {}) {
  return {
    jobInstance: {
      async findFirst({ where }) {
        return active.find((job) => job.jobKey === where.jobKey && ["SCHEDULED", "CLAIMED", "PAUSED"].includes(job.status)) || null;
      },
      async findMany({ where } = {}) {
        if (where?.status?.in) return active.filter((job) => !where.jobKey || job.jobKey === where.jobKey);
        return [];
      },
      async updateMany({ where, data }) {
        const target = active.find((job) => job.id === where.id && where.status.in.includes(job.status));
        if (!target) return { count: 0 };
        Object.assign(target, data, { status: data.status });
        return { count: 1 };
      },
    },
    creatorFinancialCollectionState: {
      async findUnique() {
        return financialReady ? {
          status: financialStatus, receiptCoverageVersion: 1,
          baselineVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), baselineObservedAt: new Date("2026-08-01T00:00:00.000Z"),
          baselineGeneration: "financial-baseline-generation",
          lastCatchupCompletedAt: financialCatchupAt, lastCatchupObservedAt: financialCatchupAt,
          retryAfterAt: financialRetryAfterAt,
        } : null;
      },
    },
    creatorCampaignCollectionState: {
      async findUnique() {
        return campaignReady ? {
          status: campaignStatus,
          baselineVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), baselineObservedAt: new Date("2026-08-01T00:00:00.000Z"),
          baselineGeneration: "campaign-baseline-generation",
          lastCatchupCompletedAt: campaignCatchupAt, lastCatchupObservedAt: campaignCatchupAt,
          retryAfterAt: campaignRetryAfterAt,
          membershipCoverageStatus: campaignMembershipStatus,
          fanValueFreshnessStatus: campaignFanFreshnessStatus,
          fanValueOutstanding: campaignFanOutstanding,
          sourceJobId: campaignSourceJobId,
        } : null;
      },
    },
  };
}

test.beforeEach(() => {
  scheduled = [];
  notificationState = null;
});

test("new full proof suppresses redundant notification and financial catch-ups", async () => {
  const now = new Date("2026-10-01T12:00:00Z"), old = new Date("2026-09-20T12:00:00Z");
  notificationState = { fullBackfillVerifiedAt: now, fullBackfillObservedAt: now, lastCatchupVerifiedAt: old , lastCatchupObservedAt: old};
  const db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorFinancialCollectionState.findUnique = async () => ({ status: "COMPLETE", baselineGeneration: "full-proof", baselineVerifiedAt: now, baselineObservedAt: now, lastCatchupCompletedAt: old, lastCatchupObservedAt: old });
  const result = await ensureRecurringCreatorAnalyticsCatchups({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert(result.skipped.includes("notifications_catchup:fresh"));
  assert(result.skipped.includes("financial_catchup:fresh"));
  assert(!scheduled.some(j => ["catchup_notifications_scan", "financial_transactions_scan"].includes(j.jobKey)));
});

test("migration keeps all historical baselines ready and schedules bounded catch-ups for missing source age", async () => {
  const now = new Date("2026-10-01T12:00:00Z");
  notificationState = { fullBackfillVerifiedAt: now };
  const db = dbFixture({ financialReady: true, campaignReady: true });
  for (const delegate of ["creatorFinancialCollectionState", "creatorCampaignCollectionState"]) {
    const read = db[delegate].findUnique;
    db[delegate].findUnique = async () => {
      const row = await read();
      delete row.baselineObservedAt; delete row.lastCatchupObservedAt;
      return row;
    };
  }
  db.creatorFinancialTransaction = { findMany: async () => [] };
  db.creatorCampaign = { findMany: async () => [] };
  db.$queryRawUnsafe = rawQueryWithAuthorityNow([], now);
  const initial = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(initial.ready, true); assert.equal(scheduled.length, 0);
  const recurring = await ensureRecurringCreatorAnalyticsCatchups({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(recurring.ready, true);
  assert.deepEqual(scheduled.map(row => row.jobKey), ["catchup_notifications_scan", "financial_transactions_scan", "fetch_campaigns"]);
  assert(scheduled.every(row => row.params.collectionMode === "catchup"));
});

for (const completion of ["full", "deferred", "terminal"]) test("recurring planner rechecks " + completion + " after its collector lock", async () => {
  const now = new Date("2026-10-01T12:00:00Z"), old = new Date("2026-09-20T12:00:00Z");
  notificationState = { fullBackfillVerifiedAt: now , fullBackfillObservedAt: now};
  const db = dbFixture({ financialReady: true, campaignReady: true });
  let reads = 0;
  db.creatorFinancialCollectionState.findUnique = async () => {
    reads++;
    const state = { status: "COMPLETE", baselineGeneration: "full-proof", baselineVerifiedAt: old, baselineObservedAt: old, lastCatchupCompletedAt: old, lastCatchupObservedAt: old };
    // Initial readiness and pre-lock due check see the old state. The third
    // read is in scheduleIfIdle after acquiring collector authority.
    if (reads >= 3) {
      if (completion === "full") { state.baselineVerifiedAt = now; state.baselineObservedAt = now; }
      else { state.status = "FAILED"; state.retryAfterAt = completion === "deferred" ? new Date(+now + 3600000) : null; }
    }
    return state;
  };
  const result = await ensureRecurringCreatorAnalyticsCatchups({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert(reads >= 3);
  assert(!scheduled.some(j => j.jobKey === "financial_transactions_scan"));
  assert(result.skipped.includes("financial_catchup:" + ({ full: "fresh", deferred: "deferred", terminal: "failed_terminal" }[completion])));
});

function rawQueryWithAuthorityNow(result, now = new Date("2026-08-09T12:00:00.000Z")) {
  return async (sql, ...args) => {
    if (String(sql || "").includes("clock_timestamp()")) {
      return [{ authorityNow: now }];
    }
    return typeof result === "function" ? result(sql, ...args) : result;
  };
}

for (const kind of ["notifications", "financial", "campaigns"]) for (const change of ["completion", "deferred", "terminal"]) {
  test(`initial ${kind} revalidates ${change} after acquiring collector authority`, async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const db = dbFixture({ financialReady: kind === "campaigns" });
    notificationState = kind === "notifications" ? null : { fullBackfillVerifiedAt: now , fullBackfillObservedAt: now};
    let current = null;
    const key = { notifications: "catchup_notifications_scan", financial: "financial_transactions_scan", campaigns: "fetch_campaigns" }[kind];
    const delegate = { notifications: "creatorNotificationSyncState", financial: "creatorFinancialCollectionState", campaigns: "creatorCampaignCollectionState" }[kind];
    db[delegate] = { async findUnique() { return current; } };
    db.jobInstance.findFirst = async ({ where }) => {
      if (where.jobKey === key) {
        current = change === "completion"
          ? { status: "COMPLETE", baselineGeneration: "new-full", baselineVerifiedAt: now, baselineObservedAt: now, fullBackfillVerifiedAt: now , fullBackfillObservedAt: now}
          : { status: "FAILED", retryAfterAt: change === "deferred" ? new Date(+now + 60000) : null };
        if (kind === "notifications") notificationState = current;
      }
      return null;
    };
    const result = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
    assert.equal(result.created, false);
    assert.equal(result.reason, { completion: "baseline_verified", deferred: "deferred", terminal: "failed_terminal" }[change]);
    assert.equal(scheduled.length, 0);
  });
}

for (const change of ["fresh", "debt", "deferred", "directory", "generation"]) {
  test(`Campaign recurring plan is reconstructed from locked ${change} state`, async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    notificationState = { fullBackfillVerifiedAt: now , fullBackfillObservedAt: now};
    const db = dbFixture({ financialReady: true, campaignReady: true, financialCatchupAt: now });
    let current = { status: "COMPLETE", baselineGeneration: "full", baselineVerifiedAt: now, baselineObservedAt: now,
      campaignDirectoryGeneration: "directory-old", campaignDirectoryRevision: 1,
      campaignDirectoryRequestedAt: new Date(+now - 10000), campaignDirectoryVerifiedAt: now,
      campaignDirectoryCampaignCount: 7, campaignDirectoryDiscoveryDueAt: new Date(+now + 3600000),
      campaignFrontierFreshnessStatus: "PARTIAL", activeGeneration: "run-a" };
    db.creatorCampaignCollectionState.findUnique = async () => current;
    db.jobInstance.findFirst = async ({ where }) => {
      if (where.jobKey === "fetch_campaigns") {
        current = { ...current };
        if (change === "fresh") Object.assign(current, { campaignFrontierFreshnessStatus: "COMPLETE",
          campaignFrontierObservationVersion: 1, campaignFrontierPlanRunId: "run-a", membershipCoverageStatus: "COMPLETE",
          campaignFrontierNextDueAt: new Date(+now + 3600000) });
        if (change === "debt") Object.assign(current, { fanValueCoverageScanRunId: "run-a", fanValueExpected: 1, fanValueFreshnessStatus: "QUEUED" });
        if (change === "deferred") current.retryAfterAt = new Date(+now + 60000);
        if (change === "directory") current.campaignDirectoryDiscoveryRequestedRevision = 2;
        if (change === "generation") Object.assign(current, { campaignDirectoryGeneration: "directory-new", campaignDirectoryRevision: 2 });
      }
      return null;
    };
    let reservations = 0;
    const result = await ensureRecurringCreatorAnalyticsCatchups({ db, creatorId: "creator-1", agencyId: "agency-1", now,
      reserveCampaignDirectory: async state => { reservations++; assert.equal(state, current); return true; } });
    const job = scheduled.find(row => row.jobKey === "fetch_campaigns");
    if (["fresh", "deferred"].includes(change)) {
      assert.equal(job, undefined); assert.equal(reservations, 0);
      assert(result.skipped.includes(`campaigns_catchup:${change}`));
    } else if (change === "directory") {
      assert.equal(job.params.campaignDirectoryReuseGeneration, undefined);
      assert.equal(job.params.campaignDirectoryDiscoveryVersion, 1);
      assert.equal(reservations, 1); assert(result.created.includes("campaigns_directory_discovery"));
    } else {
      assert.equal(job.params.campaignDirectoryReuseGeneration, change === "debt" ? "directory-old" : "directory-new");
      assert.equal(job.params.campaignDirectoryReuseRevision, change === "debt" ? 1 : 2);
      assert.equal(reservations, 0); assert(result.created.includes("campaigns_frontier_reuse"));
    }
  });
}

test("initial analytics sync is strictly Notifications -> Financial -> Campaigns", async () => {
  const now = new Date("2026-08-09T12:00:00.000Z");

  let db = dbFixture();
  let step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "notifications");
  assert.equal(scheduled.at(-1).jobKey, "catchup_notifications_scan");
  assert.equal(scheduled.at(-1).params.notificationMode, "full");
  assert.equal(scheduled.at(-1).params.analyticsSyncStage, "notifications");
  assert.equal(scheduled.at(-1).params.collectionContractVersion, 1);
  assert.equal(scheduled.at(-1).params.collectionType, "NOTIFICATIONS");
  assert.equal(scheduled.at(-1).params.collectionMode, "full");
  assert.ok(scheduled.at(-1).params.collectionGeneration);
  assert.equal(scheduled.at(-1).params.collectionRequestedAt, now.toISOString());
  assert.deepEqual(scheduled.at(-1).dedupeParams, {
    planningEpoch: "none:none",
    collectionOrderingAfter: "none",
    collectionContractVersion: 1,
    collectionType: "NOTIFICATIONS",
    collectionMode: "full",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(scheduled.at(-1).dedupeParams, "collectionGeneration"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(scheduled.at(-1).dedupeParams, "collectionRequestedAt"), false);
  assert.equal(scheduled.at(-1).db, db);

  scheduled = [];
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-09T10:00:00.000Z") , fullBackfillObservedAt: new Date("2026-08-09T10:00:00.000Z")};
  db = dbFixture({ financialReady: false });
  step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "financial");
  assert.equal(scheduled.at(-1).jobKey, "financial_transactions_scan");
  assert.equal(scheduled.at(-1).params.financialMode, "full");
  assert.equal(scheduled.at(-1).params.analyticsSyncStage, "financial");
  assert.equal(scheduled.at(-1).params.collectionContractVersion, 1);
  assert.equal(scheduled.at(-1).params.collectionType, "FINANCIAL");
  assert.equal(scheduled.at(-1).params.collectionMode, "full");
  assert.ok(scheduled.at(-1).params.collectionGeneration);
  assert.equal(scheduled.at(-1).params.collectionRequestedAt, now.toISOString());

  scheduled = [];
  db = dbFixture({ financialReady: true, campaignReady: false });
  step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "campaigns");
  assert.equal(scheduled.at(-1).jobKey, "fetch_campaigns");
  assert.equal(scheduled.at(-1).params.campaignMode, "full");
  assert.equal(scheduled.at(-1).params.analyticsSyncStage, "campaigns");
  assert.equal(scheduled.at(-1).params.collectionContractVersion, 1);
  assert.equal(scheduled.at(-1).params.collectionType, "CAMPAIGNS");
  assert.equal(scheduled.at(-1).params.collectionMode, "full");
  assert.ok(scheduled.at(-1).params.collectionGeneration);
  assert.equal(scheduled.at(-1).params.collectionRequestedAt, now.toISOString());

  scheduled = [];
  db = dbFixture({ financialReady: true, campaignReady: true });
  step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.ready, true);
  assert.equal(step.stage, "ready");
  assert.equal(scheduled.length, 0);
});

test("initial pipeline advances only after a verified completion from the current stage", async () => {
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-09T10:00:00.000Z") , fullBackfillObservedAt: new Date("2026-08-09T10:00:00.000Z")};
  const db = dbFixture({ financialReady: false });
  const job = {
    id: "notification-initial",
    creatorId: "creator-1",
    agencyId: "agency-1",
    jobKey: "catchup_notifications_scan",
    params: { analyticsSyncKind: "initial", analyticsSyncVersion: 1, analyticsSyncStage: "notifications" },
  };
  const rejected = await advanceCreatorAnalyticsInitialSyncAfterCompletion({ db, job, sideEffect: { verified: false } });
  assert.equal(rejected.advanced, false);
  assert.equal(scheduled.length, 0);

  const advanced = await advanceCreatorAnalyticsInitialSyncAfterCompletion({ db, job, sideEffect: { verified: true }, now: new Date("2026-08-09T12:00:00.000Z") });
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.next.stage, "financial");
  assert.equal(scheduled.at(-1).jobKey, "financial_transactions_scan");
});

test("a completed-but-unverified notification traversal does not advance initial sync or cancel its repair FULL", async () => {
  notificationState = {
    fullBackfillCompletedAt: new Date("2026-08-08T10:00:00.000Z"),
    fullBackfillVerifiedAt: null, fullBackfillObservedAt: null,
    headNotificationId: "known-head",
  };
  const active = [{
    id: "repair-auto-full",
    jobKey: "catchup_notifications_scan",
    status: "CLAIMED",
    params: { notificationMode: "full", reason: "automatic_repair" },
  }];
  const db = dbFixture({ financialReady: true, campaignReady: true, active });
  const step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z") });
  assert.equal(step.ready, false);
  assert.equal(step.stage, "notifications");
  assert.equal(step.reason, "already_in_flight");
  assert.equal(active[0].status, "CLAIMED");
  assert.equal(active[0].lastError, undefined);
  assert.equal(scheduled.length, 0);
});

test("verified history fences a legacy manual FULL that has no explicit force marker", async () => {
  notificationState = {
    fullBackfillCompletedAt: new Date("2026-08-08T10:00:00.000Z"),
    fullBackfillVerifiedAt: new Date("2026-08-08T10:01:00.000Z"), fullBackfillObservedAt: new Date("2026-08-08T10:01:00.000Z"),
    headNotificationId: "known-head",
  };
  const active = [{
    id: "legacy-manual-full",
    jobKey: "catchup_notifications_scan",
    status: "CLAIMED",
    params: { notificationMode: "full", manualNotificationScan: true, manualNotificationScanVersion: 1 },
  }];
  const db = dbFixture({ financialReady: true, campaignReady: true, active });
  const step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z") });
  assert.equal(step.ready, true);
  assert.equal(active[0].status, "CANCELLED");
});

test("completed history preserves only an explicitly forced FULL rebuild", async () => {
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-08T10:00:00.000Z") , fullBackfillObservedAt: new Date("2026-08-08T10:00:00.000Z")};
  const active = [{
    id: "forced-manual-full",
    jobKey: "catchup_notifications_scan",
    status: "CLAIMED",
    params: { notificationMode: "full", manualNotificationScan: true, forceNotificationFullRebuild: true },
  }];
  const db = dbFixture({ financialReady: true, campaignReady: true, active });
  const step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z") });
  assert.equal(step.ready, true);
  assert.equal(active[0].status, "CLAIMED");
});

test("current Campaign catch-up scheduler publishes no provider-order frontier hints", async () => {
  const source = require("node:fs").readFileSync(require.resolve("./creator-analytics-sync-orchestrator"), "utf8");
  assert.doesNotMatch(source, /function campaignCatchupState/);
  assert.doesNotMatch(source, /knownClaimerFrontierHashes/);
  assert.doesNotMatch(source, /catchupFrontierHash/);
});

test("recurring analytics uses fixed head catch-ups only after initial history is ready", async () => {
  notificationState = {
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), lastCatchupObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    headNotificationId: "notification-head",
    knownNotificationIds: ["n-3", "n-2", "n-1"],
  };
  const db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorFinancialTransaction = {
    async findMany() { return [{ externalTransactionId: "t-3" }, { externalTransactionId: "t-2" }]; },
  };
  db.creatorCampaign = {
    async findMany() { return [{ externalCampaignId: "campaign-a", catchupFrontierHash: "a".repeat(64) }]; },
  };
  db.$queryRawUnsafe = rawQueryWithAuthorityNow([]);

  const result = await ensureRecurringCreatorAnalyticsCatchups({
    db,
    creatorId: "creator-1",
    agencyId: "agency-1",
    now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.equal(result.ready, true);
  assert.deepEqual(scheduled.map((row) => row.jobKey), ["catchup_notifications_scan", "financial_transactions_scan", "fetch_campaigns"]);
  const notification = scheduled[0].params;
  const financial = scheduled[1].params;
  const campaigns = scheduled[2].params;
  assert.equal(notification.notificationMode, "catchup");
  assert.deepEqual(notification.knownNotificationIds, ["n-3", "n-2", "n-1"]);
  assert.equal(financial.financialMode, "catchup");
  assert.equal(financial.knownTransactionIds, undefined);
  assert.equal(financial.catchupMaxPages, undefined);
  assert.equal(financial.collectionType, "FINANCIAL");
  assert.equal(financial.collectionRequestedAt, "2026-08-09T12:00:00.000Z");
  assert.ok(financial.collectionGeneration);
  assert.equal(campaigns.campaignMode, "catchup");
  assert.equal(campaigns.collectionType, "CAMPAIGNS");
  assert.equal(campaigns.collectionRequestedAt, "2026-08-09T12:00:00.000Z");
  assert.ok(campaigns.collectionGeneration);
  assert.equal(Object.prototype.hasOwnProperty.call(campaigns, "knownCampaignFanCounts"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(campaigns, "knownClaimersByCampaign"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(campaigns, "knownClaimerFrontierHashes"), false);
  assert.equal(campaigns.campaignOrderIndependentTraversalVersion, 1);
  assert.equal(JSON.stringify(campaigns).includes("HOT"), false);
  assert.equal(JSON.stringify(campaigns).includes("WARM"), false);
  assert.equal(JSON.stringify(campaigns).includes("COLD"), false);
});



test("a freshly completed notification catch-up cannot be immediately scheduled again", async () => {
  notificationState = {
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-09T11:58:00.000Z"),
    lastCatchupVerifiedAt: new Date("2026-08-09T11:58:00.000Z"), lastCatchupObservedAt: new Date("2026-08-09T11:58:00.000Z"),
    headNotificationId: "fresh-head",
  };
  const db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorNotificationScanItem = { async findMany() { return [{ notificationId: "fresh-head" }]; } };
  db.creatorFinancialTransaction = { async findMany() { return []; } };
  db.creatorCampaign = { async findMany() { return []; } };
  db.$queryRawUnsafe = rawQueryWithAuthorityNow([]);

  const result = await ensureRecurringCreatorAnalyticsCatchups({
    db,
    creatorId: "creator-1",
    agencyId: "agency-1",
    now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.equal(result.ready, true);
  assert.equal(scheduled.some((row) => row.jobKey === "catchup_notifications_scan"), false);
  assert.ok(result.skipped.includes("notifications_catchup:fresh"));
});



test("completed-but-unverified notification catch-up never satisfies recurring freshness", async () => {
  notificationState = {
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-09T11:59:30.000Z"),
    lastCatchupVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), lastCatchupObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    headNotificationId: "verified-old-head",
  };
  const db = dbFixture({
    financialReady: true, campaignReady: true,
    financialCatchupAt: new Date("2026-08-09T11:59:00.000Z"),
    campaignCatchupAt: new Date("2026-08-09T11:59:00.000Z"),
  });
  db.creatorFinancialTransaction = { async findMany() { return []; } };
  db.creatorCampaign = { async findMany() { return []; } };
  db.$queryRawUnsafe = rawQueryWithAuthorityNow([]);

  const result = await ensureRecurringCreatorAnalyticsCatchups({
    db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.equal(result.ready, true);
  assert.equal(scheduled.some((row) => row.jobKey === "catchup_notifications_scan"), true);
  assert.equal(result.skipped.includes("notifications_catchup:fresh"), false);
});



test("future-poisoned baseline proofs cannot advance the staged initial sync", async () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  const poisoned = new Date("2026-08-09T13:00:00.000Z");

  notificationState = { fullBackfillVerifiedAt: poisoned, fullBackfillObservedAt: poisoned, headNotificationId: "poisoned-head" };
  let db = dbFixture({ financialReady: true, campaignReady: true });
  let step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "notifications");
  assert.equal(scheduled.at(-1).params.notificationMode, "full");
  assert.equal(scheduled.at(-1).params.collectionMode, "full");

  scheduled = [];
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z") , fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z")};
  db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorFinancialCollectionState.findUnique = async () => ({
    status: "COMPLETE", baselineVerifiedAt: poisoned, baselineObservedAt: poisoned, baselineGeneration: "financial-poisoned",
  });
  step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "financial");
  assert.equal(scheduled.at(-1).params.collectionMode, "full");

  scheduled = [];
  db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorCampaignCollectionState.findUnique = async () => ({
    status: "COMPLETE", baselineVerifiedAt: poisoned, baselineObservedAt: poisoned, baselineGeneration: "campaign-poisoned",
  });
  step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "campaigns");
  assert.equal(scheduled.at(-1).params.collectionMode, "full");
});

test("future-poisoned verified timestamps are DUE in planner exactly like the read evaluator", async () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  const poisoned = new Date("2026-08-09T13:00:00.000Z");
  notificationState = {
    status: "COMPLETE",
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupVerifiedAt: poisoned, lastCatchupObservedAt: poisoned,
    headNotificationId: "verified-head",
  };
  const db = dbFixture({
    financialReady: true, campaignReady: true,
    financialCatchupAt: poisoned, campaignCatchupAt: poisoned,
  });
  db.creatorFinancialTransaction = { async findMany() { return []; } };
  db.creatorCampaign = { async findMany() { return []; } };
  db.$queryRawUnsafe = rawQueryWithAuthorityNow([]);

  const result = await ensureRecurringCreatorAnalyticsCatchups({
    db, creatorId: "creator-1", agencyId: "agency-1", now,
  });

  assert.equal(result.ready, true);
  assert.equal(scheduled.some((row) => row.jobKey === "catchup_notifications_scan"), true);
  assert.equal(scheduled.some((row) => row.jobKey === "financial_transactions_scan"), true);
  assert.equal(scheduled.some((row) => row.jobKey === "fetch_campaigns"), true);
  assert.equal(result.skipped.includes("notifications_catchup:fresh"), false);
  assert.equal(result.skipped.includes("financial_catchup:fresh"), false);
  assert.equal(result.skipped.includes("campaigns_catchup:fresh"), false);
});
test("verified history also fences a legacy notification job with no explicit mode", async () => {
  notificationState = {
    fullBackfillCompletedAt: new Date("2026-08-08T10:00:00.000Z"),
    fullBackfillVerifiedAt: new Date("2026-08-08T10:01:00.000Z"), fullBackfillObservedAt: new Date("2026-08-08T10:01:00.000Z"),
    headNotificationId: "known-head",
  };
  const active = [{
    id: "legacy-no-mode-full",
    jobKey: "catchup_notifications_scan",
    status: "CLAIMED",
    params: { reason: "legacy_pre_mode_build" },
  }];
  const db = dbFixture({ financialReady: true, campaignReady: true, active });
  const step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z") });
  assert.equal(step.ready, true);
  assert.equal(active[0].status, "CANCELLED");
  assert.equal(active[0].lastError, "superseded_by_existing_notification_history");
});

test("failed catch-up does not erase durable baseline readiness", async () => {
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z") , fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z")};
  const db = dbFixture({
    financialReady: true,
    campaignReady: true,
    financialStatus: "FAILED",
    campaignStatus: "FAILED",
    financialRetryAfterAt: new Date("2026-08-09T13:00:00.000Z"),
    campaignRetryAfterAt: new Date("2026-08-09T13:00:00.000Z"),
  });
  const initial = await ensureInitialCreatorAnalyticsSync({
    db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.equal(initial.ready, true);
  assert.equal(initial.stage, "ready");
  assert.equal(scheduled.length, 0, "failed catch-up must never regress into full baseline collection");
});

test("recurring financial and campaign work respect durable retryAfterAt as DEFERRED", async () => {
  notificationState = {
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-09T11:59:00.000Z"),
    headNotificationId: "head",
  };
  const retryAt = new Date("2026-08-09T13:00:00.000Z");
  const db = dbFixture({
    financialReady: true,
    campaignReady: true,
    financialStatus: "FAILED",
    campaignStatus: "FAILED",
    financialCatchupAt: new Date("2026-08-01T00:00:00.000Z"),
    campaignCatchupAt: new Date("2026-08-01T00:00:00.000Z"),
    financialRetryAfterAt: retryAt,
    campaignRetryAfterAt: retryAt,
  });
  db.creatorFinancialTransaction = { async findMany() { throw new Error("financial frontier must not be read while deferred"); } };
  db.creatorCampaign = { async findMany() { throw new Error("campaign frontier must not be read while deferred"); } };

  const result = await ensureRecurringCreatorAnalyticsCatchups({
    db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.equal(result.ready, true);
  assert.ok(result.skipped.includes("financial_catchup:deferred"));
  assert.ok(result.skipped.includes("campaigns_catchup:deferred"));
  assert.equal(scheduled.some((row) => row.jobKey === "financial_transactions_scan"), false);
  assert.equal(scheduled.some((row) => row.jobKey === "fetch_campaigns"), false);
});

test("terminal collection failure without retryAt is quarantined from automatic recurring scheduling", async () => {
  notificationState = {
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-09T11:59:00.000Z"),
    lastCatchupVerifiedAt: new Date("2026-08-09T11:59:00.000Z"), lastCatchupObservedAt: new Date("2026-08-09T11:59:00.000Z"),
  };
  const db = dbFixture({
    financialReady: true,
    campaignReady: true,
    financialStatus: "FAILED",
    campaignStatus: "FAILED",
    financialCatchupAt: new Date("2026-08-01T00:00:00.000Z"),
    campaignCatchupAt: new Date("2026-08-01T00:00:00.000Z"),
  });
  db.creatorFinancialTransaction = { async findMany() { throw new Error("terminal financial state must not scan frontier"); } };
  db.creatorCampaign = { async findMany() { throw new Error("terminal campaign state must not scan frontier"); } };

  const result = await ensureRecurringCreatorAnalyticsCatchups({
    db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.ok(result.skipped.includes("financial_catchup:failed_terminal"));
  assert.ok(result.skipped.includes("campaigns_catchup:failed_terminal"));
  assert.equal(scheduled.length, 0);
});

test("notification durable retryAfterAt defers both initial and recurring collection instead of creating duplicate jobs", async () => {
  const retryAt = new Date("2026-08-09T13:00:00.000Z");
  notificationState = { status: "FAILED", retryAfterAt: retryAt };
  let db = dbFixture({ financialReady: true, campaignReady: true });
  let result = await ensureInitialCreatorAnalyticsSync({
    db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.equal(result.stage, "notifications");
  assert.equal(result.reason, "deferred");
  assert.equal(result.retryAfterAt.toISOString(), retryAt.toISOString());
  assert.equal(scheduled.length, 0);

  notificationState = {
    status: "FAILED", retryAfterAt: retryAt,
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-01T00:00:00.000Z"), headNotificationId: "head",
  };
  scheduled = [];
  db = dbFixture({ financialReady: true, campaignReady: true, financialCatchupAt: new Date("2026-08-09T11:59:00.000Z"), campaignCatchupAt: new Date("2026-08-09T11:59:00.000Z") });
  result = await ensureRecurringCreatorAnalyticsCatchups({
    db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.ok(result.skipped.includes("notifications_catchup:deferred"));
  assert.equal(scheduled.some((row) => row.jobKey === "catchup_notifications_scan"), false);
});

test("terminal notification failure without retryAt is quarantined from automatic initial and recurring scheduling", async () => {
  notificationState = { status: "FAILED", retryAfterAt: null };
  let db = dbFixture({ financialReady: true, campaignReady: true });
  let result = await ensureInitialCreatorAnalyticsSync({
    db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.equal(result.reason, "failed_terminal");
  assert.equal(scheduled.length, 0);

  notificationState = {
    status: "FAILED", retryAfterAt: null,
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"), fullBackfillObservedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
  };
  scheduled = [];
  db = dbFixture({ financialReady: true, campaignReady: true, financialCatchupAt: new Date("2026-08-09T11:59:00.000Z"), campaignCatchupAt: new Date("2026-08-09T11:59:00.000Z") });
  result = await ensureRecurringCreatorAnalyticsCatchups({
    db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z"),
  });
  assert.ok(result.skipped.includes("notifications_catchup:failed_terminal"));
  assert.equal(scheduled.some((row) => row.jobKey === "catchup_notifications_scan"), false);
});



test("collector planning reloads durable state under the collector lock before deriving epoch/order", async () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-09T10:00:00.000Z") , fullBackfillObservedAt: new Date("2026-08-09T10:00:00.000Z")};
  const db = dbFixture();
  let reads = 0;
  db.creatorFinancialCollectionState.findUnique = async () => {
    reads += 1;
    if (reads === 1) return null; // readiness says Financial still needs baseline
    if (reads === 2) return { activeGeneration: "prelock-generation", activeRequestedAt: new Date("2026-08-09T11:59:59.000Z") };
    return { activeGeneration: "locked-generation", activeRequestedAt: new Date("2026-08-09T12:00:00.500Z") };
  };
  scheduled = [];
  const step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "financial");
  assert.ok(reads >= 3, "planning must re-read collector state after entering the lock");
  assert.equal(scheduled.length, 1);
  assert.deepEqual(scheduled[0].dedupeParams, {
    planningEpoch: "locked-generation:none",
    collectionOrderingAfter: "2026-08-09T12:00:00.500Z",
    collectionContractVersion: 1,
    collectionType: "FINANCIAL",
    collectionMode: "full",
  });
});


for (const fanStatus of ["QUEUED", "PARTIAL"]) test(`FanData ${fanStatus} cannot block a due Campaign frontier`, async () => {
  const now = new Date("2026-10-04T12:00:00Z");
  notificationState = { fullBackfillVerifiedAt: now, fullBackfillObservedAt: now };
  const db = dbFixture({ financialReady: true, campaignReady: true, financialCatchupAt: now });
  const original = db.creatorCampaignCollectionState.findUnique;
  db.creatorCampaignCollectionState.findUnique = async () => ({ ...await original(),
    status: "PARTIAL", activeGeneration: "old", fanValueCoverageScanRunId: "old",
    fanValueExpected: 5, fanValueFreshnessStatus: fanStatus,
    fanValueOutstanding: fanStatus === "QUEUED" ? 5 : 0, fanValueFailed: fanStatus === "PARTIAL" ? 5 : 0,
  });
  const result = await ensureRecurringCreatorAnalyticsCatchups({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(result.ready, true);
  assert.equal(scheduled.filter(j => j.jobKey === "fetch_campaigns").length, 1);
  assert.equal(scheduled[0].params.collectionMode, "catchup");
});

for (const activeStatus of ["SCHEDULED", "CLAIMED", "PAUSED"]) test(`FanData independence retains ${activeStatus} provider exclusion`, async () => {
  const now = new Date("2026-10-04T12:00:00Z");
  notificationState = { fullBackfillVerifiedAt: now, fullBackfillObservedAt: now };
  const db = dbFixture({ financialReady: true, campaignReady: true, financialCatchupAt: now,
    active: [{id:"existing",jobKey:"fetch_campaigns",status:activeStatus}] });
  const result = await ensureRecurringCreatorAnalyticsCatchups({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert(result.skipped.includes("campaigns_catchup:already_in_flight"));
  assert.equal(scheduled.length, 0);
});

for (const status of ["SCANNING", "FAILED"]) test(`verified streams catch up while Campaign bootstrap is ${status}`, async () => {
  const now = new Date("2026-10-04T12:00:00Z"), old = new Date("2026-09-01T00:00:00Z");
  notificationState = { fullBackfillVerifiedAt: old, fullBackfillObservedAt: old };
  const db = dbFixture({ financialReady: true, campaignReady: false,
    active: status === "SCANNING" ? [{id:"bootstrap",jobKey:"fetch_campaigns",status:"CLAIMED"}] : [] });
  db.creatorCampaignCollectionState.findUnique = async () => ({ status, baselineVerifiedAt: null });
  const result = await ensureRecurringCreatorAnalyticsCatchups({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(result.ready, false);
  assert.deepEqual(scheduled.map(j => j.jobKey).sort(), ["catchup_notifications_scan", "financial_transactions_scan"]);
  assert(scheduled.every(j => j.params.collectionMode === "catchup"));
});

test("membership baseline advances bootstrap with FanData still pending", async () => {
  const now = new Date("2026-10-04T12:00:00Z");
  notificationState = { fullBackfillVerifiedAt: now, fullBackfillObservedAt: now };
  const db = dbFixture({ financialReady: true });
  db.creatorCampaignCollectionState.findUnique = async () => ({status:"PARTIAL", membershipBaselineVerifiedAt:now,
    membershipBaselineObservedAt:now, membershipBaselineGeneration:"member-proof", fanValueOutstanding:5});
  const result = await advanceCreatorAnalyticsInitialSyncAfterCompletion({db, now,
    job:{jobKey:"fetch_campaigns",creatorId:"creator-1",agencyId:"agency-1",params:{analyticsSyncKind:"initial",analyticsSyncVersion:1}},
    sideEffect:{ok:true,completion:{membershipComplete:true,providerTraversalComplete:true,complete:false}}});
  assert.equal(result.advanced,true); assert.equal(result.next.ready,true); assert.equal(scheduled.length,0);
});

test("provider exhaustion without complete membership cannot advance bootstrap", async () => {
  const result = await advanceCreatorAnalyticsInitialSyncAfterCompletion({db:dbFixture(),
    job:{jobKey:"fetch_campaigns",creatorId:"creator-1",agencyId:"agency-1",params:{analyticsSyncKind:"initial",analyticsSyncVersion:1}},
    sideEffect:{ok:true,completion:{membershipComplete:false,providerTraversalComplete:true,complete:false}}});
  assert.equal(result.advanced,false);assert.equal(result.reason,"campaigns_not_verified");assert.equal(scheduled.length,0);
});

test("recurring planning acquires Notifications, Financial, Campaigns before any stage write", async () => {
  const now=new Date("2026-10-04T12:00:00Z"), old=new Date("2026-09-01T00:00:00Z"), locks=[];
  notificationState={fullBackfillVerifiedAt:old,fullBackfillObservedAt:old};
  const db=dbFixture({financialReady:true,campaignReady:false});
  const check=()=>assert.deepEqual(locks.slice(0,3),["analytics-collector:notifications:creator-1","analytics-collector:financial:creator-1","analytics-collector:campaigns:creator-1"]);
  db.$executeRawUnsafe=async(sql,key)=>{if(sql.includes('pg_advisory_xact_lock'))locks.push(key);return 1;};
  db.$queryRawUnsafe=async()=>[{authorityNow:now}];
  db.$transaction=async work=>{const tx={...db};delete tx.$transaction;return work(tx);};
  const read=db.jobInstance.findFirst;db.jobInstance.findFirst=async arg=>{check();return read(arg);};
  await ensureRecurringCreatorAnalyticsCatchups({db,creatorId:"creator-1",agencyId:"agency-1",now});
  check();assert(scheduled.some(j=>j.jobKey==="fetch_campaigns"));assert(scheduled.some(j=>j.jobKey==="catchup_notifications_scan"));
});
