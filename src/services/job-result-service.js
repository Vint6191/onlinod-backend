"use strict";
const { runDbTransaction } = require("./db-transaction-service");


const prisma = require("../prisma");
const { CATCHUP_JOB_KEY, applyCatchupJobResult, recordCatchupJobFailure } = require("./team-observation-service");
const { ingestNotificationFacts } = require("./notification-facts-service");
const { recordNotificationPageProgress, assertNotificationCollectionResult } = require("./notification-sync-state-service");
const { recordNotificationScanItems } = require("./notification-scan-control-service");
const { JOB_KEY: FINANCIAL_TRANSACTIONS_JOB_KEY, ingestFinancialTransactionsChunk, ingestFinancialChartChunk, completeFinancialTransactionsScan, recordFinancialCollectionFailure } = require("./financial-transactions-service");
const { FAN_DATA_POINT_REFRESH_JOB_KEY, applyFanDataPointRefreshChunk } = require("./fan-data-authority-service");
const { recordCampaignFanRefreshChunk, finalizeCampaignFanRefreshJob, recordCampaignFanRefreshJobFailure } = require("./campaign-fan-refresh-queue-service");
const { ingestEarningsChunk, completeEarningsScan, ingestCampaignChunk, loadCampaignDirectorySegment, ingestCampaignFanValueChunk, ingestCampaignFanValuesBatchChunk, completeCampaignScan } = require("./creator-analytics-ledger-service");
const { recordCampaignCollectionFailure } = require("./analytics-collector-control-service");
const {
  LIKES_DISCOVERY_JOB_KEY,
  applyLikesDiscoveryChunk,
  applyLikesDiscoveryCompletion,
  recordLikesDiscoveryFailure,
} = require("./likes-service");
const {
  SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY,
  applySfsDiscoveryChunk, applySfsDiscoveryCompletion, applySfsTargetScanCompletion, recordSfsJobFailure,
} = require("./sfs-service");
const {
  SUBSCRIBER_DIRECTORY_JOB_KEY,
  applySubscriberScanChunk,
  applySubscriberScanCompletion,
  recordSubscriberScanFailure,
} = require("./subscriber-directory-service");

const {
  VAULT_UNSORTED_JOB_KEY,
  applyVaultUnsortedChunk,
  applyVaultUnsortedCompletion,
  recordVaultUnsortedFailure,
} = require("./vault-unsorted-service");
const {
  DIALOG_INTELLIGENCE_JOB_KEY,
  applyDialogIntelligenceChunk,
  applyPurchaseSignalsChunk,
  completeDialogIntelligenceJob,
  recordDialogIntelligenceFailure,
} = require("./dialog-intelligence-service");

const EARNINGS_JOB_KEY = "fetch_earnings";
const CAMPAIGNS_JOB_KEY = "fetch_campaigns";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function integer(value, fallback = 0) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}
function cents(value) {
  return Math.round(finite(value, 0));
}
function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function applyEarningsResult({ db = prisma, job, deviceId, result, publication }) {
  if (!job.creatorId || !job.agencyId) throw new Error("Earnings job is missing creator scope");
  const payload = asObject(result);
  const summary = asObject(payload.summary);
  const dailyLedger = await completeEarningsScan({ db, job, deviceId, result: payload, publication });
  return {
    ok: dailyLedger.complete === true,
    type: "earnings",
    scanProofId: dailyLedger.scanProofId || null,
    totalCents: summary.totalCents == null ? null : cents(summary.totalCents),
    dailyLedger,
  };
}

async function applyCampaignsResult({ db = prisma, job, deviceId, userId, result, publication }) {
  if (!job.creatorId || !job.agencyId) throw new Error("Campaigns job is missing creator scope");
  const payload = asObject(result);
  const completion = await completeCampaignScan({ db, job, deviceId, result: payload, publication });
  const rangeKey = String(payload.rangeKey || job.params?.rangeKey || "7d").trim() || "7d";
  // FanData refresh is delegated to a separate durable queue. Once provider
  // membership traversal is proven, finish this OF-reading job even if that
  // asynchronous queue is still outstanding; otherwise every refresh backlog
  // turns into a second full Campaign provider traversal.
  if (completion.providerTraversalComplete !== true) {
    return { ok: false, type: "campaigns", rangeKey, completion };
  }

  // The relational campaign/fan tables are the sole source of truth. Do not
  // re-materialize the full campaign list into the legacy Json snapshot: that
  // would recreate the opaque storage architecture this ledger replaces.
  // Provider completion is independent of summary/history projections.
  const campaignCount = completion.proof?.observedCampaignCount ?? 0;
  return {
    ok: true,
    type: "campaigns",
    snapshotId: null,
    rangeKey,
    campaignCount,
    summaryPending: true,
    refreshPending: completion.complete !== true,
    completion,
  };
}

async function applyJobChunk({ db, job, deviceId, userId, chunkResult }) {
  // Async scanners may have already flushed every compact batch and use the
  // final progress call only to switch driverPhase to complete. No payload is a
  // valid no-op; never route it into a job-specific chunk parser.
  if (chunkResult === undefined || chunkResult === null) return null;
  if (job.jobKey === FINANCIAL_TRANSACTIONS_JOB_KEY && chunkResult?.kind === "financial_transactions_page") {
    return ingestFinancialTransactionsChunk({ db, job, deviceId, chunk: chunkResult });
  }
  if (job.jobKey === FINANCIAL_TRANSACTIONS_JOB_KEY && chunkResult?.kind === "financial_chart_total") {
    return ingestFinancialChartChunk({ db, job, deviceId, chunk: chunkResult });
  }
  if (job.jobKey === EARNINGS_JOB_KEY && chunkResult?.kind === "earnings_daily_page") {
    return ingestEarningsChunk({ db, job, deviceId, chunk: chunkResult });
  }
  if (job.jobKey === CAMPAIGNS_JOB_KEY && ["campaigns_page", "campaign_claimers_page"].includes(chunkResult?.kind)) {
    return ingestCampaignChunk({ db, job, deviceId, chunk: chunkResult });
  }
  if (job.jobKey === CAMPAIGNS_JOB_KEY && chunkResult?.kind === "campaign_directory_segment") {
    return loadCampaignDirectorySegment({ db, job, chunk: chunkResult });
  }
  if (job.jobKey === CAMPAIGNS_JOB_KEY && chunkResult?.kind === "campaign_fan_value") {
    return ingestCampaignFanValueChunk({ db, job, deviceId, chunk: chunkResult });
  }
  if (job.jobKey === CAMPAIGNS_JOB_KEY && chunkResult?.kind === "campaign_fan_values_batch") {
    return ingestCampaignFanValuesBatchChunk({ db, job, deviceId, chunk: chunkResult });
  }
  if (job.jobKey === DIALOG_INTELLIGENCE_JOB_KEY) {
    return applyDialogIntelligenceChunk({ db, job, deviceId, userId, chunkResult });
  }
  if (job.jobKey === VAULT_UNSORTED_JOB_KEY) {
    return applyVaultUnsortedChunk({ db, job, deviceId, userId, chunkResult });
  }
  if (job.jobKey === CATCHUP_JOB_KEY && chunkResult?.kind === "notification_facts_page_all") {
    assertNotificationCollectionResult({ job, scanRunId: chunkResult.scanRunId, notificationMode: chunkResult.notificationMode });
    const batches = Array.isArray(chunkResult.batches) ? chunkResult.batches : [];
    if (batches.length > 5) throw new Error("Notification ALL page contains too many typed batches");
    const seenTypes = new Set();
    const applied = [];
    for (const batch of batches) {
      const type = String(batch?.notificationType || "").trim().toLowerCase();
      if (!["purchases", "tips", "subscriptions", "likes", "comments"].includes(type)) {
        throw new Error("Unsupported notification ALL typed batch");
      }
      if (seenTypes.has(type)) throw new Error(`Duplicate notification ALL typed batch: ${type}`);
      seenTypes.add(type);
      const events = Array.isArray(batch?.events) ? batch.events : [];
      if (events.length > 100) throw new Error("Notification ALL typed batch exceeds 100 events");
      let ledger = null;
      if (events.length > 0) {
        ledger = await ingestNotificationFacts({
          db, job, deviceId,
          result: {
            events,
            notificationType: type,
            batchKey: batch.batchKey,
            finalizeCoverage: false,
            sourceTimezone: chunkResult.sourceTimezone,
            scanRunId: chunkResult.scanRunId,
            collectorVersion: chunkResult.collectorVersion,
            schemaVersion: chunkResult.schemaVersion,
            coverage: { [type]: { status: "partial" } },
          },
        });
      }
      const rawSignals = Array.isArray(batch?.purchaseSignals) ? batch.purchaseSignals : [];
      if (rawSignals.length > 100) throw new Error("Notification ALL purchase signal page exceeds 100 events");
      const purchaseSignals = rawSignals.length
        ? await applyPurchaseSignalsChunk({ db, job, deviceId, userId, chunkResult: { kind: "dialog_purchase_signals", signals: rawSignals } })
        : null;
      applied.push({ notificationType: type, ledger, purchaseSignals });
    }
    const audit = await recordNotificationScanItems({ db, job, chunk: chunkResult });
    const syncState = await recordNotificationPageProgress({ db, job, deviceId, chunk: chunkResult });
    return { type: "notification_facts_page_all", batches: applied, audit, syncStateId: syncState?.id || null };
  }
  if (job.jobKey === CATCHUP_JOB_KEY && chunkResult?.kind === "notification_facts_page") {
    assertNotificationCollectionResult({ job, scanRunId: chunkResult.scanRunId, notificationMode: chunkResult.notificationMode });
    const type = String(chunkResult.notificationType || "").trim().toLowerCase();
    if (!["purchases", "tips", "subscriptions", "likes", "comments"].includes(type)) throw new Error("Unsupported notification facts page type");
    const events = Array.isArray(chunkResult.events) ? chunkResult.events.slice(0, 100) : [];
    if (events.length !== (Array.isArray(chunkResult.events) ? chunkResult.events.length : 0)) {
      throw new Error("Notification facts page exceeds 100 events");
    }
    const ledger = await ingestNotificationFacts({
      db, job, deviceId,
      result: {
        events,
        notificationType: type,
        batchKey: chunkResult.batchKey,
        finalizeCoverage: false,
        sourceTimezone: chunkResult.sourceTimezone,
        scanRunId: chunkResult.scanRunId,
        collectorVersion: chunkResult.collectorVersion,
        schemaVersion: chunkResult.schemaVersion,
        coverage: { [type]: { status: "partial" } },
      },
    });
    const rawSignals = Array.isArray(chunkResult.purchaseSignals) ? chunkResult.purchaseSignals : [];
    if (rawSignals.length > 100) throw new Error("Notification purchase signal page exceeds 100 events");
    const signals = rawSignals;
    const purchaseSignals = signals.length
      ? await applyPurchaseSignalsChunk({ db, job, deviceId, userId, chunkResult: { kind: "dialog_purchase_signals", signals } })
      : null;
    return { type: "notification_facts_page", ledger, purchaseSignals };
  }
  if (job.jobKey === CATCHUP_JOB_KEY && chunkResult?.kind === "dialog_purchase_signals") {
    return applyPurchaseSignalsChunk({ db, job, deviceId, userId, chunkResult });
  }
  if (job.jobKey === SUBSCRIBER_DIRECTORY_JOB_KEY) {
    return applySubscriberScanChunk({ db, job, deviceId, userId, chunkResult });
  }
  if (job.jobKey === FAN_DATA_POINT_REFRESH_JOB_KEY) {
    const applyPointRefresh = async (tx) => {
      const applied = await applyFanDataPointRefreshChunk({ db: tx, job, deviceId, chunkResult });
      await recordCampaignFanRefreshChunk({ db: tx, job, chunkResult, applied });
      return applied;
    };
    // Campaign freshness demand/result projection must commit atomically with
    // canonical FanData. A process crash may not leave fresh data committed
    // while the waiting Campaign runs remain permanently OUTSTANDING.
    return runDbTransaction(db, applyPointRefresh);
  }
  if (job.jobKey === LIKES_DISCOVERY_JOB_KEY) {
    return applyLikesDiscoveryChunk({ db, job, deviceId, userId, chunkResult });
  }
  if (job.jobKey === SFS_DISCOVERY_JOB_KEY) return applySfsDiscoveryChunk({ db, job, deviceId, userId, chunkResult });
  if (chunkResult !== undefined && chunkResult !== null) {
    throw new Error(`No backend chunk applier registered for ${job.jobKey}`);
  }
  return null;
}

async function applyJobResult({ db = prisma, job, deviceId, userId, result, publication }) {
  if (job.jobKey === DIALOG_INTELLIGENCE_JOB_KEY) {
    return completeDialogIntelligenceJob({ db, job, deviceId, userId, result: result || {} });
  }
  if (job.jobKey === VAULT_UNSORTED_JOB_KEY) {
    return applyVaultUnsortedCompletion({ db, job, deviceId, userId, result: result || {} });
  }
  if (job.jobKey === FINANCIAL_TRANSACTIONS_JOB_KEY) return completeFinancialTransactionsScan({ db, job, deviceId, result: result || {}, publication });
  if (job.jobKey === EARNINGS_JOB_KEY) return applyEarningsResult({ db, job, deviceId, userId, result, publication });
  if (job.jobKey === CAMPAIGNS_JOB_KEY) return applyCampaignsResult({ db, job, deviceId, userId, result, publication });
  if (job.jobKey === "traffic_sources_scan") throw Object.assign(new Error("TRAFFIC_SOURCE_INGEST_RETIRED"), { code: "TRAFFIC_SOURCE_INGEST_RETIRED", status: 410 });
  if (job.jobKey === CATCHUP_JOB_KEY) return applyCatchupJobResult({ db, job, deviceId, userId, result: result || {} });
  if (job.jobKey === LIKES_DISCOVERY_JOB_KEY) return applyLikesDiscoveryCompletion({ db, job, deviceId, userId, result: result || {} });
  if (job.jobKey === SFS_DISCOVERY_JOB_KEY) return applySfsDiscoveryCompletion({ db, job, deviceId, userId, result: result || {} });
  if (job.jobKey === SFS_TARGET_SCAN_JOB_KEY) return applySfsTargetScanCompletion({ db, job, deviceId, userId, result: result || {} });
  if (job.jobKey === FAN_DATA_POINT_REFRESH_JOB_KEY) {
    const demandCoverage = await finalizeCampaignFanRefreshJob({ db, job, result: result || {} });
    return { ok: true, type: "fan_data_point_refresh", ...(asObject(result)), demandCoverage };
  }
  if (job.jobKey === SUBSCRIBER_DIRECTORY_JOB_KEY) {
    return applySubscriberScanCompletion({ db, job, deviceId, userId, result: result || {} });
  }
  throw new Error(`No backend result applier registered for ${job.jobKey}`);
}

async function recordJobFailure({ db = prisma, job, error, terminal = true, retryAfterAt = null }) {
  if (job.jobKey === FINANCIAL_TRANSACTIONS_JOB_KEY) return recordFinancialCollectionFailure({ db, job, error, terminal, retryAfterAt });
  if (job.jobKey === CAMPAIGNS_JOB_KEY) return recordCampaignCollectionFailure({ db, job, error, terminal, retryAfterAt });
  if (job.jobKey === DIALOG_INTELLIGENCE_JOB_KEY) {
    return recordDialogIntelligenceFailure({ db, job, error, terminal });
  }
  if (job.jobKey === VAULT_UNSORTED_JOB_KEY) return recordVaultUnsortedFailure({ db, job, error, terminal });
  if (job.jobKey === CATCHUP_JOB_KEY) return recordCatchupJobFailure({ db, job, error, terminal, retryAfterAt });
  if (job.jobKey === SUBSCRIBER_DIRECTORY_JOB_KEY) return recordSubscriberScanFailure({ db, job, error, terminal });
  if (job.jobKey === LIKES_DISCOVERY_JOB_KEY) return recordLikesDiscoveryFailure({ db, job, error, terminal });
  if ([SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY].includes(job.jobKey)) return recordSfsJobFailure({ db, job, error, terminal });
  if (job.jobKey === FAN_DATA_POINT_REFRESH_JOB_KEY) return recordCampaignFanRefreshJobFailure({ db, job, error, terminal });
  return null;
}

module.exports = { EARNINGS_JOB_KEY, CAMPAIGNS_JOB_KEY, applyJobChunk, applyJobResult, recordJobFailure };
