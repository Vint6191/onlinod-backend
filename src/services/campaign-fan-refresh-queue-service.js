"use strict";

const crypto = require("node:crypto");
const { CAMPAIGN_FAN_VALUE_FRESHNESS_MS } = require("./analytics-freshness-policy");
const CAMPAIGN_FAN_REFRESH_QUEUE_VERSION = 1;
const CAMPAIGN_FAN_REFRESH_JOB_MAX = 50; // one OF claimer page; point-refresh accepts <=500

function clean(value, max = 180) {
  const out = String(value ?? "").trim();
  return out && out.length <= max ? out : null;
}
function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function uniqueIds(values) {
  return [...new Set((values || []).map((value) => clean(value, 180)).filter(Boolean))].sort();
}

function campaignFanRefreshIsFresh(valueObservedAt, freshnessCutoffAt) {
  const observed = asDate(valueObservedAt);
  const cutoff = asDate(freshnessCutoffAt);
  return Boolean(observed && cutoff && observed.getTime() >= cutoff.getTime());
}

async function enqueueUniqueCampaignFanRefreshes({
  db,
  job,
  scanRunId,
  scanStartedAt,
  candidates = [],
  now = new Date(),
  planner = null,
} = {}) {
  const creatorId = clean(job?.creatorId, 180);
  const agencyId = clean(job?.agencyId, 180);
  const campaignJobId = clean(job?.id, 180);
  const runId = clean(scanRunId, 120);
  const runStartedAt = asDate(scanStartedAt);
  const scheduledAt = asDate(now) || new Date();
  const cutoff = new Date(scheduledAt.getTime() - CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
  if (!db || !creatorId || !agencyId || !campaignJobId || !runId || !runStartedAt) {
    throw new Error("CAMPAIGN_FAN_REFRESH_QUEUE_SCOPE_INVALID");
  }
  const normalized = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const fanId = clean(candidate?.onlyFansUserId ?? candidate?.fanId, 180);
    if (!fanId) continue;
    if (campaignFanRefreshIsFresh(candidate?.valueObservedAt, cutoff)) continue;
    normalized.push(fanId);
  }
  const staleIds = uniqueIds(normalized).slice(0, CAMPAIGN_FAN_REFRESH_JOB_MAX);
  if (!staleIds.length) return { queued: 0, scheduled: 0, skippedFresh: Math.max(0, (candidates || []).length), fanIds: [] };

  // Older unit adapters do not model the new durable queue. Production Prisma
  // always does after generate; keep legacy semantic tests focused on the ledger.
  if (!db.creatorCampaignFanRefreshWork?.findMany || !db.creatorCampaignFanRefreshWork?.createMany || !db.jobInstance) {
    return { queued: 0, scheduled: 0, adapterUnsupported: true, fanIds: [] };
  }

  const existing = await db.creatorCampaignFanRefreshWork.findMany({
    where: { creatorId, scanRunId: runId, onlyFansUserId: { in: staleIds } },
    select: { onlyFansUserId: true },
    take: staleIds.length,
  });
  const existingIds = new Set((existing || []).map((row) => clean(row?.onlyFansUserId, 180)).filter(Boolean));
  const newIds = staleIds.filter((id) => !existingIds.has(id));
  if (!newIds.length) return { queued: 0, scheduled: 0, deduped: staleIds.length, fanIds: [] };

  const fanSetHash = crypto.createHash("sha256").update(newIds.join("\n")).digest("hex").slice(0, 24);
  const idempotencyKey = `phase3:campaign-fan-refresh:${creatorId}:${runId}:${fanSetHash}`;
  const rangeKey = `campaign-refresh:${runId}:${fanSetHash}`;
  const createPlannedJobIfAbsent = planner || require("./job-planning-repository").createPlannedJobIfAbsent;
  const planned = await createPlannedJobIfAbsent({
    db,
    publish: false,
    jobKey: "fan_data_point_refresh",
    scope: "creator",
    creatorId,
    agencyId,
    idempotencyKey,
    params: {
      fanIds: newIds,
      rangeKey,
      requestReason: "campaign_server_unique_refresh_v1",
      observationTokenVersion: 1,
      observationReadLeaseVersion: 1,
      campaignRefreshQueueVersion: CAMPAIGN_FAN_REFRESH_QUEUE_VERSION,
      campaignRefreshRunId: runId,
      campaignSourceJobId: campaignJobId,
    },
    priority: Math.max(1, Number(job?.priority || 0), 85),
    scheduledAt,
    nextRunAt: scheduledAt,
  });
  const refreshJobId = clean(planned?.job?.id, 180);
  if (!refreshJobId) throw new Error("CAMPAIGN_FAN_REFRESH_JOB_CREATE_FAILED");

  const created = await db.creatorCampaignFanRefreshWork.createMany({
    data: newIds.map((onlyFansUserId) => ({
      agencyId,
      creatorId,
      scanRunId: runId,
      scanStartedAt: runStartedAt,
      onlyFansUserId,
      campaignJobId,
      refreshJobId,
      freshnessCutoffAt: cutoff,
      scheduledAt,
    })),
    skipDuplicates: true,
  });
  return {
    queued: Number(created?.count || 0),
    scheduled: newIds.length,
    deduped: staleIds.length - newIds.length,
    refreshJobId,
    fanIds: newIds,
  };
}

module.exports = {
  CAMPAIGN_FAN_REFRESH_QUEUE_VERSION,
  CAMPAIGN_FAN_REFRESH_JOB_MAX,
  CAMPAIGN_FAN_VALUE_FRESHNESS_MS,
  campaignFanRefreshIsFresh,
  enqueueUniqueCampaignFanRefreshes,
};
