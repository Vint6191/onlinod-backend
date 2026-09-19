"use strict";

const crypto = require("node:crypto");
const { CAMPAIGN_FAN_VALUE_FRESHNESS_MS } = require("./analytics-freshness-policy");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { fanDataRefreshScheduleAvailable } = require("./provider-capacity-authority-service");

const CAMPAIGN_FAN_REFRESH_QUEUE_VERSION = 2;
const CAMPAIGN_FAN_REFRESH_JOB_MAX = 50;
const CAMPAIGN_FAN_REFRESH_MAX_RETRIES = 5;
const CAMPAIGN_FAN_REFRESH_RETRY_BASE_MS = 60 * 1000;
const CAMPAIGN_FAN_REFRESH_RETRY_MAX_MS = 30 * 60 * 1000;
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
  if (value === null || value === undefined || value === "") return null;
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
function campaignFanRefreshRetryDelayMs(attempt) {
  const safeAttempt = Math.max(1, Math.min(CAMPAIGN_FAN_REFRESH_MAX_RETRIES, Number(attempt) || 1));
  return Math.min(CAMPAIGN_FAN_REFRESH_RETRY_MAX_MS, CAMPAIGN_FAN_REFRESH_RETRY_BASE_MS * (2 ** (safeAttempt - 1)));
}
function campaignFanRefreshFailurePlan(demand, now) {
  const failedAt = asDate(now) || new Date();
  const retryAttempts = Math.max(0, Number(demand?.retryAttempts || 0)) + 1;
  const quarantined = retryAttempts >= CAMPAIGN_FAN_REFRESH_MAX_RETRIES;
  return {
    retryAttempts,
    quarantined,
    nextRetryAt: quarantined ? null : new Date(failedAt.getTime() + campaignFanRefreshRetryDelayMs(retryAttempts)),
    quarantinedAt: quarantined ? failedAt : null,
    lastOutcome: quarantined ? "QUARANTINED" : "RETRY_BACKOFF",
  };
}
function shouldResetCampaignRefreshJob(existing) {
  return ["DONE", "FAILED", "CANCELLED"].includes(String(existing?.status || ""));
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

async function ensureCoverageRun(db, { creatorId, scanRunId, cutoff, now, coverageAuthority = null }) {
  const state = await db.creatorCampaignCollectionState?.findUnique?.({ where: { creatorId } });
  if (!state) return null;
  if (state.fanValueCoverageScanRunId !== scanRunId) {
    return db.creatorCampaignCollectionState.update({
      where: { creatorId },
      data: {
        fanValueCoverageScanRunId: scanRunId,
        fanValueCoverageDelegated: coverageAuthority?.delegated === true,
        fanValueCoverageOwnerKind: clean(coverageAuthority?.ownerKind, 32),
        fanValueCoverageCollectorVersion: clean(coverageAuthority?.collectorVersion, 80),
        fanValueCoverageSourceJobId: clean(coverageAuthority?.sourceJobId, 220),
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
  const authorityUpdate = coverageAuthority ? {
    fanValueCoverageDelegated: coverageAuthority.delegated === true,
    fanValueCoverageOwnerKind: clean(coverageAuthority.ownerKind, 32),
    fanValueCoverageCollectorVersion: clean(coverageAuthority.collectorVersion, 80),
    fanValueCoverageSourceJobId: clean(coverageAuthority.sourceJobId, 220),
  } : {};
  const cutoffAdvanced = !currentCutoff || cutoff.getTime() > currentCutoff.getTime();
  const authorityChanged = coverageAuthority && (
    state.fanValueCoverageDelegated !== (coverageAuthority.delegated === true) ||
    String(state.fanValueCoverageOwnerKind || "") !== String(coverageAuthority.ownerKind || "") ||
    String(state.fanValueCoverageCollectorVersion || "") !== String(coverageAuthority.collectorVersion || "") ||
    String(state.fanValueCoverageSourceJobId || "") !== String(coverageAuthority.sourceJobId || "")
  );
  if (cutoffAdvanced || authorityChanged) {
    return db.creatorCampaignCollectionState.update({
      where: { creatorId },
      data: { ...(cutoffAdvanced ? { fanValueFreshnessCutoffAt: cutoff } : {}), ...authorityUpdate, fanValueCoverageUpdatedAt: now },
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

async function assertCoverageMutationNotLost(db, { creatorId, scanRunId, result, code }) {
  const count = Math.max(0, Number(result?.count || 0));
  if (count === 1) return true;
  if (count > 1) throw new Error(code);
  // There is only one current CreatorCampaignCollectionState row per creator.
  // Historical Campaign runs may still have durable work rows but no longer own
  // the creator's current aggregate counters; a zero update is legitimate for
  // those rows. Zero is fail-closed only when the requested scanRun is still the
  // current coverage generation, because then a work transition without matching
  // aggregate counters would corrupt end-to-end coverage arithmetic.
  if (typeof db?.creatorCampaignCollectionState?.findUnique === "function") {
    const current = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId } });
    if (String(current?.fanValueCoverageScanRunId || "") === String(scanRunId || "")) throw new Error(code);
  }
  return false;
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
    const coverageUpdated = await db.creatorCampaignCollectionState.updateMany({
      where: { creatorId: demand.creatorId, fanValueCoverageScanRunId: runId, fanValueOutstanding: { gte: count } }, data,
    });
    await assertCoverageMutationNotLost(db, {
      creatorId: demand.creatorId, scanRunId: runId, result: coverageUpdated,
      code: "CAMPAIGN_FAN_REFRESH_COVERAGE_TRANSITION_LOST",
    });
    await reconcileCampaignFanValueCoverage({ db, creatorId: demand.creatorId, scanRunId: runId, now });
  }
  return transitioned;
}

async function transitionRecoveredWorkForDemand(db, { demand, outcome, observedAt, now }) {
  if (!demand?.id) return { queued: 0, failed: 0, scanRunIds: [] };
  const rows = await db.creatorCampaignFanRefreshWork.findMany({
    where: { demandId: demand.id, status: { in: [WORK_STATUS.QUEUED, WORK_STATUS.FAILED] } },
    select: { id: true, creatorId: true, scanRunId: true, status: true, freshnessCutoffAt: true },
  });
  const eligible = rows.filter((row) => campaignFanRefreshIsFresh(observedAt, row.freshnessCutoffAt));
  if (!eligible.length) return { queued: 0, failed: 0, scanRunIds: [] };
  const byRun = new Map();
  for (const row of eligible) {
    const key = String(row.scanRunId || "");
    if (!key) continue;
    const group = byRun.get(key) || { queuedIds: [], failedIds: [] };
    if (row.status === WORK_STATUS.FAILED) group.failedIds.push(row.id);
    else group.queuedIds.push(row.id);
    byRun.set(key, group);
  }
  let queued = 0;
  let failed = 0;
  for (const [scanRunId, group] of byRun) {
    let queuedCount = 0;
    let failedCount = 0;
    if (group.queuedIds.length) {
      const updated = await db.creatorCampaignFanRefreshWork.updateMany({
        where: { id: { in: group.queuedIds }, status: WORK_STATUS.QUEUED },
        data: { status: outcome, outcome, observedAt, completedAt: now, lastError: null },
      });
      queuedCount = Math.max(0, Number(updated?.count || 0));
    }
    if (group.failedIds.length) {
      const updated = await db.creatorCampaignFanRefreshWork.updateMany({
        where: { id: { in: group.failedIds }, status: WORK_STATUS.FAILED },
        data: { status: outcome, outcome, observedAt, completedAt: now, lastError: null },
      });
      failedCount = Math.max(0, Number(updated?.count || 0));
    }
    if (queuedCount || failedCount) {
      const data = { fanValueCoverageUpdatedAt: now };
      if (queuedCount) data.fanValueOutstanding = { decrement: queuedCount };
      if (failedCount) data.fanValueFailed = { decrement: failedCount };
      const completed = queuedCount + failedCount;
      if (outcome === WORK_STATUS.SUCCEEDED) data.fanValueSucceeded = { increment: completed };
      else data.fanValueUnavailable = { increment: completed };
      const coverageUpdated = await db.creatorCampaignCollectionState.updateMany({
        where: {
          creatorId: demand.creatorId,
          fanValueCoverageScanRunId: scanRunId,
          ...(queuedCount ? { fanValueOutstanding: { gte: queuedCount } } : {}),
          ...(failedCount ? { fanValueFailed: { gte: failedCount } } : {}),
        },
        data,
      });
      await assertCoverageMutationNotLost(db, {
        creatorId: demand.creatorId, scanRunId, result: coverageUpdated,
        code: "CAMPAIGN_FAN_REFRESH_RECOVERY_COVERAGE_TRANSITION_LOST",
      });
      await reconcileCampaignFanValueCoverage({ db, creatorId: demand.creatorId, scanRunId, now });
    }
    queued += queuedCount;
    failed += failedCount;
  }
  return { queued, failed, scanRunIds: [...byRun.keys()] };
}

async function reconcileCampaignFanRefreshDemandsFromCanonicalObservationsSetBased({ db, creatorId, fanIds, now }) {
  const effectiveNow = asDate(now) || await dbAuthorityNow({ db, fallbackNow: new Date() });
  const rows = await db.$queryRawUnsafe(`
    WITH candidate AS (
      SELECT d."id" AS "demandId",
             d."requestedRevision",
             d."creatorId",
             d."onlyFansUserId",
             v."fetchedAt" AS "observedAt",
             CASE WHEN UPPER(COALESCE(v."availability", '')) = 'AVAILABLE' THEN 'SUCCEEDED' ELSE 'UNAVAILABLE' END AS "outcome"
      FROM "CreatorFanRefreshDemand" d
      JOIN "CreatorFan" f
        ON f."creatorId" = d."creatorId" AND f."onlyFansUserId" = d."onlyFansUserId"
      JOIN "CreatorFanValueCurrent" v
        ON v."creatorId" = f."creatorId" AND v."fanId" = f."id"
      WHERE d."creatorId" = $1
        AND d."onlyFansUserId" = ANY($2::text[])
        AND d."status" IN ('QUEUED', 'FAILED')
        AND d."satisfiedRevision" < d."requestedRevision"
        AND v."fetchedAt" >= d."requestedFreshnessCutoffAt"
      ORDER BY d."id"
      FOR UPDATE OF d
    ), demand_update AS (
      UPDATE "CreatorFanRefreshDemand" d
      SET "status" = CASE WHEN c."outcome" = 'SUCCEEDED' THEN 'COMPLETE' ELSE 'UNAVAILABLE' END,
          "satisfiedRevision" = c."requestedRevision",
          "activeRefreshJobId" = NULL,
          "activeRefreshRevision" = NULL,
          "lastObservedAt" = c."observedAt",
          "lastOutcome" = c."outcome",
          "lastCompletedAt" = $3,
          "lastFailedAt" = NULL,
          "retryAttempts" = 0,
          "nextRetryAt" = NULL,
          "lastRetryAt" = NULL,
          "quarantinedAt" = NULL,
          "lastError" = NULL,
          "updatedAt" = $3
      FROM candidate c
      WHERE d."id" = c."demandId"
      RETURNING d."id", c."outcome", c."observedAt"
    ), work_before AS (
      SELECT w."id", w."scanRunId", w."status" AS "oldStatus", du."outcome", du."observedAt"
      FROM "CreatorCampaignFanRefreshWork" w
      JOIN demand_update du ON du."id" = w."demandId"
      WHERE w."status" IN ('QUEUED', 'FAILED')
        AND du."observedAt" >= w."freshnessCutoffAt"
      ORDER BY w."id"
      FOR UPDATE OF w
    ), work_update AS (
      UPDATE "CreatorCampaignFanRefreshWork" w
      SET "status" = wb."outcome",
          "outcome" = wb."outcome",
          "observedAt" = wb."observedAt",
          "completedAt" = $3,
          "lastError" = NULL,
          "updatedAt" = $3
      FROM work_before wb
      WHERE w."id" = wb."id"
      RETURNING w."id", wb."scanRunId", wb."oldStatus", wb."outcome"
    ), delta AS (
      SELECT "scanRunId",
             COUNT(*) FILTER (WHERE "oldStatus" = 'QUEUED')::int AS "queuedDone",
             COUNT(*) FILTER (WHERE "oldStatus" = 'FAILED')::int AS "failedDone",
             COUNT(*) FILTER (WHERE "outcome" = 'SUCCEEDED')::int AS "succeededDone",
             COUNT(*) FILTER (WHERE "outcome" = 'UNAVAILABLE')::int AS "unavailableDone"
      FROM work_update
      GROUP BY "scanRunId"
    ), coverage_guard AS (
      SELECT d."scanRunId",
             s."fanValueOutstanding" >= d."queuedDone" AS "outstandingSafe",
             s."fanValueFailed" >= d."failedDone" AS "failedSafe"
      FROM delta d
      JOIN "CreatorCampaignCollectionState" s
        ON s."creatorId" = $1 AND s."fanValueCoverageScanRunId" = d."scanRunId"
    ), coverage_update AS (
      UPDATE "CreatorCampaignCollectionState" s
      SET "fanValueOutstanding" = GREATEST(0, s."fanValueOutstanding" - d."queuedDone"),
          "fanValueFailed" = GREATEST(0, s."fanValueFailed" - d."failedDone"),
          "fanValueSucceeded" = s."fanValueSucceeded" + d."succeededDone",
          "fanValueUnavailable" = s."fanValueUnavailable" + d."unavailableDone",
          "fanValueCoverageUpdatedAt" = $3,
          "fanValueFreshnessStatus" = CASE
            WHEN GREATEST(0, s."fanValueOutstanding" - d."queuedDone") > 0 THEN 'QUEUED'::"AnalyticsCoverageStatus"
            WHEN GREATEST(0, s."fanValueFailed" - d."failedDone") > 0 THEN 'PARTIAL'::"AnalyticsCoverageStatus"
            ELSE 'COMPLETE'::"AnalyticsCoverageStatus"
          END,
          "status" = CASE
            WHEN s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND s."campaignFrontierFreshnessStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND GREATEST(0, s."fanValueOutstanding" - d."queuedDone") = 0
             AND GREATEST(0, s."fanValueFailed" - d."failedDone") = 0
              THEN 'COMPLETE'::"AnalyticsCoverageStatus"
            WHEN s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
              THEN 'PARTIAL'::"AnalyticsCoverageStatus"
            ELSE s."status"
          END,
          "retryAfterAt" = CASE WHEN s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus" THEN NULL ELSE s."retryAfterAt" END,
          "lastErrorCode" = CASE
            WHEN s."membershipCoverageStatus" <> 'COMPLETE'::"AnalyticsCoverageStatus" THEN s."lastErrorCode"
            WHEN GREATEST(0, s."fanValueOutstanding" - d."queuedDone") > 0 THEN 'CAMPAIGN_FAN_VALUE_REFRESH_PENDING'
            WHEN GREATEST(0, s."fanValueFailed" - d."failedDone") > 0 THEN 'CAMPAIGN_FAN_VALUE_REFRESH_PARTIAL'
            ELSE NULL
          END,
          "lastErrorMessage" = CASE
            WHEN s."membershipCoverageStatus" <> 'COMPLETE'::"AnalyticsCoverageStatus" THEN s."lastErrorMessage"
            WHEN GREATEST(0, s."fanValueOutstanding" - d."queuedDone") > 0
              THEN 'Campaign membership is complete; ' || GREATEST(0, s."fanValueOutstanding" - d."queuedDone")::text || ' FanData refreshes are still outstanding'
            WHEN GREATEST(0, s."fanValueFailed" - d."failedDone") > 0
              THEN 'Campaign membership is complete; ' || GREATEST(0, s."fanValueFailed" - d."failedDone")::text || ' FanData refreshes failed'
            ELSE NULL
          END,
          "lastCompleteScanRunId" = CASE
            WHEN s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND s."campaignFrontierFreshnessStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND GREATEST(0, s."fanValueOutstanding" - d."queuedDone") = 0
             AND GREATEST(0, s."fanValueFailed" - d."failedDone") = 0
              THEN d."scanRunId"
            ELSE s."lastCompleteScanRunId"
          END,
          "baselineVerifiedAt" = CASE
            WHEN s."mode" = 'full'
             AND s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND s."campaignFrontierFreshnessStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND GREATEST(0, s."fanValueOutstanding" - d."queuedDone") = 0
             AND GREATEST(0, s."fanValueFailed" - d."failedDone") = 0
              THEN $3 ELSE s."baselineVerifiedAt" END,
          "baselineGeneration" = CASE
            WHEN s."mode" = 'full'
             AND s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND s."campaignFrontierFreshnessStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND GREATEST(0, s."fanValueOutstanding" - d."queuedDone") = 0
             AND GREATEST(0, s."fanValueFailed" - d."failedDone") = 0
              THEN s."activeGeneration" ELSE s."baselineGeneration" END,
          "lastCatchupCompletedAt" = CASE
            WHEN s."mode" = 'catchup'
             AND s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND s."campaignFrontierFreshnessStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND GREATEST(0, s."fanValueOutstanding" - d."queuedDone") = 0
             AND GREATEST(0, s."fanValueFailed" - d."failedDone") = 0
              THEN $3 ELSE s."lastCatchupCompletedAt" END,
          "lastCatchupGeneration" = CASE
            WHEN s."mode" = 'catchup'
             AND s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND s."campaignFrontierFreshnessStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
             AND GREATEST(0, s."fanValueOutstanding" - d."queuedDone") = 0
             AND GREATEST(0, s."fanValueFailed" - d."failedDone") = 0
              THEN s."activeGeneration" ELSE s."lastCatchupGeneration" END,
          "updatedAt" = $3
      FROM delta d
      WHERE s."creatorId" = $1
        AND s."fanValueCoverageScanRunId" = d."scanRunId"
        AND s."fanValueOutstanding" >= d."queuedDone"
        AND s."fanValueFailed" >= d."failedDone"
      RETURNING d."scanRunId"
    )
    SELECT
      (SELECT COUNT(*)::int FROM demand_update) AS "healed",
      (SELECT COUNT(*)::int FROM work_update) AS "workTransitioned",
      (SELECT COUNT(*)::int FROM coverage_update) AS "coverageRunsUpdated",
      (SELECT COUNT(*)::int FROM coverage_guard WHERE NOT "outstandingSafe" OR NOT "failedSafe") AS "coverageTransitionLost"
  `, creatorId, fanIds, effectiveNow);
  const result = Array.isArray(rows) && rows[0] ? rows[0] : {};
  const lost = Math.max(0, Number(result.coverageTransitionLost || 0));
  if (lost > 0) throw new Error("CAMPAIGN_FAN_REFRESH_RECOVERY_COVERAGE_TRANSITION_LOST");
  const healed = Math.max(0, Number(result.healed || 0));
  return {
    healed,
    workTransitioned: Math.max(0, Number(result.workTransitioned || 0)),
    coverageRunsUpdated: Math.max(0, Number(result.coverageRunsUpdated || 0)),
    reason: healed ? "canonical_observation_healed" : "no_fresh_observation",
    topology: "set_based_v1",
  };
}

async function reconcileCampaignFanRefreshDemandsFromCanonicalObservations({ db, creatorId, fanIds = [], now = null } = {}) {
  const scopedCreatorId = clean(creatorId, 180);
  const ids = [...new Set((Array.isArray(fanIds) ? fanIds : []).map((value) => clean(value, 180)).filter(Boolean))].sort();
  if (!scopedCreatorId || !ids.length) return { healed: 0, reason: "nothing_to_reconcile" };
  const productionSetBasedAdapter = typeof db?.$queryRawUnsafe === "function"
    && Boolean(db?.creatorFanRefreshDemand?.findMany)
    && Boolean(db?.creatorCampaignFanRefreshWork)
    && Boolean(db?.creatorCampaignCollectionState);
  if (productionSetBasedAdapter) {
    return reconcileCampaignFanRefreshDemandsFromCanonicalObservationsSetBased({ db, creatorId: scopedCreatorId, fanIds: ids, now });
  }
  if (!db?.creatorFanRefreshDemand?.findMany || !db?.creatorFan?.findMany) return { healed: 0, reason: "adapter_unsupported" };
  await lockDemandRowsByFanIds(db, scopedCreatorId, ids);
  const demands = await db.creatorFanRefreshDemand.findMany({
    where: {
      creatorId: scopedCreatorId,
      onlyFansUserId: { in: ids },
      status: { in: [DEMAND_STATUS.QUEUED, DEMAND_STATUS.FAILED] },
    },
  });
  if (!demands.length) return { healed: 0, reason: "no_open_demands" };
  const fans = await db.creatorFan.findMany({
    where: { creatorId: scopedCreatorId, onlyFansUserId: { in: demands.map((row) => row.onlyFansUserId) } },
    include: { valueCurrent: true },
  });
  const currentByFan = new Map((fans || []).map((fan) => [String(fan.onlyFansUserId), fan.valueCurrent || null]));
  const effectiveNow = asDate(now) || await dbAuthorityNow({ db, fallbackNow: new Date() });
  let healed = 0;
  for (const demand of demands) {
    const requestedRevision = Math.max(1, Number(demand.requestedRevision || 1));
    const satisfiedRevision = Math.max(0, Number(demand.satisfiedRevision || 0));
    if (satisfiedRevision >= requestedRevision) continue;
    const value = currentByFan.get(String(demand.onlyFansUserId));
    const observedAt = asDate(value?.valueObservedAt);
    if (!observedAt || !campaignFanRefreshIsFresh(observedAt, demand.requestedFreshnessCutoffAt)) continue;
    const outcome = String(value?.availability || "").toUpperCase() === "AVAILABLE" ? WORK_STATUS.SUCCEEDED : WORK_STATUS.UNAVAILABLE;
    await db.creatorFanRefreshDemand.update({
      where: { id: demand.id },
      data: {
        status: outcome === WORK_STATUS.SUCCEEDED ? DEMAND_STATUS.COMPLETE : DEMAND_STATUS.UNAVAILABLE,
        satisfiedRevision: requestedRevision,
        activeRefreshJobId: null,
        activeRefreshRevision: null,
        lastObservedAt: observedAt,
        lastOutcome: outcome,
        lastCompletedAt: effectiveNow,
        lastFailedAt: null,
        retryAttempts: 0,
        nextRetryAt: null,
        lastRetryAt: null,
        quarantinedAt: null,
        lastError: null,
      },
    });
    await transitionRecoveredWorkForDemand(db, { demand, outcome, observedAt, now: effectiveNow });
    healed += 1;
  }
  return { healed, reason: healed ? "canonical_observation_healed" : "no_fresh_observation", topology: "adapter_fallback" };
}

async function requeueFailedWorkForDemand(db, { demand, now }) {
  const failedWork = await db.creatorCampaignFanRefreshWork.findMany({
    where: { demandId: demand.id, status: WORK_STATUS.FAILED },
    select: { id: true, scanRunId: true },
  });
  if (!failedWork.length) return { requeued: 0, scanRunIds: [] };
  const byRun = new Map();
  for (const row of failedWork) {
    const runId = clean(row.scanRunId, 120);
    if (!runId) continue;
    const ids = byRun.get(runId) || [];
    ids.push(row.id);
    byRun.set(runId, ids);
  }
  let requeued = 0;
  for (const [scanRunId, ids] of byRun) {
    const updated = await db.creatorCampaignFanRefreshWork.updateMany({
      where: { id: { in: ids }, status: WORK_STATUS.FAILED },
      data: {
        status: WORK_STATUS.QUEUED,
        outcome: null,
        observedAt: null,
        completedAt: null,
        refreshJobId: null,
        lastError: null,
        scheduledAt: now,
      },
    });
    const count = Math.max(0, Number(updated?.count || 0));
    if (!count) continue;
    requeued += count;
    const coverageUpdated = await db.creatorCampaignCollectionState.updateMany({
      where: { creatorId: demand.creatorId, fanValueCoverageScanRunId: scanRunId, fanValueFailed: { gte: count } },
      data: {
        fanValueFailed: { decrement: count },
        fanValueOutstanding: { increment: count },
        fanValueFreshnessStatus: "QUEUED",
        fanValueCoverageUpdatedAt: now,
        status: "PARTIAL",
        retryAfterAt: null,
        lastErrorCode: "CAMPAIGN_FAN_VALUE_REFRESH_RETRY_QUEUED",
        lastErrorMessage: `Campaign FanData refresh retry queued for ${count} fan${count === 1 ? "" : "s"}`,
      },
    });
    await assertCoverageMutationNotLost(db, {
      creatorId: demand.creatorId, scanRunId, result: coverageUpdated,
      code: "CAMPAIGN_FAN_REFRESH_REQUEUE_COVERAGE_TRANSITION_LOST",
    });
  }
  return { requeued, scanRunIds: [...byRun.keys()] };
}

function supportsSetBasedCampaignFanRefreshRecovery(db) {
  return typeof db?.$queryRawUnsafe === "function"
    && typeof db?.$executeRawUnsafe === "function"
    && Boolean(db?.creatorFanRefreshDemand?.findMany);
}

async function recoverFailedCampaignFanRefreshDemandsSetBased({ db, now, creatorId = null, force = false, maxDemands = 200 } = {}) {
  const effectiveNow = asDate(now) || await dbAuthorityNow({ db, fallbackNow: new Date() });
  const scopedCreatorId = clean(creatorId, 180);
  const limit = Math.max(1, Math.min(2000, Number(maxDemands) || 200));
  const rows = await db.$queryRawUnsafe(`
    WITH candidate AS (
      SELECT d."id", d."creatorId", d."quarantinedAt"
      FROM "CreatorFanRefreshDemand" d
      WHERE d."status" = 'FAILED'
        AND d."activeRefreshJobId" IS NULL
        AND ($2::boolean = TRUE OR (
          d."quarantinedAt" IS NULL
          AND d."nextRetryAt" IS NOT NULL
          AND d."nextRetryAt" <= $1
        ))
        AND ($3::text IS NULL OR d."creatorId" = $3)
      ORDER BY COALESCE(d."nextRetryAt", d."lastFailedAt", d."updatedAt") ASC, d."id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $4
    ), failed_work AS (
      SELECT w."id", w."demandId", w."creatorId", w."scanRunId"
      FROM "CreatorCampaignFanRefreshWork" w
      JOIN candidate c ON c."id" = w."demandId"
      WHERE w."status" = 'FAILED'
      ORDER BY w."id" ASC
      FOR UPDATE OF w
    ), delta AS (
      SELECT "creatorId", "scanRunId", COUNT(*)::int AS "failedCount"
      FROM failed_work
      GROUP BY "creatorId", "scanRunId"
    ), coverage_guard AS (
      SELECT d."creatorId", d."scanRunId", d."failedCount",
             s."fanValueFailed" >= d."failedCount" AS "failedSafe"
      FROM delta d
      JOIN "CreatorCampaignCollectionState" s
        ON s."creatorId" = d."creatorId"
       AND s."fanValueCoverageScanRunId" = d."scanRunId"
    ), unsafe AS (
      SELECT COUNT(*)::int AS "count"
      FROM coverage_guard
      WHERE NOT "failedSafe"
    ), work_update AS (
      UPDATE "CreatorCampaignFanRefreshWork" w
      SET "status" = 'QUEUED',
          "outcome" = NULL,
          "observedAt" = NULL,
          "completedAt" = NULL,
          "refreshJobId" = NULL,
          "lastError" = NULL,
          "scheduledAt" = $1,
          "updatedAt" = $1
      FROM failed_work fw
      WHERE w."id" = fw."id"
        AND (SELECT "count" FROM unsafe) = 0
      RETURNING w."id", fw."demandId", fw."creatorId", fw."scanRunId"
    ), work_per_demand AS (
      SELECT "demandId", COUNT(*)::int AS "workCount"
      FROM work_update
      GROUP BY "demandId"
    ), demand_update AS (
      UPDATE "CreatorFanRefreshDemand" d
      SET "status" = 'QUEUED',
          "activeRefreshJobId" = NULL,
          "activeRefreshRevision" = NULL,
          "nextRetryAt" = NULL,
          "lastRetryAt" = $1,
          "quarantinedAt" = CASE WHEN $2::boolean THEN NULL ELSE d."quarantinedAt" END,
          "retryAttempts" = CASE WHEN $2::boolean THEN 0 ELSE d."retryAttempts" END,
          "lastOutcome" = CASE WHEN $2::boolean THEN 'MANUAL_REPAIR_QUEUED' ELSE 'RETRY_QUEUED' END,
          "lastError" = NULL,
          "updatedAt" = $1
      FROM work_per_demand wd
      WHERE d."id" = wd."demandId"
      RETURNING d."id"
    ), coverage_update AS (
      UPDATE "CreatorCampaignCollectionState" s
      SET "fanValueFailed" = s."fanValueFailed" - d."failedCount",
          "fanValueOutstanding" = s."fanValueOutstanding" + d."failedCount",
          "fanValueFreshnessStatus" = 'QUEUED'::"AnalyticsCoverageStatus",
          "fanValueCoverageUpdatedAt" = $1,
          "status" = 'PARTIAL'::"AnalyticsCoverageStatus",
          "retryAfterAt" = NULL,
          "lastErrorCode" = 'CAMPAIGN_FAN_VALUE_REFRESH_RETRY_QUEUED',
          "lastErrorMessage" = 'Campaign FanData refresh retry queued for ' || d."failedCount"::text ||
            CASE WHEN d."failedCount" = 1 THEN ' fan' ELSE ' fans' END,
          "updatedAt" = $1
      FROM delta d
      WHERE s."creatorId" = d."creatorId"
        AND s."fanValueCoverageScanRunId" = d."scanRunId"
        AND s."fanValueFailed" >= d."failedCount"
        AND (SELECT "count" FROM unsafe) = 0
      RETURNING s."creatorId", d."scanRunId"
    )
    SELECT
      (SELECT "count" FROM unsafe) AS "coverageTransitionLost",
      (SELECT COUNT(*)::int FROM demand_update) AS "recovered",
      (SELECT COUNT(*)::int FROM work_update) AS "requeuedWork",
      (SELECT COUNT(*)::int FROM coverage_update) AS "coverageRunsUpdated"
  `, effectiveNow, force === true, scopedCreatorId, limit);
  const result = Array.isArray(rows) && rows[0] ? rows[0] : {};
  if (Math.max(0, Number(result.coverageTransitionLost || 0)) > 0) {
    throw new Error("CAMPAIGN_FAN_REFRESH_REQUEUE_COVERAGE_TRANSITION_LOST");
  }
  const recovered = Math.max(0, Number(result.recovered || 0));
  return {
    recovered,
    requeuedWork: Math.max(0, Number(result.requeuedWork || 0)),
    coverageRunsUpdated: Math.max(0, Number(result.coverageRunsUpdated || 0)),
    reason: recovered ? (force ? "manual_repair_queued" : "retry_due_queued") : "none_due",
    topology: "set_based_v1",
  };
}

async function recoverFailedCampaignFanRefreshDemands({ db, now = null, creatorId = null, force = false, maxDemands = 200 } = {}) {
  if (!db?.creatorFanRefreshDemand?.findMany) return { recovered: 0, requeuedWork: 0, reason: "adapter_unsupported" };
  if (supportsSetBasedCampaignFanRefreshRecovery(db)) {
    return recoverFailedCampaignFanRefreshDemandsSetBased({ db, now, creatorId, force, maxDemands });
  }
  const effectiveNow = asDate(now) || await dbAuthorityNow({ db, fallbackNow: new Date() });
  const scopedCreatorId = clean(creatorId, 180);
  const limit = Math.max(1, Math.min(2000, Number(maxDemands) || 200));
  const candidates = await db.creatorFanRefreshDemand.findMany({
    where: {
      status: DEMAND_STATUS.FAILED,
      activeRefreshJobId: null,
      ...(scopedCreatorId ? { creatorId: scopedCreatorId } : {}),
      ...(force ? {} : { quarantinedAt: null, nextRetryAt: { lte: effectiveNow } }),
    },
    orderBy: [{ nextRetryAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  let recovered = 0;
  let requeuedWork = 0;
  for (const demand of candidates) {
    const work = await requeueFailedWorkForDemand(db, { demand, now: effectiveNow });
    if (!work.requeued) continue;
    await db.creatorFanRefreshDemand.update({
      where: { id: demand.id },
      data: {
        status: DEMAND_STATUS.QUEUED,
        activeRefreshJobId: null,
        activeRefreshRevision: null,
        nextRetryAt: null,
        lastRetryAt: effectiveNow,
        quarantinedAt: force ? null : demand.quarantinedAt,
        ...(force ? { retryAttempts: 0 } : {}),
        lastOutcome: force ? "MANUAL_REPAIR_QUEUED" : "RETRY_QUEUED",
        lastError: null,
      },
    });
    recovered += 1;
    requeuedWork += work.requeued;
  }
  return { recovered, requeuedWork, reason: recovered ? (force ? "manual_repair_queued" : "retry_due_queued") : "none_due", topology: "adapter_fallback" };
}

async function repairFailedCampaignFanRefreshDemands({ db, creatorId, now = null, maxDemands = 200 } = {}) {
  if (!creatorId) return { recovered: 0, requeuedWork: 0, reason: "creator_required" };
  if (typeof db?.$transaction === "function") {
    return db.$transaction(async (tx) => {
      const repaired = await recoverFailedCampaignFanRefreshDemands({ db: tx, creatorId, now, force: true, maxDemands });
      const promoted = await promoteQueuedCampaignFanRefreshDemands({ db: tx, now, maxJobs: 4, inTransaction: true });
      return { ...repaired, promotedJobs: promoted.promotedJobs, promotedFans: promoted.promotedFans };
    });
  }
  const repaired = await recoverFailedCampaignFanRefreshDemands({ db, creatorId, now, force: true, maxDemands });
  const promoted = await promoteQueuedCampaignFanRefreshDemands({ db, now, maxJobs: 4, inTransaction: true });
  return { ...repaired, promotedJobs: promoted.promotedJobs, promotedFans: promoted.promotedFans };
}


function supportsSetBasedCampaignFanRefreshQueue(db) {
  return typeof db?.$queryRawUnsafe === "function"
    && typeof db?.$executeRawUnsafe === "function"
    && typeof db?.creatorFanRefreshDemand?.createMany === "function"
    && typeof db?.creatorFanRefreshDemand?.updateMany === "function"
    && typeof db?.creatorCampaignFanRefreshWork?.createMany === "function"
    && typeof db?.creatorCampaignFanRefreshWork?.updateMany === "function"
    && Boolean(db?.jobInstance)
    && Boolean(db?.creatorCampaignCollectionState);
}

async function advanceCampaignFanRefreshDemandsSetBased({ db, agencyId, creatorId, fanIds, cutoff, scheduledAt } = {}) {
  const ids = [...new Set((Array.isArray(fanIds) ? fanIds : []).map((value) => clean(value, 180)).filter(Boolean))].sort();
  if (!ids.length) return [];
  const rows = await db.$queryRawUnsafe(`
    WITH candidate AS (
      SELECT d."id",
             d."onlyFansUserId",
             d."requestedFreshnessCutoffAt",
             d."requestedRevision",
             d."activeRefreshRevision",
             CASE
               WHEN d."activeRefreshJobId" IS NOT NULL AND j."status" IN ('SCHEDULED', 'CLAIMED')
                 THEN d."activeRefreshJobId"
               ELSE NULL
             END AS "retainedRefreshJobId"
      FROM "CreatorFanRefreshDemand" d
      LEFT JOIN "JobInstance" j ON j."id" = d."activeRefreshJobId"
      WHERE d."creatorId" = $1
        AND d."onlyFansUserId" = ANY($2::text[])
      ORDER BY d."id" ASC
      FOR UPDATE OF d
    ), demand_update AS (
      UPDATE "CreatorFanRefreshDemand" d
      SET "agencyId" = $3,
          "requestedFreshnessCutoffAt" = GREATEST(d."requestedFreshnessCutoffAt", $4),
          "requestedRevision" = CASE
            WHEN d."requestedFreshnessCutoffAt" < $4 THEN d."requestedRevision" + 1
            ELSE d."requestedRevision"
          END,
          "status" = 'QUEUED',
          "lastRequestedAt" = $5,
          "lastError" = NULL,
          "activeRefreshJobId" = c."retainedRefreshJobId",
          "activeRefreshRevision" = CASE
            WHEN c."retainedRefreshJobId" IS NULL THEN NULL
            ELSE c."activeRefreshRevision"
          END,
          "updatedAt" = $5
      FROM candidate c
      WHERE d."id" = c."id"
      RETURNING d."id", d."onlyFansUserId", d."requestedRevision", d."activeRefreshJobId", d."activeRefreshRevision"
    )
    SELECT "id", "onlyFansUserId", "requestedRevision", "activeRefreshJobId", "activeRefreshRevision"
    FROM demand_update
    ORDER BY "id" ASC
  `, creatorId, ids, agencyId, cutoff, scheduledAt);
  return Array.isArray(rows) ? rows : [];
}

async function lockSchedulableDemandRowsSetBased({ db, rows, replaceRefreshJobId = null } = {}) {
  const input = (Array.isArray(rows) ? rows : []).filter((row) => row?.demand?.id && Number(row?.revision || 0) >= 1);
  if (!input.length) return [];
  const ids = input.map((row) => clean(row.demand.id, 180));
  const revisions = input.map((row) => Math.max(1, Number(row.revision || 1)));
  const replaceId = clean(replaceRefreshJobId, 180);
  const locked = await db.$queryRawUnsafe(`
    WITH input AS (
      SELECT *
      FROM UNNEST($1::text[], $2::int[]) AS i("id", "revision")
    )
    SELECT d."id", d."requestedRevision", d."activeRefreshJobId"
    FROM "CreatorFanRefreshDemand" d
    JOIN input i ON i."id" = d."id" AND i."revision" = d."requestedRevision"
    WHERE d."activeRefreshJobId" IS NULL
       OR ($3::text IS NOT NULL AND d."activeRefreshJobId" = $3)
    ORDER BY d."id" ASC
    FOR UPDATE OF d
  `, ids, revisions, replaceId);
  return Array.isArray(locked) ? locked : [];
}

async function bindDemandRefreshJobSetBased({ db, demandIds, revisions, refreshJobId, scheduledAt, replaceRefreshJobId = null } = {}) {
  const ids = Array.isArray(demandIds) ? demandIds.map((value) => clean(value, 180)).filter(Boolean) : [];
  const revs = Array.isArray(revisions) ? revisions.map((value) => Math.max(1, Number(value || 1))) : [];
  if (!ids.length || ids.length !== revs.length) return { demandBound: 0, workBound: 0 };
  const rows = await db.$queryRawUnsafe(`
    WITH input AS (
      SELECT *
      FROM UNNEST($1::text[], $2::int[]) AS i("id", "revision")
    ), demand_update AS (
      UPDATE "CreatorFanRefreshDemand" d
      SET "activeRefreshJobId" = $3,
          "activeRefreshRevision" = i."revision",
          "status" = 'QUEUED',
          "lastRequestedAt" = $4,
          "lastError" = NULL,
          "updatedAt" = $4
      FROM input i
      WHERE d."id" = i."id"
        AND d."requestedRevision" = i."revision"
        AND (d."activeRefreshJobId" IS NULL OR ($5::text IS NOT NULL AND d."activeRefreshJobId" = $5))
      RETURNING d."id"
    ), work_update AS (
      UPDATE "CreatorCampaignFanRefreshWork" w
      SET "refreshJobId" = $3,
          "updatedAt" = $4
      FROM demand_update du
      WHERE w."demandId" = du."id"
        AND w."status" = 'QUEUED'
      RETURNING w."id"
    )
    SELECT
      (SELECT COUNT(*)::int FROM demand_update) AS "demandBound",
      (SELECT COUNT(*)::int FROM work_update) AS "workBound"
  `, ids, revs, refreshJobId, scheduledAt, clean(replaceRefreshJobId, 180));
  const result = Array.isArray(rows) && rows[0] ? rows[0] : {};
  return {
    demandBound: Math.max(0, Number(result.demandBound || 0)),
    workBound: Math.max(0, Number(result.workBound || 0)),
  };
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
  const setBasedBinding = supportsSetBasedCampaignFanRefreshQueue(db);
  const replaceRefreshJobId = String(job?.jobKey || "") === "fan_data_point_refresh" ? clean(job?.id, 180) : null;
  if (setBasedBinding) {
    const locked = await lockSchedulableDemandRowsSetBased({ db, rows, replaceRefreshJobId });
    if (locked.length !== rows.length) throw new Error("CAMPAIGN_FAN_REFRESH_DEMAND_BIND_RACE");
  }
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
  const planRefreshJob = planner || require("./job-planning-repository").ensurePlannedJob;
  const planned = await planRefreshJob({
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
    // Same-revision demand retries intentionally reuse the semantic idempotency
    // key. A prior terminal DONE/FAILED/CANCELLED JobInstance must therefore be
    // rescheduled, not merely returned as an inert idempotency hit. Demand-level
    // retryAttempts/quarantine remains the bounded retry authority.
    resetExisting: planner ? false : true,
    shouldResetExisting: planner ? undefined : shouldResetCampaignRefreshJob,
    protectedStatuses: ["SCHEDULED", "CLAIMED"],
  });
  const refreshJobId = clean(planned?.job?.id, 180);
  if (!refreshJobId) throw new Error("CAMPAIGN_FAN_REFRESH_JOB_CREATE_FAILED");
  if (setBasedBinding) {
    const bound = await bindDemandRefreshJobSetBased({
      db,
      demandIds: rows.map((row) => row.demand.id),
      revisions: rows.map((row) => row.revision),
      refreshJobId,
      scheduledAt,
      replaceRefreshJobId,
    });
    if (bound.demandBound !== rows.length) throw new Error("CAMPAIGN_FAN_REFRESH_DEMAND_BIND_RACE");
  } else {
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
  }
  return refreshJobId;
}

async function enqueueUniqueCampaignFanRefreshes({ db, job, scanRunId, scanStartedAt, candidates = [], now = new Date(), planner = null, collectorVersion = null } = {}) {
  const creatorId = clean(job?.creatorId, 180);
  const agencyId = clean(job?.agencyId, 180);
  const campaignJobId = clean(job?.id, 180);
  const runId = clean(scanRunId, 120);
  const runStartedAt = asDate(scanStartedAt);
  const scheduledAt = asDate(now) || new Date();
  const cutoff = new Date(runStartedAt.getTime() - CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
  if (!db || !creatorId || !agencyId || !campaignJobId || !runId || !runStartedAt) throw new Error("CAMPAIGN_FAN_REFRESH_QUEUE_SCOPE_INVALID");

  const params = job?.params && typeof job.params === "object" && !Array.isArray(job.params) ? job.params : {};
  const coverageAuthority = {
    delegated: Number(params.campaignFreshnessCoverageVersion || 0) >= 1 || Boolean(clean(collectorVersion, 80)),
    ownerKind: params.manualCampaignScan === true ? "MANUAL" : "AUTOMATIC",
    collectorVersion: clean(collectorVersion, 80),
    sourceJobId: campaignJobId,
  };
  const normalized = uniqueCandidates(candidates).slice(0, CAMPAIGN_FAN_REFRESH_JOB_MAX);
  await ensureCoverageRun(db, { creatorId, scanRunId: runId, cutoff, now: scheduledAt, coverageAuthority });
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

  const coalesced = [];
  const needsJob = [];
  const demandRows = new Map();
  if (stale.length) {
    // Establish the unique creator/fan demand without relying on a recoverable
    // unique-violation inside the surrounding PostgreSQL transaction.
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

    if (supportsSetBasedCampaignFanRefreshQueue(db)) {
      // Production path: stable row locking, revision advancement, active-job
      // coalescing and stale active-job cleanup are one bounded statement. The
      // returned rows are the exact authority used for work creation below.
      const advanced = await advanceCampaignFanRefreshDemandsSetBased({
        db, agencyId, creatorId, fanIds: stale.map((row) => row.onlyFansUserId), cutoff, scheduledAt,
      });
      if (advanced.length !== stale.length) throw new Error("CAMPAIGN_FAN_REFRESH_DEMAND_CREATE_FAILED");
      for (const demand of advanced) {
        const fanId = clean(demand?.onlyFansUserId, 180);
        const demandId = clean(demand?.id, 180);
        if (!fanId || !demandId) throw new Error("CAMPAIGN_FAN_REFRESH_DEMAND_CREATE_FAILED");
        const revision = Math.max(1, Number(demand?.requestedRevision || 1));
        const activeRefreshJobId = clean(demand?.activeRefreshJobId, 180);
        demandRows.set(fanId, { demand: { id: demandId }, revision, activeRefreshJobId });
        if (activeRefreshJobId) coalesced.push(fanId);
        else needsJob.push(fanId);
      }
    } else {
      // Compatibility path for the older in-memory transaction adapters used by
      // regression tests. Production Prisma always takes the set-based branch.
      await lockDemandRowsByFanIds(db, creatorId, stale.map((row) => row.onlyFansUserId));
      const existingDemands = await db.creatorFanRefreshDemand.findMany({
        where: { creatorId, onlyFansUserId: { in: stale.map((row) => row.onlyFansUserId) } },
        include: { activeRefreshJob: { select: { id: true, status: true } } },
      });
      const demandByFan = new Map((existingDemands || []).map((row) => [String(row.onlyFansUserId), row]));
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
    }
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
  // Failed demand is durable debt, not a terminal dead-end. Requeue only due,
  // non-quarantined rows under the same transaction/row locks used by the
  // backlog promoter. This keeps multi-replica retry idempotent.
  await recoverFailedCampaignFanRefreshDemands({
    db, now: effectiveNow, force: false, maxDemands: limit * CAMPAIGN_FAN_REFRESH_JOB_MAX,
  });
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

function supportsSetBasedCampaignFanRefreshTerminal(db) {
  return typeof db?.$queryRawUnsafe === "function"
    && typeof db?.$executeRawUnsafe === "function"
    && typeof db?.creatorFanRefreshDemand?.findMany === "function"
    && typeof db?.creatorCampaignFanRefreshWork?.updateMany === "function"
    && Boolean(db?.creatorCampaignCollectionState);
}

async function transitionCampaignFanRefreshTerminalSetBased({ db, refreshJobId, now, error } = {}) {
  const jobId = clean(refreshJobId, 180);
  if (!jobId) return { applied: 0, workTransitioned: 0, coverageRunsUpdated: 0, topology: "set_based_v1" };
  const effectiveNow = asDate(now) || await dbAuthorityNow({ db, fallbackNow: new Date() });
  const errorText = clean(error, 1000) || "refresh job finished without a fresh terminal value";
  const rows = await db.$queryRawUnsafe(`
    WITH candidate AS (
      SELECT d."id", d."creatorId", d."retryAttempts"
      FROM "CreatorFanRefreshDemand" d
      WHERE d."activeRefreshJobId" = $1
        AND NOT (
          COALESCE(d."activeRefreshRevision", 0) > 0
          AND d."requestedRevision" > d."activeRefreshRevision"
        )
      ORDER BY d."id" ASC
      FOR UPDATE OF d
    ), work_before AS (
      SELECT w."id", w."demandId", w."creatorId", w."scanRunId"
      FROM "CreatorCampaignFanRefreshWork" w
      JOIN candidate c ON c."id" = w."demandId"
      WHERE w."status" = 'QUEUED'
      ORDER BY w."id" ASC
      FOR UPDATE OF w
    ), planned_delta AS (
      SELECT "creatorId", "scanRunId", COUNT(*)::int AS "failedCount"
      FROM work_before
      GROUP BY "creatorId", "scanRunId"
    ), current_guard AS (
      SELECT p."creatorId", p."scanRunId", p."failedCount",
             s."fanValueOutstanding" >= p."failedCount" AS "outstandingSafe"
      FROM planned_delta p
      JOIN "CreatorCampaignCollectionState" s
        ON s."creatorId" = p."creatorId"
       AND s."fanValueCoverageScanRunId" = p."scanRunId"
    ), unsafe AS (
      SELECT COUNT(*)::int AS "count"
      FROM current_guard
      WHERE NOT "outstandingSafe"
    ), demand_update AS (
      UPDATE "CreatorFanRefreshDemand" d
      SET "status" = 'FAILED',
          "activeRefreshJobId" = NULL,
          "activeRefreshRevision" = NULL,
          "lastFailedAt" = $2,
          "retryAttempts" = d."retryAttempts" + 1,
          "nextRetryAt" = CASE
            WHEN d."retryAttempts" + 1 >= ${CAMPAIGN_FAN_REFRESH_MAX_RETRIES} THEN NULL
            ELSE $2 + make_interval(mins => LEAST(30, (1 << LEAST(4, GREATEST(0, d."retryAttempts")))))
          END,
          "quarantinedAt" = CASE
            WHEN d."retryAttempts" + 1 >= ${CAMPAIGN_FAN_REFRESH_MAX_RETRIES} THEN $2
            ELSE NULL
          END,
          "lastOutcome" = CASE
            WHEN d."retryAttempts" + 1 >= ${CAMPAIGN_FAN_REFRESH_MAX_RETRIES} THEN 'QUARANTINED'
            ELSE 'RETRY_BACKOFF'
          END,
          "lastError" = $3,
          "updatedAt" = $2
      FROM candidate c
      WHERE d."id" = c."id"
        AND (SELECT "count" FROM unsafe) = 0
      RETURNING d."id", d."creatorId"
    ), work_update AS (
      UPDATE "CreatorCampaignFanRefreshWork" w
      SET "status" = 'FAILED',
          "outcome" = 'FAILED',
          "observedAt" = NULL,
          "completedAt" = $2,
          "lastError" = $3,
          "updatedAt" = $2
      FROM work_before wb
      JOIN demand_update du ON du."id" = wb."demandId"
      WHERE w."id" = wb."id"
        AND (SELECT "count" FROM unsafe) = 0
      RETURNING w."id", wb."creatorId", wb."scanRunId"
    ), actual_delta AS (
      SELECT "creatorId", "scanRunId", COUNT(*)::int AS "failedCount"
      FROM work_update
      GROUP BY "creatorId", "scanRunId"
    ), coverage_update AS (
      UPDATE "CreatorCampaignCollectionState" s
      SET "fanValueOutstanding" = s."fanValueOutstanding" - d."failedCount",
          "fanValueFailed" = s."fanValueFailed" + d."failedCount",
          "fanValueFreshnessStatus" = CASE
            WHEN s."fanValueOutstanding" - d."failedCount" > 0 THEN 'QUEUED'::"AnalyticsCoverageStatus"
            ELSE 'PARTIAL'::"AnalyticsCoverageStatus"
          END,
          "fanValueCoverageUpdatedAt" = $2,
          "status" = CASE
            WHEN s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus" THEN 'PARTIAL'::"AnalyticsCoverageStatus"
            ELSE s."status"
          END,
          "retryAfterAt" = CASE
            WHEN s."membershipCoverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus" THEN NULL
            ELSE s."retryAfterAt"
          END,
          "lastErrorCode" = CASE
            WHEN s."membershipCoverageStatus" <> 'COMPLETE'::"AnalyticsCoverageStatus" THEN s."lastErrorCode"
            WHEN s."fanValueOutstanding" - d."failedCount" > 0 THEN 'CAMPAIGN_FAN_VALUE_REFRESH_PENDING'
            ELSE 'CAMPAIGN_FAN_VALUE_REFRESH_PARTIAL'
          END,
          "lastErrorMessage" = CASE
            WHEN s."membershipCoverageStatus" <> 'COMPLETE'::"AnalyticsCoverageStatus" THEN s."lastErrorMessage"
            WHEN s."fanValueOutstanding" - d."failedCount" > 0
              THEN 'Campaign membership is complete; ' || (s."fanValueOutstanding" - d."failedCount")::text || ' FanData refreshes are still outstanding'
            ELSE 'Campaign membership is complete; ' || (s."fanValueFailed" + d."failedCount")::text || ' FanData refreshes failed'
          END,
          "updatedAt" = $2
      FROM actual_delta d
      WHERE s."creatorId" = d."creatorId"
        AND s."fanValueCoverageScanRunId" = d."scanRunId"
        AND s."fanValueOutstanding" >= d."failedCount"
        AND (SELECT "count" FROM unsafe) = 0
      RETURNING s."creatorId", d."scanRunId"
    )
    SELECT
      (SELECT "count" FROM unsafe) AS "coverageTransitionLost",
      (SELECT COUNT(*)::int FROM demand_update) AS "applied",
      (SELECT COUNT(*)::int FROM work_update) AS "workTransitioned",
      (SELECT COUNT(*)::int FROM coverage_update) AS "coverageRunsUpdated"
  `, jobId, effectiveNow, errorText);
  const result = Array.isArray(rows) && rows[0] ? rows[0] : {};
  if (Math.max(0, Number(result.coverageTransitionLost || 0)) > 0) {
    throw new Error("CAMPAIGN_FAN_REFRESH_TERMINAL_COVERAGE_TRANSITION_LOST");
  }
  return {
    applied: Math.max(0, Number(result.applied || 0)),
    workTransitioned: Math.max(0, Number(result.workTransitioned || 0)),
    coverageRunsUpdated: Math.max(0, Number(result.coverageRunsUpdated || 0)),
    topology: "set_based_v1",
  };
}

async function recordCampaignFanRefreshChunk({ db, job, chunkResult, applied: projectionReceipt = null } = {}) {
  if (!db?.creatorFanRefreshDemand?.findMany || String(job?.jobKey || "") !== "fan_data_point_refresh") return null;
  const items = Array.isArray(chunkResult?.items) ? chunkResult.items : [];
  const ids = [...new Set(items.map((item) => clean(item?.onlyFansUserId, 180)).filter(Boolean))].sort();
  if (!ids.length) return { applied: 0 };

  // Production point-refresh chunks have already committed their canonical FanData
  // projection before this hook runs. That projection invokes the same canonical
  // Campaign-demand reconciler for every value observation. Keep this hook only
  // as an idempotent set-based catch-up for item ids whose canonical value may
  // already be fresh; never re-enter the legacy per-demand writer after a trusted
  // canonical projection. This removes the hidden O(N) half of partial 25/50
  // success while preserving direct/in-memory adapter compatibility below.
  const canonicalProjectionCommitted = projectionReceipt?.type === "fan_data_point_refresh" && projectionReceipt?.ok === true;
  const productionSetBasedAdapter = typeof db?.$queryRawUnsafe === "function"
    && Boolean(db?.creatorFanRefreshDemand?.findMany)
    && Boolean(db?.creatorCampaignFanRefreshWork)
    && Boolean(db?.creatorCampaignCollectionState);
  if (canonicalProjectionCommitted && productionSetBasedAdapter) {
    const canonicalValueIds = new Set(items
      .filter((item) => item?.value && typeof item.value === "object")
      .map((item) => clean(item?.onlyFansUserId, 180))
      .filter(Boolean));
    const catchUpIds = ids.filter((fanId) => !canonicalValueIds.has(fanId));
    if (!catchUpIds.length) {
      return {
        applied: 0,
        topology: "canonical_projection_v1",
        reconciliation: { healed: 0, reason: "canonical_projection_already_reconciled" },
      };
    }
    const reconciliation = await reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
      db, creatorId: job.creatorId, fanIds: catchUpIds,
    });
    return {
      applied: Math.max(0, Number(reconciliation?.healed || 0)),
      topology: "canonical_set_based_catchup_v1",
      reconciliation,
    };
  }

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
        retryAttempts: 0,
        nextRetryAt: null,
        lastRetryAt: null,
        quarantinedAt: null,
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
  const errorText = `fan_data_point_refresh completed without satisfying requested freshness${result?.errors ? `; errors=${Number(result.errors)}` : ""}`;
  let terminal = { applied: 0, topology: "none" };
  if (failed.length && supportsSetBasedCampaignFanRefreshTerminal(db)) {
    terminal = await transitionCampaignFanRefreshTerminalSetBased({ db, refreshJobId: job.id, now, error: errorText });
  } else {
    for (const demand of failed) {
      const { retryAttempts, quarantined, nextRetryAt, quarantinedAt, lastOutcome } = campaignFanRefreshFailurePlan(demand, now);
      await db.creatorFanRefreshDemand.update({
        where: { id: demand.id },
        data: {
          status: DEMAND_STATUS.FAILED,
          activeRefreshJobId: null,
          activeRefreshRevision: null,
          lastFailedAt: now,
          retryAttempts,
          nextRetryAt,
          quarantinedAt,
          lastOutcome,
          lastError: errorText,
        },
      });
      await transitionWorkForDemand(db, { demand, outcome: WORK_STATUS.FAILED, observedAt: null, error: "refresh job finished without a fresh terminal value", now });
    }
    terminal = { applied: failed.length, topology: "adapter_fallback" };
  }
  return {
    applied: terminal.applied,
    rescheduled: followUpJobId ? superseded.length : 0,
    deferred: followUpJobId ? 0 : superseded.length,
    followUpJobId,
    topology: terminal.topology,
    workTransitioned: terminal.workTransitioned || 0,
    coverageRunsUpdated: terminal.coverageRunsUpdated || 0,
  };
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
  const errorText = clean(error?.message || error, 1000) || "fan_data_point_refresh failed";
  let failedTransition = { applied: 0, topology: "none" };
  if (failed.length && supportsSetBasedCampaignFanRefreshTerminal(db)) {
    failedTransition = await transitionCampaignFanRefreshTerminalSetBased({ db, refreshJobId: job.id, now, error: errorText });
  } else {
    for (const demand of failed) {
      const { retryAttempts, quarantined, nextRetryAt, quarantinedAt, lastOutcome } = campaignFanRefreshFailurePlan(demand, now);
      await db.creatorFanRefreshDemand.update({ where: { id: demand.id }, data: {
        status: DEMAND_STATUS.FAILED, activeRefreshJobId: null, activeRefreshRevision: null,
        lastFailedAt: now, retryAttempts, nextRetryAt, quarantinedAt,
        lastOutcome,
        lastError: errorText,
      } });
      await transitionWorkForDemand(db, { demand, outcome: WORK_STATUS.FAILED, observedAt: null, error: errorText, now });
    }
    failedTransition = { applied: failed.length, topology: "adapter_fallback" };
  }
  return {
    applied: failedTransition.applied,
    rescheduled: followUpJobId ? superseded.length : 0,
    deferred: followUpJobId ? 0 : superseded.length,
    followUpJobId,
    topology: failedTransition.topology,
    workTransitioned: failedTransition.workTransitioned || 0,
    coverageRunsUpdated: failedTransition.coverageRunsUpdated || 0,
  };
}

module.exports = {
  CAMPAIGN_FAN_REFRESH_QUEUE_VERSION,
  CAMPAIGN_FAN_REFRESH_JOB_MAX,
  CAMPAIGN_FAN_REFRESH_MAX_RETRIES,
  CAMPAIGN_FAN_VALUE_FRESHNESS_MS,
  WORK_STATUS,
  DEMAND_STATUS,
  campaignFanRefreshIsFresh,
  campaignFanValueCoverageFromState: coverageFromState,
  enqueueUniqueCampaignFanRefreshes,
  promoteQueuedCampaignFanRefreshDemands,
  recoverFailedCampaignFanRefreshDemands,
  repairFailedCampaignFanRefreshDemands,
  reconcileCampaignFanRefreshDemandsFromCanonicalObservations,
  recordCampaignFanRefreshChunk,
  finalizeCampaignFanRefreshJob,
  recordCampaignFanRefreshJobFailure,
  reconcileCampaignFanValueCoverage,
  _test: { scheduleDemandRefreshJob, transitionCampaignFanRefreshTerminalSetBased, supportsSetBasedCampaignFanRefreshTerminal, campaignFanRefreshRetryDelayMs, campaignFanRefreshFailurePlan, shouldResetCampaignRefreshJob },
};
