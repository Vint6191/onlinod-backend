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
  campaignCatchupState,
  advanceCreatorAnalyticsInitialSyncAfterCompletion,
} = require("./creator-analytics-sync-orchestrator");

function dbFixture({
  financialReady = false, campaignReady = false, active = [], financialCatchupAt = null, campaignCatchupAt = null,
  financialStatus = "COMPLETE", campaignStatus = "COMPLETE", financialRetryAfterAt = null, campaignRetryAfterAt = null,
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
          status: financialStatus,
          baselineVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
          baselineGeneration: "financial-baseline-generation",
          lastCatchupCompletedAt: financialCatchupAt,
          retryAfterAt: financialRetryAfterAt,
        } : null;
      },
    },
    creatorCampaignCollectionState: {
      async findUnique() {
        return campaignReady ? {
          status: campaignStatus,
          baselineVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
          baselineGeneration: "campaign-baseline-generation",
          lastCatchupCompletedAt: campaignCatchupAt,
          retryAfterAt: campaignRetryAfterAt,
        } : null;
      },
    },
  };
}

test.beforeEach(() => {
  scheduled = [];
  notificationState = null;
});

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
    collectionContractVersion: 1,
    collectionType: "NOTIFICATIONS",
    collectionMode: "full",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(scheduled.at(-1).dedupeParams, "collectionGeneration"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(scheduled.at(-1).dedupeParams, "collectionRequestedAt"), false);
  assert.equal(scheduled.at(-1).db, db);

  scheduled = [];
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-09T10:00:00.000Z") };
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
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-09T10:00:00.000Z") };
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
    fullBackfillVerifiedAt: null,
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
    fullBackfillVerifiedAt: new Date("2026-08-08T10:01:00.000Z"),
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
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-08T10:00:00.000Z") };
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

test("campaign catch-up compares OF stats against actual stored memberships and keeps per-campaign known frontiers", async () => {
  const db = {
    creatorCampaign: {
      async findMany() {
        return [
          { id: "db-a", externalCampaignId: "campaign-a", _count: { fans: 72 } },
          { id: "db-b", externalCampaignId: "campaign-b", _count: { fans: 4 } },
        ];
      },
    },
    async $queryRawUnsafe() {
      return [
        { externalCampaignId: "campaign-a", onlyFansUserId: "fan-72" },
        { externalCampaignId: "campaign-a", onlyFansUserId: "fan-71" },
        { externalCampaignId: "campaign-b", onlyFansUserId: "fan-b4" },
      ];
    },
    creatorFanValueCurrent: {
      async findMany() {
        return [
          { fan: { onlyFansUserId: "fan-72" } },
          { fan: { onlyFansUserId: "fan-b4" } },
        ];
      },
    },
  };
  const state = await campaignCatchupState(db, "creator-1");
  assert.deepEqual(state.knownCampaignFanCounts, { "campaign-a": 72, "campaign-b": 4 });
  assert.deepEqual(state.knownClaimersByCampaign["campaign-a"], ["fan-72", "fan-71"]);
  assert.deepEqual(state.knownClaimersByCampaign["campaign-b"], ["fan-b4"]);
});

test("recurring analytics uses fixed head catch-ups only after initial history is ready", async () => {
  notificationState = {
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    headNotificationId: "notification-head",
    knownNotificationIds: ["n-3", "n-2", "n-1"],
  };
  const db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorFinancialTransaction = {
    async findMany() { return [{ externalTransactionId: "t-3" }, { externalTransactionId: "t-2" }]; },
  };
  db.creatorCampaign = {
    async findMany() { return [{ id: "db-a", externalCampaignId: "campaign-a", _count: { fans: 72 } }]; },
  };
  db.$queryRawUnsafe = async () => [{ externalCampaignId: "campaign-a", onlyFansUserId: "fan-72" }];

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
  assert.deepEqual(financial.knownTransactionIds, ["t-3", "t-2"]);
  assert.equal(financial.collectionType, "FINANCIAL");
  assert.equal(financial.collectionRequestedAt, "2026-08-09T12:00:00.000Z");
  assert.ok(financial.collectionGeneration);
  assert.equal(campaigns.campaignMode, "catchup");
  assert.equal(campaigns.collectionType, "CAMPAIGNS");
  assert.equal(campaigns.collectionRequestedAt, "2026-08-09T12:00:00.000Z");
  assert.ok(campaigns.collectionGeneration);
  assert.deepEqual(campaigns.knownCampaignFanCounts, { "campaign-a": 72 });
  assert.deepEqual(campaigns.knownClaimersByCampaign, { "campaign-a": ["fan-72"] });
  assert.equal(JSON.stringify(campaigns).includes("HOT"), false);
  assert.equal(JSON.stringify(campaigns).includes("WARM"), false);
  assert.equal(JSON.stringify(campaigns).includes("COLD"), false);
});



test("a freshly completed notification catch-up cannot be immediately scheduled again", async () => {
  notificationState = {
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-09T11:58:00.000Z"),
    lastCatchupVerifiedAt: new Date("2026-08-09T11:58:00.000Z"),
    headNotificationId: "fresh-head",
  };
  const db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorNotificationScanItem = { async findMany() { return [{ notificationId: "fresh-head" }]; } };
  db.creatorFinancialTransaction = { async findMany() { return []; } };
  db.creatorCampaign = { async findMany() { return []; } };
  db.$queryRawUnsafe = async () => [];

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
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-09T11:59:30.000Z"),
    lastCatchupVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    headNotificationId: "verified-old-head",
  };
  const db = dbFixture({
    financialReady: true, campaignReady: true,
    financialCatchupAt: new Date("2026-08-09T11:59:00.000Z"),
    campaignCatchupAt: new Date("2026-08-09T11:59:00.000Z"),
  });
  db.creatorFinancialTransaction = { async findMany() { return []; } };
  db.creatorCampaign = { async findMany() { return []; } };
  db.$queryRawUnsafe = async () => [];

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

  notificationState = { fullBackfillVerifiedAt: poisoned, headNotificationId: "poisoned-head" };
  let db = dbFixture({ financialReady: true, campaignReady: true });
  let step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "notifications");
  assert.equal(scheduled.at(-1).params.notificationMode, "full");
  assert.equal(scheduled.at(-1).params.collectionMode, "full");

  scheduled = [];
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z") };
  db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorFinancialCollectionState.findUnique = async () => ({
    status: "COMPLETE", baselineVerifiedAt: poisoned, baselineGeneration: "financial-poisoned",
  });
  step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "financial");
  assert.equal(scheduled.at(-1).params.collectionMode, "full");

  scheduled = [];
  db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorCampaignCollectionState.findUnique = async () => ({
    status: "COMPLETE", baselineVerifiedAt: poisoned, baselineGeneration: "campaign-poisoned",
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
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupVerifiedAt: poisoned,
    headNotificationId: "verified-head",
  };
  const db = dbFixture({
    financialReady: true, campaignReady: true,
    financialCatchupAt: poisoned, campaignCatchupAt: poisoned,
  });
  db.creatorFinancialTransaction = { async findMany() { return []; } };
  db.creatorCampaign = { async findMany() { return []; } };
  db.$queryRawUnsafe = async () => [];

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
    fullBackfillVerifiedAt: new Date("2026-08-08T10:01:00.000Z"),
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
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z") };
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
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
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
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-08-09T11:59:00.000Z"),
    lastCatchupVerifiedAt: new Date("2026-08-09T11:59:00.000Z"),
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
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
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
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
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

