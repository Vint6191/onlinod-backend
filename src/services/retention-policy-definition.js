"use strict";
const DEFAULT_BATCH_SIZE = 2000;
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

  refreshSessionRawHistoryDays: {
    label: "Refresh-session raw token history",
    unit: "days after token expiry",
    env: "ONLINOD_REFRESH_SESSION_RAW_HISTORY_DAYS",
    fallback: 30,
    min: 7,
    max: 3650,
    hint: "Keep revoked/expired raw refresh-token rows for reuse/security evidence after their original expiry. Ended authorization lineages are compacted into AuthorizationSessionBoundary before raw rows are purged.",
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


module.exports = { DEFAULT_BATCH_SIZE, defaultRetentionSettings, normalizeRetentionSettings, retentionSchema };
