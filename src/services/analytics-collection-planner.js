"use strict";

const { randomUUID, createHash } = require("node:crypto");
const prisma = require("../prisma");
const { buildJobIdempotencyKey, bucketTimestamp } = require("./job-idempotency");
const { createPlannedJobIfAbsent, reschedulePlannedJob, updatePlannedJobDemand, publishPlannedJobAvailable } = require("./job-planning-repository");
const { withDbAdvisoryXactLock } = require("./db-transaction-service");
const { allowedCreatorScope } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const {
  DAY_MS,
  ANALYTICS_CONTRACT_VERSION,
  ANALYTICS_SOURCE_TIMEZONE,
  displayRangeBounds,
  eachDay,
  utcDay,
  dateKey,
} = require("./analytics-range-contract");

const SCAN_GENERATION_MS = 15 * 60 * 1000;
const CURRENT_DAY_FRESHNESS_MS = 15 * 60 * 1000;
const RECENT_CLOSED_FRESHNESS_MS = 48 * 60 * 60 * 1000;
// Provider history is never declared immutable. Old earnings remain mutable
// evidence and are periodically reverified so refunds/chargebacks/corrections
// can converge without inventing an unsupported FINAL state.
const HISTORICAL_FRESHNESS_MS = 30 * DAY_MS;
const RECENT_HISTORY_DAYS = 30;
const RECONCILIATION_BLOCK_DAYS = 7;
const SWEEP_PAGE_SIZE = 250;
const SWEEP_CYCLE_MS = 60 * 60 * 1000;
const SWEEP_LEASE_MS = 15 * 60 * 1000;
const SWEEP_LEASE_KEY = "earnings_recurring_v1";
const SWEEP_COORDINATION_LOCK_KEY = "analytics-sweep-coordinator";
const DEMAND_LEASE_MS = 5 * 60 * 1000;
const DEMAND_PAGE_SIZE = 100;
const DEMAND_CLAIM_LOCK_KEY = "analytics-demand-claim";
const DEMAND_MAX_PER_SWEEP = 4;

let sweepPromise = null;
let demandSweepPromise = null;

function sweepCycleKey(now) {
  const current = asDate(now);
  if (!current) throw new Error("ANALYTICS_SWEEP_NOW_INVALID");
  return new Date(bucketTimestamp(current, SWEEP_CYCLE_MS)).toISOString();
}

async function claimAnalyticsSweepCycle({
  db,
  now,
  ownerToken = randomUUID(),
  leaseNow = new Date(),
  leaseKey = SWEEP_LEASE_KEY,
  coordinationLockKey = SWEEP_COORDINATION_LOCK_KEY,
  leaseMs = SWEEP_LEASE_MS,
}) {
  const currentNow = asDate(now);
  const wallNow = asDate(leaseNow);
  if (!currentNow || !wallNow) throw new Error("ANALYTICS_SWEEP_CLOCK_INVALID");
  const cycleKey = sweepCycleKey(currentNow);
  return withDbAdvisoryXactLock({
    db,
    key: coordinationLockKey,
    work: async (tx) => {
      const existing = await tx.analyticsCollectionLease.findUnique({ where: { key: leaseKey } });
      const leaseUntil = new Date(wallNow.getTime() + leaseMs);
      if (!existing) {
        const row = await tx.analyticsCollectionLease.create({
          data: {
            key: leaseKey, ownerToken, cycleKey, cycleNow: currentNow, cursorCreatorId: null,
            leaseUntil, completedAt: null,
          },
        });
        return { acquired: true, reason: "cycle_created", ownerToken, cycleKey, cycleNow: asDate(row.cycleNow) || currentNow, cursorCreatorId: row.cursorCreatorId || null };
      }

      if (String(existing.cycleKey) === cycleKey) {
        if (existing.completedAt) {
          return { acquired: false, reason: "cycle_completed", ownerToken, cycleKey, cycleNow: asDate(existing.cycleNow) || currentNow, cursorCreatorId: existing.cursorCreatorId || null };
        }
        const currentLeaseUntil = asDate(existing.leaseUntil);
        if (currentLeaseUntil && currentLeaseUntil > wallNow) {
          return { acquired: false, reason: "cycle_lease_held", ownerToken, cycleKey, cycleNow: asDate(existing.cycleNow) || currentNow, cursorCreatorId: existing.cursorCreatorId || null };
        }
        const row = await tx.analyticsCollectionLease.update({
          where: { key: leaseKey },
          data: { ownerToken, leaseUntil, completedAt: null },
        });
        return { acquired: true, reason: "cycle_lease_recovered", ownerToken, cycleKey, cycleNow: asDate(row.cycleNow) || currentNow, cursorCreatorId: row.cursorCreatorId || null };
      }

      // A new UTC-hour cycle must never preempt a still-live previous cycle.
      // Otherwise two replicas can overlap around the hour boundary until the
      // old owner notices its token was replaced. Keep exactly one active
      // analytics sweep globally; a new cycle may start only after the prior
      // owner completed or its lease actually expired.
      const previousLeaseUntil = asDate(existing.leaseUntil);
      if (!existing.completedAt && previousLeaseUntil && previousLeaseUntil > wallNow) {
        return {
          acquired: false,
          reason: "previous_cycle_lease_held",
          ownerToken,
          cycleKey,
          cycleNow: currentNow,
          cursorCreatorId: existing.cursorCreatorId || null,
          activeCycleKey: String(existing.cycleKey),
        };
      }

      const row = await tx.analyticsCollectionLease.update({
        where: { key: leaseKey },
        data: { ownerToken, cycleKey, cycleNow: currentNow, cursorCreatorId: null, leaseUntil, completedAt: null },
      });
      return { acquired: true, reason: "new_cycle_claimed", ownerToken, cycleKey, cycleNow: asDate(row.cycleNow) || currentNow, cursorCreatorId: null };
    },
  });
}

async function renewAnalyticsSweepLease({
  db,
  ownerToken,
  cycleKey,
  cursorCreatorId,
  leaseNow = new Date(),
  leaseKey = SWEEP_LEASE_KEY,
  leaseMs = SWEEP_LEASE_MS,
}) {
  const wallNow = asDate(leaseNow);
  if (!wallNow) throw new Error("ANALYTICS_SWEEP_CLOCK_INVALID");
  const result = await db.analyticsCollectionLease.updateMany({
    where: { key: leaseKey, ownerToken, cycleKey, completedAt: null },
    data: { cursorCreatorId: cursorCreatorId || null, leaseUntil: new Date(wallNow.getTime() + leaseMs) },
  });
  return Number(result?.count || 0) === 1;
}

async function completeAnalyticsSweepCycle({
  db,
  ownerToken,
  cycleKey,
  cursorCreatorId,
  completedAt = new Date(),
  leaseKey = SWEEP_LEASE_KEY,
}) {
  const finishedAt = asDate(completedAt);
  if (!finishedAt) throw new Error("ANALYTICS_SWEEP_CLOCK_INVALID");
  const result = await db.analyticsCollectionLease.updateMany({
    where: { key: leaseKey, ownerToken, cycleKey, completedAt: null },
    data: { cursorCreatorId: cursorCreatorId || null, leaseUntil: finishedAt, completedAt: finishedAt },
  });
  return Number(result?.count || 0) === 1;
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function freshnessLimitMs(day, now) {
  const today = utcDay(now);
  if (day.getTime() === today.getTime()) return CURRENT_DAY_FRESHNESS_MS;
  const ageDays = Math.floor((today.getTime() - day.getTime()) / DAY_MS);
  return ageDays <= RECENT_HISTORY_DAYS ? RECENT_CLOSED_FRESHNESS_MS : HISTORICAL_FRESHNESS_MS;
}

function coverageFresh(row, day, now, force = false) {
  if (force || !row) return false;
  const today = utcDay(now);
  const isCurrentDay = day.getTime() === today.getTime();
  if (isCurrentDay) {
    if (!["PARTIAL", "COMPLETE"].includes(String(row.status || ""))) return false;
  } else if (String(row.status || "") !== "COMPLETE") {
    return false;
  }
  if (!row.scanProofId || String(row.scanProof?.status || "") !== "COMMITTED") return false;
  const lastVerifiedAt = asDate(row.lastVerifiedAt);
  if (!lastVerifiedAt || lastVerifiedAt > new Date(now.getTime() + 5 * 60 * 1000)) return false;
  if (row.retryAfterAt && asDate(row.retryAfterAt) > now) return true;
  return now.getTime() - lastVerifiedAt.getTime() <= freshnessLimitMs(day, now);
}

function alignedWeekStart(day) {
  const epoch = Date.UTC(2016, 0, 4); // Monday; fixed alignment makes overlapping demands converge.
  const offsetDays = Math.floor((day.getTime() - epoch) / DAY_MS);
  const block = Math.floor(offsetDays / RECONCILIATION_BLOCK_DAYS);
  return new Date(epoch + block * RECONCILIATION_BLOCK_DAYS * DAY_MS);
}

function windowsForDueDays(dueDays, now) {
  const today = utcDay(now);
  const windows = new Map();
  for (const day of dueDays) {
    if (day.getTime() === today.getTime()) {
      const key = dateKey(day);
      windows.set(`today:${key}`, { scanFrom: day, scanTo: day });
      continue;
    }
    const blockStart = alignedWeekStart(day);
    const blockEnd = new Date(Math.min(blockStart.getTime() + (RECONCILIATION_BLOCK_DAYS - 1) * DAY_MS, today.getTime() - DAY_MS));
    const key = `${dateKey(blockStart)}:${dateKey(blockEnd)}`;
    windows.set(key, { scanFrom: blockStart, scanTo: blockEnd });
  }
  return [...windows.values()].sort((a, b) => a.scanFrom - b.scanFrom);
}

function priorityForReason(reason, fallback = 30) {
  const normalized = String(reason || "").toUpperCase();
  if (normalized === "INTERACTIVE_REFRESH") return Math.max(100, fallback);
  if (normalized === "BILLING") return Math.max(80, fallback);
  if (normalized === "INITIAL_SYNC") return Math.max(60, fallback);
  return fallback;
}

function scanGeneration(now) {
  return new Date(bucketTimestamp(now, SCAN_GENERATION_MS)).toISOString();
}

function sameScanWindow(job, identityParams) {
  const params = job?.params && typeof job.params === "object" ? job.params : {};
  return Number(params.analyticsContractVersion) === ANALYTICS_CONTRACT_VERSION
    && String(params.scanFrom || "") === identityParams.scanFrom
    && String(params.scanTo || "") === identityParams.scanTo
    && String(params.sourceTimezone || "") === ANALYTICS_SOURCE_TIMEZONE;
}

async function planWindow({ db, creatorId, agencyId, displayRangeKey, scanFrom, scanTo, collectionReason, priority, now }) {
  const generation = scanGeneration(now);
  const identityParams = {
    analyticsContractVersion: ANALYTICS_CONTRACT_VERSION,
    scanFrom: dateKey(scanFrom),
    scanTo: dateKey(scanTo),
    sourceTimezone: ANALYTICS_SOURCE_TIMEZONE,
  };
  const idempotencyKey = buildJobIdempotencyKey({
    jobKey: "fetch_earnings",
    scope: "creator",
    creatorId,
    agencyId,
    params: identityParams,
    bucketAt: now,
    bucketMs: SCAN_GENERATION_MS,
  });
  const params = {
    ...identityParams,
    displayRangeKey,
    scanGeneration: generation,
    collectionReason,
    requestedAt: now.toISOString(),
  };

  const decision = await withDbAdvisoryXactLock({
    db,
    key: `analytics-plan:${creatorId}`,
    work: async (tx) => {
      const active = await tx.jobInstance.findMany({
        where: {
          creatorId,
          agencyId,
          jobKey: "fetch_earnings",
          status: { in: ["SCHEDULED", "CLAIMED"] },
        },
        orderBy: [{ priority: "desc" }, { scheduledAt: "asc" }],
        select: {
          id: true,
          idempotencyKey: true,
          jobKey: true,
          creatorId: true,
          agencyId: true,
          status: true,
          priority: true,
          params: true,
          nextRunAt: true,
          leaseRevision: true,
        },
      });
      const existing = active.find((job) => sameScanWindow(job, identityParams)) || null;
      if (existing) {
        const demand = await updatePlannedJobDemand({
          db: tx,
          job: existing,
          priority,
          // A claimed job's contract is immutable. For a scheduled job, keep the
          // original server-pinned contract too; only priority/nextRunAt may rise.
          params: existing.params || params,
          nextRunAt: now,
          publish: false,
        });
        return {
          job: demand.job || existing,
          created: false,
          publish: demand.updated === true && String((demand.job || existing).status) === "SCHEDULED",
          reason: demand.updated ? "active_window_merged" : "active_window_reused",
        };
      }

      const planned = await createPlannedJobIfAbsent({
        db: tx,
        publish: false,
        jobKey: "fetch_earnings",
        scope: "creator",
        creatorId,
        agencyId,
        idempotencyKey,
        params,
        priority,
        scheduledAt: now,
        nextRunAt: now,
      });
      if (!planned.created && planned.job && ["SCHEDULED", "CLAIMED"].includes(planned.job.status)) {
        const demand = await updatePlannedJobDemand({
          db: tx,
          job: planned.job,
          priority,
          params: planned.job.params || params,
          nextRunAt: now,
          publish: false,
        });
        return {
          job: demand.job || planned.job,
          created: false,
          publish: demand.updated === true && String((demand.job || planned.job).status) === "SCHEDULED",
          reason: demand.updated ? "idempotency_demand_merged" : planned.reason,
        };
      }
      if (!planned.created && planned.job) {
        // A terminal attempt in the same deterministic bucket must not suppress
        // a still-due exact window. Reset that same idempotency row under the
        // creator planning lock instead of creating a parallel logical job.
        const retry = await reschedulePlannedJob({
          db: tx,
          job: planned.job,
          params,
          priority,
          scheduledAt: now,
          nextRunAt: now,
          continuation: null,
          progress: null,
          lastProgressAt: null,
          startedAt: null,
          protectedStatuses: ["CLAIMED"],
          resetAttempts: true,
          publish: false,
        });
        const retryJob = retry.job || planned.job;
        return {
          job: retryJob,
          created: false,
          publish: retry.rescheduled === true && String(retryJob.status) === "SCHEDULED",
          reason: retry.rescheduled ? "terminal_window_rescheduled" : retry.reason,
        };
      }
      return { job: planned.job, created: planned.created, publish: planned.created === true, reason: planned.reason };
    },
  });

  if (decision.publish && decision.job) publishPlannedJobAvailable(decision.job);
  return { job: decision.job, created: decision.created, reason: decision.reason };
}

async function ensureAnalyticsWindowFreshness({
  db = prisma,
  creatorId,
  agencyId,
  startDay,
  endDay,
  displayRangeKey = null,
  reason = "RECURRING",
  priority = 30,
  force = false,
  now = new Date(),
  coverageRows = null,
} = {}) {
  if (!creatorId || !agencyId) throw new Error("ANALYTICS_PLANNER_SCOPE_REQUIRED");
  const currentNow = asDate(now);
  const from = utcDay(startDay);
  const to = utcDay(endDay);
  const today = utcDay(currentNow);
  if (!currentNow || !from || !to || from > to || to > today) throw new Error("ANALYTICS_PLANNER_WINDOW_INVALID");
  const days = eachDay(from, to);
  const rows = Array.isArray(coverageRows)
    ? coverageRows
    : await db.analyticsCoverage.findMany({
      where: {
        creatorId,
        dataType: "EARNINGS",
        sourceTimezone: ANALYTICS_SOURCE_TIMEZONE,
        coverageDate: { gte: from, lte: to },
      },
      select: { coverageDate: true, status: true, lastVerifiedAt: true, retryAfterAt: true, scanProofId: true, scanProof: { select: { status: true } } },
    });
  const byDay = new Map(rows.map((row) => [dateKey(row.coverageDate), row]));
  const dueDays = days.filter((day) => !coverageFresh(byDay.get(dateKey(day)), day, currentNow, force));
  if (!dueDays.length) {
    return { ok: true, displayRangeKey, startDay: from, endDay: to, dueDays: 0, windows: 0, created: 0, reused: 0, jobs: [] };
  }
  const windows = windowsForDueDays(dueDays, currentNow);
  const jobs = [];
  let created = 0;
  let reused = 0;
  const effectivePriority = priorityForReason(reason, priority);
  for (const window of windows) {
    const result = await planWindow({
      db,
      creatorId,
      agencyId,
      displayRangeKey,
      scanFrom: window.scanFrom,
      scanTo: window.scanTo,
      collectionReason: String(reason || "RECURRING").toUpperCase(),
      priority: effectivePriority,
      now: currentNow,
    });
    jobs.push(result.job);
    if (result.created) created += 1;
    else reused += 1;
  }
  return { ok: true, displayRangeKey, startDay: from, endDay: to, dueDays: dueDays.length, windows: windows.length, created, reused, jobs };
}

async function ensureAnalyticsFreshness({
  db = prisma,
  creatorId,
  agencyId,
  rangeKey = "30d",
  reason = "RECURRING",
  priority = 30,
  force = false,
  now = new Date(),
  coverageRows = null,
  includePrevious = false,
} = {}) {
  if (!creatorId || !agencyId) throw new Error("ANALYTICS_PLANNER_SCOPE_REQUIRED");
  const currentNow = asDate(now);
  if (!currentNow) throw new Error("ANALYTICS_PLANNER_NOW_INVALID");
  const range = displayRangeBounds(rangeKey, currentNow);
  let startDay = range.startDay;
  if (includePrevious) {
    const days = Math.floor((range.endDay.getTime() - range.startDay.getTime()) / DAY_MS) + 1;
    startDay = new Date(range.startDay.getTime() - days * DAY_MS);
  }
  const result = await ensureAnalyticsWindowFreshness({
    db,
    creatorId,
    agencyId,
    startDay,
    endDay: range.endDay,
    displayRangeKey: range.rangeKey,
    reason,
    priority,
    force,
    now: currentNow,
    coverageRows,
  });
  return { ...result, rangeKey: range.rangeKey };
}

function operationalFreshnessWindow(now = new Date()) {
  const today = utcDay(now);
  // One current day + the previous 30 fully closed UTC days. This covers both
  // the Home 30d current range and Billing's previous-30-closed-day authority
  // without turning either product display range into a collection identity.
  return {
    startDay: new Date(today.getTime() - 30 * DAY_MS),
    endDay: today,
  };
}

async function ensureOperationalAnalyticsFreshness({
  db = prisma,
  creatorId,
  agencyId,
  reason = "RECURRING",
  priority = 30,
  now = new Date(),
  coverageRows = null,
} = {}) {
  const window = operationalFreshnessWindow(now);
  return ensureAnalyticsWindowFreshness({
    db,
    creatorId,
    agencyId,
    startDay: window.startDay,
    endDay: window.endDay,
    displayRangeKey: "30d",
    reason,
    priority,
    now,
    coverageRows,
  });
}

function normalizedDemandCreatorIds(creatorIds) {
  if (creatorIds == null) return null;
  if (!Array.isArray(creatorIds)) throw new Error("ANALYTICS_DEMAND_SCOPE_INVALID");
  return [...new Set(creatorIds.map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function analyticsDemandKey({ agencyId, creatorIds, rangeKey, includePrevious }) {
  const ids = normalizedDemandCreatorIds(creatorIds);
  const scopeIdentity = ids == null ? "AGENCY" : `CREATORS:${ids.join(",")}`;
  const scopeHash = createHash("sha256").update(scopeIdentity).digest("hex").slice(0, 24);
  return `earnings:${String(agencyId)}:${scopeHash}:${String(rangeKey)}:${includePrevious ? "prev" : "current"}`;
}

function demandLockKey(key) {
  return `analytics-demand:${key}`;
}

async function enqueueAgencyAnalyticsFreshnessDemand({
  db = prisma,
  agencyId,
  creatorIds = null,
  rangeKey = "7d",
  includePrevious = true,
  reason = "INTERACTIVE_REFRESH",
  priority = 100,
  requestedByMemberId,
  requestedAccessEpoch,
  now = new Date(),
} = {}) {
  if (!agencyId) throw new Error("ANALYTICS_PLANNER_AGENCY_REQUIRED");
  const actorMemberId = String(requestedByMemberId || "").trim();
  const actorAccessEpoch = Number(requestedAccessEpoch);
  if (!actorMemberId || !Number.isInteger(actorAccessEpoch) || actorAccessEpoch < 1) {
    throw new Error("ANALYTICS_DEMAND_ACCESS_FENCE_REQUIRED");
  }
  const currentNow = asDate(now);
  if (!currentNow) throw new Error("ANALYTICS_PLANNER_NOW_INVALID");
  const ids = normalizedDemandCreatorIds(creatorIds);
  const range = displayRangeBounds(rangeKey, currentNow);
  const rangeDays = Math.floor((range.endDay.getTime() - range.startDay.getTime()) / DAY_MS) + 1;
  const coverageFrom = includePrevious ? new Date(range.startDay.getTime() - rangeDays * DAY_MS) : range.startDay;
  const key = analyticsDemandKey({ agencyId, creatorIds: ids, rangeKey: range.rangeKey, includePrevious });
  return withDbAdvisoryXactLock({
    db,
    key: demandLockKey(key),
    work: async (tx) => {
      const existing = await tx.analyticsCollectionDemand.findUnique({ where: { key } });
      if (!existing) {
        const row = await tx.analyticsCollectionDemand.create({
          data: {
            key,
            agencyId,
            rangeKey: range.rangeKey,
            coverageFrom,
            coverageTo: range.endDay,
            priority: priorityForReason(reason, priority),
            reason: String(reason || "INTERACTIVE_REFRESH").toUpperCase(),
            creatorIds: ids,
            requestedByMemberId: actorMemberId,
            requestedAccessEpoch: actorAccessEpoch,
            requestRevision: 1,
            completedRevision: 0,
            requestedAt: currentNow,
            completedAt: null,
          },
        });
        return { queued: true, coalesced: false, key, rangeKey: range.rangeKey, requestRevision: row.requestRevision };
      }
      const claimAlive = Boolean(existing.claimToken && asDate(existing.claimUntil) && asDate(existing.claimUntil) > currentNow);
      const row = await tx.analyticsCollectionDemand.update({
        where: { key },
        data: {
          rangeKey: range.rangeKey,
          coverageFrom,
          coverageTo: range.endDay,
          priority: Math.max(Number(existing.priority || 0), priorityForReason(reason, priority)),
          reason: String(reason || "INTERACTIVE_REFRESH").toUpperCase(),
          creatorIds: ids,
          requestedByMemberId: actorMemberId,
          requestedAccessEpoch: actorAccessEpoch,
          requestRevision: Number(existing.requestRevision || 0) + 1,
          requestedAt: currentNow,
          completedAt: null,
          lastError: null,
          ...(!claimAlive ? { claimToken: null, claimUntil: null, claimedRevision: null, cursorCreatorId: null } : {}),
        },
      });
      return { queued: true, coalesced: true, key, rangeKey: range.rangeKey, requestRevision: row.requestRevision };
    },
  });
}

async function claimNextAnalyticsDemand({ db = prisma, now = new Date(), ownerToken = randomUUID() } = {}) {
  const currentNow = asDate(now);
  if (!currentNow) throw new Error("ANALYTICS_DEMAND_CLOCK_INVALID");
  return withDbAdvisoryXactLock({
    db,
    key: DEMAND_CLAIM_LOCK_KEY,
    work: async (tx) => {
      const row = await tx.analyticsCollectionDemand.findFirst({
        where: {
          completedAt: null,
          OR: [{ claimUntil: null }, { claimUntil: { lte: currentNow } }],
        },
        orderBy: [{ priority: "desc" }, { requestedAt: "asc" }, { key: "asc" }],
      });
      if (!row) return null;
      const resumeSameRevision = Number(row.claimedRevision || 0) === Number(row.requestRevision || 0);
      const claimed = await tx.analyticsCollectionDemand.update({
        where: { key: row.key },
        data: {
          claimToken: ownerToken,
          claimUntil: new Date(currentNow.getTime() + DEMAND_LEASE_MS),
          claimedRevision: row.requestRevision,
          cursorCreatorId: resumeSameRevision ? row.cursorCreatorId : null,
          lastError: null,
        },
      });
      return claimed;
    },
  });
}

async function renewAnalyticsDemandLease({ db = prisma, key, claimToken, claimedRevision, cursorCreatorId, now = new Date() }) {
  const currentNow = asDate(now);
  if (!currentNow) throw new Error("ANALYTICS_DEMAND_CLOCK_INVALID");
  const result = await db.analyticsCollectionDemand.updateMany({
    where: { key, claimToken, claimedRevision, completedAt: null },
    data: { cursorCreatorId: cursorCreatorId || null, claimUntil: new Date(currentNow.getTime() + DEMAND_LEASE_MS) },
  });
  return Number(result?.count || 0) === 1;
}

async function settleAnalyticsDemand({ db = prisma, demand, completedAt = new Date(), error = null, cancellationReason = null }) {
  const finishedAt = asDate(completedAt);
  if (!finishedAt) throw new Error("ANALYTICS_DEMAND_CLOCK_INVALID");
  return withDbAdvisoryXactLock({
    db,
    key: demandLockKey(demand.key),
    work: async (tx) => {
      const current = await tx.analyticsCollectionDemand.findUnique({ where: { key: demand.key } });
      if (!current || current.claimToken !== demand.claimToken || Number(current.claimedRevision) !== Number(demand.claimedRevision)) {
        return { settled: false, reason: "claim_lost" };
      }
      if (error) {
        await tx.analyticsCollectionDemand.update({
          where: { key: demand.key },
          data: { claimToken: null, claimUntil: finishedAt, lastError: String(error).slice(0, 1000) },
        });
        return { settled: true, completed: false, retry: true };
      }
      if (Number(current.requestRevision) > Number(demand.claimedRevision)) {
        await tx.analyticsCollectionDemand.update({
          where: { key: demand.key },
          data: { claimToken: null, claimUntil: null, claimedRevision: null, cursorCreatorId: null, completedAt: null, lastError: null },
        });
        return { settled: true, completed: false, retry: true, reason: "newer_revision_pending" };
      }
      const cancelled = cancellationReason ? String(cancellationReason).slice(0, 1000) : null;
      await tx.analyticsCollectionDemand.update({
        where: { key: demand.key },
        data: {
          completedRevision: demand.claimedRevision,
          completedAt: finishedAt,
          claimToken: null,
          claimUntil: finishedAt,
          cursorCreatorId: demand.cursorCreatorId || null,
          lastError: cancelled,
        },
      });
      return { settled: true, completed: true, retry: false, cancelled: Boolean(cancelled), ...(cancelled ? { reason: cancelled } : {}) };
    },
  });
}

function creatorIdsFromDemand(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("ANALYTICS_DEMAND_SCOPE_CORRUPT");
  return normalizedDemandCreatorIds(value);
}

async function resolveAnalyticsDemandExecutionScope({ db = prisma, demand } = {}) {
  const memberId = String(demand?.requestedByMemberId || "").trim();
  const admittedAccessEpoch = Number(demand?.requestedAccessEpoch);
  if (!memberId || !Number.isInteger(admittedAccessEpoch) || admittedAccessEpoch < 1) {
    return { authorized: false, reason: "ANALYTICS_DEMAND_ACCESS_FENCE_MISSING" };
  }
  const member = await db.agencyMember.findFirst({
    where: {
      id: memberId,
      agencyId: demand.agencyId,
      deletedAt: null,
      deactivatedAt: null,
      agency: { deletedAt: null },
    },
    select: {
      id: true, userId: true, agencyId: true, role: true, roleKey: true, permissions: true,
      assignedCreators: true, accessEpoch: true, deletedAt: true, deactivatedAt: true,
    },
  });
  if (!member) return { authorized: false, reason: "ANALYTICS_DEMAND_MEMBER_REVOKED" };
  if (Number(member.accessEpoch || 1) !== admittedAccessEpoch) {
    return { authorized: false, reason: "ANALYTICS_DEMAND_ACCESS_EPOCH_CHANGED" };
  }
  if (!await canUsePermission({ member, key: "creator_analytics.refresh", db })) {
    return { authorized: false, reason: "ANALYTICS_DEMAND_PERMISSION_REVOKED" };
  }
  const scope = await allowedCreatorScope({ agencyId: demand.agencyId, member, db });
  return { authorized: true, member, creatorIds: scope.broad ? null : normalizedDemandCreatorIds(scope.creatorIds) };
}

async function analyticsDemandAccessFenceCurrent({ db = prisma, demand } = {}) {
  const memberId = String(demand?.requestedByMemberId || "").trim();
  const accessEpoch = Number(demand?.requestedAccessEpoch);
  if (!memberId || !Number.isInteger(accessEpoch) || accessEpoch < 1) return false;
  const current = await db.agencyMember.findFirst({
    where: {
      id: memberId, agencyId: demand.agencyId, accessEpoch, deletedAt: null, deactivatedAt: null,
      agency: { deletedAt: null },
    },
    select: { id: true },
  });
  return Boolean(current);
}

async function processAnalyticsDemand({ db = prisma, demand, pageSize = DEMAND_PAGE_SIZE, now = new Date() } = {}) {
  if (!demand?.key || !demand.claimToken || !Number.isInteger(Number(demand.claimedRevision))) {
    throw new Error("ANALYTICS_DEMAND_CLAIM_REQUIRED");
  }
  const processNow = asDate(now);
  if (!processNow) throw new Error("ANALYTICS_DEMAND_CLOCK_INVALID");
  const size = Math.max(25, Math.min(500, Number(pageSize) || DEMAND_PAGE_SIZE));
  // Parse persisted scope only as corruption evidence. Execution never trusts it:
  // every page is fenced by the current member/accessEpoch/permission/scope.
  creatorIdsFromDemand(demand.creatorIds);
  let cursor = demand.cursorCreatorId || null;
  let creators = 0;
  let pages = 0;
  let created = 0;
  let reused = 0;
  let dueDays = 0;
  const authority = await resolveAnalyticsDemandExecutionScope({ db, demand });
  if (!authority.authorized) {
    const settled = await settleAnalyticsDemand({
      db, demand, completedAt: new Date(), cancellationReason: authority.reason,
    });
    return { ok: settled.settled, settled, creators, pages, created, reused, dueDays, accessDenied: true };
  }
  const scopedIds = authority.creatorIds;
  for (;;) {
    if (!await analyticsDemandAccessFenceCurrent({ db, demand })) {
      const settled = await settleAnalyticsDemand({
        db, demand, completedAt: new Date(), cancellationReason: "ANALYTICS_DEMAND_ACCESS_EPOCH_CHANGED",
      });
      return { ok: settled.settled, settled, creators, pages, created, reused, dueDays, accessDenied: true };
    }
    const alive = await renewAnalyticsDemandLease({
      db, key: demand.key, claimToken: demand.claimToken, claimedRevision: demand.claimedRevision, cursorCreatorId: cursor,
    });
    if (!alive) return { ok: false, reason: "demand_claim_lost", creators, pages, created, reused, dueDays };
    const rows = await db.creatorAccount.findMany({
      where: {
        agencyId: demand.agencyId,
        status: "READY",
        deletedAt: null,
        agency: { deletedAt: null },
        ...(scopedIds ? { id: { in: scopedIds, ...(cursor ? { gt: cursor } : {}) } } : cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: size,
      select: { id: true, agencyId: true },
    });
    if (!rows.length) break;
    pages += 1;
    creators += rows.length;
    const ids = rows.map((row) => row.id);
    const coverage = await db.analyticsCoverage.findMany({
      where: {
        creatorId: { in: ids },
        dataType: "EARNINGS",
        sourceTimezone: ANALYTICS_SOURCE_TIMEZONE,
        coverageDate: { gte: demand.coverageFrom, lte: demand.coverageTo },
      },
      select: { creatorId: true, coverageDate: true, status: true, lastVerifiedAt: true, retryAfterAt: true, scanProofId: true, scanProof: { select: { status: true } } },
    });
    const byCreator = new Map();
    for (const item of coverage) {
      const list = byCreator.get(item.creatorId) || [];
      list.push(item);
      byCreator.set(item.creatorId, list);
    }
    for (let index = 0; index < rows.length; index += 1) {
      const creator = rows[index];
      const result = await ensureAnalyticsWindowFreshness({
        db,
        creatorId: creator.id,
        agencyId: creator.agencyId,
        startDay: demand.coverageFrom,
        endDay: demand.coverageTo,
        displayRangeKey: demand.rangeKey,
        reason: demand.reason,
        priority: demand.priority,
        now: processNow,
        coverageRows: byCreator.get(creator.id) || [],
      });
      created += result.created;
      reused += result.reused;
      dueDays += result.dueDays;
      cursor = creator.id;
      demand.cursorCreatorId = cursor;
      if ((index + 1) % 25 === 0 && index + 1 < rows.length) {
        if (!await analyticsDemandAccessFenceCurrent({ db, demand })) {
          const settled = await settleAnalyticsDemand({
            db, demand, completedAt: new Date(), cancellationReason: "ANALYTICS_DEMAND_ACCESS_EPOCH_CHANGED",
          });
          return { ok: settled.settled, settled, creators, pages, created, reused, dueDays, accessDenied: true };
        }
        const heartbeat = await renewAnalyticsDemandLease({
          db, key: demand.key, claimToken: demand.claimToken, claimedRevision: demand.claimedRevision, cursorCreatorId: cursor,
        });
        if (!heartbeat) return { ok: false, reason: "demand_claim_lost", creators, pages, created, reused, dueDays };
      }
    }
    if (rows.length < size) break;
  }
  const settled = await settleAnalyticsDemand({ db, demand, completedAt: new Date() });
  return { ok: settled.settled, settled, creators, pages, created, reused, dueDays };
}

async function runAnalyticsCollectionDemandSweep({ db = prisma, now = new Date(), maxDemands = DEMAND_MAX_PER_SWEEP, pageSize = DEMAND_PAGE_SIZE } = {}) {
  if (demandSweepPromise) return { ok: true, skipped: true, reason: "in_process_demand_sweep_in_flight" };
  demandSweepPromise = (async () => {
    const limit = Math.max(1, Math.min(20, Number(maxDemands) || DEMAND_MAX_PER_SWEEP));
    const totals = { demands: 0, creators: 0, pages: 0, created: 0, reused: 0, dueDays: 0 };
    for (let index = 0; index < limit; index += 1) {
      const demand = await claimNextAnalyticsDemand({ db, now: index === 0 ? now : new Date() });
      if (!demand) break;
      totals.demands += 1;
      try {
        const result = await processAnalyticsDemand({ db, demand, pageSize, now: index === 0 ? now : new Date() });
        totals.creators += result.creators || 0;
        totals.pages += result.pages || 0;
        totals.created += result.created || 0;
        totals.reused += result.reused || 0;
        totals.dueDays += result.dueDays || 0;
      } catch (error) {
        await settleAnalyticsDemand({ db, demand, completedAt: new Date(), error: error?.message || error });
      }
    }
    return { ok: true, skipped: false, ...totals };
  })();
  try {
    return await demandSweepPromise;
  } finally {
    demandSweepPromise = null;
  }
}

async function runAnalyticsCollectionSweep({ db = prisma, now = new Date(), pageSize = SWEEP_PAGE_SIZE } = {}) {
  if (sweepPromise) return { ok: true, skipped: true, reason: "in_process_sweep_in_flight" };
  sweepPromise = (async () => {
    const requestedNow = asDate(now) || new Date();
    const claim = await claimAnalyticsSweepCycle({ db, now: requestedNow });
    if (!claim.acquired) {
      return { ok: true, skipped: true, reason: claim.reason, cycleKey: claim.cycleKey };
    }

    const currentNow = claim.cycleNow;
    const size = Math.max(25, Math.min(1000, Number(pageSize) || SWEEP_PAGE_SIZE));
    const range = operationalFreshnessWindow(currentNow);
    let cursor = claim.cursorCreatorId || null;
    let creators = 0;
    let pages = 0;
    let created = 0;
    let reused = 0;
    let dueDays = 0;
    for (;;) {
      const leaseAlive = await renewAnalyticsSweepLease({
        db, ownerToken: claim.ownerToken, cycleKey: claim.cycleKey, cursorCreatorId: cursor,
      });
      if (!leaseAlive) {
        return { ok: false, skipped: true, reason: "cycle_lease_lost", cycleKey: claim.cycleKey, creators, pages, created, reused, dueDays, pageSize: size };
      }
      const rows = await db.creatorAccount.findMany({
        where: {
          status: "READY",
          deletedAt: null,
          agency: { deletedAt: null },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: size,
        select: { id: true, agencyId: true },
      });
      if (!rows.length) break;
      pages += 1;
      creators += rows.length;
      cursor = rows.at(-1).id;
      const ids = rows.map((row) => row.id);
      const coverage = await db.analyticsCoverage.findMany({
        where: {
          creatorId: { in: ids },
          dataType: "EARNINGS",
          sourceTimezone: ANALYTICS_SOURCE_TIMEZONE,
          coverageDate: { gte: range.startDay, lte: range.endDay },
        },
        select: { creatorId: true, coverageDate: true, status: true, lastVerifiedAt: true, retryAfterAt: true, scanProofId: true, scanProof: { select: { status: true } } },
      });
      const coverageByCreator = new Map();
      for (const item of coverage) {
        const list = coverageByCreator.get(item.creatorId) || [];
        list.push(item);
        coverageByCreator.set(item.creatorId, list);
      }
      for (let index = 0; index < rows.length; index += 1) {
        const creator = rows[index];
        const result = await ensureOperationalAnalyticsFreshness({
          db,
          creatorId: creator.id,
          agencyId: creator.agencyId,
          reason: "RECURRING",
          priority: 30,
          now: currentNow,
          coverageRows: coverageByCreator.get(creator.id) || [],
        });
        created += result.created;
        reused += result.reused;
        dueDays += result.dueDays;
        // Persist bounded forward progress inside a page too. A crashed owner may
        // therefore replay at most this small chunk, and exact-window job
        // reservation still makes that replay provider-write-free.
        if ((index + 1) % 25 === 0 && index + 1 < rows.length) {
          const heartbeat = await renewAnalyticsSweepLease({
            db, ownerToken: claim.ownerToken, cycleKey: claim.cycleKey, cursorCreatorId: creator.id,
          });
          if (!heartbeat) {
            return { ok: false, skipped: true, reason: "cycle_lease_lost", cycleKey: claim.cycleKey, creators, pages, created, reused, dueDays, pageSize: size };
          }
        }
      }
      const renewed = await renewAnalyticsSweepLease({
        db, ownerToken: claim.ownerToken, cycleKey: claim.cycleKey, cursorCreatorId: cursor,
      });
      if (!renewed) {
        return { ok: false, skipped: true, reason: "cycle_lease_lost", cycleKey: claim.cycleKey, creators, pages, created, reused, dueDays, pageSize: size };
      }
      if (rows.length < size) break;
    }
    const completed = await completeAnalyticsSweepCycle({ db, ownerToken: claim.ownerToken, cycleKey: claim.cycleKey, cursorCreatorId: cursor });
    if (!completed) {
      return { ok: false, skipped: true, reason: "cycle_completion_lost", cycleKey: claim.cycleKey, creators, pages, created, reused, dueDays, pageSize: size };
    }
    return { ok: true, skipped: false, cycleKey: claim.cycleKey, creators, pages, created, reused, dueDays, pageSize: size };
  })();
  try {
    return await sweepPromise;
  } finally {
    sweepPromise = null;
  }
}

module.exports = {
  SCAN_GENERATION_MS,
  CURRENT_DAY_FRESHNESS_MS,
  RECENT_CLOSED_FRESHNESS_MS,
  HISTORICAL_FRESHNESS_MS,
  SWEEP_CYCLE_MS,
  SWEEP_LEASE_MS,
  SWEEP_LEASE_KEY,
  DEMAND_LEASE_MS,
  analyticsDemandKey,
  enqueueAgencyAnalyticsFreshnessDemand,
  claimNextAnalyticsDemand,
  renewAnalyticsDemandLease,
  settleAnalyticsDemand,
  processAnalyticsDemand,
  runAnalyticsCollectionDemandSweep,
  sweepCycleKey,
  claimAnalyticsSweepCycle,
  renewAnalyticsSweepLease,
  completeAnalyticsSweepCycle,
  coverageFresh,
  sameScanWindow,
  planWindow,
  ensureAnalyticsWindowFreshness,
  ensureAnalyticsFreshness,
  ensureOperationalAnalyticsFreshness,
  operationalFreshnessWindow,
  runAnalyticsCollectionSweep,
  windowsForDueDays,
};
