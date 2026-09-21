"use strict";

const crypto = require("node:crypto");
const { CAMPAIGN_FAN_VALUE_FRESHNESS_MS } = require("./analytics-freshness-policy");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { fanDataRefreshScheduleAvailable } = require("./provider-capacity-authority-service");
const {
  acquireCampaignTransactionLock,
  withCampaignTransactionLock,
} = require("./campaign-transaction-lock-service");

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
function campaignPromotionSignalId(creatorId) {
  return `campaign_promote_${crypto.createHash("sha256").update(String(creatorId || "")).digest("hex").slice(0, 24)}`;
}

async function signalCampaignFanRefreshPromotion({ db, agencyId, creatorId, dueAt = new Date(), reason = "QUEUED_DEBT" } = {}) {
  const scopedCreatorId = clean(creatorId, 180);
  const scopedAgencyId = clean(agencyId, 180);
  const effectiveDueAt = asDate(dueAt) || new Date();
  const signalReason = clean(reason, 64) || "QUEUED_DEBT";
  if (!scopedCreatorId || !scopedAgencyId) return { signaled: false, reason: "scope_required" };

  // Production PostgreSQL must merge concurrent signals atomically. A previous
  // read -> JS LEAST -> Prisma upsert sequence could overwrite an earlier dueAt
  // with a later one, and it gave a claimed worker no causal evidence that new
  // debt arrived after its claim. revision is therefore incremented in the same
  // row write that performs SQL LEAST(dueAt).
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      INSERT INTO "CampaignFanRefreshPromotionSignal" (
        "id","agencyId","creatorId","dueAt","reason","revision","attempts","createdAt","updatedAt"
      ) VALUES ($1,$2,$3,$4,$5,1,0,NOW(),NOW())
      ON CONFLICT ("creatorId") DO UPDATE SET
        "agencyId" = EXCLUDED."agencyId",
        "dueAt" = LEAST("CampaignFanRefreshPromotionSignal"."dueAt", EXCLUDED."dueAt"),
        "reason" = EXCLUDED."reason",
        "revision" = "CampaignFanRefreshPromotionSignal"."revision" + 1,
        "lastError" = NULL,
        "updatedAt" = NOW()
      RETURNING "dueAt", "revision"
    `, campaignPromotionSignalId(scopedCreatorId), scopedAgencyId, scopedCreatorId, effectiveDueAt, signalReason);
    const row = Array.isArray(rows) ? rows[0] || null : null;
    return { signaled: true, dueAt: asDate(row?.dueAt) || effectiveDueAt, revision: Number(row?.revision || 0) || null };
  }

  // Adapter-only compatibility path. Production Prisma exposes $queryRawUnsafe;
  // semantic tests/in-memory adapters may not. Keep behavior functional there,
  // but do not treat this branch as the concurrency authority proof.
  if (db?.campaignFanRefreshPromotionSignal?.upsert) {
    const existing = await db.campaignFanRefreshPromotionSignal.findUnique?.({ where: { creatorId: scopedCreatorId } });
    const nextDueAt = existing?.dueAt && asDate(existing.dueAt) && asDate(existing.dueAt) < effectiveDueAt ? asDate(existing.dueAt) : effectiveDueAt;
    const row = await db.campaignFanRefreshPromotionSignal.upsert({
      where: { creatorId: scopedCreatorId },
      create: {
        id: campaignPromotionSignalId(scopedCreatorId), agencyId: scopedAgencyId, creatorId: scopedCreatorId,
        dueAt: effectiveDueAt, reason: signalReason, revision: 1, attempts: 0,
      },
      update: {
        agencyId: scopedAgencyId, dueAt: nextDueAt, reason: signalReason,
        revision: { increment: 1 }, lastError: null,
      },
    });
    return { signaled: true, dueAt: asDate(row?.dueAt) || nextDueAt, revision: Number(row?.revision || 0) || null };
  }
  return { signaled: false, reason: "adapter_unsupported" };
}

async function healExistingCanonicalCampaignDebt({ db, creatorId, now = null, limit = 500 } = {}) {
  const scopedCreatorId = clean(creatorId, 180);
  if (!scopedCreatorId || typeof db?.$queryRawUnsafe !== "function") return { healedFans: 0, reason: "adapter_unsupported" };
  const take = Math.max(1, Math.min(500, Number(limit) || 500));
  const rows = await db.$queryRawUnsafe(`
    SELECT d."onlyFansUserId"
    FROM "CreatorFanRefreshDemand" d
    JOIN "CreatorFan" f
      ON f."creatorId" = d."creatorId"
     AND f."onlyFansUserId" = d."onlyFansUserId"
    JOIN "CreatorFanValueCurrent" v
      ON v."creatorId" = f."creatorId"
     AND v."fanId" = f."id"
    WHERE d."creatorId" = $1
      AND d."status" IN ('QUEUED','FAILED')
      AND v."fetchedAt" IS NOT NULL
      AND v."fetchedAt" >= d."requestedFreshnessCutoffAt"
    ORDER BY d."updatedAt" ASC, d."id" ASC
    FOR UPDATE OF d SKIP LOCKED
    LIMIT $2
  `, scopedCreatorId, take);
  const fanIds = [...new Set((rows || []).map((row) => clean(row?.onlyFansUserId, 180)).filter(Boolean))];
  if (!fanIds.length) return { healedFans: 0, reason: "none_due" };
  const result = await reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
    db, creatorId: scopedCreatorId, fanIds, now: asDate(now) || new Date(), _campaignLockHeld: true,
  });
  return { healedFans: fanIds.length, result, reason: "canonical_backfill" };
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

async function incrementCoverage(db, { creatorId, scanRunId, cutoff, expected = 0, alreadyFresh = 0, queued = 0, outstanding = 0, now, coverageAuthority = null }) {
  await ensureCoverageRun(db, { creatorId, scanRunId, cutoff, now, coverageAuthority });
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

async function reconcileCampaignFanRefreshDemandsFromCanonicalObservations({ db, creatorId, fanIds = [], now = null, _campaignLockHeld = false } = {}) {
  const scopedCreatorId = clean(creatorId, 180);
  const ids = [...new Set((Array.isArray(fanIds) ? fanIds : []).map((value) => clean(value, 180)).filter(Boolean))].sort();
  if (!scopedCreatorId || !ids.length) return { healed: 0, reason: "nothing_to_reconcile" };
  if (!_campaignLockHeld && typeof db?.$transaction === "function") {
    return withCampaignTransactionLock({
      db,
      creatorId: scopedCreatorId,
      work: (tx) => reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
        db: tx, creatorId: scopedCreatorId, fanIds: ids, now, _campaignLockHeld: true,
      }),
      options: { maxWait: 30_000, timeout: 60_000 },
    });
  }
  if (!_campaignLockHeld) await acquireCampaignTransactionLock(db, scopedCreatorId);
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
  if (!scopedCreatorId) return { recovered: 0, requeuedWork: 0, coverageRunsUpdated: 0, reason: "creator_required", topology: "set_based_v3_creator_scoped" };
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
        AND d."creatorId" = $3
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
    topology: "set_based_v3_creator_scoped",
  };
}

async function recoverFailedCampaignFanRefreshDemands({ db, now = null, creatorId = null, force = false, maxDemands = 200, _transactionWrapped = false, _campaignLockHeld = false } = {}) {
  if (!db?.creatorFanRefreshDemand?.findMany) return { recovered: 0, requeuedWork: 0, reason: "adapter_unsupported" };
  const scopedCreatorId = clean(creatorId, 180);
  if (!scopedCreatorId) return { recovered: 0, requeuedWork: 0, reason: "creator_required" };
  if (supportsSetBasedCampaignFanRefreshRecovery(db)) {
    if (!_transactionWrapped && typeof db?.$transaction === "function") {
      return db.$transaction((tx) => recoverFailedCampaignFanRefreshDemands({
        db: tx, now, creatorId: scopedCreatorId, force, maxDemands, _transactionWrapped: true, _campaignLockHeld,
      }), { maxWait: 30_000, timeout: 60_000 });
    }
    if (!_campaignLockHeld) await acquireCampaignTransactionLock(db, scopedCreatorId);
    return recoverFailedCampaignFanRefreshDemandsSetBased({ db, now, creatorId: scopedCreatorId, force, maxDemands });
  }
  const effectiveNow = asDate(now) || await dbAuthorityNow({ db, fallbackNow: new Date() });
  const limit = Math.max(1, Math.min(2000, Number(maxDemands) || 200));
  const candidates = await db.creatorFanRefreshDemand.findMany({
    where: {
      creatorId: scopedCreatorId,
      status: DEMAND_STATUS.FAILED,
      activeRefreshJobId: null,
      ...(force ? {} : { quarantinedAt: null, nextRetryAt: { lte: effectiveNow } }),
    },
    orderBy: [{ nextRetryAt: "asc" }, { updatedAt: "asc" }],
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
  const scopedCreatorId = clean(creatorId, 180);
  if (!scopedCreatorId) return { recovered: 0, requeuedWork: 0, reason: "creator_required" };
  const work = async (tx) => {
    await acquireCampaignTransactionLock(tx, scopedCreatorId);
    const repaired = await recoverFailedCampaignFanRefreshDemands({
      db: tx, creatorId: scopedCreatorId, now, force: true, maxDemands,
      _transactionWrapped: true, _campaignLockHeld: true,
    });
    const agencyRow = await tx.creatorFanRefreshDemand.findFirst({ where: { creatorId: scopedCreatorId }, select: { agencyId: true } });
    if (agencyRow?.agencyId) {
      await signalCampaignFanRefreshPromotion({
        db: tx, agencyId: agencyRow.agencyId, creatorId: scopedCreatorId, dueAt: asDate(now) || new Date(), reason: "MANUAL_REPAIR",
      });
    }
    return { ...repaired, promotionSignaled: Boolean(agencyRow?.agencyId), promotedJobs: 0, promotedFans: 0 };
  };
  if (typeof db?.$transaction === "function") return db.$transaction(work, { maxWait: 30_000, timeout: 60_000 });
  return work(db);
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
    await signalCampaignFanRefreshPromotion({ db, agencyId, creatorId, dueAt: scheduledAt, reason: "CAPACITY_DEFERRED" });
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

async function enqueueUniqueCampaignFanRefreshes({ db, job, scanRunId, scanStartedAt, candidates = [], now = new Date(), planner = null, collectorVersion = null, _campaignLockHeld = false } = {}) {
  const creatorId = clean(job?.creatorId, 180);
  const agencyId = clean(job?.agencyId, 180);
  const campaignJobId = clean(job?.id, 180);
  const runId = clean(scanRunId, 120);
  const runStartedAt = asDate(scanStartedAt);
  const scheduledAt = asDate(now) || new Date();
  const cutoff = new Date(runStartedAt.getTime() - CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
  if (!db || !creatorId || !agencyId || !campaignJobId || !runId || !runStartedAt) throw new Error("CAMPAIGN_FAN_REFRESH_QUEUE_SCOPE_INVALID");
  if (!_campaignLockHeld && typeof db?.$transaction === "function") {
    return withCampaignTransactionLock({
      db,
      creatorId,
      work: (tx) => enqueueUniqueCampaignFanRefreshes({
        db: tx, job, scanRunId, scanStartedAt, candidates, now, planner, collectorVersion, _campaignLockHeld: true,
      }),
      options: { maxWait: 30_000, timeout: 60_000 },
    });
  }
  if (!_campaignLockHeld) await acquireCampaignTransactionLock(db, creatorId);

  const params = job?.params && typeof job.params === "object" && !Array.isArray(job.params) ? job.params : {};
  const coverageAuthority = {
    delegated: Number(params.campaignFreshnessCoverageVersion || 0) >= 1 || Boolean(clean(collectorVersion, 80)),
    ownerKind: params.manualCampaignScan === true ? "MANUAL" : "AUTOMATIC",
    collectorVersion: clean(collectorVersion, 80),
    sourceJobId: campaignJobId,
  };
  const normalized = uniqueCandidates(candidates).slice(0, CAMPAIGN_FAN_REFRESH_JOB_MAX);
  // A20.11 lock-order authority: any transaction that touches Campaign refresh
  // demand/work plus the creator-wide collection state must acquire them in the
  // same direction: demand -> work -> collection state. Earlier generations
  // initialized CreatorCampaignCollectionState here, before demand row locks,
  // while healing/recovery/terminal paths lock demand/work first. That reverse
  // order can deadlock a new Campaign generation against completion of an older
  // refresh job. State-only early-return cases are safe because they never seek
  // demand/work after taking the state row.
  if (!normalized.length) {
    await ensureCoverageRun(db, { creatorId, scanRunId: runId, cutoff, now: scheduledAt, coverageAuthority });
    return { expected: 0, alreadyFresh: 0, queued: 0, scheduled: 0, coalesced: 0, fanIds: [] };
  }
  if (!db.creatorCampaignFanRefreshWork?.findMany || !db.creatorFanRefreshDemand?.findMany || !db.jobInstance) {
    await ensureCoverageRun(db, { creatorId, scanRunId: runId, cutoff, now: scheduledAt, coverageAuthority });
    return { expected: 0, alreadyFresh: 0, queued: 0, scheduled: 0, adapterUnsupported: true, fanIds: [] };
  }

  const ids = normalized.map((row) => row.onlyFansUserId);
  const existingWork = await db.creatorCampaignFanRefreshWork.findMany({
    where: { creatorId, scanRunId: runId, onlyFansUserId: { in: ids } },
    select: { onlyFansUserId: true }, take: ids.length,
  });
  const seenWork = new Set((existingWork || []).map((row) => clean(row?.onlyFansUserId, 180)).filter(Boolean));
  const newCandidates = normalized.filter((row) => !seenWork.has(row.onlyFansUserId));
  if (!newCandidates.length) {
    // Replay-only path still refreshes durable generation authority, but it does
    // so as a state-only terminal step and never seeks demand/work afterwards.
    await ensureCoverageRun(db, { creatorId, scanRunId: runId, cutoff, now: scheduledAt, coverageAuthority });
    return { expected: 0, alreadyFresh: 0, queued: 0, scheduled: 0, deduped: normalized.length, fanIds: [] };
  }

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
    coverageAuthority,
  });
  if (needsJob.length && !scheduledJobId) {
    await signalCampaignFanRefreshPromotion({ db, agencyId, creatorId, dueAt: scheduledAt, reason: "ENQUEUE_DEFERRED" });
  }
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

async function promoteQueuedCampaignFanRefreshDemands({ db, creatorId, now = null, maxJobs = 4, planner = null, inTransaction = false, _campaignLockHeld = false } = {}) {
  const scopedCreatorId = clean(creatorId, 180);
  if (!scopedCreatorId) return { promotedJobs: 0, promotedFans: 0, reason: "creator_required" };
  if (!inTransaction && typeof db?.$transaction === "function") {
    return db.$transaction((tx) => promoteQueuedCampaignFanRefreshDemands({
      db: tx, creatorId: scopedCreatorId, now, maxJobs, planner, inTransaction: true, _campaignLockHeld,
    }), { maxWait: 30_000, timeout: 60_000 });
  }
  if (!db?.creatorFanRefreshDemand?.findMany || !db?.jobInstance) return { promotedJobs: 0, promotedFans: 0, reason: "adapter_unsupported" };
  if (!_campaignLockHeld) await acquireCampaignTransactionLock(db, scopedCreatorId);
  const effectiveNow = asDate(now) || await dbAuthorityNow({ db, fallbackNow: new Date() });
  const limit = Math.max(1, Math.min(16, Number(maxJobs) || 4));
  const pending = await db.creatorFanRefreshDemand.findMany({
    where: {
      creatorId: scopedCreatorId,
      status: DEMAND_STATUS.QUEUED,
      activeRefreshJobId: null,
      campaignWork: { some: { status: WORK_STATUS.QUEUED } },
    },
    orderBy: [{ lastRequestedAt: "asc" }, { id: "asc" }],
    take: limit * CAMPAIGN_FAN_REFRESH_JOB_MAX,
  });
  if (!pending.length) return { promotedJobs: 0, promotedFans: 0, reason: "none_pending" };
  const agencyId = clean(pending[0]?.agencyId, 180);
  if (!agencyId) return { promotedJobs: 0, promotedFans: 0, reason: "scope_invalid" };
  let promotedJobs = 0;
  let promotedFans = 0;
  for (let cursor = 0; cursor < pending.length && promotedJobs < limit; cursor += CAMPAIGN_FAN_REFRESH_JOB_MAX) {
    const slice = pending.slice(cursor, cursor + CAMPAIGN_FAN_REFRESH_JOB_MAX);
    const batch = slice.map((demand) => ({
      fanId: clean(demand.onlyFansUserId, 180), demand, revision: Math.max(1, Number(demand.requestedRevision || 1)),
    })).filter((row) => row.fanId);
    if (!batch.length) continue;
    const refreshJobId = await scheduleDemandRefreshJob({
      db,
      job: { id: "campaign-refresh-backlog-promoter", agencyId, creatorId: scopedCreatorId, priority: 85 },
      demands: batch,
      scheduledAt: effectiveNow,
      planner,
    });
    if (!refreshJobId) break;
    promotedJobs += 1;
    promotedFans += batch.length;
  }
  return { promotedJobs, promotedFans, reason: promotedJobs ? "promoted" : "capacity_saturated" };
}

const CAMPAIGN_PROMOTION_SIGNAL_CLAIM_MS = 2 * 60 * 1000;

async function claimCampaignFanRefreshPromotionSignal({ db, now = new Date() } = {}) {
  if (typeof db?.$transaction !== "function") return null;
  const fallbackNow = asDate(now) || new Date();
  const claimToken = `claim_${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}`;
  return db.$transaction(async (tx) => {
    if (typeof tx?.$queryRawUnsafe !== "function") return null;
    // PostgreSQL, not a scheduler replica wall clock, owns due/lease chronology.
    // A skewed process clock must never reclaim another replica's live signal.
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const claimUntil = new Date(authorityNow.getTime() + CAMPAIGN_PROMOTION_SIGNAL_CLAIM_MS);
    const rows = await tx.$queryRawUnsafe(`
      WITH candidate AS (
        SELECT s."id"
        FROM "CampaignFanRefreshPromotionSignal" s
        WHERE s."dueAt" <= $1
          AND COALESCE(s."claimUntil", '-infinity'::timestamp) <= $1
        ORDER BY s."dueAt" ASC, s."creatorId" ASC
        FOR UPDATE OF s SKIP LOCKED
        LIMIT 1
      )
      UPDATE "CampaignFanRefreshPromotionSignal" s
      SET "claimToken" = $2,
          "claimUntil" = $3,
          "updatedAt" = NOW()
      FROM candidate c
      WHERE s."id" = c."id"
      RETURNING s."id", s."agencyId", s."creatorId", s."dueAt", s."revision", s."attempts", s."claimToken", s."claimUntil"
    `, authorityNow, claimToken, claimUntil);
    const signal = Array.isArray(rows) ? rows[0] || null : null;
    return signal ? { ...signal, claimedAt: authorityNow } : null;
  }, { maxWait: 10_000, timeout: 10_000 });
}

async function releaseCampaignFanRefreshPromotionClaim({ db, signal, now = new Date(), error = null } = {}) {
  if (!signal?.id || !signal?.claimToken) return false;
  const effectiveNow = await dbAuthorityNow({ db, fallbackNow: asDate(now) || new Date() });
  const retryDueAt = new Date(effectiveNow.getTime() + 60_000);
  const lastError = clean(error?.message || error, 1000);
  // Exact claimed revision owns this retry schedule, so move dueAt forward.
  // If a newer producer incremented revision, the exact update does not match;
  // the stale claimant then releases only its old token and preserves producer dueAt.
  if (typeof db?.$executeRawUnsafe === "function") {
    const count = await db.$executeRawUnsafe(`
      UPDATE "CampaignFanRefreshPromotionSignal"
      SET "dueAt" = $3, "claimToken" = NULL, "claimUntil" = NULL,
          "attempts" = "attempts" + 1, "lastError" = $4, "updatedAt" = NOW()
      WHERE "id" = $1 AND "claimToken" = $2 AND "revision" = $5
    `, signal.id, signal.claimToken, retryDueAt, lastError, Number(signal.revision || 0));
    if (Number(count || 0) > 0) return true;
    await db.$executeRawUnsafe(`
      UPDATE "CampaignFanRefreshPromotionSignal"
      SET "claimToken"=NULL, "claimUntil"=NULL, "updatedAt"=NOW()
      WHERE "id"=$1 AND "claimToken"=$2
    `, signal.id, signal.claimToken);
    return false;
  }
  if (db?.campaignFanRefreshPromotionSignal?.updateMany) {
    // Adapter fallback is likewise fenced by claimed revision so it cannot
    // overwrite a signal produced after this claim.
    const updated = await db.campaignFanRefreshPromotionSignal.updateMany({
      where: { id: signal.id, claimToken: signal.claimToken, revision: Number(signal.revision || 0) },
      data: { dueAt: retryDueAt, claimToken: null, claimUntil: null, attempts: { increment: 1 }, lastError },
    });
    return Number(updated?.count || 0) > 0;
  }
  return false;
}

async function runCampaignFanRefreshPromotionMaintenance({
  db,
  now = new Date(),
  maxCreators = 200,
  maxJobsPerCreator = 4,
  concurrency = 4,
  maxRuntimeMs = 8_000,
} = {}) {
  const root = db;
  if (typeof root?.$transaction !== "function" || typeof root?.$queryRawUnsafe !== "function") return { processedCreators: 0, promotedJobs: 0, promotedFans: 0, healedFans: 0, recovered: 0, reason: "adapter_unsupported" };
  const fallbackNow = asDate(now) || new Date();
  const max = Math.max(1, Math.min(250, Number(maxCreators) || 200));
  const workerCount = Math.max(1, Math.min(8, Number(concurrency) || 4, max));
  const runtimeBudgetMs = Math.max(1_000, Math.min(30_000, Number(maxRuntimeMs) || 8_000));
  const startedMonotonic = Date.now();
  const totals = {
    processedCreators: 0, promotedJobs: 0, promotedFans: 0, healedFans: 0, recovered: 0,
    errors: 0, contended: 0, errorDetails: [],
  };
  let reservedSlots = 0;
  let drained = false;

  async function processSignal(signal) {
    try {
      const claimed = await root.$transaction(async (tx) => {
        const creatorId = clean(signal.creatorId, 180);
        const agencyId = clean(signal.agencyId, 180);
        if (!creatorId || !agencyId) return { stale: true };
        // Lock ordering remains signal-claim commit -> creator Campaign authority.
        // The signal token itself is revalidated against PostgreSQL time only after
        // creator authority is held; every final signal mutation is token-guarded.
        await acquireCampaignTransactionLock(tx, creatorId);
        const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
        const current = await tx.campaignFanRefreshPromotionSignal.findFirst({
          where: {
            id: signal.id,
            claimToken: signal.claimToken,
            claimUntil: { gt: authorityNow },
            revision: Number(signal.revision || 0),
          },
        });
        if (!current) {
          // The lease expired or a producer incremented revision after claim.
          // Release only our token; preserve the producer-owned dueAt/revision.
          await tx.campaignFanRefreshPromotionSignal.updateMany({
            where: { id: signal.id, claimToken: signal.claimToken },
            data: { claimToken: null, claimUntil: null },
          });
          return { stale: true };
        }

        const healed = await healExistingCanonicalCampaignDebt({ db: tx, creatorId, now: authorityNow, limit: 500 });
        const recovered = await recoverFailedCampaignFanRefreshDemands({
          db: tx, creatorId, now: authorityNow, force: false, maxDemands: 500,
          _transactionWrapped: true, _campaignLockHeld: true,
        });
        const promoted = await promoteQueuedCampaignFanRefreshDemands({
          db: tx, creatorId, now: authorityNow, maxJobs: maxJobsPerCreator, inTransaction: true, _campaignLockHeld: true,
        });
        const [queuedCount, failedDueCount, nextFailed] = await Promise.all([
          tx.creatorFanRefreshDemand.count({ where: { creatorId, status: DEMAND_STATUS.QUEUED, activeRefreshJobId: null } }),
          tx.creatorFanRefreshDemand.count({ where: { creatorId, status: DEMAND_STATUS.FAILED, activeRefreshJobId: null, quarantinedAt: null, nextRetryAt: { lte: authorityNow } } }),
          tx.creatorFanRefreshDemand.findFirst({
            where: { creatorId, status: DEMAND_STATUS.FAILED, activeRefreshJobId: null, quarantinedAt: null, nextRetryAt: { gt: authorityNow } },
            orderBy: { nextRetryAt: "asc" }, select: { nextRetryAt: true },
          }),
        ]);
        let signalMutation;
        if (queuedCount > 0 || failedDueCount > 0 || healed.healedFans >= 500) {
          signalMutation = await tx.campaignFanRefreshPromotionSignal.updateMany({
            where: { id: signal.id, claimToken: signal.claimToken, revision: Number(signal.revision || 0) },
            data: { dueAt: new Date(authorityNow.getTime() + 5_000), claimToken: null, claimUntil: null, attempts: { increment: 1 }, lastError: null },
          });
        } else if (nextFailed?.nextRetryAt) {
          signalMutation = await tx.campaignFanRefreshPromotionSignal.updateMany({
            where: { id: signal.id, claimToken: signal.claimToken, revision: Number(signal.revision || 0) },
            data: { dueAt: nextFailed.nextRetryAt, claimToken: null, claimUntil: null, attempts: 0, lastError: null },
          });
        } else {
          signalMutation = await tx.campaignFanRefreshPromotionSignal.deleteMany({
            where: { id: signal.id, claimToken: signal.claimToken, revision: Number(signal.revision || 0) },
          });
        }
        if (Number(signalMutation?.count || 0) !== 1) {
          // revision changed after claim => a producer published newer causal
          // debt. Preserve its dueAt/revision and only release our old token.
          await tx.campaignFanRefreshPromotionSignal.updateMany({
            where: { id: signal.id, claimToken: signal.claimToken },
            data: { claimToken: null, claimUntil: null },
          });
          return { stale: true };
        }
        return { creatorId, agencyId, healed, recovered, promoted };
      }, { maxWait: 30_000, timeout: 60_000 });
      if (claimed?.stale) { totals.contended += 1; return; }
      totals.processedCreators += 1;
      totals.healedFans += Number(claimed.healed?.healedFans || 0);
      totals.recovered += Number(claimed.recovered?.recovered || 0);
      totals.promotedJobs += Number(claimed.promoted?.promotedJobs || 0);
      totals.promotedFans += Number(claimed.promoted?.promotedFans || 0);
    } catch (error) {
      totals.errors += 1;
      if (totals.errorDetails.length < 5) {
        totals.errorDetails.push({
          signalId: signal?.id || null,
          agencyId: signal?.agencyId || null,
          creatorId: signal?.creatorId || null,
          code: error?.code || null,
          message: String(error?.message || error || "campaign_promotion_maintenance_error").slice(0, 500),
        });
      }
      await releaseCampaignFanRefreshPromotionClaim({ db: root, signal, now: fallbackNow, error }).catch(() => {});
    }
  }

  async function worker(initialSignal = null) {
    let nextSignal = initialSignal;
    for (;;) {
      if (drained || Date.now() - startedMonotonic >= runtimeBudgetMs) return;
      let signal = nextSignal;
      nextSignal = null;
      if (!signal && reservedSlots >= max) return;
      if (!signal) {
        reservedSlots += 1;
        // Claim is one short SKIP LOCKED transaction and derives lease chronology
        // from PostgreSQL. Never preclaim a batch that can expire in a JS queue.
        signal = await claimCampaignFanRefreshPromotionSignal({ db: root, now: fallbackNow });
      }
      if (!signal) { drained = true; return; }
      await processSignal(signal);
    }
  }

  // Free-tier empty queue: pay for one claim first, only fan out when work exists.
  reservedSlots += 1;
  const firstSignal = await claimCampaignFanRefreshPromotionSignal({ db: root, now: fallbackNow });
  if (!firstSignal) {
    drained = true;
  } else {
    await Promise.all([
      worker(firstSignal),
      ...Array.from({ length: Math.max(0, workerCount - 1) }, () => worker()),
    ]);
  }
  const budgetExhausted = !drained && reservedSlots < max && Date.now() - startedMonotonic >= runtimeBudgetMs;
  return {
    ...totals,
    claimedSlots: reservedSlots,
    concurrency: workerCount,
    budgetExhausted,
    reason: totals.processedCreators ? "processed" : (totals.contended ? "contended" : (budgetExhausted ? "budget_exhausted" : "none_due")),
  };
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

async function recordCampaignFanRefreshChunk({ db, job, chunkResult, applied: projectionReceipt = null, _campaignLockHeld = false } = {}) {
  if (!db?.creatorFanRefreshDemand?.findMany || String(job?.jobKey || "") !== "fan_data_point_refresh") return null;
  const creatorId = clean(job?.creatorId, 180);
  if (creatorId && !_campaignLockHeld && typeof db?.$transaction === "function") {
    return withCampaignTransactionLock({
      db,
      creatorId,
      work: (tx) => recordCampaignFanRefreshChunk({ db: tx, job, chunkResult, applied: projectionReceipt, _campaignLockHeld: true }),
      options: { maxWait: 30_000, timeout: 60_000 },
    });
  }
  if (creatorId && !_campaignLockHeld) await acquireCampaignTransactionLock(db, creatorId);
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

async function signalCampaignDebtAfterTerminal({ db, job, creatorId, now, terminalApplied = 0, deferred = 0, reason = "TERMINAL_DEBT" } = {}) {
  const scopedCreatorId = clean(creatorId || job?.creatorId, 180);
  const agencyId = clean(job?.agencyId, 180);
  if (!scopedCreatorId || !agencyId || (Number(terminalApplied || 0) <= 0 && Number(deferred || 0) <= 0)) {
    return { signaled: false, reason: "none" };
  }
  // The maintenance lane computes the real earliest retry after taking the
  // creator-scoped authority. Signalling immediately is safe and avoids a
  // second global scan/read here; if all debt is in backoff it simply moves
  // the signal to the earliest nextRetryAt.
  return signalCampaignFanRefreshPromotion({
    db, agencyId, creatorId: scopedCreatorId, dueAt: asDate(now) || new Date(), reason,
  });
}

async function finalizeCampaignFanRefreshJob({ db, job, result = null, planner = null, _campaignLockHeld = false } = {}) {
  if (!db?.creatorFanRefreshDemand?.findMany || String(job?.jobKey || "") !== "fan_data_point_refresh") return null;
  const creatorId = clean(job?.creatorId, 180);
  if (creatorId && !_campaignLockHeld && typeof db?.$transaction === "function") {
    return withCampaignTransactionLock({
      db,
      creatorId,
      work: (tx) => finalizeCampaignFanRefreshJob({ db: tx, job, result, planner, _campaignLockHeld: true }),
      options: { maxWait: 30_000, timeout: 60_000 },
    });
  }
  if (creatorId && !_campaignLockHeld) await acquireCampaignTransactionLock(db, creatorId);
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
  const deferred = followUpJobId ? 0 : superseded.length;
  const promotionSignal = await signalCampaignDebtAfterTerminal({
    db, job, creatorId, now, terminalApplied: terminal.applied, deferred, reason: "TERMINAL_FINALIZE_DEBT",
  });
  return {
    applied: terminal.applied,
    rescheduled: followUpJobId ? superseded.length : 0,
    deferred,
    followUpJobId,
    topology: terminal.topology,
    workTransitioned: terminal.workTransitioned || 0,
    coverageRunsUpdated: terminal.coverageRunsUpdated || 0,
    promotionSignaled: promotionSignal?.signaled === true,
  };
}

async function recordCampaignFanRefreshJobFailure({ db, job, error, terminal = true, planner = null, _campaignLockHeld = false } = {}) {
  if (!terminal || !db?.creatorFanRefreshDemand?.findMany || String(job?.jobKey || "") !== "fan_data_point_refresh") return null;
  const creatorId = clean(job?.creatorId, 180);
  if (creatorId && !_campaignLockHeld && typeof db?.$transaction === "function") {
    return withCampaignTransactionLock({
      db,
      creatorId,
      work: (tx) => recordCampaignFanRefreshJobFailure({ db: tx, job, error, terminal, planner, _campaignLockHeld: true }),
      options: { maxWait: 30_000, timeout: 60_000 },
    });
  }
  if (creatorId && !_campaignLockHeld) await acquireCampaignTransactionLock(db, creatorId);
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
  const deferred = followUpJobId ? 0 : superseded.length;
  const promotionSignal = await signalCampaignDebtAfterTerminal({
    db, job, creatorId, now, terminalApplied: failedTransition.applied, deferred, reason: "TERMINAL_FAILURE_DEBT",
  });
  return {
    applied: failedTransition.applied,
    rescheduled: followUpJobId ? superseded.length : 0,
    deferred,
    followUpJobId,
    topology: failedTransition.topology,
    workTransitioned: failedTransition.workTransitioned || 0,
    coverageRunsUpdated: failedTransition.coverageRunsUpdated || 0,
    promotionSignaled: promotionSignal?.signaled === true,
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
  runCampaignFanRefreshPromotionMaintenance,
  signalCampaignFanRefreshPromotion,
  claimCampaignFanRefreshPromotionSignal,
  releaseCampaignFanRefreshPromotionClaim,
  healExistingCanonicalCampaignDebt,
  recoverFailedCampaignFanRefreshDemands,
  repairFailedCampaignFanRefreshDemands,
  reconcileCampaignFanRefreshDemandsFromCanonicalObservations,
  recordCampaignFanRefreshChunk,
  finalizeCampaignFanRefreshJob,
  recordCampaignFanRefreshJobFailure,
  reconcileCampaignFanValueCoverage,
  _test: { scheduleDemandRefreshJob, transitionCampaignFanRefreshTerminalSetBased, supportsSetBasedCampaignFanRefreshTerminal, campaignFanRefreshRetryDelayMs, campaignFanRefreshFailurePlan, shouldResetCampaignRefreshJob },
};
