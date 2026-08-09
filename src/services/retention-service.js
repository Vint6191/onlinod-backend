/* src/services/retention-service.js
   Compact retention/GC sweeps for high-volume analytics tables.

   Production rule:
   - never store raw OF payloads as a retention strategy;
   - keep normalized facts long enough for audit;
   - aggressively remove intermediate realtime state and zero/free organic noise;
   - allow SUPER_ADMIN to tune retention in Admin → System without redeploy.
*/
"use strict";

const prisma = require("../prisma");
const { gcTeamLedgers } = require("./team-ppv-ledger-service");
const { compactAutomationDeliveries } = require("./automation-history-service");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 2000;
const RETENTION_SETTING_KEY = "retention.policy.v1";
// Cluster-wide unique identifier for the retention sweep advisory lock.
// MUST NOT be changed across versions in production deployments — changing
// this id temporarily defeats the lock during rolling upgrades. Keep the
// original v18.26 id so old/new instances cannot run parallel sweeps.
const RETENTION_ADVISORY_LOCK_ID = 91825026;

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

async function getRetentionSettings() {
  const defaults = defaultRetentionSettings();
  let row = null;
  try {
    row = await prisma.systemSetting.findUnique({ where: { key: RETENTION_SETTING_KEY } });
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

async function tryAcquireRetentionLock() {
  try {
    const rows = await prisma.$queryRaw`SELECT pg_try_advisory_lock(${RETENTION_ADVISORY_LOCK_ID}) AS locked`;
    const row = Array.isArray(rows) ? rows[0] : null;
    return row?.locked === true || row?.pg_try_advisory_lock === true;
  } catch (err) {
    console.warn("[retention] advisory lock acquire failed; running without lock:", err?.message || err);
    return true;
  }
}

async function releaseRetentionLock() {
  try {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${RETENTION_ADVISORY_LOCK_ID})`;
  } catch (err) {
    console.warn("[retention] advisory lock release failed:", err?.message || err);
  }
}

function daysAgo(days) {
  return new Date(Date.now() - Math.max(0, Number(days) || 0) * DAY_MS);
}

async function deleteByIdsInBatches({ model, where, orderBy, batchSize, label }) {
  let total = 0;
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

    if (rows.length < batchSize) break;
  }
  return { label, deleted: total };
}

async function runTeamActivityRetentionSweep(options = {}) {
  const cfg = await resolveSweepConfig(options);
  const out = [];

  out.push(await deleteByIdsInBatches({
    model: prisma.teamActivityEvent,
    batchSize: cfg.batchSize,
    label: `teamActivityEvent.intermediate_${cfg.teamIntermediateDays}d`,
    orderBy: { ts: "asc" },
    where: {
      type: { in: ["dialog_unread_seen", "fan_message_seen_active"] },
      ts: { lt: daysAgo(cfg.teamIntermediateDays) },
    },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.teamActivityEvent,
    batchSize: cfg.batchSize,
    label: `teamActivityEvent.dialog_session_${cfg.teamSessionDays}d`,
    orderBy: { ts: "asc" },
    where: {
      type: "dialog_session",
      ts: { lt: daysAgo(cfg.teamSessionDays) },
    },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.teamActivityEvent,
    batchSize: cfg.batchSize,
    label: `teamActivityEvent.claim_notices_${cfg.teamNoticeDays}d`,
    orderBy: { ts: "asc" },
    where: {
      type: "ppv_claim_resolution_notice",
      ts: { lt: daysAgo(cfg.teamNoticeDays) },
    },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.teamActivityEvent,
    batchSize: cfg.batchSize,
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
      ts: { lt: daysAgo(cfg.teamAuditDays) },
    },
  }));

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

async function deleteZeroTrafficValueSnapshots({ batchSize, olderThan }) {
  let total = 0;
  for (;;) {
    const affected = await prisma.$executeRaw`
      WITH doomed AS (
        SELECT v."id"
        FROM "TrafficFanValueSnapshot" AS v
        WHERE v."fetchedAt" < ${olderThan}
          AND COALESCE(v."totalSummCents", 0) = 0
          AND COALESCE(v."messagesSummCents", 0) = 0
          AND COALESCE(v."tipsSummCents", 0) = 0
          AND COALESCE(v."subscribesSummCents", 0) = 0
          AND COALESCE(v."postsSummCents", 0) = 0
          AND COALESCE(v."streamsSummCents", 0) = 0
          AND NOT EXISTS (
            SELECT 1
            FROM "TrafficSourceMember" AS m
            WHERE m."agencyId" = v."agencyId"
              AND m."creatorId" = v."creatorId"
              AND m."fanId" = v."fanId"
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "CreatorSubscriptionLedger" AS l
            WHERE l."agencyId" = v."agencyId"
              AND l."creatorId" = v."creatorId"
              AND l."fanId" = v."fanId"
          )
        ORDER BY v."fetchedAt" ASC
        LIMIT ${batchSize}
      )
      DELETE FROM "TrafficFanValueSnapshot" AS v
      USING doomed
      WHERE v."id" = doomed."id"
    `;
    total += Number(affected || 0);
    if (Number(affected || 0) < batchSize) break;
  }
  return { label: "trafficFanValueSnapshot.zero_orphan", deleted: total };
}

async function runTeamLedgerRetentionSweep(_options = {}) {
  const result = await gcTeamLedgers({});
  const items = [
    { label: "teamSentMessageLedger", deleted: Number(result?.sentMessageLedger || 0) },
    { label: "teamPpvPurchaseLedger", deleted: Number(result?.ppvPurchaseLedger || 0) },
    { label: "teamPpvResolveJob", deleted: Number(result?.ppvResolveJob || 0) },
  ];
  return summarizeSweep("teamLedgers", items);
}

async function runAutomationRetentionSweep(options = {}) {
  const cfg = await resolveSweepConfig(options);
  const out = [];
  const jobOlderThan = daysAgo(cfg.automationJobDoneDays);

  out.push(await compactAutomationDeliveries({
    olderThan: daysAgo(cfg.automationDeliveryDetailedDays),
    batchSize: cfg.batchSize,
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.automationMonthlyAggregate,
    batchSize: cfg.batchSize,
    label: `automationMonthlyAggregate.old_${cfg.automationAggregateDays}d`,
    orderBy: { periodStart: "asc" },
    where: { periodStart: { lt: daysAgo(cfg.automationAggregateDays) } },
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
    where: { createdAt: { lt: daysAgo(cfg.automationEventDays) } },
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.automationTask,
    batchSize: cfg.batchSize,
    label: `automationTask.trash_${cfg.automationTaskTrashDays}d`,
    orderBy: { deletedAt: "asc" },
    where: {
      deletedAt: { not: null, lt: daysAgo(cfg.automationTaskTrashDays) },
    },
  }));

  return summarizeSweep("automation", out);
}

async function runTrafficRetentionSweep(options = {}) {
  const cfg = await resolveSweepConfig(options);
  const out = [];

  out.push(await deleteFreeOrganicLedgerNoise({
    batchSize: cfg.batchSize,
    olderThan: new Date(Date.now() - Math.max(1, cfg.trafficFreeOrganicCleanupHours) * HOUR_MS),
  }));

  if (cfg.trafficPaidOrganicLedgerDays > 0) {
    out.push(await deleteOldPaidOrganicLedger({
      batchSize: cfg.batchSize,
      olderThan: daysAgo(cfg.trafficPaidOrganicLedgerDays),
    }));
  } else {
    out.push({ label: "creatorSubscriptionLedger.paid_organic_retention", deleted: 0, skipped: true, reason: "keep_forever" });
  }

  out.push(await deleteDeadTrafficSourceMembers({
    batchSize: cfg.batchSize,
    olderThan: daysAgo(cfg.trafficSourceMemberNoRevenueDays),
  }));

  out.push(await deleteZeroTrafficValueSnapshots({
    batchSize: cfg.batchSize,
    olderThan: daysAgo(cfg.trafficZeroSnapshotDays),
  }));

  out.push(await deleteByIdsInBatches({
    model: prisma.trafficDailyAggregate,
    batchSize: cfg.batchSize,
    label: `trafficDailyAggregate.old_${cfg.trafficDailyAggregateDays}d`,
    orderBy: { day: "asc" },
    where: { day: { lt: daysAgo(cfg.trafficDailyAggregateDays) } },
  }));

  return summarizeSweep("traffic", out);
}

async function runDialogIntelligenceRetentionSweep(options = {}) {
  const cfg = await resolveSweepConfig(options);
  const out = [];
  out.push(await deleteByIdsInBatches({
    model: prisma.dialogScanChunkCommit,
    batchSize: cfg.batchSize,
    label: `dialogScanChunkCommit.old_${cfg.dialogScanChunkDays}d`,
    orderBy: { committedAt: "asc" },
    where: { committedAt: { lt: daysAgo(cfg.dialogScanChunkDays) } },
  }));
  out.push(await deleteByIdsInBatches({
    model: prisma.dialogScanRun,
    batchSize: cfg.batchSize,
    label: `dialogScanRun.terminal_${cfg.dialogScanRunDays}d`,
    orderBy: { updatedAt: "asc" },
    where: {
      status: { in: ["COMPLETED", "FAILED", "CANCELED"] },
      updatedAt: { lt: daysAgo(cfg.dialogScanRunDays) },
    },
  }));
  return summarizeSweep("dialogIntelligence", out);
}

async function runAuditLogRetentionSweep(options = {}) {
  const cfg = await resolveSweepConfig(options);
  const olderThan = daysAgo(cfg.auditLogDays);
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


async function runCreatorTaskActivityRetentionSweep(options = {}) {
  const cfg = await resolveSweepConfig(options);
  const items = [];
  if (!prisma.creatorTaskActivity?.findMany) return summarizeSweep("creatorTaskActivity", items);
  items.push(await deleteByIdsInBatches({
    model: prisma.creatorTaskActivity,
    batchSize: cfg.batchSize,
    label: "creatorTaskActivity.30d",
    orderBy: { updatedAt: "asc" },
    where: { updatedAt: { lt: daysAgo(30) } },
  }));
  return summarizeSweep("creatorTaskActivity", items);
}

async function runRetentionSweep(options = {}) {
  const startedAt = Date.now();
  const useLock = options?.useAdvisoryLock !== false;
  let lockAcquired = false;

  if (useLock) {
    lockAcquired = await tryAcquireRetentionLock();
    if (!lockAcquired) {
      return { ok: true, skipped: true, reason: "lock_held", elapsedMs: Date.now() - startedAt, totalDeleted: 0 };
    }
  }

  try {
    const [teamActivity, teamLedgers, traffic, automation, dialogIntelligence, auditLogs, creatorTaskActivity] = await Promise.all([
      runTeamActivityRetentionSweep(options),
      runTeamLedgerRetentionSweep(options),
      runTrafficRetentionSweep(options),
      runAutomationRetentionSweep(options),
      runDialogIntelligenceRetentionSweep(options),
      runAuditLogRetentionSweep(options),
      runCreatorTaskActivityRetentionSweep(options),
    ]);

    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      totalDeleted: (teamActivity.totalDeleted || 0) + (teamLedgers.totalDeleted || 0) + (traffic.totalDeleted || 0) + (automation.totalDeleted || 0) + (dialogIntelligence.totalDeleted || 0) + (auditLogs.totalDeleted || 0) + (creatorTaskActivity.totalDeleted || 0),
      teamActivity,
      teamLedgers,
      traffic,
      automation,
      dialogIntelligence,
      auditLogs,
      creatorTaskActivity,
      lock: useLock ? "advisory" : "disabled",
    };
  } finally {
    if (useLock && lockAcquired) await releaseRetentionLock();
  }
}

function summarizeSweep(label, items) {
  const totalDeleted = items.reduce((sum, item) => sum + Number(item?.deleted || 0), 0);
  return { label, totalDeleted, items };
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
  getRetentionSettings,
  updateRetentionSettings,
  resetRetentionSettings,
  defaultRetentionSettings,
  normalizeRetentionSettings,
  retentionSchema,
  tryAcquireRetentionLock,
  releaseRetentionLock,
};
