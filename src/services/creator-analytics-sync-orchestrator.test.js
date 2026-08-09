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
  buildNotificationScanParams({ state, reason, analyticsRangeKey }) {
    return {
      from: "2016-01-01T00:00:00.000Z",
      to: "2026-08-09T12:00:00.000Z",
      types: ["purchases", "tips", "subscriptions", "likes", "comments"],
      notificationMode: state?.fullBackfillVerifiedAt || state?.fullBackfillCompletedAt ? "catchup" : "full",
      pageLimit: 10,
      reason,
      analyticsRangeKey,
      ...(state?.headNotificationId ? { stopAtNotificationId: state.headNotificationId } : {}),
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

function dbFixture({ financialReady = false, campaignReady = false, active = [] } = {}) {
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
      async findUnique({ where }) {
        if (financialReady && where.id === "financial-full-job") return { status: "DONE", params: { financialMode: "full" } };
        return null;
      },
    },
    creatorEarningsTotal: {
      async findUnique() {
        return financialReady ? { sourceJobId: "financial-full-job", scanRunId: "scan-full", rangeFrom: new Date("2016-01-01T00:00:00.000Z") } : null;
      },
    },
    analyticsCoverage: {
      async findFirst() { return campaignReady ? { id: "coverage-campaigns" } : null; },
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

  scheduled = [];
  notificationState = { fullBackfillVerifiedAt: new Date("2026-08-09T10:00:00.000Z") };
  db = dbFixture({ financialReady: false });
  step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "financial");
  assert.equal(scheduled.at(-1).jobKey, "financial_transactions_scan");
  assert.equal(scheduled.at(-1).params.financialMode, "full");
  assert.equal(scheduled.at(-1).params.analyticsSyncStage, "financial");

  scheduled = [];
  db = dbFixture({ financialReady: true, campaignReady: false });
  step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now });
  assert.equal(step.stage, "campaigns");
  assert.equal(scheduled.at(-1).jobKey, "fetch_campaigns");
  assert.equal(scheduled.at(-1).params.campaignMode, "full");
  assert.equal(scheduled.at(-1).params.analyticsSyncStage, "campaigns");

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

test("a completed historical notification traversal is adopted and redundant automatic full work is fenced", async () => {
  notificationState = {
    fullBackfillCompletedAt: new Date("2026-08-08T10:00:00.000Z"),
    fullBackfillVerifiedAt: null,
    headNotificationId: "known-head",
  };
  const active = [{
    id: "legacy-auto-full",
    jobKey: "catchup_notifications_scan",
    status: "CLAIMED",
    params: { notificationMode: "full", reason: "automatic_old_build" },
  }];
  const db = dbFixture({ financialReady: true, campaignReady: true, active });
  const step = await ensureInitialCreatorAnalyticsSync({ db, creatorId: "creator-1", agencyId: "agency-1", now: new Date("2026-08-09T12:00:00.000Z") });
  assert.equal(step.ready, true);
  assert.equal(active[0].status, "CANCELLED");
  assert.equal(active[0].lastError, "superseded_by_existing_notification_history");
  assert.equal(scheduled.length, 0);
});

test("completed history also fences a legacy manual FULL that has no explicit force marker", async () => {
  notificationState = {
    fullBackfillCompletedAt: new Date("2026-08-08T10:00:00.000Z"),
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
    headNotificationId: "notification-head",
  };
  const db = dbFixture({ financialReady: true, campaignReady: true });
  db.creatorNotificationScanItem = {
    async findMany() { return [{ notificationId: "n-3" }, { notificationId: "n-2" }, { notificationId: "n-1" }]; },
  };
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
  assert.equal(campaigns.campaignMode, "catchup");
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

test("completed history also fences a legacy notification job with no explicit mode", async () => {
  notificationState = {
    fullBackfillCompletedAt: new Date("2026-08-08T10:00:00.000Z"),
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
