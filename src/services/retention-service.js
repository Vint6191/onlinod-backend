/* src/services/retention-service.js
   Compact retention/GC sweeps for high-volume analytics tables.

   Production rule:
   - never store raw OF payloads as a retention strategy;
   - keep normalized facts long enough for audit;
   - aggressively remove intermediate realtime state and zero/free organic noise;
   - allow SUPER_ADMIN to tune retention in Admin → System without redeploy.
*/
"use strict";

const { randomUUID } = require("node:crypto");
const prisma = require("../prisma");
const { gcTeamLedgers } = require("./team-ppv-ledger-service");
const { purgeExpiredTipLedger } = require("./team-tip-ledger-service");
const { compactAutomationDeliveries } = require("./automation-history-service");
const { withDbAdvisoryXactLock, runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { runMaintenanceLane } = require("./maintenance-work-authority");
const { FAMILY: PHASE2_COVERAGE_FAMILY, GENERATION: PHASE2_COVERAGE_GENERATION, phase2CoverageStatus } = require("./phase2-work-coverage-authority-service");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 2000;
const RETENTION_SETTING_KEY = "retention.policy.v1";
// Retention is destructive cluster work. A short transaction-level advisory
// lock serializes lease claim only; the long-running sweep itself is owned by
// this durable DB lease, so Prisma pool connection identity is irrelevant.
const RETENTION_LEASE_KEY = "global_retention_v1";
const RETENTION_COORDINATION_LOCK_KEY = "retention-sweep-coordinator";
const RETENTION_LEASE_MS = 2 * 60 * 60 * 1000;
const RETENTION_HEARTBEAT_MS = 10 * 60 * 1000;
const TEAM_PROVIDER_CORRECTION_HORIZON_DAYS = 366;
const TEAM_PROJECTION_RETENTION_LANE_KEY = "team_projection_retention_v1";
const TEAM_PROJECTION_RETENTION_GENERATION = "team_projection_retention_v1";
const TEAM_PROJECTION_RETENTION_AGENCIES_PER_BATCH = 10;


const RETENTION_FIELDS = Object.freeze({
  retentionSweepWindowHours: {
    label: "Retention sweep interval",
    unit: "hours",
    env: "ONLINOD_RETENTION_SWEEP_WINDOW_HOURS",
    fallback: 24,
    min: 1,
    max: 168,
    hint: "How often recurring scheduler may run retention cleanup.",
  },
  batchSize: {
    label: "Delete batch size",
    unit: "rows",
    env: "ONLINOD_RETENTION_BATCH_SIZE",
    fallback: DEFAULT_BATCH_SIZE,
    min: 100,
    max: 10000,
    hint: "Rows deleted per batch. Larger is faster but locks longer.",
  },

  teamIntermediateDays: {
    label: "Team intermediate events",
    unit: "days",
    env: "ONLINOD_TEAM_ACTIVITY_INTERMEDIATE_DAYS",
    fallback: 7,
    min: 1,
    max: 365,
    hint: "dialog_unread_seen / fan_message_seen_active.",
  },
  teamSessionDays: {
    label: "Team dialog sessions",
    unit: "days",
    env: "ONLINOD_TEAM_ACTIVITY_SESSION_DAYS",
    fallback: 30,
    min: 1,
    max: 365,
    hint: "dialog_session realtime session rows.",
  },
  teamNoticeDays: {
    label: "Team claim notices",
    unit: "days",
    env: "ONLINOD_TEAM_ACTIVITY_NOTICE_DAYS",
    fallback: 90,
    min: 1,
    max: 730,
    hint: "ppv_claim_resolution_notice rows.",
  },
  teamAuditDays: {
    label: "Team audit/financial events",
    unit: "days",
    env: "ONLINOD_TEAM_ACTIVITY_AUDIT_DAYS",
    fallback: 365,
    min: 30,
    max: 3650,
    hint: "sent, ppv purchase, unanswered/incoming attribution rows.",
  },
  teamCanonicalDetailDays: {
    label: "Team canonical raw detail",
    unit: "days",
    env: "ONLINOD_TEAM_CANONICAL_DETAIL_DAYS",
    fallback: 180,
    min: 30,
    max: 730,
    hint: "Canonical Team-v13 raw events plus exact response/dialog/coverage projections. Older exact detail is removed only when product coverage can state the retained boundary.",
  },
  teamMoneyRawDetailDays: {
    label: "Team money raw attribution detail",
    unit: "days",
    env: "ONLINOD_TEAM_MONEY_RAW_DETAIL_DAYS",
    fallback: 180,
    min: 30,
    max: 730,
    hint: "PPV/Tip mutable attribution ledgers after durable TeamMoneyAttributionFact projection.",
  },

  automationDeliveryDetailedDays: {
    label: "Automation detailed delivery history",
    unit: "days",
    env: "ONLINOD_AUTOMATION_DELIVERY_DETAILED_DAYS",
    fallback: 90,
    min: 7,
    max: 3650,
    hint: "Terminal write deliveries are compacted into monthly aggregates after this period.",
  },
  automationAggregateDays: {
    label: "Automation monthly aggregates",
    unit: "days",
    env: "ONLINOD_AUTOMATION_AGGREGATE_DAYS",
    fallback: 1095,
    min: 365,
    max: 3650,
    hint: "Retention for compact monthly Automation metrics.",
  },

  analyticsIngestBatchDays: {
    label: "Analytics ingest execution history",
    unit: "days",
    env: "ONLINOD_ANALYTICS_INGEST_BATCH_DAYS",
    fallback: 30,
    min: 7,
    max: 3650,
    hint: "Earnings page/completion batches after durable AnalyticsScanProof exists.",
  },
  analyticsJobInstanceDays: {
    label: "Analytics completed job history",
    unit: "days",
    env: "ONLINOD_ANALYTICS_JOB_INSTANCE_DAYS",
    fallback: 30,
    min: 7,
    max: 3650,
    hint: "Terminal fetch_earnings JobInstance rows after durable proof exists.",
  },
  analyticsDemandHistoryDays: {
    label: "Analytics collection demand history",
    unit: "days",
    env: "ONLINOD_ANALYTICS_DEMAND_HISTORY_DAYS",
    fallback: 90,
    min: 7,
    max: 3650,
    hint: "Completed and quarantined AnalyticsCollectionDemand control-plane history after the durable outcome no longer needs active retry.",
  },
  analyticsSupersededScanProofDays: {
    label: "Analytics superseded durable proofs",
    unit: "days",
    env: "ONLINOD_ANALYTICS_SUPERSEDED_SCAN_PROOF_DAYS",
    fallback: 30,
    min: 7,
    max: 3650,
    hint: "Old AnalyticsScanProof rows are removed only after no canonical earnings or coverage row references them.",
  },
  analyticsNonEarningsJobDays: {
    label: "Analytics non-earnings job history",
    unit: "days",
    env: "ONLINOD_ANALYTICS_NON_EARNINGS_JOB_DAYS",
    fallback: 30,
    min: 7,
    max: 3650,
    hint: "Terminal notification/financial/campaign JobInstance rows after durable collector state exists.",
  },
  analyticsNonEarningsIngestBatchDays: {
    label: "Analytics non-earnings ingest history",
    unit: "days",
    env: "ONLINOD_ANALYTICS_NON_EARNINGS_INGEST_DAYS",
    fallback: 30,
    min: 7,
    max: 3650,
    hint: "Operational notification/financial/campaign ingest batches after durable collector state exists.",
  },
  analyticsNotificationScanAuditDays: {
    label: "Notification scan audit history",
    unit: "days",
    env: "ONLINOD_ANALYTICS_NOTIFICATION_SCAN_AUDIT_DAYS",
    fallback: 30,
    min: 7,
    max: 3650,
    hint: "Per-page notification scan audit rows; current catch-up frontier lives in CreatorNotificationSyncState.",
  },

  automationJobDoneDays: {
    label: "Automation completed jobs",
    unit: "days",
    env: "ONLINOD_AUTOMATION_JOB_DONE_DAYS",
    fallback: 30,
    min: 1,
    max: 3650,
    hint: "Done/failed/canceled/expired AutomationJob rows.",
  },
  automationEventDays: {
    label: "Automation audit events",
    unit: "days",
    env: "ONLINOD_AUTOMATION_EVENT_DAYS",
    fallback: 90,
    min: 1,
    max: 3650,
    hint: "Compact AutomationEvent audit rows. No raw payload is stored.",
  },
  automationTaskTrashDays: {
    label: "Trashed automation tasks",
    unit: "days",
    env: "ONLINOD_AUTOMATION_TASK_TRASH_DAYS",
    fallback: 30,
    min: 1,
    max: 3650,
    hint: "Hard-delete soft-deleted AutomationTask rows after this many days.",
  },
  auditLogDays: {
    label: "Audit logs",
    unit: "days",
    env: "ONLINOD_AUDIT_LOG_DAYS",
    fallback: 365,
    min: 30,
    max: 3650,
    hint: "AuditLog and AdminActionLog retention. Keep long for investigations.",
  },

  dialogScanChunkDays: {
    label: "Dialog scan chunk commits",
    unit: "days",
    env: "ONLINOD_DIALOG_SCAN_CHUNK_DAYS",
    fallback: 30,
    min: 1,
    max: 365,
    hint: "Technical idempotency/progress commits only; normalized Dialog Ledger is retained.",
  },
  dialogScanRunDays: {
    label: "Dialog scan run history",
    unit: "days",
    env: "ONLINOD_DIALOG_SCAN_RUN_DAYS",
    fallback: 180,
    min: 7,
    max: 3650,
    hint: "Terminal run metadata only; messages, purchases and aggregates are retained.",
  },

  trafficSourceMemberNoRevenueDays: {
    label: "Dead source members without revenue",
    unit: "days",
    env: "ONLINOD_TRAFFIC_SOURCE_MEMBER_NO_REVENUE_DAYS",
    fallback: 730,
    min: 30,
    max: 3650,
    hint: "Deletes source members only if no paid revenue exists and no refresh is pending.",
  },
  trafficZeroSnapshotDays: {
    label: "Zero orphan fan value snapshots",
    unit: "days",
    env: "ONLINOD_TRAFFIC_ZERO_SNAPSHOT_DAYS",
    fallback: 180,
    min: 7,
    max: 3650,
    hint: "Deletes zero-value snapshots that are not tied to a source member or ledger.",
  },
  trafficDailyAggregateDays: {
    label: "Traffic daily aggregates",
    unit: "days",
    env: "ONLINOD_TRAFFIC_DAILY_AGGREGATE_DAYS",
    fallback: 1095,
    min: 365,
    max: 3650,
    hint: "Old traffic daily aggregate rows. Keep long by default.",
  },
  trafficPaidOrganicLedgerDays: {
    label: "Paid organic subscription ledger",
    unit: "days",
    env: "ONLINOD_TRAFFIC_PAID_ORGANIC_LEDGER_DAYS",
    fallback: 730,
    min: 0,
    max: 3650,
    hint: "0 = keep paid organic ledger forever.",
  },
  trafficFreeOrganicCleanupHours: {
    label: "Free organic noise cleanup delay",
    unit: "hours",
    env: "ONLINOD_TRAFFIC_FREE_ORGANIC_CLEANUP_HOURS",
    fallback: 24,
    min: 1,
    max: 720,
    hint: "Free/zero rows are removed only after safe attribution confirmation.",
  },
});

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function clampInt(value, spec) {
  const fallback = Number(spec?.fallback || 0);
  const n = Number(value);
  const rounded = Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.max(spec.min, Math.min(spec.max, rounded));
}

function defaultRetentionSettings() {
  const out = {};
  for (const [key, spec] of Object.entries(RETENTION_FIELDS)) {
    out[key] = clampInt(envInt(spec.env, spec.fallback), spec);
  }
  return out;
}

function normalizeRetentionSettings(value = {}, base = defaultRetentionSettings()) {
  const incoming = value && typeof value === "object" ? value : {};
  const out = { ...base };
  for (const [key, spec] of Object.entries(RETENTION_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      out[key] = clampInt(incoming[key], spec);
    } else {
      out[key] = clampInt(out[key], spec);
    }
  }
  return out;
}

function retentionSchema() {
  return Object.fromEntries(Object.entries(RETENTION_FIELDS).map(([key, spec]) => [key, { ...spec }]));
}

async function getRetentionSettings({ db = prisma } = {}) {
  const defaults = defaultRetentionSettings();
  let row = null;
  try {
    row = await db.systemSetting.findUnique({ where: { key: RETENTION_SETTING_KEY } });
  } catch (err) {
    // If migrations were not deployed yet, fall back to env defaults so normal
    // app startup does not hard crash. Admin page will surface the DB error.
    if (/SystemSetting/i.test(String(err?.message || err))) {
      return { ok: false, source: "env", settings: defaults, defaults, schema: retentionSchema(), error: err?.message || String(err) };
    }
    throw err;
  }
  const settings = normalizeRetentionSettings(row?.value || {}, defaults);
  return {
    ok: true,
    key: RETENTION_SETTING_KEY,
    source: row ? "db" : "env",
    settings,
    defaults,
    schema: retentionSchema(),
    updatedAt: row?.updatedAt || null,
    updatedByAdminId: row?.updatedByAdminId || null,
  };
}

async function updateRetentionSettings({ settings, adminId = null }) {
  const current = await getRetentionSettings();
  const merged = normalizeRetentionSettings(settings || {}, current.settings || defaultRetentionSettings());
  const row = await prisma.systemSetting.upsert({
    where: { key: RETENTION_SETTING_KEY },
    create: { key: RETENTION_SETTING_KEY, value: merged, updatedByAdminId: adminId || null },
    update: { value: merged, updatedByAdminId: adminId || null },
  });
  return { ok: true, key: RETENTION_SETTING_KEY, source: "db", settings: merged, defaults: current.defaults, schema: retentionSchema(), updatedAt: row.updatedAt, updatedByAdminId: row.updatedByAdminId };
}

async function resetRetentionSettings({ adminId = null } = {}) {
  await prisma.systemSetting.deleteMany({ where: { key: RETENTION_SETTING_KEY } });
  const current = await getRetentionSettings();
  return { ...current, reset: true, resetByAdminId: adminId || null };
}

async function resolveSweepConfig(overrides = {}) {
  const current = await getRetentionSettings();
  return normalizeRetentionSettings({ ...(current.settings || {}), ...(overrides || {}) }, current.settings || defaultRetentionSettings());
}

async function claimRetentionSweepLease({
  db = prisma,
  ownerToken = randomUUID(),
  fallbackNow = new Date(),
  leaseMs = RETENTION_LEASE_MS,
  minIntervalMs = 0,
} = {}) {
  return withDbAdvisoryXactLock({
    db,
    key: RETENTION_COORDINATION_LOCK_KEY,
    work: async (tx) => {
      if (!tx?.retentionSweepLease?.findUnique || !tx?.retentionSweepLease?.upsert) {
        const error = new Error("RETENTION_COORDINATION_SCHEMA_UNAVAILABLE");
        error.code = "RETENTION_COORDINATION_SCHEMA_UNAVAILABLE";
        throw error;
      }
      const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
      const existing = await tx.retentionSweepLease.findUnique({ where: { key: RETENTION_LEASE_KEY } });
      const completedAt = existing?.completedAt instanceof Date ? existing.completedAt : existing?.completedAt ? new Date(existing.completedAt) : null;
      const minimumInterval = Math.max(0, Number(minIntervalMs) || 0);
      if (
        existing && completedAt && Number.isFinite(completedAt.getTime())
        && String(existing.lastOutcome || "").toUpperCase() === "COMPLETE"
        && minimumInterval > 0
        && completedAt.getTime() + minimumInterval > authorityNow.getTime()
      ) {
        return {
          acquired: false,
          reason: "recently_completed",
          ownerToken: existing.ownerToken,
          completedAt,
          nextDueAt: new Date(completedAt.getTime() + minimumInterval),
        };
      }
      if (existing && !existing.completedAt) {
        const until = existing.leaseUntil instanceof Date ? existing.leaseUntil : new Date(existing.leaseUntil);
        if (Number.isFinite(until.getTime()) && until > authorityNow) {
          return { acquired: false, reason: "lease_held", ownerToken: existing.ownerToken, leaseUntil: until };
        }
      }
      const leaseUntil = new Date(authorityNow.getTime() + Math.max(60_000, Number(leaseMs) || RETENTION_LEASE_MS));
      const row = await tx.retentionSweepLease.upsert({
        where: { key: RETENTION_LEASE_KEY },
        create: {
          key: RETENTION_LEASE_KEY, ownerToken, leaseUntil, startedAt: authorityNow,
          completedAt: null, lastOutcome: "RUNNING", lastError: null,
        },
        update: {
          ownerToken, leaseUntil, startedAt: authorityNow,
          completedAt: null, lastOutcome: "RUNNING", lastError: null,
        },
      });
      return { acquired: true, reason: existing ? "lease_recovered_or_reclaimed" : "lease_created", ownerToken, leaseUntil, startedAt: row.startedAt || authorityNow };
    },
  });
}

async function renewRetentionSweepLease({ db = prisma, ownerToken, fallbackNow = new Date(), leaseMs = RETENTION_LEASE_MS } = {}) {
  if (!ownerToken) return false;
  return runDbTransaction(db, async (tx) => {
    if (!tx?.retentionSweepLease?.updateMany) return false;
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const leaseUntil = new Date(authorityNow.getTime() + Math.max(60_000, Number(leaseMs) || RETENTION_LEASE_MS));
    const result = await tx.retentionSweepLease.updateMany({
      where: { key: RETENTION_LEASE_KEY, ownerToken, completedAt: null },
      data: { leaseUntil, lastOutcome: "RUNNING" },
    });
    if (Number(result?.count || 0) !== 1) {
      const error = new Error("RETENTION_COORDINATION_OWNERSHIP_LOST");
      error.code = "RETENTION_COORDINATION_OWNERSHIP_LOST";
      throw error;
    }
    return { renewed: true, authorityNow, leaseUntil };
  });
}

async function finalizeRetentionSweepLease({ db = prisma, ownerToken, outcome, error = null, fallbackNow = new Date() } = {}) {
  if (!ownerToken) return false;
  return runDbTransaction(db, async (tx) => {
    if (!tx?.retentionSweepLease?.updateMany) return false;
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const result = await tx.retentionSweepLease.updateMany({
      where: { key: RETENTION_LEASE_KEY, ownerToken, completedAt: null },
      data: {
        leaseUntil: authorityNow,
        completedAt: authorityNow,
        lastOutcome: String(outcome || "UNKNOWN").slice(0, 80),
        lastError: error ? String(error?.message || error).slice(0, 2000) : null,
      },
    });
    return Number(result?.count || 0) === 1;
  });
}

function sweepNow(options = {}) {
  const value = options?.authorityNow ?? options?.now ?? new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function daysAgo(days, now = new Date()) {
  const base = now instanceof Date ? now : new Date(now);
  return new Date(base.getTime() - Math.max(0, Number(days) || 0) * DAY_MS);
}

async function deleteByIdsInBatches({ model, where, orderBy, batchSize, label, maxBatches = null }) {
  let total = 0;
  let batches = 0;
  let hasMore = false;
  const finiteMax = maxBatches == null ? null : Math.max(1, Math.floor(Number(maxBatches) || 1));
  for (;;) {
    const rows = await model.findMany({
      where,
      select: { id: true },
      orderBy: orderBy || { id: "asc" },
      take: batchSize,
    });
    if (!rows.length) break;

    const result = await model.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    total += result?.count || rows.length;
    batches += 1;

    if (rows.length < batchSize) break;
    if (finiteMax != null && batches >= finiteMax) { hasMore = true; break; }
  }
  return { label, deleted: total, batches, hasMore };
}

function maxDate(a, b) {
  const left = a instanceof Date ? a : a ? new Date(a) : null;
  const right = b instanceof Date ? b : b ? new Date(b) : null;
  if (!left || !Number.isFinite(left.getTime())) return right;
  if (!right || !Number.isFinite(right.getTime())) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

async function compactTeamProjectionAuthorityForAgency({ db = prisma, agencyId, cutoff, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (!agencyId || !(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
    throw new Error("TEAM_PROJECTION_RETENTION_IDENTITY_REQUIRED");
  }
  const coverage = await phase2CoverageStatus({
    db,
    agencyId,
    family: PHASE2_COVERAGE_FAMILY.TEAM_RESPONSE_RANGE_REPAIR,
    generation: PHASE2_COVERAGE_GENERATION.TEAM_RESPONSE_RANGE_REPAIR,
  });
  if (coverage.currentReady !== true) {
    return { agencyId, skipped: true, reason: "response_repair_coverage_incomplete", deleted: 0, hasMore: false, watermarkAdvanced: false };
  }

  const limit = Math.max(1, Math.min(10_000, Math.floor(Number(batchSize) || DEFAULT_BATCH_SIZE)));
  return runDbTransaction(db, async (tx) => {
    // A45: only FULL compact correction roots are eligible. INCOMPLETE_HISTORY
    // remains explicit evidence and open coverage has endedAt=NULL, so neither is
    // destroyed merely because wall-clock retention elapsed.
    const [responseRows, dialogRows, coverageRows] = await Promise.all([
      tx.teamResponseCase.findMany({
        where: { agencyId, projectionState: "FULL", replyAt: { lt: cutoff } },
        select: { id: true }, orderBy: [{ replyAt: "asc" }, { id: "asc" }], take: limit,
      }),
      tx.teamDialogSession.findMany({
        where: { agencyId, endedAt: { lt: cutoff } },
        select: { id: true }, orderBy: [{ endedAt: "asc" }, { id: "asc" }], take: limit,
      }),
      tx.teamCoverageSession.findMany({
        where: { agencyId, endedAt: { not: null, lt: cutoff } },
        select: { id: true }, orderBy: [{ endedAt: "asc" }, { id: "asc" }], take: limit,
      }),
    ]);

    const responseDelete = responseRows.length ? await tx.teamResponseCase.deleteMany({ where: { id: { in: responseRows.map((row) => row.id) } } }) : { count: 0 };
    const dialogDelete = dialogRows.length ? await tx.teamDialogSession.deleteMany({ where: { id: { in: dialogRows.map((row) => row.id) } } }) : { count: 0 };
    const coverageDelete = coverageRows.length ? await tx.teamCoverageSession.deleteMany({ where: { id: { in: coverageRows.map((row) => row.id) } } }) : { count: 0 };
    const hasMore = responseRows.length >= limit || dialogRows.length >= limit || coverageRows.length >= limit;
    let watermarkAdvanced = false;

    // The retained boundary advances only when every eligible family returned a
    // short page in this transaction. A crash therefore either keeps the old
    // coverage boundary or commits both final compaction and the new boundary.
    if (!hasMore) {
      const current = await tx.teamProjectionCoverage.findUnique({ where: { agencyId } });
      if (current) {
        await tx.teamProjectionCoverage.update({
          where: { agencyId },
          data: {
            responseCoverageFrom: maxDate(current.responseCoverageFrom, cutoff),
            dialogCoverageFrom: maxDate(current.dialogCoverageFrom, cutoff),
            source: "phase2_retention_vector_v3",
          },
        });
      }
      await tx.phase2WorkCoverage.updateMany({
        where: {
          agencyId,
          family: PHASE2_COVERAGE_FAMILY.TEAM_RESPONSE_RANGE_REPAIR,
          generation: PHASE2_COVERAGE_GENERATION.TEAM_RESPONSE_RANGE_REPAIR,
          active: true,
          enumerationState: "COMPLETE",
        },
        data: { retainedFrom: cutoff },
      });
      watermarkAdvanced = true;
    }

    const deleted = Number(responseDelete?.count || 0) + Number(dialogDelete?.count || 0) + Number(coverageDelete?.count || 0);
    return {
      agencyId, deleted, hasMore, watermarkAdvanced,
      responseDeleted: Number(responseDelete?.count || 0),
      dialogDeleted: Number(dialogDelete?.count || 0),
      coverageDeleted: Number(coverageDelete?.count || 0),
      retainedFrom: watermarkAdvanced ? cutoff : null,
    };
  });
}

async function runTeamProjectionRetentionCompaction({ db = prisma, authorityNow = new Date(), detailDays = 180, batchSize = DEFAULT_BATCH_SIZE, agenciesPerBatch = TEAM_PROJECTION_RETENTION_AGENCIES_PER_BATCH } = {}) {
  const correctionDays = Math.max(TEAM_PROVIDER_CORRECTION_HORIZON_DAYS, Math.max(1, Number(detailDays) || 180));
  const cutoff = daysAgo(correctionDays, authorityNow);
  return runMaintenanceLane({
    db,
    key: TEAM_PROJECTION_RETENTION_LANE_KEY,
    generation: TEAM_PROJECTION_RETENTION_GENERATION,
    oneTime: false,
    minIntervalMs: 0,
    fallbackNow: authorityNow,
    work: async ({ claim, heartbeat }) => {
      const cursorAgencyId = String(claim?.cursor?.agencyId || "").trim() || null;
      const rows = await db.teamProjectionCoverage.findMany({
        where: cursorAgencyId ? { agencyId: { gt: cursorAgencyId } } : {},
        select: { agencyId: true },
        orderBy: { agencyId: "asc" },
        take: Math.max(1, Math.min(50, Math.floor(Number(agenciesPerBatch) || TEAM_PROJECTION_RETENTION_AGENCIES_PER_BATCH))),
      });
      if (!rows.length) {
        return { complete: false, outcome: "CYCLE_COMPLETE", cursor: null, deleted: 0, agenciesScanned: 0, hasMore: false, retainedFrom: cutoff };
      }

      let deleted = 0;
      let hasMore = false;
      const details = [];
      for (const row of rows) {
        const item = await compactTeamProjectionAuthorityForAgency({ db, agencyId: row.agencyId, cutoff, batchSize });
        deleted += Number(item?.deleted || 0);
        if (item?.hasMore) hasMore = true;
        details.push(item);
        const renewed = await heartbeat({ cursor: { agencyId: row.agencyId }, progress: { deleted, agenciesScanned: details.length, retainedFrom: cutoff.toISOString() } });
        if (!renewed?.renewed) throw Object.assign(new Error("TEAM_PROJECTION_RETENTION_OWNERSHIP_LOST"), { code: "MAINTENANCE_LANE_OWNERSHIP_LOST" });
      }
      return {
        complete: false,
        outcome: hasMore ? "PARTIAL" : "BATCH_COMPLETE",
        cursor: { agencyId: rows[rows.length - 1].agencyId },
        progress: { deleted, agenciesScanned: rows.length, retainedFrom: cutoff.toISOString() },
        deleted, agenciesScanned: rows.length, hasMore, retainedFrom: cutoff, details,
      };
    },
  });
}

async function runTeamActivityRetentionSweep(options = {}) {
  const authorityNow = sweepNow(options);
  const cfg = await resolveSweepConfig(options);
  const out = [];

  out.push(await deleteByIdsInBatches({
    model: prisma.teamActivityEvent,
    batchSize: cfg.batchSize,
    maxBatches: 4,
    label: `teamActivityEvent.intermediate_${cfg.teamIntermediateDays}d`,
    orderBy: { ts: "asc" },
    where: {
      type: { in: ["dialog_unread_seen", "fan_message_seen_active"] },
      ts: { lt: daysAgo(cfg.teamIntermediateDays, authorityNow) },
    },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.teamActivityEvent,
    batchSize: cfg.batchSize,
    maxBatches: 4,
    label: `teamActivityEvent.dialog_session_${cfg.teamSessionDays}d`,
    orderBy: { ts: "asc" },
    where: {
      type: "dialog_session",
      ts: { lt: daysAgo(cfg.teamSessionDays, authorityNow) },
    },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.teamActivityEvent,
    batchSize: cfg.batchSize,
    maxBatches: 4,
    label: `teamActivityEvent.claim_notices_${cfg.teamNoticeDays}d`,
    orderBy: { ts: "asc" },
    where: {
      type: "ppv_claim_resolution_notice",
      ts: { lt: daysAgo(cfg.teamNoticeDays, authorityNow) },
    },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.teamActivityEvent,
    batchSize: cfg.batchSize,
    maxBatches: 4,
    label: `teamActivityEvent.audit_${cfg.teamAuditDays}d`,
    orderBy: { ts: "asc" },
    where: {
      type: {
        in: [
          "chat_message_sent_local",
          "sent_message_recorded",
          "ppv_message_sent_recorded",
          "ppv_purchase_attributed",
          "ppv_purchase_unresolved",
          "dialog_unanswered_left",
          "fan_message_after_last_responder",
          "creator_fan_incoming_unassigned",
        ],
      },
      ts: { lt: daysAgo(cfg.teamAuditDays, authorityNow) },
    },
  }));

  // R15 vector-retention cutover: do not treat the old daily marker as proof
  // that pending/response consumers no longer need raw evidence. Until the full
  // consumer vector is projected, only activity-only v2 semantic contributions
  // (broadcast/content) may lose raw payload. Message/incoming/seen/coverage raw
  // remains fail-closed and is retired by the later vector-watermark generation.
  out.push(await deleteByIdsInBatches({
    model: prisma.teamActivityEvent,
    batchSize: cfg.batchSize,
    maxBatches: 4,
    label: `teamActivityEvent.activity_only_v2_${cfg.teamCanonicalDetailDays}d`,
    orderBy: { ts: "asc" },
    where: {
      source: "electron_team_v13",
      eventKind: { in: ["BROADCAST_DISPATCH_CONFIRMED", "CONTENT_POST_PUBLISHED_CONFIRMED", "CONTENT_STORY_PUBLISHED_CONFIRMED"] },
      historicalProjectionVersion: "team_activity_contribution_v2",
      historicalProjectedAt: { not: null },
      ts: { lt: daysAgo(cfg.teamCanonicalDetailDays, authorityNow) },
    },
  }));

  // R15/A45 retention vector: compact projection roots are retired only behind
  // completed response-repair coverage and a correction-horizon retained watermark.
  // The lane is cursor-fair across agencies and every agency performs one bounded
  // delete unit; open/incomplete evidence is preserved.
  const projectionCompaction = await runTeamProjectionRetentionCompaction({
    db: options.db || prisma, authorityNow, detailDays: cfg.teamCanonicalDetailDays, batchSize: cfg.batchSize,
  });
  out.push({
    label: "teamProjection.compact_v3",
    deleted: Number(projectionCompaction?.deleted || 0),
    hasMore: projectionCompaction?.hasMore === true,
    skipped: projectionCompaction?.skipped === true,
    reason: projectionCompaction?.reason || null,
    retainedFrom: projectionCompaction?.retainedFrom || null,
  });

  return summarizeSweep("teamActivityEvent", out);
}

async function deleteFreeOrganicLedgerNoise({ batchSize, olderThan }) {
  let total = 0;
  for (;;) {
    const affected = await prisma.$executeRaw`
      WITH doomed AS (
        SELECT l."id"
        FROM "CreatorSubscriptionLedger" AS l
        WHERE l."sourceId" IS NULL
          AND l."amountCents" <= 0
          AND l."occurredAt" < ${olderThan}
          AND (l."organicConfirmed" = TRUE OR l."attributionAttempts" >= 5)
          AND NOT EXISTS (
            SELECT 1
            FROM "TrafficSourceMember" AS m
            WHERE m."agencyId" = l."agencyId"
              AND m."creatorId" = l."creatorId"
              AND m."fanId" = l."fanId"
          )
        ORDER BY l."occurredAt" ASC
        LIMIT ${batchSize}
      )
      DELETE FROM "CreatorSubscriptionLedger" AS l
      USING doomed
      WHERE l."id" = doomed."id"
    `;
    total += Number(affected || 0);
    if (Number(affected || 0) < batchSize) break;
  }
  return { label: "creatorSubscriptionLedger.free_organic_noise", deleted: total };
}

async function deleteOldPaidOrganicLedger({ batchSize, olderThan }) {
  let total = 0;
  for (;;) {
    const affected = await prisma.$executeRaw`
      WITH doomed AS (
        SELECT l."id"
        FROM "CreatorSubscriptionLedger" AS l
        WHERE l."sourceId" IS NULL
          AND l."amountCents" > 0
          AND l."organicConfirmed" = TRUE
          AND l."occurredAt" < ${olderThan}
        ORDER BY l."occurredAt" ASC
        LIMIT ${batchSize}
      )
      DELETE FROM "CreatorSubscriptionLedger" AS l
      USING doomed
      WHERE l."id" = doomed."id"
    `;
    total += Number(affected || 0);
    if (Number(affected || 0) < batchSize) break;
  }
  return { label: "creatorSubscriptionLedger.paid_organic_retention", deleted: total };
}

async function deleteDeadTrafficSourceMembers({ batchSize, olderThan }) {
  let total = 0;
  for (;;) {
    const affected = await prisma.$executeRaw`
      WITH doomed AS (
        SELECT m."id"
        FROM "TrafficSourceMember" AS m
        WHERE m."lastRevenueAt" IS NULL
          AND m."lastSeenAt" < ${olderThan}
          AND m."needsValueRefresh" = FALSE
          AND NOT EXISTS (
            SELECT 1
            FROM "CreatorSubscriptionLedger" AS l
            WHERE l."agencyId" = m."agencyId"
              AND l."creatorId" = m."creatorId"
              AND l."fanId" = m."fanId"
              AND l."amountCents" > 0
          )
        ORDER BY m."lastSeenAt" ASC
        LIMIT ${batchSize}
      )
      DELETE FROM "TrafficSourceMember" AS m
      USING doomed
      WHERE m."id" = doomed."id"
    `;
    total += Number(affected || 0);
    if (Number(affected || 0) < batchSize) break;
  }
  return { label: "trafficSourceMember.dead_no_revenue", deleted: total };
}

async function runTeamLedgerRetentionSweep(options = {}) {
  const authorityNow = sweepNow(options);
  const cfg = await resolveSweepConfig(options);
  const [result, tipResult] = await Promise.all([
    gcTeamLedgers({
      now: authorityNow,
      olderThanMs: cfg.teamMoneyRawDetailDays * DAY_MS,
      limit: cfg.batchSize,
    }),
    purgeExpiredTipLedger({
      retentionDays: cfg.teamMoneyRawDetailDays,
      limit: cfg.batchSize,
      dryRun: false,
      now: authorityNow,
    }),
  ]);
  const items = [
    { label: "teamSentMessageLedger", deleted: Number(result?.sentMessageLedger || 0) },
    { label: "teamSentMessageLedger.compacted", deleted: 0, compacted: Number(result?.sentMessageLedgerCompacted || 0), hasMore: Boolean(result?.hasMore) },
    { label: "teamPpvPurchaseLedger", deleted: Number(result?.ppvPurchaseLedger || 0) },
    { label: "teamPpvPurchaseLedger.compacted", deleted: 0, compacted: Number(result?.ppvPurchaseLedgerCompacted || 0) },
    { label: "teamPpvResolveJob", deleted: Number(result?.ppvResolveJob || 0) },
    { label: "teamTipLedger", deleted: Number(tipResult?.deleted || 0), compacted: Number(tipResult?.compacted || 0), hasMore: Boolean(tipResult?.hasMore) },
  ];
  return summarizeSweep("teamLedgers", items);
}

async function runAutomationRetentionSweep(options = {}) {
  const authorityNow = sweepNow(options);
  const cfg = await resolveSweepConfig(options);
  const out = [];
  const jobOlderThan = daysAgo(cfg.automationJobDoneDays, authorityNow);

  out.push(await compactAutomationDeliveries({
    olderThan: daysAgo(cfg.automationDeliveryDetailedDays, authorityNow),
    batchSize: cfg.batchSize,
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.automationMonthlyAggregate,
    batchSize: cfg.batchSize,
    label: `automationMonthlyAggregate.old_${cfg.automationAggregateDays}d`,
    orderBy: { periodStart: "asc" },
    where: { periodStart: { lt: daysAgo(cfg.automationAggregateDays, authorityNow) } },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.automationJob,
    batchSize: cfg.batchSize,
    label: `automationJob.terminal_${cfg.automationJobDoneDays}d`,
    orderBy: { updatedAt: "asc" },
    where: {
      status: { in: ["done", "failed", "canceled", "expired"] },
      OR: [
        { completedAt: { lt: jobOlderThan } },
        { completedAt: null, updatedAt: { lt: jobOlderThan } },
      ],
    },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.automationEvent,
    batchSize: cfg.batchSize,
    label: `automationEvent.audit_${cfg.automationEventDays}d`,
    orderBy: { createdAt: "asc" },
    where: { createdAt: { lt: daysAgo(cfg.automationEventDays, authorityNow) } },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.automationTask,
    batchSize: cfg.batchSize,
    label: `automationTask.trash_${cfg.automationTaskTrashDays}d`,
    orderBy: { deletedAt: "asc" },
    where: {
      deletedAt: { not: null, lt: daysAgo(cfg.automationTaskTrashDays, authorityNow) },
    },
  }));

  return summarizeSweep("automation", out);
}

async function runTrafficRetentionSweep(options = {}) {
  const authorityNow = sweepNow(options);
  const cfg = await resolveSweepConfig(options);
  const out = [];

  out.push(await deleteFreeOrganicLedgerNoise({
    batchSize: cfg.batchSize,
    olderThan: new Date(authorityNow.getTime() - Math.max(1, cfg.trafficFreeOrganicCleanupHours) * HOUR_MS),
  }));

  if (cfg.trafficPaidOrganicLedgerDays > 0) {
    out.push(await deleteOldPaidOrganicLedger({
      batchSize: cfg.batchSize,
      olderThan: daysAgo(cfg.trafficPaidOrganicLedgerDays, authorityNow),
    }));
  } else {
    out.push({ label: "creatorSubscriptionLedger.paid_organic_retention", deleted: 0, skipped: true, reason: "keep_forever" });
  }

  out.push(await deleteDeadTrafficSourceMembers({
    batchSize: cfg.batchSize,
    olderThan: daysAgo(cfg.trafficSourceMemberNoRevenueDays, authorityNow),
  }));


  out.push(await deleteByIdsInBatches({
    model: prisma.trafficDailyAggregate,
    batchSize: cfg.batchSize,
    label: `trafficDailyAggregate.old_${cfg.trafficDailyAggregateDays}d`,
    orderBy: { day: "asc" },
    where: { day: { lt: daysAgo(cfg.trafficDailyAggregateDays, authorityNow) } },
  }));

  return summarizeSweep("traffic", out);
}

async function runDialogIntelligenceRetentionSweep(options = {}) {
  const authorityNow = sweepNow(options);
  const cfg = await resolveSweepConfig(options);
  const out = [];
  out.push(await deleteByIdsInBatches({
    model: prisma.dialogScanChunkCommit,
    batchSize: cfg.batchSize,
    label: `dialogScanChunkCommit.old_${cfg.dialogScanChunkDays}d`,
    orderBy: { committedAt: "asc" },
    where: { committedAt: { lt: daysAgo(cfg.dialogScanChunkDays, authorityNow) } },
  }));
  out.push(await deleteByIdsInBatches({
    model: prisma.dialogScanRun,
    batchSize: cfg.batchSize,
    label: `dialogScanRun.terminal_${cfg.dialogScanRunDays}d`,
    orderBy: { updatedAt: "asc" },
    where: {
      status: { in: ["COMPLETED", "FAILED", "CANCELED"] },
      updatedAt: { lt: daysAgo(cfg.dialogScanRunDays, authorityNow) },
    },
  }));
  return summarizeSweep("dialogIntelligence", out);
}

async function runAuditLogRetentionSweep(options = {}) {
  const authorityNow = sweepNow(options);
  const cfg = await resolveSweepConfig(options);
  const olderThan = daysAgo(cfg.auditLogDays, authorityNow);
  const out = [];

  out.push(await deleteByIdsInBatches({
    model: prisma.auditLog,
    batchSize: cfg.batchSize,
    label: `auditLog.old_${cfg.auditLogDays}d`,
    orderBy: { createdAt: "asc" },
    where: { createdAt: { lt: olderThan } },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.adminActionLog,
    batchSize: cfg.batchSize,
    label: `adminActionLog.old_${cfg.auditLogDays}d`,
    orderBy: { createdAt: "asc" },
    where: { createdAt: { lt: olderThan } },
  }));

  return summarizeSweep("auditLogs", out);
}


async function runAnalyticsExecutionRetentionSweep(options = {}) {
  const authorityNow = sweepNow(options);
  const cfg = await resolveSweepConfig(options);
  const batchSize = Math.max(100, Math.min(10000, Number(cfg.batchSize) || DEFAULT_BATCH_SIZE));
  const ingestCutoff = daysAgo(cfg.analyticsIngestBatchDays, authorityNow);
  const jobCutoff = daysAgo(cfg.analyticsJobInstanceDays, authorityNow);
  const demandCutoff = daysAgo(cfg.analyticsDemandHistoryDays, authorityNow);
  const proofCutoff = daysAgo(cfg.analyticsSupersededScanProofDays, authorityNow);
  const nonEarningsJobCutoff = daysAgo(cfg.analyticsNonEarningsJobDays, authorityNow);
  const nonEarningsIngestCutoff = daysAgo(cfg.analyticsNonEarningsIngestBatchDays, authorityNow);
  const notificationAuditCutoff = daysAgo(cfg.analyticsNotificationScanAuditDays, authorityNow);
  const items = [];

  let ingestDeleted = 0;
  for (;;) {
    const deleted = Number(await prisma.$executeRawUnsafe(`
      DELETE FROM "AnalyticsIngestBatch" b
      WHERE b."id" IN (
        SELECT ib."id"
        FROM "AnalyticsIngestBatch" ib
        JOIN "AnalyticsScanProof" p
          ON p."creatorId" = ib."creatorId"
         AND p."dataType" = 'EARNINGS'::"AnalyticsDataType"
         AND p."scanRunId" = substring(ib."idempotencyKey" from 'run:([^:]+):')
        WHERE ib."dataType" = 'EARNINGS'::"AnalyticsDataType"
          AND ib."completedAt" IS NOT NULL
          AND ib."completedAt" < $1
        ORDER BY ib."completedAt" ASC
        LIMIT $2
      )
    `, ingestCutoff, batchSize));
    ingestDeleted += deleted;
    if (deleted < batchSize) break;
  }
  items.push({ label: `analyticsIngestBatch.earnings_${cfg.analyticsIngestBatchDays}d`, deleted: ingestDeleted });

  let jobsDeleted = 0;
  for (;;) {
    const deleted = Number(await prisma.$executeRawUnsafe(`
      DELETE FROM "JobInstance" j
      WHERE j."id" IN (
        SELECT candidate."id"
        FROM "JobInstance" candidate
        WHERE candidate."jobKey" = 'fetch_earnings'
          AND candidate."status" IN ('DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED')
          AND candidate."completedAt" IS NOT NULL
          AND candidate."completedAt" < $1
          AND EXISTS (
            SELECT 1 FROM "AnalyticsScanProof" p
            WHERE p."sourceJobId" = candidate."id"
              AND p."dataType" = 'EARNINGS'::"AnalyticsDataType"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "CreatorEarningsDaily" d
            WHERE d."sourceJobId" = candidate."id" AND d."scanProofId" IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "AnalyticsIngestBatch" ib
            JOIN "AnalyticsCoverage" c ON c."ingestBatchId" = ib."id"
            WHERE ib."sourceJobId" = candidate."id"
              AND ib."dataType" = 'EARNINGS'::"AnalyticsDataType"
              AND c."scanProofId" IS NULL
          )
        ORDER BY candidate."completedAt" ASC
        LIMIT $2
      )
    `, jobCutoff, batchSize));
    jobsDeleted += deleted;
    if (deleted < batchSize) break;
  }
  items.push({ label: `jobInstance.fetch_earnings_${cfg.analyticsJobInstanceDays}d`, deleted: jobsDeleted });

  // Failed/cancelled/expired earnings attempts that never produced durable proof
  // are technical history too. Delete them only when no canonical earnings or
  // coverage row still depends on their execution identity.
  let unprovenEarningsJobsDeleted = 0;
  for (;;) {
    const deleted = Number(await prisma.$executeRawUnsafe(`
      DELETE FROM "JobInstance" j
      WHERE j."id" IN (
        SELECT candidate."id"
        FROM "JobInstance" candidate
        WHERE candidate."jobKey" = 'fetch_earnings'
          AND candidate."status" IN ('FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED')
          AND candidate."updatedAt" < $1
          AND NOT EXISTS (SELECT 1 FROM "AnalyticsScanProof" p WHERE p."sourceJobId" = candidate."id")
          AND NOT EXISTS (SELECT 1 FROM "CreatorEarningsDaily" d WHERE d."sourceJobId" = candidate."id")
          AND NOT EXISTS (
            SELECT 1 FROM "AnalyticsIngestBatch" ib
            JOIN "AnalyticsCoverage" c ON c."ingestBatchId" = ib."id"
            WHERE ib."sourceJobId" = candidate."id" AND ib."dataType" = 'EARNINGS'::"AnalyticsDataType"
          )
        ORDER BY candidate."updatedAt" ASC, candidate."id" ASC
        LIMIT $2
      )
    `, jobCutoff, batchSize));
    unprovenEarningsJobsDeleted += deleted;
    if (deleted < batchSize) break;
  }
  items.push({ label: `jobInstance.fetch_earnings_unproven_${cfg.analyticsJobInstanceDays}d`, deleted: unprovenEarningsJobsDeleted });

  // Notification frontier is now bounded in CreatorNotificationSyncState, so
  // whole page audit history is no longer needed for current catch-up semantics.
  let notificationAuditDeleted = 0;
  for (;;) {
    const deleted = Number(await prisma.$executeRawUnsafe(`
      DELETE FROM "CreatorNotificationScanItem" item
      WHERE item."id" IN (
        SELECT candidate."id" FROM "CreatorNotificationScanItem" candidate
        WHERE candidate."createdAt" < $1
          AND EXISTS (
            SELECT 1 FROM "JobInstance" source_job
            WHERE source_job."id" = candidate."sourceJobId"
              AND source_job."status" IN ('DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED')
          )
        ORDER BY candidate."createdAt" ASC, candidate."id" ASC
        LIMIT $2
      )
    `, notificationAuditCutoff, batchSize));
    notificationAuditDeleted += deleted;
    if (deleted < batchSize) break;
  }
  items.push({ label: `creatorNotificationScanItem.audit_${cfg.analyticsNotificationScanAuditDays}d`, deleted: notificationAuditDeleted });

  // Non-earnings ingest batches are operational history. Their current
  // collection semantics live in specialized durable state before these rows
  // become eligible for compaction.
  let nonEarningsIngestDeleted = 0;
  for (;;) {
    const deleted = Number(await prisma.$executeRawUnsafe(`
      DELETE FROM "AnalyticsIngestBatch" ib
      WHERE ib."id" IN (
        SELECT candidate."id"
        FROM "AnalyticsIngestBatch" candidate
        WHERE candidate."completedAt" IS NOT NULL
          AND candidate."completedAt" < $1
          AND candidate."dataType" IN (
            'CAMPAIGNS'::"AnalyticsDataType",
            'FINANCIAL_TRANSACTIONS'::"AnalyticsDataType",
            'NOTIFICATIONS'::"AnalyticsDataType",
            'NOTIFICATION_PURCHASES'::"AnalyticsDataType", 'NOTIFICATION_TIPS'::"AnalyticsDataType",
            'NOTIFICATION_SUBSCRIPTIONS'::"AnalyticsDataType", 'NOTIFICATION_LIKES'::"AnalyticsDataType",
            'NOTIFICATION_COMMENTS'::"AnalyticsDataType"
          )
          AND (
            candidate."sourceJobId" IS NULL
            OR EXISTS (
              SELECT 1 FROM "JobInstance" source_job
              WHERE source_job."id" = candidate."sourceJobId"
                AND source_job."status" IN ('DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED')
            )
          )
        ORDER BY candidate."completedAt" ASC
        LIMIT $2
      )
    `, nonEarningsIngestCutoff, batchSize));
    nonEarningsIngestDeleted += deleted;
    if (deleted < batchSize) break;
  }
  items.push({ label: `analyticsIngestBatch.non_earnings_${cfg.analyticsNonEarningsIngestBatchDays}d`, deleted: nonEarningsIngestDeleted });

  let nonEarningsJobsDeleted = 0;
  for (;;) {
    const deleted = Number(await prisma.$executeRawUnsafe(`
      DELETE FROM "JobInstance" j
      WHERE j."id" IN (
        SELECT candidate."id"
        FROM "JobInstance" candidate
        WHERE candidate."jobKey" IN ('catchup_notifications_scan', 'financial_transactions_scan', 'fetch_campaigns')
          AND candidate."status" IN ('DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED')
          AND candidate."updatedAt" < $1
          AND NOT EXISTS (
            SELECT 1 FROM "CreatorNotificationScanItem" scan_item
            WHERE scan_item."sourceJobId" = candidate."id"
          )
        ORDER BY candidate."updatedAt" ASC, candidate."id" ASC
        LIMIT $2
      )
    `, nonEarningsJobCutoff, batchSize));
    nonEarningsJobsDeleted += deleted;
    if (deleted < batchSize) break;
  }
  items.push({ label: `jobInstance.analytics_non_earnings_${cfg.analyticsNonEarningsJobDays}d`, deleted: nonEarningsJobsDeleted });

  let demandsDeleted = 0;
  for (;;) {
    const deleted = Number(await prisma.$executeRawUnsafe(`
      DELETE FROM "AnalyticsCollectionDemand" d
      WHERE d."completedAt" IS NOT NULL
        AND d."completedAt" < $1
        AND d."claimToken" IS NULL
        AND d."key" IN (
          SELECT candidate."key"
          FROM "AnalyticsCollectionDemand" candidate
          WHERE candidate."completedAt" IS NOT NULL
            AND candidate."completedAt" < $1
            AND candidate."claimToken" IS NULL
            AND pg_try_advisory_xact_lock(hashtext('analytics-demand:' || candidate."key"))
          ORDER BY candidate."completedAt" ASC, candidate."key" ASC
          LIMIT $2
        )
    `, demandCutoff, batchSize));
    demandsDeleted += deleted;
    if (deleted < batchSize) break;
  }
  items.push({ label: `analyticsCollectionDemand.completed_${cfg.analyticsDemandHistoryDays}d`, deleted: demandsDeleted });

  let quarantinedDemandsDeleted = 0;
  for (;;) {
    const deleted = Number(await prisma.$executeRawUnsafe(`
      DELETE FROM "AnalyticsCollectionDemand" d
      WHERE d."completedAt" IS NULL
        AND d."quarantinedAt" IS NOT NULL
        AND d."quarantinedAt" < $1
        AND d."claimToken" IS NULL
        AND d."key" IN (
          SELECT candidate."key"
          FROM "AnalyticsCollectionDemand" candidate
          WHERE candidate."completedAt" IS NULL
            AND candidate."quarantinedAt" IS NOT NULL
            AND candidate."quarantinedAt" < $1
            AND candidate."claimToken" IS NULL
            AND pg_try_advisory_xact_lock(hashtext('analytics-demand:' || candidate."key"))
          ORDER BY candidate."quarantinedAt" ASC, candidate."key" ASC
          LIMIT $2
        )
    `, demandCutoff, batchSize));
    quarantinedDemandsDeleted += deleted;
    if (deleted < batchSize) break;
  }
  items.push({ label: `analyticsCollectionDemand.quarantined_${cfg.analyticsDemandHistoryDays}d`, deleted: quarantinedDemandsDeleted });

  // AnalyticsScanProof is durable business evidence while a canonical daily or
  // coverage row still points at it.  Once a newer scan has superseded every
  // such reference, the old receipt becomes technical history and may be
  // compacted.  Never rely on ON DELETE SET NULL here: reachability is the
  // retention authority and referenced proofs are explicitly excluded.
  let proofsDeleted = 0;
  for (;;) {
    const deleted = Number(await prisma.$executeRawUnsafe(`
      DELETE FROM "AnalyticsScanProof" p
      WHERE p."id" IN (
        SELECT candidate."id"
        FROM "AnalyticsScanProof" candidate
        WHERE candidate."createdAt" < $1
          AND NOT EXISTS (
            SELECT 1
            FROM "CreatorEarningsDaily" d
            WHERE d."scanProofId" = candidate."id"
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "AnalyticsCoverage" c
            WHERE c."scanProofId" = candidate."id"
          )
        ORDER BY candidate."createdAt" ASC, candidate."id" ASC
        LIMIT $2
      )
    `, proofCutoff, batchSize));
    proofsDeleted += deleted;
    if (deleted < batchSize) break;
  }
  items.push({
    label: `analyticsScanProof.superseded_unreferenced_${cfg.analyticsSupersededScanProofDays}d`,
    deleted: proofsDeleted,
  });

  return summarizeSweep("analyticsExecution", items);
}

async function runCreatorTaskActivityRetentionSweep(options = {}) {
  const authorityNow = sweepNow(options);
  const cfg = await resolveSweepConfig(options);
  const items = [];
  if (!prisma.creatorTaskActivity?.findMany) return summarizeSweep("creatorTaskActivity", items);
  items.push(await deleteByIdsInBatches({
    model: prisma.creatorTaskActivity,
    batchSize: cfg.batchSize,
    label: "creatorTaskActivity.30d",
    orderBy: { updatedAt: "asc" },
    where: { updatedAt: { lt: daysAgo(30, authorityNow) } },
  }));
  return summarizeSweep("creatorTaskActivity", items);
}

async function runRetentionSweep(options = {}) {
  const startedAt = Date.now();
  const useCoordination = options?.useAdvisoryLock !== false && options?.useCoordination !== false;
  let lease = null;

  if (useCoordination) {
    try {
      lease = await claimRetentionSweepLease({
        db: prisma,
        fallbackNow: options?.now || new Date(),
        minIntervalMs: Math.max(0, Number(options?.minIntervalMs) || 0),
      });
    } catch (error) {
      // Destructive GC fails closed when its cluster coordinator is unavailable.
      return {
        ok: false, skipped: true, reason: "coordination_failed", coordinationError: String(error?.message || error),
        elapsedMs: Date.now() - startedAt, totalDeleted: 0, lock: "db_lease_failed_closed",
      };
    }
    if (!lease?.acquired) {
      return {
        ok: true,
        skipped: true,
        reason: lease?.reason || "lease_held",
        completedAt: lease?.completedAt || null,
        nextDueAt: lease?.nextDueAt || null,
        elapsedMs: Date.now() - startedAt,
        totalDeleted: 0,
        lock: "db_lease",
      };
    }
  }

  // The durable lease was claimed with PostgreSQL clock authority. Use that
  // same instant for every lane cutoff so replica wall-clock skew cannot make
  // destructive retention older/younger than policy.
  const authorityNow = lease?.startedAt instanceof Date ? lease.startedAt : sweepNow(options);
  const laneOptions = { ...options, authorityNow };

  let heartbeatTimer = null;
  let heartbeatInFlight = false;
  let heartbeatError = null;
  if (useCoordination && lease?.acquired) {
    heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      renewRetentionSweepLease({ db: prisma, ownerToken: lease.ownerToken })
        .catch((error) => { heartbeatError = error; })
        .finally(() => { heartbeatInFlight = false; });
    }, RETENTION_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  const lanes = [
    ["teamActivity", runTeamActivityRetentionSweep],
    ["teamLedgers", runTeamLedgerRetentionSweep],
    ["traffic", runTrafficRetentionSweep],
    ["automation", runAutomationRetentionSweep],
    ["dialogIntelligence", runDialogIntelligenceRetentionSweep],
    ["auditLogs", runAuditLogRetentionSweep],
    ["creatorTaskActivity", runCreatorTaskActivityRetentionSweep],
    ["analyticsExecution", runAnalyticsExecutionRetentionSweep],
  ];
  let report = null;
  let thrown = null;
  try {
    const settled = await Promise.allSettled(lanes.map(([, run]) => run(laneOptions)));
    const laneErrors = [];
    const laneResults = {};
    let totalDeleted = 0;
    settled.forEach((entry, index) => {
      const [name] = lanes[index];
      if (entry.status === "fulfilled") {
        laneResults[name] = entry.value;
        totalDeleted += Number(entry.value?.totalDeleted || 0);
      } else {
        const message = String(entry.reason?.message || entry.reason || "retention lane failed");
        laneResults[name] = { label: name, ok: false, totalDeleted: 0, error: message };
        laneErrors.push({ lane: name, error: message });
      }
    });
    const remainingWork = Object.values(laneResults).some((lane) => lane?.hasMore === true);
    report = {
      ok: laneErrors.length === 0,
      partial: laneErrors.length > 0 && laneErrors.length < lanes.length,
      remainingWork,
      elapsedMs: Date.now() - startedAt,
      totalDeleted,
      ...laneResults,
      laneErrors,
      lock: useCoordination ? "db_lease" : "disabled",
    };
    if (heartbeatError) {
      report.ok = false;
      report.coordinationHeartbeatError = String(heartbeatError?.message || heartbeatError);
    }
    return report;
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (useCoordination && lease?.acquired) {
      const outcome = thrown ? "FAILED" : (report?.ok && report?.remainingWork !== true) ? "COMPLETE" : "PARTIAL";
      try {
        const finalized = await finalizeRetentionSweepLease({ db: prisma, ownerToken: lease.ownerToken, outcome, error: thrown || (report?.laneErrors?.length ? JSON.stringify(report.laneErrors) : null) });
        if (finalized !== true && report) {
          report.ok = false;
          report.coordinationFinalizeError = "RETENTION_COORDINATION_OWNERSHIP_LOST";
        }
      } catch (finalizeError) {
        console.warn("[retention] durable lease finalize failed:", finalizeError?.message || finalizeError);
        if (report) {
          report.ok = false;
          report.coordinationFinalizeError = String(finalizeError?.message || finalizeError);
        }
      }
    }
  }
}

function summarizeSweep(label, items) {
  const totalDeleted = items.reduce((sum, item) => sum + Number(item?.deleted || 0), 0);
  const hasMore = items.some((item) => item?.hasMore === true);
  return { label, totalDeleted, hasMore, items };
}

module.exports = {
  RETENTION_SETTING_KEY,
  runRetentionSweep,
  runTeamActivityRetentionSweep,
  runTeamLedgerRetentionSweep,
  runTrafficRetentionSweep,
  runAutomationRetentionSweep,
  runDialogIntelligenceRetentionSweep,
  runAuditLogRetentionSweep,
  runCreatorTaskActivityRetentionSweep,
  runAnalyticsExecutionRetentionSweep,
  getRetentionSettings,
  updateRetentionSettings,
  resetRetentionSettings,
  defaultRetentionSettings,
  normalizeRetentionSettings,
  retentionSchema,
  claimRetentionSweepLease,
  renewRetentionSweepLease,
  finalizeRetentionSweepLease,
  compactTeamProjectionAuthorityForAgency,
  runTeamProjectionRetentionCompaction,
};
