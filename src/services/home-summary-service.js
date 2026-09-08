"use strict";

const prisma = require("../prisma");
const { allowedCreatorScope } = require("../middleware/automation-permissions");
const { canUsePermission, isOwner } = require("./team-access-control");
const {
  DAY_MS,
  displayRangeBounds,
  previousDisplayRange,
  normalizeHomeRangeKey,
  dateKey,
  utcDay,
} = require("./analytics-range-contract");
const {
  CURRENT_DAY_FRESHNESS_MS,
  RECENT_CLOSED_FRESHNESS_MS,
  HISTORICAL_FRESHNESS_MS,
} = require("./analytics-collection-planner");

function availability(available, reason = null) {
  return { available: available === true, reason: available === true ? null : (reason || "UNAVAILABLE") };
}

function pctChange(current, previous) {
  const c = Number(current);
  const p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return Math.round(((c - p) / p) * 1000) / 10;
}

function dayCount(startDay, endDay) {
  if (!startDay || !endDay || startDay > endDay) return 0;
  return Math.floor((endDay.getTime() - startDay.getTime()) / DAY_MS) + 1;
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function minDate(a, b) {
  return a < b ? a : b;
}

function freshEnough(value, now, maxAgeMs) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  return Boolean(date && Number.isFinite(date.getTime()) && date <= new Date(now.getTime() + 5 * 60 * 1000) && now.getTime() - date.getTime() <= maxAgeMs);
}

async function readCoverageState({ db, creatorIds, range, now }) {
  const ids = creatorIds || [];
  const out = new Map(ids.map((id) => [id, { completeDays: 0, fresh: true, currentVerifiedAt: null }]));
  if (!ids.length) return { byCreator: out, expectedDays: dayCount(range.startDay, range.endDay) };

  const today = utcDay(now);
  const includesToday = range.startDay <= today && range.endDay >= today;
  const closedEnd = minDate(range.endDay, new Date(today.getTime() - DAY_MS));
  const recentClosedStart = maxDate(range.startDay, new Date(today.getTime() - 30 * DAY_MS));
  const oldClosedEnd = minDate(closedEnd, new Date(recentClosedStart.getTime() - DAY_MS));
  const tasks = [];

  if (range.startDay <= oldClosedEnd) {
    tasks.push(db.analyticsCoverage.groupBy({
      by: ["creatorId"],
      where: {
        creatorId: { in: ids }, dataType: "EARNINGS", sourceTimezone: "UTC",
        status: "COMPLETE", scanProofId: { not: null },
        scanProof: { is: { status: "COMMITTED" } },
        coverageDate: { gte: range.startDay, lte: oldClosedEnd },
      },
      _count: { _all: true },
      _min: { lastVerifiedAt: true },
    }).then((rows) => ({ kind: "old", rows })));
  }

  if (recentClosedStart <= closedEnd) {
    tasks.push(db.analyticsCoverage.groupBy({
      by: ["creatorId"],
      where: {
        creatorId: { in: ids }, dataType: "EARNINGS", sourceTimezone: "UTC",
        status: "COMPLETE", scanProofId: { not: null },
        scanProof: { is: { status: "COMMITTED" } },
        coverageDate: { gte: recentClosedStart, lte: closedEnd },
      },
      _count: { _all: true },
      _min: { lastVerifiedAt: true },
    }).then((rows) => ({ kind: "recent", rows })));
  }

  if (includesToday) {
    tasks.push(db.analyticsCoverage.findMany({
      where: {
        creatorId: { in: ids }, dataType: "EARNINGS", sourceTimezone: "UTC",
        coverageDate: today, status: { in: ["PARTIAL", "COMPLETE"] }, scanProofId: { not: null },
        scanProof: { is: { status: "COMMITTED" } },
      },
      select: { creatorId: true, lastVerifiedAt: true },
    }).then((rows) => ({ kind: "today", rows })));
  }

  for (const group of await Promise.all(tasks)) {
    for (const row of group.rows) {
      const state = out.get(row.creatorId);
      if (!state) continue;
      if (group.kind === "today") {
        state.completeDays += 1;
        state.currentVerifiedAt = row.lastVerifiedAt || null;
        if (!freshEnough(row.lastVerifiedAt, now, CURRENT_DAY_FRESHNESS_MS)) state.fresh = false;
      } else {
        state.completeDays += Number(row?._count?._all || 0);
        const limit = group.kind === "recent" ? RECENT_CLOSED_FRESHNESS_MS : HISTORICAL_FRESHNESS_MS;
        if (!freshEnough(row?._min?.lastVerifiedAt, now, limit)) state.fresh = false;
      }
    }
  }

  const expectedDays = dayCount(range.startDay, range.endDay);
  for (const state of out.values()) {
    state.complete = state.completeDays >= expectedDays;
    if (!state.complete) state.fresh = false;
  }
  return { byCreator: out, expectedDays };
}

async function readCanonicalRevenue({ db, agencyId, creators, range, previous, now }) {
  const creatorIds = creators.map((row) => row.id);
  if (!creatorIds.length) {
    return { totalCents: 0, deltaPct: null, points: [], creators: [], reportingCreators: 0, staleCreators: 0, pendingCreatorIds: [], pendingJobs: [] };
  }

  const [coverage, previousCoverage, activeJobs] = await Promise.all([
    readCoverageState({ db, creatorIds, range, now }),
    previous ? readCoverageState({ db, creatorIds, range: previous, now }) : Promise.resolve(null),
    db.jobInstance.findMany({
      where: { creatorId: { in: creatorIds }, jobKey: "fetch_earnings", status: { in: ["SCHEDULED", "CLAIMED"] } },
      select: { id: true, creatorId: true, status: true },
    }),
  ]);

  const reportingIds = creatorIds.filter((id) => coverage.byCreator.get(id)?.complete === true);
  const previousReportingIds = previousCoverage
    ? creatorIds.filter((id) => previousCoverage.byCreator.get(id)?.complete === true)
    : [];
  const [currentGroups, dateGroups, previousTotal] = await Promise.all([
    reportingIds.length ? db.creatorEarningsDaily.groupBy({
      by: ["creatorId"],
      where: {
        agencyId, creatorId: { in: reportingIds }, sourceTimezone: "UTC", scanProofId: { not: null },
        scanProof: { is: { status: "COMMITTED" } }, date: { gte: range.startDay, lte: range.endDay },
      },
      _count: { _all: true }, _sum: { totalCents: true }, _max: { collectedAt: true },
    }) : Promise.resolve([]),
    reportingIds.length ? db.creatorEarningsDaily.groupBy({
      by: ["date"],
      where: {
        agencyId, creatorId: { in: reportingIds }, sourceTimezone: "UTC", scanProofId: { not: null },
        scanProof: { is: { status: "COMMITTED" } }, date: { gte: range.startDay, lte: range.endDay },
      },
      _sum: { totalCents: true },
    }) : Promise.resolve([]),
    previous && previousReportingIds.length === creatorIds.length ? db.creatorEarningsDaily.aggregate({
      where: {
        agencyId, creatorId: { in: previousReportingIds }, sourceTimezone: "UTC", scanProofId: { not: null },
        scanProof: { is: { status: "COMMITTED" } }, date: { gte: previous.startDay, lte: previous.endDay },
      },
      _sum: { totalCents: true },
    }) : Promise.resolve(null),
  ]);

  const currentByCreator = new Map(currentGroups.map((row) => [String(row.creatorId), row]));
  const activeByCreator = new Map();
  for (const job of activeJobs) {
    const list = activeByCreator.get(job.creatorId) || [];
    list.push(job);
    activeByCreator.set(job.creatorId, list);
  }
  const pendingCreatorIds = [...activeByCreator.keys()];
  const pendingJobs = activeJobs.map((job) => ({ creatorId: job.creatorId, jobId: job.id, reason: String(job.status || "pending").toLowerCase() }));
  let totalCents = 0;
  let staleCreators = 0;
  const creatorRows = creators.map((creator) => {
    const state = coverage.byCreator.get(creator.id) || { complete: false, fresh: false };
    const group = currentByCreator.get(creator.id) || null;
    const hasRevenue = state.complete === true && Number(group?._count?._all || 0) >= coverage.expectedDays;
    const stale = hasRevenue && state.fresh !== true;
    if (stale) staleCreators += 1;
    const revenueCents = hasRevenue ? Number(group?._sum?.totalCents || 0) : null;
    if (revenueCents !== null) totalCents += revenueCents;
    const capturedAt = hasRevenue && group?._max?.collectedAt ? group._max.collectedAt : null;
    const freshnessAnchor = state.currentVerifiedAt || capturedAt;
    const staleSeconds = stale && freshnessAnchor ? Math.max(0, Math.floor((now.getTime() - new Date(freshnessAnchor).getTime()) / 1000)) : null;
    return {
      id: creator.id,
      name: creator.displayName,
      displayName: creator.displayName,
      username: creator.username,
      avatarUrl: creator.avatarUrl,
      status: creator.status,
      remoteId: creator.remoteId,
      revenueCents,
      salesCount: null,
      uniqueFans: null,
      capturedAt,
      hasRevenue,
      pending: activeByCreator.has(creator.id),
      stale,
      staleSeconds,
    };
  }).sort((a, b) => Number(b.revenueCents ?? -1) - Number(a.revenueCents ?? -1));

  const currentComplete = reportingIds.length === creatorIds.length;
  const previousComplete = previous && previousReportingIds.length === creatorIds.length;
  const currentFresh = currentComplete && creatorIds.every((id) => coverage.byCreator.get(id)?.fresh === true);
  const previousFresh = previousCoverage && previousComplete
    ? creatorIds.every((id) => previousCoverage.byCreator.get(id)?.fresh === true)
    : false;
  const previousCents = previousTotal ? Number(previousTotal?._sum?.totalCents || 0) : null;

  return {
    // A partial agency aggregate is not the agency total. Keep individually
    // verified creator rows available, but publish the headline KPI/chart only
    // once every scoped creator has canonical coverage for the requested range.
    // This preserves UNKNOWN != ZERO and prevents partial coverage from looking
    // like complete agency revenue.
    totalCents: currentComplete ? totalCents : null,
    deltaPct: currentComplete && previousComplete && currentFresh && previousFresh ? pctChange(totalCents, previousCents) : null,
    points: currentComplete
      ? dateGroups.sort((a, b) => new Date(a.date) - new Date(b.date)).map((row) => ({ label: dateKey(row.date), valueCents: Number(row?._sum?.totalCents || 0) }))
      : [],
    creators: creatorRows,
    reportingCreators: reportingIds.length,
    staleCreators,
    pendingCreatorIds,
    pendingJobs,
  };
}

function emptyRevenueCreator(creator) {
  return {
    id: creator.id, name: creator.displayName, displayName: creator.displayName, username: creator.username,
    avatarUrl: creator.avatarUrl, status: creator.status, remoteId: creator.remoteId,
    revenueCents: null, salesCount: null, uniqueFans: null, capturedAt: null,
    hasRevenue: false, pending: false, stale: false, staleSeconds: null,
  };
}

async function buildHomeSummary({ agencyId, member, rangeKey = "7d" }) {
  if (!member || String(member.agencyId || "") !== String(agencyId || "")) {
    const error = new Error("Current agency membership is required");
    error.code = "AGENCY_FORBIDDEN";
    error.status = 403;
    throw error;
  }
  const now = new Date();
  let homeRangeKey;
  try {
    homeRangeKey = normalizeHomeRangeKey(rangeKey);
  } catch (error) {
    error.status = 400;
    throw error;
  }
  const range = displayRangeBounds(homeRangeKey, now);
  const previous = previousDisplayRange(range.rangeKey, now);
  const scope = await allowedCreatorScope({ agencyId, member, db: prisma });
  const creatorWhere = scope.broad ? {} : { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } };
  const [canViewMoney, canViewTeam, canViewAudit, canManageWorkspace, canRefreshAnalytics] = await Promise.all([
    canUsePermission({ member, key: "money.view_earnings", db: prisma }),
    canUsePermission({ member, key: "workspace.view_team", db: prisma }),
    canUsePermission({ member, key: "workspace.view_audit", db: prisma }),
    canUsePermission({ member, key: "workspace.manage_settings", db: prisma }),
    canUsePermission({ member, key: "creator_analytics.refresh", db: prisma }),
  ]);
  const owner = isOwner(member);

  const [agency, creators, members, jobs, devices, latestAudit, subscription] = await Promise.all([
    prisma.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true, plan: true, status: true } }),
    prisma.creatorAccount.findMany({
      where: { agencyId, deletedAt: null, ...creatorWhere },
      select: { id: true, displayName: true, username: true, avatarUrl: true, status: true, remoteId: true },
      orderBy: { id: "asc" },
    }),
    canViewTeam || owner ? prisma.agencyMember.findMany({
      where: { agencyId, deletedAt: null, deactivatedAt: null },
      select: { id: true, roleKey: true, displayName: true, user: { select: { email: true, name: true } } },
    }) : Promise.resolve([]),
    canManageWorkspace ? prisma.jobInstance.groupBy({
      by: ["status"],
      where: { agencyId, status: { in: ["SCHEDULED", "CLAIMED"] }, ...(scope.broad ? {} : { creatorId: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } }) },
      _count: { _all: true },
    }).catch(() => []) : Promise.resolve([]),
    canManageWorkspace ? prisma.workerDevice.findMany({
      where: { agencyId }, select: { id: true, userId: true, deviceName: true, platform: true, appVersion: true, lastSeenAt: true },
    }) : Promise.resolve([]),
    canViewAudit ? prisma.auditLog.findMany({
      where: { agencyId }, orderBy: { createdAt: "desc" }, take: 5,
      include: { actor: { select: { id: true, email: true, name: true } } },
    }) : Promise.resolve([]),
    owner ? prisma.agencySubscription.findFirst({ where: { agencyId }, orderBy: { createdAt: "desc" } }) : Promise.resolve(null),
  ]);

  const revenue = canViewMoney ? await readCanonicalRevenue({ db: prisma, agencyId, creators, range, previous, now }) : null;
  const visibleCreators = revenue ? revenue.creators : creators.map(emptyRevenueCreator);
  const onlineDevices = canManageWorkspace ? devices.filter((d) => d.lastSeenAt && now.getTime() - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000).length : null;
  const jobsByStatus = canManageWorkspace ? Object.fromEntries((jobs || []).map((row) => [row.status, row._count?._all || 0])) : {};
  const seatsLimit = owner ? (subscription?.seatsLimit ?? null) : null;

  return {
    ok: true,
    agency: agency ? { id: agency.id, name: agency.name, plan: owner ? agency.plan : null, status: agency.status, billingAvailable: owner }
      : { id: agencyId, name: null, plan: null, status: null, billingAvailable: owner },
    range: {
      key: range.rangeKey,
      label: range.rangeKey === "today" ? "Today" : range.rangeKey,
      from: range.startDay.toISOString(),
      to: range.endAt.toISOString(),
      previousKey: range.rangeKey,
    },
    refreshedAt: now.toISOString(),
    creatorScope: { broad: scope.broad === true, creatorIds: creators.map((creator) => creator.id) },
    revenue: canViewMoney ? {
      ...availability(true), refreshAllowed: canRefreshAnalytics === true,
      totalCents: revenue.totalCents, grossCents: null, deltaPct: revenue.deltaPct, currency: "USD",
      salesCount: null, uniqueFans: null, creatorCount: revenue.reportingCreators,
      points: revenue.points,
      coverage: { totalCreators: creators.length, reportingCreators: revenue.reportingCreators, pendingCount: revenue.pendingCreatorIds.length, staleCreators: revenue.staleCreators },
      pending: { count: revenue.pendingCreatorIds.length, creatorIds: revenue.pendingCreatorIds, jobs: revenue.pendingJobs, etaSeconds: null },
      stalenessMs: CURRENT_DAY_FRESHNESS_MS,
      source: "creator_earnings_daily",
    } : {
      ...availability(false, "FORBIDDEN"), refreshAllowed: false, totalCents: null, grossCents: null, deltaPct: null, currency: "USD",
      salesCount: null, uniqueFans: null, creatorCount: 0, points: [],
      coverage: { totalCreators: creators.length, reportingCreators: 0, pendingCount: 0, staleCreators: 0 },
      pending: { count: 0, creatorIds: [], jobs: [], etaSeconds: null }, stalenessMs: CURRENT_DAY_FRESHNESS_MS, source: "forbidden",
    },
    seats: owner ? { ...availability(true), used: members.length, limit: seatsLimit, remaining: seatsLimit === null ? null : Math.max(0, Number(seatsLimit) - members.length), source: seatsLimit === null ? "members_only" : "subscription" }
      : { ...availability(false, "FORBIDDEN"), used: null, limit: null, remaining: null, source: "forbidden" },
    creators: visibleCreators,
    workers: canViewTeam || owner ? { ...availability(true), totalMembers: members.length, onlineDevices: canManageWorkspace ? onlineDevices : null, devices: canManageWorkspace ? devices.length : null, activeMembers: null, runtimeDetailAvailable: canManageWorkspace === true, source: "current_membership" }
      : { ...availability(false, "FORBIDDEN"), totalMembers: null, onlineDevices: null, devices: null, activeMembers: null, runtimeDetailAvailable: false, source: "forbidden" },
    health: canManageWorkspace ? { ...availability(true), onlineDevices, jobs: jobsByStatus, source: "current_runtime" }
      : { ...availability(false, "FORBIDDEN"), onlineDevices: null, jobs: {}, source: "forbidden" },
    jobs: canManageWorkspace ? { ...availability(true), counts: jobsByStatus } : { ...availability(false, "FORBIDDEN"), counts: {} },
    audit: {
      ...availability(canViewAudit, canViewAudit ? null : "FORBIDDEN"),
      items: canViewAudit ? latestAudit.map((row) => ({ id: row.id, action: row.action, targetType: row.targetType, targetId: row.targetId, metadata: row.metadata || {}, createdAt: row.createdAt, actor: row.actor ? { id: row.actor.id, email: row.actor.email, name: row.actor.name } : null })) : [],
    },
  };
}

module.exports = { buildHomeSummary, __test: { readCoverageState, readCanonicalRevenue } };
