"use strict";

const prisma = require("../prisma");
const { resolveRange, resolvePreviousRange, rangeForClient } = require("./range-service");
const { getLatestPayload } = require("./analytics-snapshot-service");
const { ensureSingleJob } = require("./job-scheduler");

// ─────────────────────────────────────────────────────────────────────────
// Home summary service v3 — on-demand snapshot scheduling.
//
// When the UI asks for a range that's missing or stale for some creators,
// the bek schedules fetch_earnings jobs for them and returns a `pending[]`
// list so the renderer knows to show a skeleton + poll until the snapshot
// arrives. NO range fallback — if data isn't there, we wait for it.
//
// Staleness thresholds:
//   - 24h    → 5 min  (intra-day data should feel fresh)
//   - 7d     → 15 min
//   - 30d    → 30 min
//   - 90d+   → 2 h    (long-range bars don't shift much hour-to-hour)
//
// These match what a user intuitively expects: "if I'm looking at today's
// numbers I want them recent; for last quarter I don't need to refetch
// every minute".
// ─────────────────────────────────────────────────────────────────────────


// Per-range freshness budget (ms). After this much time, a snapshot is
// considered stale and we re-schedule. Pick generously — OF requests
// aren't free.
const STALENESS_MS_BY_RANGE = {
  "24h":      5  * 60 * 1000,
  "7d":       15 * 60 * 1000,
  "30d":      30 * 60 * 1000,
  "90d":      2  * 60 * 60 * 1000,
  "180d":     2  * 60 * 60 * 1000,
  "365d":     2  * 60 * 60 * 1000,
  "ytd":      2  * 60 * 60 * 1000,
  "prev_year":24 * 60 * 60 * 1000,
  "all":      24 * 60 * 60 * 1000,
};

const DEFAULT_STALENESS_MS = 30 * 60 * 1000; // 30 min

// Priority for on-demand backfill — higher than the recurring sweeper (30)
// but lower than the user-clicked refresh button (100). We're "the user is
// looking at this NOW" so it should jump the queue but yield to explicit
// refresh actions.
const ON_DEMAND_PRIORITY = 80;

function stalenessMsFor(rangeKey) {
  return STALENESS_MS_BY_RANGE[rangeKey] ?? DEFAULT_STALENESS_MS;
}


// ── Helpers ──────────────────────────────────────────────────────────────

function bigToNum(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

function pctChange(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return Math.round(((c - p) / p) * 1000) / 10;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

// Pull a numeric value out of an OF-style point. Mirrors creator-analytics
// extraction logic so home and creator pages look at the same numbers.
function pickNumericValue(item) {
  if (item === null || item === undefined) return null;
  if (typeof item === "number") return Number.isFinite(item) ? item : null;

  if (Array.isArray(item)) {
    // OF often returns ["2026-04-30", 1234] — last finite number wins.
    for (let i = item.length - 1; i >= 0; i -= 1) {
      const n = Number(item[i]);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  if (typeof item === "object") {
    const candidates = [
      item.amount, item.total, item.sum, item.value,
      item.net, item.gross, item.earnings, item.price,
      item.count, item.y, item.v, item.valueCents,
    ];
    for (const candidate of candidates) {
      const n = Number(candidate);
      if (Number.isFinite(n)) return n;
    }
  }

  return null;
}

function pickLabel(item, fallback) {
  if (Array.isArray(item)) return String(item[0] || fallback);
  if (item && typeof item === "object") {
    return String(item.label || item.date || item.x || fallback);
  }
  return String(fallback);
}

// Walk the OF response shape (stored in CreatorEarningsSnapshot.raw) and
// return the longest array of [{ label, valueCents }] points.
function extractPointsFromRaw(raw) {
  if (!raw || typeof raw !== "object") return [];

  const earnings = raw.earnings || {};
  const total = earnings.total || raw.total || {};

  const namedCandidates = [
    total.chartAmount, total.chart, total.list,
    earnings.chartAmount, earnings.chart, earnings.list,
    raw.chartAmount, raw.chart, raw.chartData,
    raw.chart?.amount, raw.chart?.data,
    raw.data?.chart, raw.data?.chartAmount, raw.data?.points,
    raw.points, raw.series, raw.list,
  ];

  for (const candidate of namedCandidates) {
    const list = safeArray(candidate);
    if (list.length < 2) continue;

    const out = [];
    list.forEach((item, idx) => {
      const value = pickNumericValue(item);
      if (!Number.isFinite(value)) return;
      // OF chart amounts are in dollars (floats). Snapshot's totalCents
      // is in cents, but `raw` mirrors the OF response directly. Convert
      // defensively: values > 1_000_000 we assume already in cents.
      const valueCents = value > 1_000_000 ? Math.round(value) : Math.round(value * 100);
      out.push({
        label: pickLabel(item, idx + 1),
        valueCents,
      });
    });

    if (out.length >= 2) return out;
  }

  return [];
}

// Resample N points to a fixed length using linear interpolation, so per-
// creator series of different lengths can be summed into one agency curve
// without alignment drift.
function resamplePoints(points, targetLen) {
  if (!Array.isArray(points) || points.length < 2 || targetLen < 2) return [];

  const out = [];
  const lastIdx = points.length - 1;

  for (let i = 0; i < targetLen; i += 1) {
    const t = (i / (targetLen - 1)) * lastIdx;
    const lo = Math.floor(t);
    const hi = Math.min(lo + 1, lastIdx);
    const frac = t - lo;

    const a = Number(points[lo]?.valueCents || 0);
    const b = Number(points[hi]?.valueCents || 0);
    const value = a + (b - a) * frac;

    out.push({
      label: String(points[lo]?.label ?? i + 1),
      valueCents: Math.round(value),
    });
  }

  return out;
}


// ── Snapshot resolution + on-demand scheduling ──────────────────────────

// For an agency + range, returns:
//   {
//     byCreatorId: Map<creatorId, snapshot>,    // fresh OR stale snapshots we'll display
//     pendingCreatorIds: [creatorId, ...],      // those with no snapshot OR stale
//     scheduledJobs: [{ creatorId, jobId, reason }, ...],
//   }
// On-demand semantics:
//   - "fresh"   → use it, no scheduling
//   - "stale"   → schedule new job, but ALSO show the stale data so user
//                 isn't staring at a skeleton when an OK-ish row exists
//   - "missing" → schedule new job, mark pending, show skeleton row
//   - status not READY → never schedule (job would just fail). If a stale
//                 snapshot exists, keep showing it as "last known good".
async function resolveAndScheduleSnapshots(agencyId, requestedRange, creators) {
  const creatorIds = creators.map((c) => c.id);
  const snaps = creatorIds.length
    ? await prisma.creatorEarningsSnapshot.findMany({
        where: { agencyId, rangeKey: requestedRange, creatorId: { in: creatorIds } },
        orderBy: { capturedAt: "desc" },
      })
    : [];

  // Latest snapshot per creator (findMany came back sorted desc, so first wins).
  const latestByCreator = new Map();
  for (const snap of snaps) {
    if (!latestByCreator.has(snap.creatorId)) {
      latestByCreator.set(snap.creatorId, snap);
    }
  }

  const stalenessMs = stalenessMsFor(requestedRange);
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - stalenessMs);

  const byCreatorId = new Map();
  const pendingCreatorIds = [];
  const scheduleTasks = [];
  const scheduledJobs = [];

  for (const creator of creators) {
    const canFetch = String(creator.status || "").toUpperCase() === "READY";
    const snap = latestByCreator.get(creator.id);
    const isFresh = snap && new Date(snap.capturedAt) > staleThreshold;

    if (snap && isFresh) {
      // Fresh — use it, no scheduling.
      byCreatorId.set(creator.id, snap);
      continue;
    }

    if (!canFetch) {
      // Not READY — can't schedule a fetch_earnings job. If we have any
      // (even stale) snapshot, still display it so the row isn't blank.
      if (snap) byCreatorId.set(creator.id, snap);
      continue;
    }

    // Either no snapshot, or stale → schedule a backfill.
    pendingCreatorIds.push(creator.id);

    scheduleTasks.push(
      ensureSingleJob({
        jobKey: "fetch_earnings",
        creatorId: creator.id,
        agencyId,
        params: { rangeKey: requestedRange },
        priority: ON_DEMAND_PRIORITY,
        now,
        freshnessWindowMs: stalenessMs,
      })
        .then((decision) => {
          scheduledJobs.push({
            creatorId: creator.id,
            jobId:     decision.jobId,
            reason:    decision.created ? "scheduled" : decision.reason,
          });
        })
        .catch((err) => {
          // Don't fail the whole summary because one creator's job failed
          // to schedule. Log and move on — the next request will retry.
          console.warn(
            "[home/summary] schedule failed for",
            creator.id,
            err?.message || err
          );
        })
    );

    // If we have a stale snapshot, still serve it while the fresh one
    // computes — better than skeleton when an OK-ish row already exists.
    if (snap) byCreatorId.set(creator.id, snap);
  }

  if (scheduleTasks.length) await Promise.all(scheduleTasks);

  return { byCreatorId, pendingCreatorIds, scheduledJobs };
}


// ── Aggregate revenue across the agency ─────────────────────────────────

async function buildAgencyRevenue(agencyId, requestedRange, allCreators) {
  const { byCreatorId, pendingCreatorIds, scheduledJobs } =
    await resolveAndScheduleSnapshots(agencyId, requestedRange, allCreators);

  let totalCents = 0;
  let grossCents = 0;
  let salesCount = 0;
  let uniqueFans = 0;

  const TARGET_POINT_COUNT = 32;
  const seriesToCombine = [];
  const stalenessMs = stalenessMsFor(requestedRange);

  // creators[] mirrors the full creator list — UI sees ALL creators,
  // those without (or with stale) snapshots get hasSnapshot/pending flags
  // so the renderer can show skeleton-pulse rows.
  const creatorRows = allCreators.map((creator) => {
    const snap = byCreatorId.get(creator.id) || null;
    const isPending = pendingCreatorIds.includes(creator.id);

    const ageMs = snap ? Date.now() - new Date(snap.capturedAt).getTime() : null;
    const isStale = snap ? ageMs > stalenessMs : false;

    if (snap) {
      totalCents += bigToNum(snap.totalCents);
      grossCents += bigToNum(snap.grossCents);
      salesCount += Number(snap.salesCount || 0);
      uniqueFans += Number(snap.uniqueFans || 0);

      const points = extractPointsFromRaw(snap.raw);
      if (points.length >= 2) {
        seriesToCombine.push(resamplePoints(points, TARGET_POINT_COUNT));
      }
    }

    return {
      id:           creator.id,
      name:         creator.displayName,
      displayName:  creator.displayName,
      username:     creator.username,
      avatarUrl:    creator.avatarUrl,
      status:       creator.status,
      remoteId:     creator.remoteId,
      revenueCents: snap ? bigToNum(snap.totalCents) : 0,
      salesCount:   snap ? Number(snap.salesCount || 0) : 0,
      uniqueFans:   snap ? Number(snap.uniqueFans || 0) : 0,
      capturedAt:   snap ? snap.capturedAt : null,
      // hasSnapshot=true means we have a row to display (fresh OR stale).
      // pending=true means a job is queued/running for this creator+range
      //   regardless of whether we have a stale row to display in the meantime.
      // stale=true is "snapshot exists but past the freshness budget".
      hasSnapshot:  !!snap,
      pending:      isPending,
      stale:        isStale,
      staleSeconds: snap ? Math.max(0, Math.floor(ageMs / 1000)) : null,
    };
  }).sort((a, b) => Number(b.revenueCents || 0) - Number(a.revenueCents || 0));

  // Build a single agency-wide curve by summing resampled per-creator series.
  const points = [];
  if (seriesToCombine.length) {
    for (let i = 0; i < TARGET_POINT_COUNT; i += 1) {
      let sum = 0;
      let label = String(i + 1);
      for (const series of seriesToCombine) {
        const point = series[i];
        if (!point) continue;
        sum += Number(point.valueCents || 0);
        if (label === String(i + 1) && point.label) label = String(point.label);
      }
      points.push({ label, valueCents: sum });
    }
  }

  return {
    totalCents,
    grossCents,
    salesCount,
    uniqueFans,
    creatorCount: byCreatorId.size,
    points,
    creators: creatorRows,
    pendingCreatorIds,
    scheduledJobs,
  };
}

// Previous range — read-only, never schedules backfill. Just sums whatever
// snapshots exist for the comparison delta. If nothing exists, deltaPct
// will be null, which the UI handles ("→ 0%" shown muted).
async function buildPreviousRevenue(agencyId, prevRangeKey, allCreators) {
  const creatorIds = allCreators.map((c) => c.id);
  if (!creatorIds.length) return { totalCents: 0 };

  const snaps = await prisma.creatorEarningsSnapshot.findMany({
    where: { agencyId, rangeKey: prevRangeKey, creatorId: { in: creatorIds } },
    orderBy: { capturedAt: "desc" },
  });

  const seen = new Set();
  let totalCents = 0;
  for (const snap of snaps) {
    if (seen.has(snap.creatorId)) continue;
    seen.add(snap.creatorId);
    totalCents += bigToNum(snap.totalCents);
  }
  return { totalCents };
}


// ── Main entry ──────────────────────────────────────────────────────────

function snapshotPart(snapshot, key, fallback) {
  const payload = snapshot?.payload || {};
  return payload[key] && typeof payload[key] === "object" ? payload[key] : fallback;
}

async function buildHomeSummary({ agencyId, rangeKey = "7d" }) {
  const range = resolveRange(rangeKey);
  const previousRange = resolvePreviousRange(rangeKey);

  const [
    snapshot,
    agency,
    members,
    creators,
    jobs,
    devices,
    latestAudit,
    subscription,
  ] = await Promise.all([
    getLatestPayload({ agencyId, scope: "home", rangeKey: range.key }),
    prisma.agency.findUnique({ where: { id: agencyId } }),
    prisma.agencyMember.findMany({
      where: { agencyId, deletedAt: null },
      select: {
        id: true, roleKey: true, displayName: true,
        user: { select: { email: true, name: true } },
      },
    }),
    prisma.creatorAccount.findMany({
      where: { agencyId, deletedAt: null },
      select: {
        id: true, displayName: true, username: true,
        avatarUrl: true, status: true, remoteId: true,
      },
    }),
    prisma.jobInstance
      .groupBy({
        by: ["status"],
        where: { agencyId },
        _count: { _all: true },
      })
      .catch(() => []),
    prisma.workerDevice.findMany({
      where: { agencyId },
      select: {
        id: true, userId: true, deviceName: true,
        platform: true, appVersion: true, lastSeenAt: true,
      },
    }),
    prisma.auditLog.findMany({
      where: { agencyId },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { actor: { select: { id: true, email: true, name: true } } },
    }),
    prisma.agencySubscription.findFirst({
      where: { agencyId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Build current revenue (with on-demand scheduling).
  // Previous revenue is read-only — we don't schedule backfill jobs for it,
  // that would double the OF traffic on every Home open. If previous data
  // doesn't exist, deltaPct will be null and UI shows muted state.
  const [currentRevenue, previousRevenue] = await Promise.all([
    buildAgencyRevenue(agencyId, range.key, creators),
    buildPreviousRevenue(agencyId, previousRange.key, creators),
  ]);

  const now = Date.now();
  const onlineDevices = devices.filter(
    (d) => d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000
  ).length;
  const seatsLimit = subscription?.seatsLimit || null;

  const snapshotMessages = snapshotPart(snapshot, "messages", {
    total: 0, team: 0, bot: 0, source: "snapshot_missing",
  });
  const snapshotWorkers = snapshotPart(snapshot, "workers", {});
  const snapshotHealth = snapshotPart(snapshot, "health", {});

  const totalCreators = creators.length;
  const reportingCreators = currentRevenue.creators.filter((c) => c.hasSnapshot).length;
  const pendingCount = currentRevenue.pendingCreatorIds.length;

  return {
    ok: true,
    agency: agency
      ? { id: agency.id, name: agency.name, plan: agency.plan, status: agency.status }
      : { id: agencyId },
    range: rangeForClient(range),
    refreshedAt: new Date().toISOString(),
    snapshot: snapshot
      ? {
          id: snapshot.id,
          capturedAt: snapshot.capturedAt,
          staleSeconds: snapshot.staleSeconds,
          source: "electron_snapshot",
        }
      : {
          id: null,
          capturedAt: null,
          staleSeconds: null,
          source: "snapshot_missing",
        },
    revenue: {
      totalCents: currentRevenue.totalCents,
      grossCents: currentRevenue.grossCents,
      deltaPct: pctChange(currentRevenue.totalCents, previousRevenue.totalCents),
      currency: "USD",
      salesCount: currentRevenue.salesCount,
      uniqueFans: currentRevenue.uniqueFans,
      creatorCount: currentRevenue.creatorCount,
      points: currentRevenue.points,
      // Coverage / pending metadata — UI shows skeleton rows for pending creators.
      coverage: {
        totalCreators,
        reportingCreators,
        pendingCount,
      },
      pending: {
        count:      pendingCount,
        creatorIds: currentRevenue.pendingCreatorIds,
        jobs:       currentRevenue.scheduledJobs,
        // Heuristic ETA — fetch_earnings typically takes 5-15s per creator
        // depending on OF response time and runner availability. UI uses
        // this to set polling cadence (don't poll faster than ETA/3).
        etaSeconds: pendingCount * 12,
      },
      stalenessMs: stalenessMsFor(range.key),
      source: "creator_earnings_snapshots",
    },
    messages: {
      total:  Number(snapshotMessages.total || 0),
      team:   Number(snapshotMessages.team  || 0),
      bot:    Number(snapshotMessages.bot   || 0),
      source: snapshotMessages.source || "analytics_snapshot",
    },
    seats: {
      used: members.length,
      limit: seatsLimit,
      available: seatsLimit === null ? null : Math.max(0, Number(seatsLimit) - members.length),
      source: seatsLimit === null ? "members_only" : "subscription",
    },
    creators: currentRevenue.creators,
    workers: {
      totalMembers:  members.length,
      onlineDevices,
      devices:       devices.length,
      activeMembers: Number(snapshotWorkers.activeMembers || 0),
      ...snapshotWorkers,
    },
    health: {
      ...snapshotHealth,
      onlineDevices,
      jobs: Object.fromEntries((jobs || []).map((row) => [row.status, row._count?._all || 0])),
    },
    jobs: Object.fromEntries((jobs || []).map((row) => [row.status, row._count?._all || 0])),
    audit: latestAudit.map((row) => ({
      id:         row.id,
      action:     row.action,
      targetType: row.targetType,
      targetId:   row.targetId,
      metadata:   row.metadata || {},
      createdAt:  row.createdAt,
      actor: row.actor
        ? { id: row.actor.id, email: row.actor.email, name: row.actor.name }
        : null,
    })),
  };
}

module.exports = { buildHomeSummary };
