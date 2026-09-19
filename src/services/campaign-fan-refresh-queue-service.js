"use strict";

const crypto = require("node:crypto");
const { CAMPAIGN_FAN_VALUE_FRESHNESS_MS } = require("./analytics-freshness-policy");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { fanDataRefreshScheduleAvailable } = require("./provider-capacity-authority-service");

const CAMPAIGN_FAN_REFRESH_QUEUE_VERSION = 2;
const CAMPAIGN_FAN_REFRESH_JOB_MAX = 50;
const WORK_STATUS = Object.freeze({
  ALREADY_FRESH: "ALREADY_FRESH",
  QUEUED: "QUEUED",
  SUCCEEDED: "SUCCEEDED",
  UNAVAILABLE: "UNAVAILABLE",
  FAILED: "FAILED",
});
const DEMAND_STATUS = Object.freeze({ QUEUED: "QUEUED", COMPLETE: "COMPLETE", UNAVAILABLE: "UNAVAILABLE", FAILED: "FAILED" });
const ACTIVE_JOB_STATUSES = new Set(["SCHEDULED", "CLAIMED"]);

function clean(value, max = 180) {
  const out = String(value ?? "").trim();
  return out && out.length <= max ? out : null;
}
function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function uniqueCandidates(values) {
  const byId = new Map();
  for (const candidate of Array.isArray(values) ? values : []) {
    const fanId = clean(candidate?.onlyFansUserId ?? candidate?.fanId, 180);
    if (!fanId) continue;
    const existing = byId.get(fanId) || {};
    byId.set(fanId, {
      onlyFansUserId: fanId,
      embeddedValueAvailable: candidate?.embeddedValueAvailable === true || existing.embeddedValueAvailable === true,
      valueObservedAt: asDate(candidate?.valueObservedAt) || existing.valueObservedAt || null,
    });
  }
  return [...byId.values()].sort((a, b) => a.onlyFansUserId.localeCompare(b.onlyFansUserId));
}
function campaignFanRefreshIsFresh(valueObservedAt, freshnessCutoffAt) {
  const observed = asDate(valueObservedAt);
  const cutoff = asDate(freshnessCutoffAt);
  return Boolean(observed && cutoff && observed.getTime() >= cutoff.getTime());
}
function maxDate(left, right) {
  const a = asDate(left);
  const b = asDate(right);
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
async function lockDemandRowsByFanIds(db, creatorId, fanIds) {
  const ids = [...new Set((Array.isArray(fanIds) ? fanIds : []).map((value) => clean(value, 180)).filter(Boolean))].sort();
  if (!ids.length || typeof db?.$queryRawUnsafe !== "function") return;
  await db.$queryRawUnsafe(
    `SELECT "id" FROM "CreatorFanRefreshDemand" WHERE "creatorId" = $1 AND "onlyFansUserId" = ANY($2::text[]) ORDER BY "id" FOR UPDATE`,
    creatorId,
    ids,
  );
}
async function lockDemandRowsByRefreshJob(db, refreshJobId) {
  const jobId = clean(refreshJobId, 180);
  if (!jobId || typeof db?.$queryRawUnsafe !== "function") return;
  await db.$queryRawUnsafe(
    `SELECT "id" FROM "CreatorFanRefreshDemand" WHERE "activeRefreshJobId" = $1 ORDER BY "id" FOR UPDATE`,
    jobId,
  );
}
function coverageFromState(state, scanRunId) {
  const runId = clean(scanRunId, 120);
  const matches = Boolean(runId && state?.fanValueCoverageScanRunId === runId);
  return {
    matches,
    status: matches ? String(state?.fanValueFreshnessStatus || "MISSING") : "MISSING",
    cutoffAt: matches ? asDate(state?.fanValueFreshnessCutoffAt) : null,
    expected: matches ? Math.max(0, Number(state?.fanValueExpected || 0)) : 0,
    alreadyFresh: matches ? Math.max(0, Number(state?.fanValueAlreadyFresh || 0)) : 0,
    queued: matches ? Math.max(0, Number(state?.fanValueQueued || 0)) : 0,
    succeeded: matches ? Math.max(0, Number(state?.fanValueSucceeded || 0)) : 0,
    unavailable: matches ? Math.max(0, Number(state?.fanValueUnavailable || 0)) : 0,
    failed: matches ? Math.max(0, Number(state?.fanValueFailed || 0)) : 0,
    outstanding: matches ? Math.max(0, Number(state?.fanValueOutstanding || 0)) : 0,
  };
}

async function ensureCoverageRun(db, { creatorId, scanRunId, cutoff, now }) {
  const state = await db.creatorCampaignCollectionState?.findUnique?.({ where: { creatorId } });
  if (!state) return null;
  if (state.fanValueCoverageScanRunId !== scanRunId) {
    return db.creatorCampaignCollectionState.update({
      where: { creatorId },
      data: {
        fanValueCoverageScanRunId: scanRunId,
        fanValueFreshnessCutoffAt: cutoff,
        fanValueFreshnessStatus: "COMPLETE",
        fanValueExpected: 0,
        fanValueAlreadyFresh: 0,
        fanValueQueued: 0,
        fanValueSucceeded: 0,
        fanValueUnavailable: 0,
        fanValueFailed: 0,
        fanValueOutstanding: 0,
        fanValueCoverageUpdatedAt: now,
      },
    });
  }
  const currentCutoff = asDate(state.fanValueFreshnessCutoffAt);
  if (!currentCutoff || cutoff.getTime() > currentCutoff.getTime()) {
    return db.creatorCampaignCollectionState.update({
      where: { creatorId },
      data: { fanValueFreshnessCutoffAt: cutoff, fanValueCoverageUpdatedAt: now },
    });
  }
  return state;
}

async function incrementCoverage(db, { creatorId, scanRunId, cutoff, expected = 0, alreadyFresh = 0, queued = 0, outstanding = 0, now }) {
  await ensureCoverageRun(db, { creatorId, scanRunId, cutoff, now });
  if (!(expected || alreadyFresh || queued || outstanding)) return;
  await db.creatorCampaignCollectionState.updateMany({
    where: { creatorId, fanValueCoverageScanRunId: scanRunId },
    data: {
      fanValueExpected: { increment: expected },
      fanValueAlreadyFresh: { increment: alreadyFresh },
      fanValueQueued: { increment: queued },
      fanValueOutstanding: { increment: outstanding },
      fanValueFreshnessStatus: outstanding > 0 ? "QUEUED" : "COMPLETE",
      fanValueCoverageUpdatedAt: now,
    },
  });
}

async function reconcileCampaignFanValueCoverage({ db, creatorId, scanRunId, now = null } = {}) {
  if (!db?.creatorCampaignCollectionState?.findUnique || !creatorId || !scanRunId) return null;
  const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId } });
  const coverage = coverageFromState(state, scanRunId);
  if (!coverage.matches) return state;
  const effectiveNow = asDate(now) || await dbAuthorityNow({ db, fallbackNow: new Date() });
  const freshnessStatus = coverage.outstanding > 0 ? "QUEUED" : coverage.failed > 0 ? "PARTIAL" : "COMPLETE";
  const membershipComplete = String(state?.membershipCoverageStatus || "") === "COMPLETE";
  const frontierComplete = String(state?.campaignFrontierFreshnessStatus || "") === "COMPLETE";
  const overallComplete = membershipComplete && frontierComplete && freshnessStatus === "COMPLETE";
  const update = {
    fanValueFreshnessStatus: freshnessStatus,
    fanValueCoverageUpdatedAt: effectiveNow,
    ...(membershipComplete ? {
      status: overallComplete ? "COMPLETE" : "PARTIAL",
      retryAfterAt: null,
      lastErrorCode: overallComplete ? null : (coverage.outstanding > 0 ? "CAMPAIGN_FAN_VALUE_REFRESH_PENDING" : "CAMPAIGN_FAN_VALUE_REFRESH_PARTIAL"),
      lastErrorMessage: overallComplete ? null : (coverage.outstanding > 0
        ? `Campaign membership is complete; ${coverage.outstanding} FanData refreshes are still outstanding`
        : `Campaign membership is complete; ${coverage.failed} FanData refreshes failed`),
    } : {}),
  };
  if (overallComplete) {
    update.lastCompleteScanRunId = scanRunId;
    if (String(state.mode || "") === "full") {
      update.baselineVerifiedAt = effectiveNow;
      update.baselineGeneration = state.activeGeneration;
    } else if (String(state.mode || "") === "catchup") {
      update.lastCatchupCompletedAt = effectiveNow;
      update.lastCatchupGeneration = state.activeGeneration;
    }
  }
  return db.creatorCampaignCollectionState.update({ where: { creatorId }, data: update });
}

async function transitionWorkForDemand(db, { demand, outcome, observedAt, error = null, now }) {
  if (!demand?.id) return [];
  const pending = await db.creatorCampaignFanRefreshWork.findMany({
    where: { demandId: demand.id, status: WORK_STATUS.QUEUED },
    select: { id: true, creatorId: true, scanRunId: true, freshnessCutoffAt: true },
  });
  const eligible = pending.filter((work) => outcome === WORK_STATUS.FAILED || campaignFanRefreshIsFresh(observedAt, work.freshnessCutoffAt));
  if (!eligible.length) return [];
  const byRun = new Map();
  for (const row of eligible) {
    const group = byRun.get(row.scanRunId) || [];
    group.push(row.id);
    byRun.set(row.scanRunId, group);
  }
  const transitioned = [];
  for (const [runId, ids] of byRun) {
    const updated = await db.creatorCampaignFanRefreshWork.updateMany({
      where: { id: { in: ids }, status: WORK_STATUS.QUEUED },
      data: {
        status: outcome,
        outcome,
        observedAt: outcome === WORK_STATUS.FAILED ? null : observedAt,
        completedAt: now,
        lastError: error ? clean(error, 1000) : null,
      },
    });
    const count = Math.max(0, Number(updated?.count || 0));
    if (!count) continue;
    transitioned.push(...ids.slice(0, count));
    const data = { fanValueOutstanding: { decrement: count }, fanValueCoverageUpdatedAt: now };
    if (outcome === WORK_STATUS.SUCCEEDED) data.fanValueSucceeded = { increment: count };
    else if (outcome === WORK_STATUS.UNAVAILABLE) data.fanValueUnavailable = { increment: count };
    else data.fanValueFailed = { increment: count };
    await db.creatorCampaignCollectionState.updateMany({
      where: { creatorId: demand.creatorId, fanValueCoverageScanRunId: runId, fanValueOutstanding: { gte: count } }, data,
    });
    await reconcileCampaignFanValueCoverage({ db, creatorId: demand.creatorId, scanRunId: runId, now });
  }
  return transitioned;
}

async function scheduleDemandRefreshJob({ db, job, demands, scheduledAt, planner = null }) {
  const rows = (Array.isArray(demands) ? demands : []).filter((row) => row?.demand?.id && row?.fanId && Number(row?.revision || 0) >= 1);
  if (!rows.length) return null;
  if (rows.length > CAMPAIGN_FAN_REFRESH_JOB_MAX) throw new Error("CAMPAIGN_FAN_REFRESH_DEMAND_BATCH_TOO_LARGE");
  const creatorId = clean(job?.creatorId, 180);
  const agencyId = clean(job?.agencyId, 180);
  if (!creatorId || !agencyId) throw new Error("CAMPAIGN_FAN_REFRESH_DEMAND_JOB_SCOPE_INVALID");
  const revisions = rows.map((row) => `${row.fanId}:${row.revision}`).sort();
  const fanSetHash = crypto.createHash("sha256").update(revisions.join("\n")).digest("hex").slice(0, 24);
  const admission = await fanDataRefreshScheduleAvailable(db, creatorId);
  if (!admission.available) {
    const demandIds = rows.map((row) => row.demand.id);
    await db.creatorFanRefreshDemand.updateMany?.({
      where: { id: { in: demandIds } },
      data: { activeRefreshJobId: null, activeRefreshRevision: null, status: DEMAND_STATUS.QUEUED },
    });
    await db.creatorCampaignFanRefreshWork.updateMany?.({
      where: { demandId: { in: demandIds }, status: WORK_STATUS.QUEUED },
      data: { refreshJobId: null },
    });
    return null;
  }
  const createPlannedJobIfAbsent = planner || require("./job-planning-repository").createPlannedJobIfAbsent;
  const planned = await createPlannedJobIfAbsent({
    db, publish: false, jobKey: "fan_data_point_refresh", scope: "creator", creatorId, agencyId,
    idempotencyKey: `phase3:campaign-fan-demand:${creatorId}:${fanSetHash}`,
    params: {
      fanIds: rows.map((row) => row.fanId),
      rangeKey: `campaign-demand:${fanSetHash}`,
      requestReason: "campaign_cross_run_refresh_demand_v2",
      observationTokenVersion: 1,
      observationReadLeaseVersion: 1,
      campaignRefreshQueueVersion: CAMPAIGN_FAN_REFRESH_QUEUE_VERSION,
      campaignRefreshDemandFanIds: rows.map((row) => row.fanId),
    },
    priority: Math.max(1, Number(job?.priority || 0), 85), scheduledAt, nextRunAt: scheduledAt,
  });
  const refreshJobId = clean(planned?.job?.id, 180);
  if (!refreshJobId) throw new Error("CAMPAIGN_FAN_REFRESH_JOB_CREATE_FAILED");
  for (const row of rows) {
    await db.creatorFanRefreshDemand.update({
      where: { id: row.demand.id },
      data: {
        activeRefreshJobId: refreshJobId,
        activeRefreshRevision: row.revision,
        status: DEMAND_STATUS.QUEUED,
        lastRequestedAt: scheduledAt,
        lastError: null,
      },
    });
    await db.creatorCampaignFanRefreshWork.updateMany?.({
      where: { demandId: row.demand.id, status: WORK_STATUS.QUEUED },
      data: { refreshJobId },
    });
  }
  return refreshJobId;
}

async function enqueueUniqueCampaignFanRefreshes({ db, job, scanRunId, scanStartedAt, candidates = [], now = new Date(), planner = null } = {}) {
  const creatorId = clean(job?.creatorId, 180);
  const agencyId = clean(job?.agencyId, 180);
  const campaignJobId = clean(job?.id, 180);
  const runId = clean(scanRunId, 120);
  const runStartedAt = asDate(scanStartedAt);
  const scheduledAt = asDate(now) || new Date();
  const cutoff = new Date(runStartedAt.getTime() - CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
  if (!db || !creatorId || !agencyId || !campaignJobId || !runId || !runStartedAt) throw new Error("CAMPAIGN_FAN_REFRESH_QUEUE_SCOPE_INVALID");

  const normalized = uniqueCandidates(candidates).slice(0, CAMPAIGN_FAN_REFRESH_JOB_MAX);
  await ensureCoverageRun(db, { creatorId, scanRunId: runId, cutoff, now: scheduledAt });
  if (!normalized.length) return { expected: 0, alreadyFresh: 0, queued: 0, scheduled: 0, coalesced: 0, fanIds: [] };
  if (!db.creatorCampaignFanRefreshWork?.findMany || !db.creatorFanRefreshDemand?.findMany || !db.jobInstance) {
    return { expected: 0, alreadyFresh: 0, queued: 0, scheduled: 0, adapterUnsupported: true, fanIds: [] };
  }

  const ids = normalized.map((row) => row.onlyFansUserId);
  const existingWork = await db.creatorCampaignFanRefreshWork.findMany({
    where: { creatorId, scanRunId: runId, onlyFansUserId: { in: ids } },
    select: { onlyFansUserId: true }, take: ids.length,
  });
  const seenWork = new Set((existingWork || []).map((row) => clean(row?.onlyFansUserId, 180)).filter(Boolean));
  const newCandidates = normalized.filter((row) => !seenWork.has(row.onlyFansUserId));
  if (!newCandidates.length) return { expected: 0, alreadyFresh: 0, queued: 0, scheduled: 0, deduped: normalized.length, fanIds: [] };

  const fresh = newCandidates.filter((row) => row.embeddedValueAvailable || campaignFanRefreshIsFresh(row.valueObservedAt, cutoff));
  const stale = newCandidates.filter((row) => !fresh.includes(row));
  let freshCreated = 0;
  if (fresh.length) {
    const created = await db.creatorCampaignFanRefreshWork.createMany({
      data: fresh.map((row) => ({
        agencyId, creatorId, scanRunId: runId, scanStartedAt: runStartedAt, onlyFansUserId: row.onlyFansUserId,
        campaignJobId, freshnessCutoffAt: cutoff, requestedRevision: 0, status: WORK_STATUS.ALREADY_FRESH,
        outcome: WORK_STATUS.ALREADY_FRESH, observedAt: row.valueObservedAt || scheduledAt, completedAt: scheduledAt, scheduledAt,
      })),
      skipDuplicates: true,
    });
    freshCreated = Number(created?.count || 0);
  }

  if (stale.length) {
    // Establish the unique creator/fan demand without relying on a recoverable
    // unique-violation inside the surrounding PostgreSQL transaction. Then lock
    // every participating demand row in a stable id order so overlapping Campaign
    // runs and a finishing point-refresh cannot make scheduling decisions from
    // different demand revisions.
    if (typeof db.creatorFanRefreshDemand?.createMany !== "function") {
      throw new Error("CAMPAIGN_FAN_REFRESH_DEMAND_ADAPTER_UNAVAILABLE");
    }
    await db.creatorFanRefreshDemand.createMany({
      data: stale.map((row) => ({
        agencyId, creatorId, onlyFansUserId: row.onlyFansUserId,
        requestedFreshnessCutoffAt: cutoff, requestedRevision: 1, satisfiedRevision: 0,
        status: DEMAND_STATUS.QUEUED, lastRequestedAt: scheduledAt,
      })),
      skipDuplicates: true,
    });
    await lockDemandRowsByFanIds(db, creatorId, stale.map((row) => row.onlyFansUserId));
  }
  const existingDemands = stale.length ? await db.creatorFanRefreshDemand.findMany({
    where: { creatorId, onlyFansUserId: { in: stale.map((row) => row.onlyFansUserId) } },
    include: { activeRefreshJob: { select: { id: true, status: true } } },
  }) : [];
  const demandByFan = new Map((existingDemands || []).map((row) => [String(row.onlyFansUserId), row]));
  const coalesced = [];
  const needsJob = [];
  const demandRows = new Map();
  for (const row of stale) {
    const existing = demandByFan.get(row.onlyFansUserId);
    if (!existing?.id) throw new Error("CAMPAIGN_FAN_REFRESH_DEMAND_CREATE_FAILED");
    const currentCutoff = asDate(existing.requestedFreshnessCutoffAt);
    const raisesTarget = !currentCutoff || cutoff.getTime() > currentCutoff.getTime();
    const revision = Math.max(1, Number(existing.requestedRevision || 1)) + (raisesTarget ? 1 : 0);
    const active = Boolean(existing.activeRefreshJobId && ACTIVE_JOB_STATUSES.has(String(existing?.activeRefreshJob?.status || "")));
    const demand = await db.creatorFanRefreshDemand.update({
      where: { id: existing.id },
      data: {
        agencyId, creatorId, onlyFansUserId: row.onlyFansUserId,
        requestedFreshnessCutoffAt: maxDate(existing.requestedFreshnessCutoffAt, cutoff) || cutoff,
        requestedRevision: revision,
        status: DEMAND_STATUS.QUEUED,
        lastRequestedAt: scheduledAt,
        lastError: null,
        ...(active ? {} : { activeRefreshJobId: null, activeRefreshRevision: null }),
      },
    });
    demandRows.set(row.onlyFansUserId, { demand, revision, activeRefreshJobId: active ? existing.activeRefreshJobId : null });
    if (active) coalesced.push(row.onlyFansUserId);
    else needsJob.push(row.onlyFansUserId);
  }

  let scheduledJobId = null;
  if (needsJob.length) {
    const rowsToSchedule = needsJob.map((fanId) => {
      const info = demandRows.get(fanId);
      return { fanId, demand: info.demand, revision: info.revision };
    });
    scheduledJobId = await scheduleDemandRefreshJob({ db, job, demands: rowsToSchedule, scheduledAt, planner });
    for (const fanId of needsJob) {
      const info = demandRows.get(fanId);
      demandRows.set(fanId, { ...info, activeRefreshJobId: scheduledJobId });
    }
  }

  let staleCreated = 0;
  if (stale.length) {
    const created = await db.creatorCampaignFanRefreshWork.createMany({
      data: stale.map((row) => {
        const info = demandRows.get(row.onlyFansUserId);
        return {
          agencyId, creatorId, scanRunId: runId, scanStartedAt: runStartedAt, onlyFansUserId: row.onlyFansUserId,
          campaignJobId, refreshJobId: info?.activeRefreshJobId || null, demandId: info?.demand?.id || null,
          requestedRevision: info?.revision || 1, freshnessCutoffAt: cutoff, status: WORK_STATUS.QUEUED, scheduledAt,
        };
      }),
      skipDuplicates: true,
    });
    staleCreated = Number(created?.count || 0);
  }

  await incrementCoverage(db, {
    creatorId, scanRunId: runId, cutoff,
    expected: freshCreated + staleCreated,
    alreadyFresh: freshCreated,
    queued: staleCreated,
    outstanding: staleCreated,
    now: scheduledAt,
  });
  return {
    expected: freshCreated + staleCreated,
    alreadyFresh: freshCreated,
    queued: staleCreated,
    scheduled: scheduledJobId ? needsJob.length : 0,
    deferred: scheduledJobId ? 0 : needsJob.length,
    coalesced: coalesced.length,
    refreshJobId: scheduledJobId,
    fanIds: stale.map((row) => row.onlyFansUserId),
  };
}

async function promoteQueuedCampaignFanRefreshDemands({ db, now = null, maxJobs = 4, planner = null, inTransaction = false } = {}) {
  if (!inTransaction && typeof db?.$transaction === "function") {
    return db.$transaction((tx) => promoteQueuedCampaignFanRefreshDemands({ db: tx, now, maxJobs, planner, inTransaction: true }));
  }
  if (!db?.creatorFanRefreshDemand?.findMany || !db?.jobInstance) return { promotedJobs: 0, promotedFans: 0, reason: "adapter_unsupported" };
  const effectiveNow = asDate(now) || await dbAuthorityNow({ db, fallbackNow: new Date() });
  const limit = Math.max(1, Math.min(16, Number(maxJobs) || 4));
  // Pull a bounded oldest-per-creator window rather than one global oldest slice.
  // A creator with a very deep old backlog may already be at its per-creator
  // scheduled-job cap. If that creator can fill the whole candidate slice, a
  // global `take` starves every newer creator before schedule admission even has
  // a chance to consider them. Production PostgreSQL therefore contributes at
  // most one job-sized batch per creator to this promotion pass. The actual job
  // create path still re-checks global/per-creator capacity under the shared
  // advisory xact lock, so this query is fairness discovery, not admission.
  let pending;
  if (typeof db?.$queryRawUnsafe === "function") {
    const promotionWindow = Math.max(CAMPAIGN_FAN_REFRESH_JOB_MAX * 16, limit * CAMPAIGN_FAN_REFRESH_JOB_MAX * 16);
    const ranked = await db.$queryRawUnsafe(`
      WITH ranked AS (
        SELECT
          d."id",
          d."creatorId",
          d."lastRequestedAt",
          ROW_NUMBER() OVER (
            PARTITION BY d."creatorId"
            ORDER BY d."lastRequestedAt" ASC, d."id" ASC
          ) AS rn
        FROM "CreatorFanRefreshDemand" d
        WHERE d."status" = 'QUEUED'
          AND d."activeRefreshJobId" IS NULL
          AND EXISTS (
            SELECT 1
            FROM "CreatorCampaignFanRefreshWork" w
            WHERE w."demandId" = d."id"
              AND w."status" = 'QUEUED'
          )
      )
      SELECT "id", "lastRequestedAt"
      FROM ranked
      WHERE rn <= $1
      ORDER BY "lastRequestedAt" ASC, "id" ASC
      LIMIT $2
    `, CAMPAIGN_FAN_REFRESH_JOB_MAX, promotionWindow);
    const rankedIds = (Array.isArray(ranked) ? ranked : []).map((row) => clean(row?.id, 180)).filter(Boolean);
    if (rankedIds.length) {
      pending = await db.creatorFanRefreshDemand.findMany({
        where: {
          id: { in: rankedIds },
          status: DEMAND_STATUS.QUEUED,
          activeRefreshJobId: null,
          campaignWork: { some: { status: WORK_STATUS.QUEUED } },
        },
      });
      pending.sort((a, b) => {
        const at = (asDate(a?.lastRequestedAt) || effectiveNow).getTime();
        const bt = (asDate(b?.lastRequestedAt) || effectiveNow).getTime();
        return at - bt || String(a?.id || "").localeCompare(String(b?.id || ""));
      });
    } else {
      pending = [];
    }
  } else {
    pending = await db.creatorFanRefreshDemand.findMany({
      where: {
        status: DEMAND_STATUS.QUEUED,
        activeRefreshJobId: null,
        campaignWork: { some: { status: WORK_STATUS.QUEUED } },
      },
      orderBy: [{ lastRequestedAt: "asc" }, { id: "asc" }],
      take: Math.max(CAMPAIGN_FAN_REFRESH_JOB_MAX, limit * CAMPAIGN_FAN_REFRESH_JOB_MAX * 4),
    });
  }
  if (!pending.length) return { promotedJobs: 0, promotedFans: 0, reason: "none_pending" };

  const byCreator = new Map();
  for (const demand of pending) {
    const creatorId = clean(demand.creatorId, 180);
    const agencyId = clean(demand.agencyId, 180);
    const fanId = clean(demand.onlyFansUserId, 180);
    if (!creatorId || !agencyId || !fanId) continue;
    let group = byCreator.get(creatorId);
    if (!group) {
      group = { creatorId, agencyId, rows: [], cursor: 0, oldestAt: asDate(demand.lastRequestedAt) || effectiveNow };
      byCreator.set(creatorId, group);
    }
    group.rows.push({ fanId, demand, revision: Math.max(1, Number(demand.requestedRevision || 1)) });
  }
  const groups = [...byCreator.values()].sort((a, b) => a.oldestAt.getTime() - b.oldestAt.getTime() || a.creatorId.localeCompare(b.creatorId));
  let promotedJobs = 0;
  let promotedFans = 0;
  while (promotedJobs < limit) {
    let madeProgress = false;
    for (const group of groups) {
      if (promotedJobs >= limit) break;
      if (group.cursor >= group.rows.length) continue;
      const batch = group.rows.slice(group.cursor, group.cursor + CAMPAIGN_FAN_REFRESH_JOB_MAX);
      group.cursor += batch.length;
      const refreshJobId = await scheduleDemandRefreshJob({
        db,
        job: { id: "campaign-refresh-backlog-promoter", agencyId: group.agencyId, creatorId: group.creatorId, priority: 85 },
        demands: batch,
        scheduledAt: effectiveNow,
        planner,
      });
      if (!refreshJobId) {
        // Capacity for this creator/global pool is currently saturated. Do not
        // skip deeper rows and manufacture younger work ahead of the oldest debt.
        group.cursor -= batch.length;
        continue;
      }
      promotedJobs += 1;
      promotedFans += batch.length;
      madeProgress = true;
    }
    if (!madeProgress) break;
  }
  return { promotedJobs, promotedFans, reason: promotedJobs ? "promoted" : "capacity_saturated" };
}

async function recordCampaignFanRefreshChunk({ db, job, chunkResult } = {}) {
  if (!db?.creatorFanRefreshDemand?.findMany || String(job?.jobKey || "") !== "fan_data_point_refresh") return null;
  const items = Array.isArray(chunkResult?.items) ? chunkResult.items : [];
  const ids = [...new Set(items.map((item) => clean(item?.onlyFansUserId, 180)).filter(Boolean))];
  if (!ids.length) return { applied: 0 };
  const fans = await db.creatorFan.findMany({
    where: { creatorId: job.creatorId, onlyFansUserId: { in: ids } },
    include: { valueCurrent: true },
  });
  const currentByFan = new Map((fans || []).map((fan) => [String(fan.onlyFansUserId), fan.valueCurrent || null]));
  await lockDemandRowsByRefreshJob(db, job.id);
  const demands = await db.creatorFanRefreshDemand.findMany({
    where: { creatorId: job.creatorId, onlyFansUserId: { in: ids }, activeRefreshJobId: job.id },
  });
  const now = await dbAuthorityNow({ db, fallbackNow: new Date() });
  let applied = 0;
  for (const demand of demands) {
    const value = currentByFan.get(String(demand.onlyFansUserId));
    const observedAt = asDate(value?.valueObservedAt);
    if (!observedAt || !campaignFanRefreshIsFresh(observedAt, demand.requestedFreshnessCutoffAt)) continue;
    const outcome = String(value?.availability || "").toUpperCase() === "AVAILABLE" ? WORK_STATUS.SUCCEEDED : WORK_STATUS.UNAVAILABLE;
    await db.creatorFanRefreshDemand.update({
      where: { id: demand.id },
      data: {
        status: outcome === WORK_STATUS.SUCCEEDED ? DEMAND_STATUS.COMPLETE : DEMAND_STATUS.UNAVAILABLE,
        satisfiedRevision: demand.requestedRevision,
        activeRefreshJobId: null,
        activeRefreshRevision: null,
        lastObservedAt: observedAt,
        lastOutcome: outcome,
        lastCompletedAt: now,
        lastFailedAt: null,
        lastError: null,
      },
    });
    await transitionWorkForDemand(db, { demand, outcome, observedAt, now });
    applied += 1;
  }
  return { applied };
}

async function finalizeCampaignFanRefreshJob({ db, job, result = null, planner = null } = {}) {
  if (!db?.creatorFanRefreshDemand?.findMany || String(job?.jobKey || "") !== "fan_data_point_refresh") return null;
  await lockDemandRowsByRefreshJob(db, job.id);
  const demands = await db.creatorFanRefreshDemand.findMany({ where: { activeRefreshJobId: job.id } });
  if (!demands.length) return { applied: 0, rescheduled: 0 };
  const now = await dbAuthorityNow({ db, fallbackNow: new Date() });
  const superseded = [];
  const failed = [];
  for (const demand of demands) {
    const activeRevision = Math.max(0, Number(demand.activeRefreshRevision || 0));
    const requestedRevision = Math.max(1, Number(demand.requestedRevision || 1));
    if (activeRevision > 0 && requestedRevision > activeRevision) {
      superseded.push({ fanId: String(demand.onlyFansUserId), demand, revision: requestedRevision });
    } else {
      failed.push(demand);
    }
  }
  let followUpJobId = null;
  if (superseded.length) {
    followUpJobId = await scheduleDemandRefreshJob({ db, job, demands: superseded, scheduledAt: now, planner });
  }
  for (const demand of failed) {
    await db.creatorFanRefreshDemand.update({
      where: { id: demand.id },
      data: {
        status: DEMAND_STATUS.FAILED,
        activeRefreshJobId: null,
        activeRefreshRevision: null,
        lastFailedAt: now,
        lastError: `fan_data_point_refresh completed without satisfying requested freshness${result?.errors ? `; errors=${Number(result.errors)}` : ""}`,
      },
    });
    await transitionWorkForDemand(db, { demand, outcome: WORK_STATUS.FAILED, observedAt: null, error: "refresh job finished without a fresh terminal value", now });
  }
  return { applied: failed.length, rescheduled: followUpJobId ? superseded.length : 0, deferred: followUpJobId ? 0 : superseded.length, followUpJobId };
}

async function recordCampaignFanRefreshJobFailure({ db, job, error, terminal = true, planner = null } = {}) {
  if (!terminal || !db?.creatorFanRefreshDemand?.findMany || String(job?.jobKey || "") !== "fan_data_point_refresh") return null;
  await lockDemandRowsByRefreshJob(db, job.id);
  const demands = await db.creatorFanRefreshDemand.findMany({ where: { activeRefreshJobId: job.id } });
  if (!demands.length) return { applied: 0, rescheduled: 0 };
  const now = await dbAuthorityNow({ db, fallbackNow: new Date() });
  const superseded = [];
  const failed = [];
  for (const demand of demands) {
    const activeRevision = Math.max(0, Number(demand.activeRefreshRevision || 0));
    const requestedRevision = Math.max(1, Number(demand.requestedRevision || 1));
    if (activeRevision > 0 && requestedRevision > activeRevision) superseded.push({ fanId: String(demand.onlyFansUserId), demand, revision: requestedRevision });
    else failed.push(demand);
  }
  let followUpJobId = null;
  if (superseded.length) followUpJobId = await scheduleDemandRefreshJob({ db, job, demands: superseded, scheduledAt: now, planner });
  for (const demand of failed) {
    await db.creatorFanRefreshDemand.update({ where: { id: demand.id }, data: {
      status: DEMAND_STATUS.FAILED, activeRefreshJobId: null, activeRefreshRevision: null,
      lastFailedAt: now, lastError: clean(error?.message || error, 1000),
    } });
    await transitionWorkForDemand(db, { demand, outcome: WORK_STATUS.FAILED, observedAt: null, error: error?.message || error, now });
  }
  return { applied: failed.length, rescheduled: followUpJobId ? superseded.length : 0, deferred: followUpJobId ? 0 : superseded.length, followUpJobId };
}

module.exports = {
  CAMPAIGN_FAN_REFRESH_QUEUE_VERSION,
  CAMPAIGN_FAN_REFRESH_JOB_MAX,
  CAMPAIGN_FAN_VALUE_FRESHNESS_MS,
  WORK_STATUS,
  DEMAND_STATUS,
  campaignFanRefreshIsFresh,
  campaignFanValueCoverageFromState: coverageFromState,
  enqueueUniqueCampaignFanRefreshes,
  promoteQueuedCampaignFanRefreshDemands,
  recordCampaignFanRefreshChunk,
  finalizeCampaignFanRefreshJob,
  recordCampaignFanRefreshJobFailure,
  reconcileCampaignFanValueCoverage,
  _test: { scheduleDemandRefreshJob },
};
