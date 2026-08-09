"use strict";

const prisma = require("../prisma");
const { applyPresenceJobResult } = require("./presence-service");
const { CATCHUP_JOB_KEY, applyCatchupJobResult, recordCatchupJobFailure } = require("./team-observation-service");
const { ingestNotificationFacts } = require("./notification-facts-service");
const { recordNotificationPageProgress } = require("./notification-sync-state-service");
const { recordNotificationScanItems } = require("./notification-scan-control-service");
const { JOB_KEY: FINANCIAL_TRANSACTIONS_JOB_KEY, ingestFinancialTransactionsChunk, ingestFinancialChartChunk, completeFinancialTransactionsScan } = require("./financial-transactions-service");
const { TRAFFIC_SOURCES_SCAN_JOB_KEY, upsertTrafficSourceScan } = require("./traffic-service");
const { ingestEarningsChunk, completeEarningsScan, ingestCampaignChunk, ingestCampaignFanValueChunk, ingestCampaignFanValuesBatchChunk, completeCampaignScan } = require("./creator-analytics-ledger-service");
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
  cleanupSubscriberScanHistory,
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
const PRESENCE_JOB_KEY = "refresh_online_presence";

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

async function applyEarningsResult({ db = prisma, job, deviceId, userId, result }) {
  if (!job.creatorId || !job.agencyId) throw new Error("Earnings job is missing creator scope");
  const payload = asObject(result);
  const summary = asObject(payload.summary);
  const range = asObject(payload.range);
  const rangeKey = String(payload.rangeKey || job.params?.rangeKey || "7d").trim() || "7d";
  const dailyLedger = await completeEarningsScan({ db, job, deviceId, result: payload });
  let snapshot = null;
  const totalValue = summary.totalCents ?? summary.total;
  const grossValue = summary.grossCents ?? summary.gross;
  const deltaValue = summary.deltaCents ?? summary.delta;
  const legacySalesCountKnown = Number.isInteger(summary.salesCount) && summary.salesCount >= 0;
  const legacyUniqueFansKnown = Number.isInteger(summary.uniqueFans) && summary.uniqueFans >= 0;
  const canWriteLegacySnapshot = dailyLedger.complete === true
    && totalValue !== null && totalValue !== undefined
    && grossValue !== null && grossValue !== undefined
    && deltaValue !== null && deltaValue !== undefined
    && legacySalesCountKnown
    && legacyUniqueFansKnown;
  if (canWriteLegacySnapshot) {
    const data = {
      creatorId: job.creatorId,
      agencyId: job.agencyId,
      rangeKey,
      rangeStartAt: dateOrNull(range.startDate),
      rangeEndAt: dateOrNull(range.endDate),
      totalCents: BigInt(cents(totalValue)),
      grossCents: BigInt(cents(grossValue)),
      deltaCents: BigInt(cents(deltaValue)),
      avgSaleCents: summary.avgSaleCents == null && summary.avgSale == null ? 0 : cents(summary.avgSaleCents ?? summary.avgSale),
      fanLtvCents: summary.fanLtvCents == null && summary.fanLtv == null ? 0 : cents(summary.fanLtvCents ?? summary.fanLtv),
      salesCount: integer(summary.salesCount),
      uniqueFans: integer(summary.uniqueFans),
      raw: null,
      capturedAt: new Date(),
      capturedByDeviceId: deviceId,
      capturedByUserId: userId,
    };
    snapshot = await db.creatorEarningsSnapshot.upsert({
      where: { creatorId_rangeKey: { creatorId: job.creatorId, rangeKey } },
      create: data,
      update: data,
    });
  }
  return {
    ok: dailyLedger.complete === true,
    type: "earnings",
    snapshotId: snapshot?.id || null,
    rangeKey,
    totalCents: totalValue == null ? null : cents(totalValue),
    salesCount: legacySalesCountKnown ? summary.salesCount : null,
    uniqueFans: legacyUniqueFansKnown ? summary.uniqueFans : null,
    dailyLedger,
  };
}

async function applyCampaignsResult({ db = prisma, job, deviceId, userId, result }) {
  if (!job.creatorId || !job.agencyId) throw new Error("Campaigns job is missing creator scope");
  const payload = asObject(result);
  const completion = await completeCampaignScan({ db, job, deviceId, result: payload });
  const rangeKey = String(payload.rangeKey || job.params?.rangeKey || "7d").trim() || "7d";
  if (completion.complete !== true) {
    return { ok: false, type: "campaigns", rangeKey, completion };
  }

  // The relational campaign/fan tables are the sole source of truth. Do not
  // re-materialize the full campaign list into the legacy Json snapshot: that
  // would recreate the opaque storage architecture this ledger replaces.
  const [campaignCount, totalActive, fanGroups] = await Promise.all([
    db.creatorCampaign.count({ where: { creatorId: job.creatorId } }),
    db.creatorCampaign.count({ where: { creatorId: job.creatorId, isActive: true } }),
    db.creatorCampaignFan.groupBy({
      by: ["campaignId"],
      where: { creatorId: job.creatorId },
      _count: { _all: true },
    }),
  ]);
  const totalClaimers = fanGroups.reduce((sum, row) => sum + Number(row._count?._all || 0), 0);
  return {
    ok: true,
    type: "campaigns",
    snapshotId: null,
    rangeKey,
    campaignCount,
    totalActive,
    totalClaimers,
    completion,
  };
}

async function applyTrafficResult({ job, deviceId, userId, result }) {
  if (!job.creatorId) throw new Error("Traffic job is missing creatorId");
  const payload = asObject(result);
  const params = asObject(job.params);
  const applied = await upsertTrafficSourceScan({
    deviceId,
    userId,
    creatorId: job.creatorId,
    accountId: payload.accountId || params.localAccountId || params.accountId || null,
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    members: Array.isArray(payload.members) ? payload.members : [],
    hydrateLimit: integer(payload.hydrateLimit ?? params.hydrateLimit, 0),
    forceHydrate: payload.forceHydrate === true || params.forceHydrate === true,
  });
  return { type: "traffic", ...asObject(applied) };
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
  if (job.jobKey === LIKES_DISCOVERY_JOB_KEY) {
    return applyLikesDiscoveryChunk({ db, job, deviceId, userId, chunkResult });
  }
  if (job.jobKey === SFS_DISCOVERY_JOB_KEY) return applySfsDiscoveryChunk({ db, job, deviceId, userId, chunkResult });
  if (chunkResult !== undefined && chunkResult !== null) {
    throw new Error(`No backend chunk applier registered for ${job.jobKey}`);
  }
  return null;
}

async function applyJobResult({ db = prisma, job, deviceId, userId, result }) {
  if (job.jobKey === DIALOG_INTELLIGENCE_JOB_KEY) {
    return completeDialogIntelligenceJob({ db, job, deviceId, userId, result: result || {} });
  }
  if (job.jobKey === VAULT_UNSORTED_JOB_KEY) {
    return applyVaultUnsortedCompletion({ db, job, deviceId, userId, result: result || {} });
  }
  if (job.jobKey === FINANCIAL_TRANSACTIONS_JOB_KEY) return completeFinancialTransactionsScan({ db, job, deviceId, result: result || {} });
  if (job.jobKey === EARNINGS_JOB_KEY) return applyEarningsResult({ db, job, deviceId, userId, result });
  if (job.jobKey === CAMPAIGNS_JOB_KEY) return applyCampaignsResult({ db, job, deviceId, userId, result });
  if (job.jobKey === TRAFFIC_SOURCES_SCAN_JOB_KEY) return applyTrafficResult({ job, deviceId, userId, result });
  if (job.jobKey === PRESENCE_JOB_KEY) return applyPresenceJobResult({ job, deviceId, result: result || {} });
  if (job.jobKey === CATCHUP_JOB_KEY) return applyCatchupJobResult({ db, job, deviceId, userId, result: result || {} });
  if (job.jobKey === LIKES_DISCOVERY_JOB_KEY) return applyLikesDiscoveryCompletion({ job, deviceId, userId, result: result || {} });
  if (job.jobKey === SFS_DISCOVERY_JOB_KEY) return applySfsDiscoveryCompletion({ job, deviceId, userId, result: result || {} });
  if (job.jobKey === SFS_TARGET_SCAN_JOB_KEY) return applySfsTargetScanCompletion({ job, deviceId, userId, result: result || {} });
  if (job.jobKey === SUBSCRIBER_DIRECTORY_JOB_KEY) {
    const applied = await applySubscriberScanCompletion({ job, deviceId, userId, result: result || {} });
    cleanupSubscriberScanHistory({ creatorId: job.creatorId }).catch(() => null);
    return applied;
  }
  throw new Error(`No backend result applier registered for ${job.jobKey}`);
}

async function recordJobFailure({ job, error, terminal = true }) {
  if (job.jobKey === DIALOG_INTELLIGENCE_JOB_KEY) {
    return recordDialogIntelligenceFailure({ job, error, terminal });
  }
  if (job.jobKey === VAULT_UNSORTED_JOB_KEY) return recordVaultUnsortedFailure({ job, error, terminal });
  if (job.jobKey === CATCHUP_JOB_KEY) return recordCatchupJobFailure({ job, error });
  if (job.jobKey === SUBSCRIBER_DIRECTORY_JOB_KEY) return recordSubscriberScanFailure({ job, error, terminal });
  if (job.jobKey === LIKES_DISCOVERY_JOB_KEY) return recordLikesDiscoveryFailure({ job, error, terminal });
  if ([SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY].includes(job.jobKey)) return recordSfsJobFailure({ job, error, terminal });
  return null;
}

module.exports = { EARNINGS_JOB_KEY, CAMPAIGNS_JOB_KEY, applyJobChunk, applyJobResult, recordJobFailure };
