"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
function stub(name, exports) {
  const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub("../prisma", {});
stub("./job-scheduler", { scheduleJobNow() { throw new Error("unexpected second traversal"); } });
stub("./job-planning-repository", { async reschedulePlannedJob({ db, job, ...input }) {
  assert.deepEqual(input.continuation, job.continuation);
  assert.deepEqual(input.progress, job.progress);
  Object.assign(db.row, { status: "SCHEDULED" }); return { job: db.row };
} });
stub("./creator-analytics-ledger-service", { async readCampaignsWithRevenue() { return { items: [] }; } });
stub("./campaign-fan-refresh-queue-service", { CAMPAIGN_FAN_REFRESH_MAX_RETRIES: 5 });
stub("./notification-sync-state-service", {
  async loadNotificationSyncState(db) { return db.sync; },
  buildNotificationScanParams() { return {}; },
});
stub("./financial-transactions-service", {
  JOB_KEY: "financial_transactions_scan", SCHEMA_VERSION: 1, COLLECTOR_VERSION: "test",
  summarizeStatusGroups() { return { statusSummary: [] }; },
});
const creator = { id: "creator-a", agencyId: "agency-a" };
const now = new Date("2026-10-01T12:00:00Z");
const kinds = [
  ["campaign", "fetch_campaigns", "CAMPAIGNS", require("./campaign-scan-control-service"), "Campaign"],
  ["financial", "financial_transactions_scan", "FINANCIAL", require("./financial-transaction-scan-control-service"), "FinancialTransaction"],
  ["notification", "catchup_notifications_scan", "NOTIFICATIONS", require("./notification-scan-control-service"), "Notification"],
];
function fixture(jobKey, type, status = "CLAIMED") {
  const row = { id: "auto-job", creatorId: creator.id, agencyId: creator.agencyId, jobKey, status,
    leaseRevision: 7, claimedByDeviceId: "device-a", lastProgressAt: now,
    params: { collectionContractVersion: 1, collectionType: type, collectionMode: "full",
      collectionGeneration: "run-a", collectionRequestedAt: now.toISOString(), notificationMode: "full" },
    continuation: { schemaVersion: 8, page: 37 }, progress: { current: 37, message: "page 37" },
  };
  const db = { row, sync: null, released: [], updates: [],
    jobInstance: {
      async findMany({ where }) {
        assert.equal(where.creatorId, creator.id); assert.equal(where.jobKey, jobKey);
        return !where.status || where.status.in.includes(row.status) ? [{ ...row }] : [];
      },
      async findUnique() { return { ...row }; },
      async updateMany({ where, data }) {
        db.updates.push(where);
        if (db.beforeUpdate) db.beforeUpdate();
        if (!where.status.in.includes(row.status) || (where.leaseRevision !== undefined && where.leaseRevision !== row.leaseRevision)) return { count: 0 };
        const revision = row.leaseRevision + (data.leaseRevision?.increment || 0);
        Object.assign(row, data, { leaseRevision: revision }); return { count: 1 };
      },
    },
    fanObservationReadLease: { async deleteMany({ where }) { db.released.push(where); return { count: 1 }; } },
    deviceCreatorBinding: { async count() { return 1; } },
    creatorFinancialTransaction: { async findMany() { return []; }, async count() { return 0; }, async aggregate() { return {}; }, async groupBy() { return []; } },
    creatorEarningsTotal: { async findMany() { return []; } },
  };
  return db;
}
for (const [name, key, type, api, suffix] of kinds) {
  test(`${name}: START adoption, status, STOP and resume use the same automatic collector`, async () => {
    const db = fixture(key, type);
    const start = await api[`startManual${suffix}Scan`]({ db, creator, now });
    assert.equal(start.action, "already_running"); assert.equal(start.job.id, db.row.id);
    const state = await api[`readManual${suffix}Scan`]({ db, creator });
    assert.equal(state.jobId, db.row.id); assert.equal(state.status, "RUNNING"); assert.equal(state.manual, false);
    const paused = await api[`stopManual${suffix}Scan`]({ db, creatorId: creator.id, now });
    assert.equal(paused.action, "paused"); assert.equal(db.row.status, "PAUSED"); assert.equal(db.row.leaseRevision, 8);
    assert.equal(db.updates[0].leaseRevision, 7);
    assert.deepEqual(db.released, [{ creatorId: creator.id, jobId: "auto-job", deviceId: "device-a", leaseRevision: 7 }]);
    assert.equal(db.row.continuation.page, 37); assert.equal(db.row.progress.current, 37);
    assert.equal((await api[`readManual${suffix}Scan`]({ db, creator })).status, "PAUSED");
    assert.equal((await api[`startManual${suffix}Scan`]({ db, creator, now })).action, "resumed");
  });
  test(`${name}: STOP does not mutate a new lease that won after its read`, async () => {
    const db = fixture(key, type);
    db.beforeUpdate = () => { db.row.leaseRevision++; db.row.claimedByDeviceId = "device-b"; };
    const stopped = await api[`stopManual${suffix}Scan`]({ db, creatorId: creator.id, now });
    assert.equal(stopped.action, "changed"); assert.equal(db.row.status, "CLAIMED");
    assert.equal(db.row.claimedByDeviceId, "device-b"); assert.equal(db.released.length, 0);
  });
  test(`${name}: accepted publication remains server-owned on STOP`, async () => {
    const db = fixture(key, type, "PUBLISHING");
    const stopped = await api[`stopManual${suffix}Scan`]({ db, creatorId: creator.id, now });
    assert.equal(stopped.action, "publishing"); assert.equal(db.updates.length, 0);
  });
}
