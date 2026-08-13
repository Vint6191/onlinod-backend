"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient } = require("./range-service");
const { audit } = require("./audit-service");
const { normalizeAssignedCreators } = require("./team-access-control");

const MAX_OPEN_COVERAGE_MS = 12 * 60 * 60 * 1000;
const MAX_SHIFT_MS = 36 * 60 * 60 * 1000;
const MIN_SHIFT_MS = 15 * 60 * 1000;
const HANDOFF_WINDOW_MS = 30 * 60 * 1000;

function clean(value, max = 180) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function error(code, message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra });
}

function uniqueIds(value, max = 200) {
  const input = Array.isArray(value) ? value : [];
  return Array.from(new Set(input.map((item) => clean(item, 180)).filter(Boolean))).slice(0, max);
}

function validTimezone(value) {
  const zone = clean(value, 100) || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return zone;
  } catch {
    throw error("TEAM_SCHEDULE_INVALID_TIMEZONE", "A valid IANA timezone is required");
  }
}

function date(value, field) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(String(value || ""));
  if (!Number.isFinite(result.getTime())) throw error("TEAM_SCHEDULE_INVALID_DATE", `${field} must be a valid ISO date-time`);
  return result;
}

function validateShiftWindow(startsAtValue, endsAtValue) {
  const startsAt = date(startsAtValue, "startsAt");
  const endsAt = date(endsAtValue, "endsAt");
  const durationMs = endsAt.getTime() - startsAt.getTime();
  if (durationMs < MIN_SHIFT_MS) throw error("TEAM_SCHEDULE_SHIFT_TOO_SHORT", "A shift must be at least 15 minutes");
  if (durationMs > MAX_SHIFT_MS) throw error("TEAM_SCHEDULE_SHIFT_TOO_LONG", "A shift cannot exceed 36 hours");
  return { startsAt, endsAt };
}

function creatorScopeWhere(allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return {};
  const ids = uniqueIds(allowedCreatorIds, 10000);
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}

function creatorAllowed(creatorId, allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return true;
  return new Set(uniqueIds(allowedCreatorIds, 10000)).has(String(creatorId));
}

async function findAllById(model, args = {}, pageSize = 5000) {
  const rows = [];
  let cursorId = null;
  for (;;) {
    const page = await model.findMany({
      ...args,
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (!page.length) break;
    rows.push(...page);
    cursorId = String(page[page.length - 1].id || "");
    if (!cursorId || page.length < pageSize) break;
  }
  return rows;
}

function memberName(member) {
  return member?.displayName || member?.user?.name || member?.user?.email || null;
}

function creatorName(creator, fallback = null) {
  return creator?.displayName || creator?.username || fallback || "Creator";
}

function interval(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs };
}

function unionSeconds(intervals) {
  const sorted = (Array.isArray(intervals) ? intervals : []).filter(Boolean).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (!sorted.length) return 0;
  let start = sorted[0].startMs;
  let end = sorted[0].endMs;
  let total = 0;
  for (const item of sorted.slice(1)) {
    if (item.startMs <= end) end = Math.max(end, item.endMs);
    else {
      total += Math.max(0, end - start);
      start = item.startMs;
      end = item.endMs;
    }
  }
  total += Math.max(0, end - start);
  return Math.round(total / 1000);
}

function median(values) {
  const rows = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function effectiveCoverageEnd(row, nowMs) {
  const startMs = new Date(row.startedAt).getTime();
  if (!Number.isFinite(startMs)) return { endMs: NaN, activeNow: false, staleOpen: false };
  if (row.endedAt) return { endMs: new Date(row.endedAt).getTime(), activeNow: false, staleOpen: false };
  const ageMs = Math.max(0, nowMs - startMs);
  const staleOpen = ageMs > MAX_OPEN_COVERAGE_MS;
  return {
    endMs: Math.min(nowMs, startMs + MAX_OPEN_COVERAGE_MS),
    activeNow: !staleOpen && nowMs >= startMs,
    staleOpen,
  };
}

function clipCoverageSession(row, range, nowMs) {
  const rawStart = new Date(row.startedAt).getTime();
  const effective = effectiveCoverageEnd(row, nowMs);
  if (!Number.isFinite(rawStart) || !Number.isFinite(effective.endMs)) return null;
  const rangeStart = range.startAt ? range.startAt.getTime() : rawStart;
  const rangeEnd = range.endAt ? range.endAt.getTime() : nowMs;
  const startMs = Math.max(rawStart, rangeStart);
  const endMs = Math.min(Math.max(effective.endMs, rawStart), rangeEnd);
  if (endMs <= startMs) return null;
  return {
    startMs,
    endMs,
    seconds: Math.max(0, Math.round((endMs - startMs) / 1000)),
    activeNow: effective.activeNow,
    staleOpen: effective.staleOpen,
  };
}

function rangeOverlapWhere(range, fieldStart = "startedAt", fieldEnd = "endedAt") {
  if (!range.startAt) return { [fieldStart]: { lte: range.endAt } };
  return {
    [fieldStart]: { lte: range.endAt },
    OR: [{ [fieldEnd]: null }, { [fieldEnd]: { gte: range.startAt } }],
  };
}

function normalizeAssignedScope(value) {
  const normalized = normalizeAssignedCreators(value);
  return normalized.mode === "all" ? null : normalized.creatorIds;
}

function intersectScope(a, b) {
  if (!Array.isArray(a)) return Array.isArray(b) ? [...b] : null;
  if (!Array.isArray(b)) return [...a];
  const set = new Set(b.map(String));
  return a.filter((id) => set.has(String(id)));
}

async function loadWorkspaceTimezone(agencyId, db = prisma) {
  const row = await db.workspaceSetting.findUnique({ where: { agencyId_key: { agencyId, key: "timezone" } } }).catch(() => null);
  const raw = row?.value;
  const candidate = typeof raw === "string" ? raw : (raw && typeof raw === "object" ? raw.timezone || raw.value : null);
  try { return validTimezone(candidate || "UTC"); } catch { return "UTC"; }
}

async function loadScheduleContext({ agencyId, allowedCreatorIds = null, canManageSchedule = false, db = prisma }) {
  const creatorWhere = { agencyId, deletedAt: null, ...creatorScopeWhere(allowedCreatorIds) };
  const [timezone, creators, members] = await Promise.all([
    loadWorkspaceTimezone(agencyId, db),
    findAllById(db.creatorAccount, {
      where: creatorWhere,
      select: { id: true, displayName: true, username: true, avatarUrl: true },
    }),
    findAllById(db.agencyMember, {
      where: { agencyId, deletedAt: null, deactivatedAt: null },
      select: {
        id: true, displayName: true, roleKey: true, assignedCreators: true,
        user: { select: { name: true, email: true } },
        teamFunctions: { select: { functionKey: true }, orderBy: { functionKey: "asc" } },
      },
    }),
  ]);
  const actorScope = Array.isArray(allowedCreatorIds) ? uniqueIds(allowedCreatorIds, 10000) : null;
  const safeMembers = members.map((row) => {
    const targetScope = normalizeAssignedScope(row.assignedCreators);
    const visibleScope = intersectScope(targetScope, actorScope);
    return {
      id: String(row.id),
      name: memberName(row) || String(row.id),
      roleKey: row.roleKey || null,
      functions: (row.teamFunctions || []).map((item) => String(item.functionKey)),
      // Never disclose creator ids outside the acting member's own scope. "all"
      // is only safe when the acting member is also unscoped.
      assignedCreators: visibleScope == null ? "all" : uniqueIds(visibleScope, 10000),
    };
  });
  return {
    canManageSchedule: Boolean(canManageSchedule),
    workspaceTimezone: timezone,
    creators: creators.map((row) => ({
      id: String(row.id),
      name: creatorName(row, row.id),
      username: row.username || null,
      avatarUrl: row.avatarUrl || null,
    })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    members: safeMembers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}

function plannedShiftWhere(range, allowedCreatorIds) {
  const where = range.startAt
    ? { startsAt: { lte: range.endAt }, endsAt: { gte: range.startAt } }
    : { startsAt: { lte: range.endAt } };
  if (Array.isArray(allowedCreatorIds)) {
    const ids = uniqueIds(allowedCreatorIds, 10000);
    where.creators = { some: { creatorId: { in: ids.length ? ids : ["__none__"] } } };
  }
  return where;
}

function responseRangeWhere(range, allowedCreatorIds) {
  const where = { replyAt: { lte: range.endAt }, ...creatorScopeWhere(allowedCreatorIds) };
  if (range.startAt) where.replyAt.gte = range.startAt;
  return where;
}

function matchShiftActual(shift, actualSessions, responseCases, nowMs) {
  const startMs = new Date(shift.startsAt).getTime();
  const endMs = new Date(shift.endsAt).getTime();
  const creatorIds = new Set((shift.creators || []).map((link) => String(link.creatorId || link.creator?.id || "")).filter(Boolean));
  const relevant = actualSessions.filter((session) => {
    if (String(session.memberId) !== String(shift.memberId)) return false;
    if (!creatorIds.has(String(session.creatorId))) return false;
    return session._startMs < endMs && session._endMs > startMs;
  });
  const presenceIntervals = relevant.map((session) => interval(Math.max(startMs, session._startMs), Math.min(endMs, session._endMs))).filter(Boolean);
  const actualPresenceSeconds = unionSeconds(presenceIntervals);
  const plannedSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  const firstActualMs = relevant.length ? Math.min(...relevant.map((row) => Math.max(startMs, row._startMs))) : null;
  const lastActualMs = relevant.length ? Math.max(...relevant.map((row) => Math.min(endMs, row._endMs))) : null;
  const responseRows = responseCases.filter((row) => {
    if (String(row.memberId || "") !== String(shift.memberId)) return false;
    if (!creatorIds.has(String(row.creatorId || ""))) return false;
    const replyAt = new Date(row.replyAt).getTime();
    return Number.isFinite(replyAt) && replyAt >= startMs && replyAt <= endMs;
  });
  const slaEligible = responseRows.filter((row) => row.slaEligible === true);
  const responseSeconds = slaEligible.map((row) => Number(row.wallClockSeconds)).filter(Number.isFinite).map((value) => Math.max(0, value));
  const sla15Passes = slaEligible.filter((row) => row.sla15Pass === true).length;
  const cancelled = String(shift.status || "PLANNED").toUpperCase() === "CANCELLED";
  let fulfillment = "UPCOMING";
  if (cancelled) fulfillment = "CANCELLED";
  else if (nowMs < startMs) fulfillment = "UPCOMING";
  else if (nowMs >= startMs && nowMs < endMs) fulfillment = actualPresenceSeconds > 0 ? "LIVE" : "NOT_STARTED";
  else if (actualPresenceSeconds <= 0) fulfillment = "MISSED";
  else if (plannedSeconds > 0 && actualPresenceSeconds / plannedSeconds >= 0.8) fulfillment = "COVERED";
  else fulfillment = "PARTIAL";

  return {
    plannedSeconds,
    actualPresenceSeconds,
    gapSeconds: Math.max(0, plannedSeconds - actualPresenceSeconds),
    firstActualAt: firstActualMs == null ? null : new Date(firstActualMs).toISOString(),
    lastActualAt: lastActualMs == null ? null : new Date(lastActualMs).toISOString(),
    lateStartSeconds: firstActualMs == null ? null : Math.max(0, Math.round((firstActualMs - startMs) / 1000)),
    earlyEndSeconds: lastActualMs == null || nowMs < endMs ? null : Math.max(0, Math.round((endMs - lastActualMs) / 1000)),
    sessionsCount: relevant.length,
    fulfillment,
    responseSamples: slaEligible.length,
    medianResponseSeconds: median(responseSeconds),
    sla15Pct: slaEligible.length ? (sla15Passes / slaEligible.length) * 100 : null,
  };
}

async function buildTeamSchedule({ agencyId, rangeKey = "7d", allowedCreatorIds = null, canManageSchedule = false, now = new Date(), db = prisma } = {}) {
  const range = resolveRange(rangeKey, now);
  const nowMs = now.getTime();
  const includeCreatorWhere = Array.isArray(allowedCreatorIds)
    ? { where: creatorScopeWhere(allowedCreatorIds), select: { creatorId: true, creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } } } }
    : { select: { creatorId: true, creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } } } };

  const [coverageRows, shifts, responseCases, context] = await Promise.all([
    findAllById(db.teamCoverageSession, {
      where: { agencyId, ...rangeOverlapWhere(range), ...creatorScopeWhere(allowedCreatorIds) },
      include: {
        member: { select: { id: true, displayName: true, roleKey: true, user: { select: { name: true, email: true } } } },
        creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
      },
    }),
    findAllById(db.teamShift, {
      where: { agencyId, ...plannedShiftWhere(range, allowedCreatorIds) },
      include: {
        member: { select: { id: true, displayName: true, roleKey: true, user: { select: { name: true, email: true } } } },
        creators: includeCreatorWhere,
      },
    }),
    db.teamResponseCase?.findMany
      ? findAllById(db.teamResponseCase, {
          where: { agencyId, ...responseRangeWhere(range, allowedCreatorIds) },
          select: { id: true, creatorId: true, memberId: true, replyAt: true, slaEligible: true, sla15Pass: true, wallClockSeconds: true },
        })
      : Promise.resolve([]),
    loadScheduleContext({ agencyId, allowedCreatorIds, canManageSchedule, db }),
  ]);

  const byCreator = new Map();
  const memberTotals = new Map();
  const actualSessions = [];
  let openSessions = 0;
  let staleOpenSessions = 0;

  for (const row of coverageRows) {
    const clipped = clipCoverageSession(row, range, nowMs);
    if (!clipped) continue;
    const creatorId = String(row.creatorId);
    if (!byCreator.has(creatorId)) byCreator.set(creatorId, { creator: row.creator, sessions: [], intervals: [] });
    const normalized = {
      id: String(row.id),
      creatorId,
      memberId: String(row.memberId),
      memberName: memberName(row.member),
      roleKey: row.member?.roleKey || null,
      coverageId: row.coverageId,
      deviceId: row.deviceId || null,
      startedAt: new Date(row.startedAt).toISOString(),
      endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
      durationSeconds: clipped.seconds,
      startReason: row.startReason || null,
      endReason: row.endReason || null,
      activeNow: clipped.activeNow,
      staleOpen: clipped.staleOpen,
      source: row.source,
      _startMs: clipped.startMs,
      _endMs: clipped.endMs,
    };
    actualSessions.push(normalized);
    const group = byCreator.get(creatorId);
    group.sessions.push(normalized);
    group.intervals.push({ startMs: clipped.startMs, endMs: clipped.endMs });
    if (clipped.activeNow) openSessions += 1;
    if (clipped.staleOpen) staleOpenSessions += 1;

    const memberKey = String(row.memberId);
    const prev = memberTotals.get(memberKey) || { memberId: memberKey, memberName: memberName(row.member), coverageSeconds: 0, sessions: 0, creators: new Set(), activeNow: false, staleOpenSessions: 0 };
    prev.coverageSeconds += clipped.seconds;
    prev.sessions += 1;
    prev.creators.add(creatorId);
    prev.activeNow = prev.activeNow || clipped.activeNow;
    if (clipped.staleOpen) prev.staleOpenSessions += 1;
    memberTotals.set(memberKey, prev);
  }

  const handoffs = [];
  const overlaps = [];
  const creators = [];
  for (const [creatorId, group] of byCreator) {
    group.sessions.sort((a, b) => a._startMs - b._startMs || a._endMs - b._endMs);
    let creatorHandoffs = 0;
    let creatorOverlaps = 0;
    for (let i = 1; i < group.sessions.length; i += 1) {
      const previous = group.sessions[i - 1];
      const next = group.sessions[i];
      if (previous.memberId === next.memberId) continue;
      const gapMs = next._startMs - previous._endMs;
      const base = {
        creatorId,
        creatorName: creatorName(group.creator, creatorId),
        fromMemberId: previous.memberId,
        fromMemberName: previous.memberName,
        toMemberId: next.memberId,
        toMemberName: next.memberName,
        at: new Date(next._startMs).toISOString(),
        gapSeconds: Math.round(gapMs / 1000),
      };
      if (gapMs >= 0 && gapMs <= HANDOFF_WINDOW_MS) {
        creatorHandoffs += 1;
        handoffs.push(base);
      } else if (gapMs < 0) {
        creatorOverlaps += 1;
        overlaps.push({ ...base, overlapSeconds: Math.round(Math.abs(gapMs) / 1000) });
      }
    }
    const uniqueMembers = new Set(group.sessions.map((row) => row.memberId));
    creators.push({
      creatorId,
      creatorName: creatorName(group.creator, creatorId),
      creatorUsername: group.creator?.username || null,
      creatorAvatarUrl: group.creator?.avatarUrl || null,
      coveredSeconds: unionSeconds(group.intervals),
      sessionSeconds: group.sessions.reduce((sum, row) => sum + row.durationSeconds, 0),
      sessionsCount: group.sessions.length,
      membersCount: uniqueMembers.size,
      handoffs: creatorHandoffs,
      overlaps: creatorOverlaps,
      activeNow: group.sessions.some((row) => row.activeNow),
      staleOpenSessions: group.sessions.filter((row) => row.staleOpen).length,
      sessions: group.sessions.slice().reverse().slice(0, 100).map(({ _startMs, _endMs, ...row }) => row),
    });
  }

  shifts.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime() || String(a.id).localeCompare(String(b.id)));
  const plannedShifts = shifts.map((row) => {
    const visibleCreators = (row.creators || []).map((link) => ({
      id: String(link.creatorId || link.creator?.id),
      name: creatorName(link.creator, link.creatorId),
      username: link.creator?.username || null,
      avatarUrl: link.creator?.avatarUrl || null,
    })).filter((item) => item.id);
    const enriched = matchShiftActual({ ...row, creators: row.creators }, actualSessions, responseCases || [], nowMs);
    return {
      id: String(row.id),
      memberId: String(row.memberId),
      memberName: memberName(row.member) || String(row.memberId),
      roleKey: row.member?.roleKey || null,
      creatorIds: visibleCreators.map((item) => item.id),
      creators: visibleCreators,
      startsAt: new Date(row.startsAt).toISOString(),
      endsAt: new Date(row.endsAt).toISOString(),
      timezone: row.timezone || "UTC",
      status: String(row.status || "PLANNED").toUpperCase(),
      note: row.note || null,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null,
      ...enriched,
    };
  });

  creators.sort((a, b) => Number(b.activeNow) - Number(a.activeNow) || b.coveredSeconds - a.coveredSeconds || a.creatorName.localeCompare(b.creatorName));
  handoffs.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  overlaps.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const members = Array.from(memberTotals.values()).map((row) => ({
    memberId: row.memberId,
    memberName: row.memberName,
    coverageSeconds: row.coverageSeconds,
    sessionsCount: row.sessions,
    creatorsCount: row.creators.size,
    activeNow: row.activeNow,
    staleOpenSessions: row.staleOpenSessions,
  })).sort((a, b) => Number(b.activeNow) - Number(a.activeNow) || b.coverageSeconds - a.coverageSeconds);

  const nonCancelled = plannedShifts.filter((row) => row.status !== "CANCELLED");
  const completed = nonCancelled.filter((row) => new Date(row.endsAt).getTime() <= nowMs);
  const totalPlannedSeconds = nonCancelled.reduce((sum, row) => sum + row.plannedSeconds, 0);
  const totalActualAgainstPlanSeconds = nonCancelled.reduce((sum, row) => sum + Math.min(row.plannedSeconds, row.actualPresenceSeconds), 0);
  const missedShifts = completed.filter((row) => row.fulfillment === "MISSED").length;

  return {
    ok: true,
    asOf: now.toISOString(),
    range: rangeForClient(range),
    creatorScope: Array.isArray(allowedCreatorIds) ? uniqueIds(allowedCreatorIds, 10000) : "all",
    context,
    summary: {
      plannedShifts: nonCancelled.length,
      livePlannedShifts: nonCancelled.filter((row) => row.fulfillment === "LIVE" || row.fulfillment === "NOT_STARTED").length,
      completedShifts: completed.length,
      missedShifts,
      creatorsCovered: creators.length,
      membersWithCoverage: members.length,
      sessions: actualSessions.length,
      openSessions,
      staleOpenSessions,
      handoffs: handoffs.length,
      overlaps: overlaps.length,
      coveredSeconds: creators.reduce((sum, row) => sum + row.coveredSeconds, 0),
      plannedSeconds: totalPlannedSeconds,
      actualAgainstPlanSeconds: totalActualAgainstPlanSeconds,
      planCoveragePct: totalPlannedSeconds > 0 ? (totalActualAgainstPlanSeconds / totalPlannedSeconds) * 100 : null,
    },
    shifts: plannedShifts,
    creators,
    members,
    handoffs: handoffs.slice(0, 100),
    overlaps: overlaps.slice(0, 100),
    source: "team_shift_plus_coverage_v1",
  };
}

async function assertShiftTargets({ agencyId, memberId, creatorIds, actorAllowedCreatorIds = null, db = prisma }) {
  const targetMemberId = clean(memberId, 180);
  if (!targetMemberId) throw error("TEAM_SCHEDULE_MEMBER_REQUIRED", "memberId is required");
  const ids = uniqueIds(creatorIds, 100);
  if (!ids.length) throw error("TEAM_SCHEDULE_CREATORS_REQUIRED", "At least one creator is required");

  if (Array.isArray(actorAllowedCreatorIds)) {
    const allowed = new Set(uniqueIds(actorAllowedCreatorIds, 10000));
    const forbidden = ids.filter((id) => !allowed.has(id));
    if (forbidden.length) throw error("TEAM_SCHEDULE_CREATOR_FORBIDDEN", "Creator is outside your assigned scope", 403, { creatorIds: forbidden });
  }

  const [member, creators] = await Promise.all([
    db.agencyMember.findFirst({
      where: { id: targetMemberId, agencyId, deletedAt: null, deactivatedAt: null },
      select: { id: true, assignedCreators: true, displayName: true, user: { select: { name: true, email: true } } },
    }),
    db.creatorAccount.findMany({ where: { agencyId, deletedAt: null, id: { in: ids } }, select: { id: true }, take: 1000 }),
  ]);
  if (!member) throw error("TEAM_SCHEDULE_MEMBER_NOT_FOUND", "Active team member was not found", 404);
  const found = new Set(creators.map((row) => String(row.id)));
  const unknown = ids.filter((id) => !found.has(id));
  if (unknown.length) throw error("TEAM_SCHEDULE_CREATOR_NOT_FOUND", "One or more creators were not found", 404, { creatorIds: unknown });

  const targetScope = normalizeAssignedScope(member.assignedCreators);
  if (Array.isArray(targetScope)) {
    const allowed = new Set(targetScope.map(String));
    const outsideTargetScope = ids.filter((id) => !allowed.has(id));
    if (outsideTargetScope.length) throw error("TEAM_SCHEDULE_MEMBER_CREATOR_FORBIDDEN", "Shift includes a creator not assigned to this member", 409, { creatorIds: outsideTargetScope });
  }
  return { member, creatorIds: ids };
}

async function createTeamShift({ agencyId, actorUserId, actorMemberId, actorAllowedCreatorIds = null, input, db = prisma }) {
  const window = validateShiftWindow(input?.startsAt, input?.endsAt);
  const timezone = validTimezone(input?.timezone || "UTC");
  const note = clean(input?.note, 500);
  const targets = await assertShiftTargets({ agencyId, memberId: input?.memberId, creatorIds: input?.creatorIds, actorAllowedCreatorIds, db });
  const row = await db.teamShift.create({
    data: {
      agencyId,
      memberId: targets.member.id,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      timezone,
      status: "PLANNED",
      note,
      createdByUserId: actorUserId || null,
      updatedByUserId: actorUserId || null,
      creators: { create: targets.creatorIds.map((creatorId) => ({ creatorId })) },
    },
    include: { creators: { select: { creatorId: true } } },
  });
  await audit({
    agencyId, actorUserId, action: "team.schedule.shift_created", targetType: "team_shift", targetId: row.id,
    metadata: { actorMemberId, memberId: row.memberId, startsAt: row.startsAt, endsAt: row.endsAt, timezone: row.timezone, creatorIds: targets.creatorIds }, db,
  });
  return { ok: true, shiftId: row.id };
}

async function updateTeamShift({ agencyId, shiftId, actorUserId, actorMemberId, actorAllowedCreatorIds = null, input, db = prisma }) {
  const id = clean(shiftId, 180);
  const existing = await db.teamShift.findFirst({ where: { id, agencyId }, include: { creators: { select: { creatorId: true } } } });
  if (!existing) throw error("TEAM_SCHEDULE_SHIFT_NOT_FOUND", "Shift was not found", 404);
  if (String(existing.status || "").toUpperCase() === "CANCELLED") throw error("TEAM_SCHEDULE_SHIFT_CANCELLED", "Cancelled shifts are immutable", 409);

  const memberId = input?.memberId ?? existing.memberId;
  const creatorIds = input?.creatorIds ?? existing.creators.map((row) => row.creatorId);
  const startsAtInput = input?.startsAt ?? existing.startsAt;
  const endsAtInput = input?.endsAt ?? existing.endsAt;
  const window = validateShiftWindow(startsAtInput, endsAtInput);
  const timezone = validTimezone(input?.timezone ?? existing.timezone ?? "UTC");
  const note = input && Object.prototype.hasOwnProperty.call(input, "note") ? clean(input.note, 500) : existing.note;
  const targets = await assertShiftTargets({ agencyId, memberId, creatorIds, actorAllowedCreatorIds, db });

  const updated = await db.$transaction(async (tx) => {
    await tx.teamShiftCreator.deleteMany({ where: { shiftId: id } });
    if (targets.creatorIds.length) await tx.teamShiftCreator.createMany({ data: targets.creatorIds.map((creatorId) => ({ shiftId: id, creatorId })), skipDuplicates: true });
    return tx.teamShift.update({
      where: { id },
      data: { memberId: targets.member.id, startsAt: window.startsAt, endsAt: window.endsAt, timezone, note, updatedByUserId: actorUserId || null },
    });
  });
  await audit({
    agencyId, actorUserId, action: "team.schedule.shift_updated", targetType: "team_shift", targetId: id,
    metadata: {
      actorMemberId,
      before: { memberId: existing.memberId, startsAt: existing.startsAt, endsAt: existing.endsAt, timezone: existing.timezone, creatorIds: existing.creators.map((row) => row.creatorId) },
      after: { memberId: updated.memberId, startsAt: updated.startsAt, endsAt: updated.endsAt, timezone: updated.timezone, creatorIds: targets.creatorIds },
    }, db,
  });
  return { ok: true, shiftId: id };
}

async function cancelTeamShift({ agencyId, shiftId, actorUserId, actorMemberId, actorAllowedCreatorIds = null, reason = null, db = prisma }) {
  const id = clean(shiftId, 180);
  const existing = await db.teamShift.findFirst({ where: { id, agencyId }, include: { creators: { select: { creatorId: true } } } });
  if (!existing) throw error("TEAM_SCHEDULE_SHIFT_NOT_FOUND", "Shift was not found", 404);
  if (Array.isArray(actorAllowedCreatorIds)) {
    const allowed = new Set(uniqueIds(actorAllowedCreatorIds, 10000));
    const forbidden = (existing.creators || []).map((row) => String(row.creatorId)).filter((creatorId) => !allowed.has(creatorId));
    if (forbidden.length) throw error("TEAM_SCHEDULE_CREATOR_FORBIDDEN", "Shift is outside your assigned creator scope", 403, { creatorIds: forbidden });
  }
  if (String(existing.status || "").toUpperCase() === "CANCELLED") return { ok: true, shiftId: id, alreadyCancelled: true };
  const cancellationReason = clean(reason, 500);
  const now = new Date();
  await db.teamShift.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: now, cancelledByUserId: actorUserId || null, updatedByUserId: actorUserId || null } });
  await audit({
    agencyId, actorUserId, action: "team.schedule.shift_cancelled", targetType: "team_shift", targetId: id,
    metadata: { actorMemberId, memberId: existing.memberId, reason: cancellationReason }, db,
  });
  return { ok: true, shiftId: id, alreadyCancelled: false };
}

module.exports = {
  MAX_OPEN_COVERAGE_MS,
  MAX_SHIFT_MS,
  MIN_SHIFT_MS,
  HANDOFF_WINDOW_MS,
  buildTeamSchedule,
  createTeamShift,
  updateTeamShift,
  cancelTeamShift,
  unionSeconds,
  clipCoverageSession,
  validateShiftWindow,
  validTimezone,
  matchShiftActual,
};
