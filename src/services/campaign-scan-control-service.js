"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { scheduleJobNow } = require("./job-scheduler");
const { readCampaignsWithRevenue } = require("./creator-analytics-ledger-service");

const JOB_KEY = "fetch_campaigns";
const MANUAL_REASON = "manual_creator_analytics_campaign_scan";
const ACTIVE_STATUSES = new Set(["SCHEDULED", "CLAIMED", "PAUSED"]);
const MANUAL_VERSION = 1;

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function clean(value, max = 220) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
function integer(value, fallback = 0, max = 100_000_000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(max, parsed);
}
function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function isManualJob(job) {
  const params = object(job?.params);
  return params.manualCampaignScan === true && params.manualCampaignScanVersion === MANUAL_VERSION;
}
function jobStatus(job) {
  if (!job) return "IDLE";
  if (job.status === "SCHEDULED") return "QUEUED";
  if (job.status === "CLAIMED") return "RUNNING";
  if (job.status === "PAUSED") return "PAUSED";
  if (job.status === "FAILED") return "FAILED";
  if (job.status === "CANCELLED") return "CANCELLED";
  if (job.status === "DONE") {
    const result = object(job.result);
    const complete = result.campaignPagesComplete === true && result.claimersComplete === true && result.truncated !== true
      && integer(result.campaignScannerRejected, 0) === 0 && integer(result.claimerScannerRejected, 0) === 0;
    return complete ? "COMPLETE" : "PARTIAL";
  }
  return String(job.status || "IDLE").toUpperCase();
}
async function recentJobs(db, creatorId, statuses = null, take = 40) {
  const rows = await db.jobInstance.findMany({
    where: { creatorId, jobKey: JOB_KEY, ...(statuses ? { status: { in: statuses } } : {}) },
    orderBy: [{ createdAt: "desc" }],
    take,
  });
  return rows.filter(isManualJob);
}
async function activeJob(db, creatorId) {
  const rows = await recentJobs(db, creatorId, ["SCHEDULED", "CLAIMED", "PAUSED"], 40);
  return rows.find((row) => ACTIVE_STATUSES.has(row.status)) || null;
}
async function countOnlineBindings(db, creator) {
  const freshAfter = new Date(Date.now() - 2 * 60 * 1000);
  return db.deviceCreatorBinding.count({
    where: {
      creatorId: creator.id,
      agencyId: creator.agencyId,
      status: "ACTIVE",
      lastSeenAt: { gte: freshAfter },
      device: { lastSeenAt: { gte: freshAfter } },
    },
  });
}

async function startManualCampaignScan({ db = prisma, creator, requestedByUserId = null, now = new Date() }) {
  if (!creator?.id || !creator?.agencyId) throw new Error("Creator scope is required");
  const active = await activeJob(db, creator.id);
  if (active?.status === "PAUSED") {
    const resumed = await db.jobInstance.update({
      where: { id: active.id },
      data: {
        status: "SCHEDULED",
        nextRunAt: now,
        scheduledAt: now,
        claimedAt: null,
        claimedByDeviceId: null,
        leaseUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
        workId: null,
        completedAt: null,
        lastError: null,
      },
    });
    return { job: resumed, action: "resumed" };
  }
  if (active) return { job: active, action: active.status === "CLAIMED" ? "already_running" : "already_queued" };

  const params = {
    manualCampaignScan: true,
    manualCampaignScanVersion: MANUAL_VERSION,
    manualRunToken: crypto.randomUUID(),
    requestedByUserId: clean(requestedByUserId, 220),
    reason: MANUAL_REASON,
    pageSize: 50,
    maxPages: 40,
    claimerPageSize: 50,
    maxClaimerPages: 10_000,
  };
  const scheduled = await scheduleJobNow({
    jobKey: JOB_KEY,
    creatorId: creator.id,
    agencyId: creator.agencyId,
    params,
    priority: 100,
    now,
    bucketMs: 1,
  });
  return { job: scheduled.job, action: scheduled.reason === "already_claimed" ? "already_running" : "created" };
}

async function stopManualCampaignScan({ db = prisma, creatorId, now = new Date() }) {
  const active = await activeJob(db, creatorId);
  if (!active) return { job: null, action: "idle" };
  if (active.status === "PAUSED") return { job: active, action: "already_paused" };
  const result = await db.jobInstance.updateMany({
    where: { id: active.id, status: { in: ["SCHEDULED", "CLAIMED"] } },
    data: {
      status: "PAUSED",
      claimedAt: null,
      claimedByDeviceId: null,
      leaseUntil: null,
      leaseTokenHash: null,
      leaseRevision: { increment: 1 },
      workId: null,
      completedAt: null,
      lastError: null,
      lastProgressAt: active.lastProgressAt || now,
    },
  });
  if (!result.count) {
    const current = await db.jobInstance.findUnique({ where: { id: active.id } });
    return { job: current, action: current?.status === "PAUSED" ? "already_paused" : "changed" };
  }
  return { job: await db.jobInstance.findUnique({ where: { id: active.id } }), action: "paused" };
}

function campaignForClient(row) {
  return {
    id: row.id,
    externalCampaignId: row.externalCampaignId,
    name: row.name,
    campaignType: row.campaignType,
    trackingCode: row.trackingCode,
    trackingUrl: row.trackingUrl,
    isActive: row.isActive === true,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    claimersCount: row.claimersCount,
    clicksCount: row.clicksCount,
    fansCount: integer(row.fansCount, 0),
    payingFans: integer(row.payingFans, 0),
    transactionsCount: integer(row.transactionsCount, 0),
    grossCents: Number(row.grossCents || 0),
    netCents: Number(row.netCents || 0),
    settledTransactionsCount: integer(row.settledTransactionsCount, 0),
    settledGrossCents: Number(row.settledGrossCents || 0),
    settledNetCents: Number(row.settledNetCents || 0),
    pendingTransactionsCount: integer(row.pendingTransactionsCount, 0),
    pendingGrossCents: Number(row.pendingGrossCents || 0),
    pendingNetCents: Number(row.pendingNetCents || 0),
    ofValueKnownFans: integer(row.ofValueKnownFans, 0),
    ofValuePayingFans: integer(row.ofValuePayingFans, 0),
    ofValueNetCents: Number(row.ofValueNetCents || 0),
    ofValueFetchedAt: iso(row.ofValueFetchedAt),
  };
}

async function readManualCampaignScan({ db = prisma, creator, limit = 100, offset = 0 }) {
  if (!creator?.id || !creator?.agencyId) throw new Error("Creator scope is required");
  const jobs = await recentJobs(db, creator.id, null, 60);
  const job = jobs[0] || null;
  const status = jobStatus(job);
  const safeLimit = Math.max(1, Math.min(200, integer(limit, 100, 200)));
  const safeOffset = Math.max(0, Math.min(1_000_000, integer(offset, 0, 1_000_000)));
  const progress = object(job?.progress);
  const result = object(job?.result);
  const continuationEnvelope = object(job?.continuation);
  const continuation = continuationEnvelope.driverPhase === "execute" ? object(continuationEnvelope.jobContinuation) : continuationEnvelope;
  const page = await readCampaignsWithRevenue({ db, creatorId: creator.id, limit: safeLimit, offset: safeOffset });
  const campaignRows = page.campaigns.map(campaignForClient);
  const totals = page.summary || { campaigns: campaignRows.length, fans: 0, payingFans: 0, settledNetCents: 0, pendingNetCents: 0, transactionsCount: 0, ofValueKnownFans: 0, ofValuePayingFans: 0, ofValueNetCents: 0, ofValueFetchedAt: null };
  const onlineWorkers = await countOnlineBindings(db, creator);
  const campaignRefs = Array.isArray(continuation.campaigns) ? continuation.campaigns : [];
  return {
    ok: true,
    creatorId: creator.id,
    jobId: job?.id || null,
    status,
    manual: Boolean(job),
    phase: clean(continuation.phase, 40) || (status === "COMPLETE" || status === "PARTIAL" ? "complete" : "campaigns"),
    campaignPagesScanned: integer(continuation.page ?? result.campaignBatchCount, 0, 10_000),
    campaignIndex: integer(continuation.campaignIndex ?? result.campaignCount, 0, 10_000),
    claimerPage: integer(continuation.claimerPage ?? result.claimerBatchCount, 0, 1_000_000),
    discoveredCampaigns: integer(campaignRefs.length || result.campaignCount, 0, 10_000),
    sourceBoundaryReached: result.campaignPagesComplete === true && result.claimersComplete === true && result.truncated !== true,
    truncated: result.truncated === true || continuation.truncated === true,
    campaignScannerRejected: integer(result.campaignScannerRejected ?? continuation.campaignScannerRejected, 0, 100_000_000),
    claimerScannerRejected: integer(result.claimerScannerRejected ?? continuation.claimerScannerRejected, 0, 100_000_000),
    fanValuesRequested: integer(result.fanValuesRequested ?? continuation.fanValuesRequested, 0, 100_000_000),
    fanValuesFetched: integer(result.fanValuesFetched ?? continuation.fanValuesFetched, 0, 100_000_000),
    fanValuesUnavailable: integer(result.fanValuesUnavailable ?? continuation.fanValuesUnavailable, 0, 100_000_000),
    startedAt: iso(job?.startedAt || job?.scheduledAt),
    completedAt: iso(job?.completedAt),
    lastProgressAt: iso(job?.lastProgressAt),
    lastErrorCode: status === "FAILED" ? "CAMPAIGN_SCAN_FAILED" : null,
    lastErrorMessage: status === "FAILED" ? clean(job?.lastError, 1000) : null,
    currentMessage: clean(progress.message, 500),
    onlineWorkers,
    summary: {
      campaigns: integer(totals.campaigns, campaignRows.length, 100_000),
      fans: integer(totals.fans, 0, 100_000_000),
      payingFans: integer(totals.payingFans, 0, 100_000_000),
      transactionsCount: integer(totals.transactionsCount, 0, 100_000_000),
      settledNetCents: Number(totals.settledNetCents || 0),
      pendingNetCents: Number(totals.pendingNetCents || 0),
      ofValueKnownFans: integer(totals.ofValueKnownFans, 0, 100_000_000),
      ofValuePayingFans: integer(totals.ofValuePayingFans, 0, 100_000_000),
      ofValueNetCents: Number(totals.ofValueNetCents || 0),
      ofValueFetchedAt: iso(totals.ofValueFetchedAt),
    },
    campaigns: campaignRows,
    pagination: page.pagination,
  };
}

module.exports = {
  JOB_KEY,
  MANUAL_REASON,
  isManualJob,
  startManualCampaignScan,
  stopManualCampaignScan,
  readManualCampaignScan,
};
