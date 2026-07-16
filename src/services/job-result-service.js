"use strict";

const prisma = require("../prisma");
const { applyPresenceJobResult } = require("./presence-service");
const { CATCHUP_JOB_KEY, applyCatchupJobResult, recordCatchupJobFailure } = require("./team-observation-service");
const { TRAFFIC_SOURCES_SCAN_JOB_KEY, upsertTrafficSourceScan } = require("./traffic-service");
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

async function applyEarningsResult({ job, deviceId, userId, result }) {
  if (!job.creatorId || !job.agencyId) throw new Error("Earnings job is missing creator scope");
  const payload = asObject(result);
  const summary = asObject(payload.summary);
  const range = asObject(payload.range);
  const rangeKey = String(payload.rangeKey || job.params?.rangeKey || "7d").trim() || "7d";
  const data = {
    creatorId: job.creatorId,
    agencyId: job.agencyId,
    rangeKey,
    rangeStartAt: dateOrNull(range.startDate),
    rangeEndAt: dateOrNull(range.endDate),
    totalCents: BigInt(cents(summary.totalCents ?? summary.total)),
    grossCents: BigInt(cents(summary.grossCents ?? summary.gross)),
    deltaCents: BigInt(cents(summary.deltaCents ?? summary.delta)),
    avgSaleCents: cents(summary.avgSaleCents ?? summary.avgSale),
    fanLtvCents: cents(summary.fanLtvCents ?? summary.fanLtv),
    salesCount: integer(summary.salesCount),
    uniqueFans: integer(summary.uniqueFans),
    raw: payload.raw ?? null,
    capturedAt: new Date(),
    capturedByDeviceId: deviceId,
    capturedByUserId: userId,
  };
  const snapshot = await prisma.creatorEarningsSnapshot.upsert({
    where: { creatorId_rangeKey: { creatorId: job.creatorId, rangeKey } },
    create: data,
    update: data,
  });
  return { type: "earnings", snapshotId: snapshot.id, rangeKey, totalCents: Number(data.totalCents), salesCount: data.salesCount };
}

async function applyCampaignsResult({ job, deviceId, userId, result }) {
  if (!job.creatorId || !job.agencyId) throw new Error("Campaigns job is missing creator scope");
  const payload = asObject(result);
  const campaigns = Array.isArray(payload.campaigns) ? payload.campaigns.slice(0, 2000) : [];
  const rangeKey = String(payload.rangeKey || job.params?.rangeKey || "7d").trim() || "7d";
  let totalActive = 0;
  let totalClaimers = 0;
  let totalClicks = 0;
  for (const campaign of campaigns) {
    if (campaign?.is_active === true || campaign?.isActive === true) totalActive += 1;
    totalClaimers += integer(campaign?.claimers_count ?? campaign?.claimersCount);
    totalClicks += integer(campaign?.clicks_count ?? campaign?.clicksCount);
  }
  const data = {
    creatorId: job.creatorId,
    agencyId: job.agencyId,
    rangeKey,
    campaigns,
    totalActive,
    totalClaimers,
    totalClicks,
    capturedAt: new Date(),
    capturedByDeviceId: deviceId,
    capturedByUserId: userId,
  };
  const snapshot = await prisma.creatorCampaignsSnapshot.upsert({
    where: { creatorId: job.creatorId },
    create: data,
    update: data,
  });
  return { type: "campaigns", snapshotId: snapshot.id, rangeKey, campaignCount: campaigns.length, totalActive, totalClaimers, totalClicks };
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
  if (job.jobKey === DIALOG_INTELLIGENCE_JOB_KEY) {
    return applyDialogIntelligenceChunk({ db, job, deviceId, userId, chunkResult });
  }
  if (job.jobKey === VAULT_UNSORTED_JOB_KEY) {
    return applyVaultUnsortedChunk({ db, job, deviceId, userId, chunkResult });
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
  if (job.jobKey === EARNINGS_JOB_KEY) return applyEarningsResult({ job, deviceId, userId, result });
  if (job.jobKey === CAMPAIGNS_JOB_KEY) return applyCampaignsResult({ job, deviceId, userId, result });
  if (job.jobKey === TRAFFIC_SOURCES_SCAN_JOB_KEY) return applyTrafficResult({ job, deviceId, userId, result });
  if (job.jobKey === PRESENCE_JOB_KEY) return applyPresenceJobResult({ job, deviceId, result: result || {} });
  if (job.jobKey === CATCHUP_JOB_KEY) return applyCatchupJobResult({ job, deviceId, userId, result: result || {} });
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
