"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient, whereForRange } = require("./range-service");
const { getRetentionSettings } = require("./retention-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { retainedDetailFrom, latestAvailableFrom, clampRangeToAvailableFrom, coverageState } = require("./team-historical-range-authority-service");

const RESPONSE_CLASSIFICATIONS = new Set(["FRESH", "BACKLOG", "HANDOFF", "UNKNOWN"]);

function clean(value, max = 180) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function clampLimit(value, fallback = 100) {
  const n = Number(value);
  return Math.max(1, Math.min(500, Number.isFinite(n) ? Math.floor(n) : fallback));
}

function creatorScopeWhere(allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return {};
  const ids = Array.from(new Set(allowedCreatorIds.map(String).map((id) => id.trim()).filter(Boolean)));
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}

function memberSelect() {
  return {
    id: true,
    displayName: true,
    roleKey: true,
    user: { select: { name: true } },
  };
}

function memberName(member) {
  return member?.displayName || member?.user?.name || null;
}

async function resolveDetailReadAuthority({ agencyId, rangeKey, family }) {
  const authorityNow = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  const range = resolveRange(rangeKey, authorityNow);
  const [retention, projection] = await Promise.all([
    getRetentionSettings(),
    prisma.teamProjectionCoverage.findUnique({ where: { agencyId } }),
  ]);
  if (retention?.ok !== true) throw new Error("TEAM_RETENTION_POLICY_UNAVAILABLE");
  if (!projection) throw new Error("TEAM_PROJECTION_COVERAGE_UNAVAILABLE");
  const detailDays = Number(retention.settings?.teamCanonicalDetailDays || 180);
  const retainedFrom = retainedDetailFrom({ authorityNow, detailDays });
  let availableFrom;
  if (family === "response") availableFrom = latestAvailableFrom(projection.responseCoverageFrom, retainedFrom);
  else if (family === "dialog") availableFrom = latestAvailableFrom(projection.dialogCoverageFrom, retainedFrom);
  else availableFrom = latestAvailableFrom(projection.responseCoverageFrom, projection.dialogCoverageFrom, retainedFrom);
  return {
    range,
    retainedRange: clampRangeToAvailableFrom(range, availableFrom),
    coverage: { ...coverageState(range, availableFrom), source: `bounded_team_${family}_detail_v1` },
    detailDays,
  };
}

async function listTeamResponseCases({
  agencyId,
  rangeKey = "7d",
  allowedCreatorIds = null,
  memberId = null,
  classification = null,
  limit = 100,
} = {}) {
  const authority = await resolveDetailReadAuthority({ agencyId, rangeKey, family: "response" });
  const { range, retainedRange } = authority;
  const normalizedClassification = clean(classification, 32)?.toUpperCase() || null;
  const where = {
    agencyId,
    ...creatorScopeWhere(allowedCreatorIds),
    ...(retainedRange ? whereForRange("replyAt", retainedRange) : { id: "__outside_retained_history__" }),
    ...(clean(memberId, 160) ? { memberId: clean(memberId, 160) } : {}),
    ...(normalizedClassification && RESPONSE_CLASSIFICATIONS.has(normalizedClassification)
      ? { classification: normalizedClassification }
      : {}),
  };
  const rows = await prisma.teamResponseCase.findMany({
    where,
    orderBy: [{ replyAt: "desc" }, { id: "desc" }],
    take: clampLimit(limit),
    include: { member: { select: memberSelect() } },
  });
  return {
    ok: true,
    range: rangeForClient(range),
    creatorScope: Array.isArray(allowedCreatorIds) ? allowedCreatorIds.map(String) : "all",
    retainedRange: retainedRange ? rangeForClient(retainedRange) : null,
    coverage: authority.coverage,
    rows: (rows || []).map((row) => ({
      id: row.id,
      creatorId: row.creatorId,
      memberId: row.memberId,
      memberName: memberName(row.member),
      dialogId: row.dialogId,
      fanId: row.fanId || null,
      replyMessageId: row.replyMessageId,
      firstIncomingMessageId: row.firstIncomingMessageId || null,
      incomingCount: row.incomingCount,
      incomingAt: row.incomingAt,
      lastIncomingAt: row.lastIncomingAt,
      replyAt: row.replyAt,
      seenAt: row.seenAt || null,
      coverageId: row.coverageId || null,
      coverageStartedAt: row.coverageStartedAt || null,
      handoffFromMemberId: row.handoffFromMemberId || null,
      classification: row.classification,
      wallClockSeconds: row.wallClockSeconds,
      coverageResponseSeconds: row.coverageResponseSeconds,
      seenResponseSeconds: row.seenResponseSeconds,
      slaEligible: row.slaEligible,
      sla5Pass: row.sla5Pass,
      sla15Pass: row.sla15Pass,
      derivationVersion: row.derivationVersion,
    })),
  };
}

async function listTeamDialogSessions({
  agencyId,
  rangeKey = "7d",
  allowedCreatorIds = null,
  memberId = null,
  limit = 100,
} = {}) {
  const authority = await resolveDetailReadAuthority({ agencyId, rangeKey, family: "dialog" });
  const { range, retainedRange } = authority;
  const where = {
    agencyId,
    ...creatorScopeWhere(allowedCreatorIds),
    ...(retainedRange ? whereForRange("startedAt", retainedRange) : { id: "__outside_retained_history__" }),
    ...(clean(memberId, 160) ? { memberId: clean(memberId, 160) } : {}),
  };
  const rows = await prisma.teamDialogSession.findMany({
    where,
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: clampLimit(limit),
    include: { member: { select: memberSelect() } },
  });
  return {
    ok: true,
    range: rangeForClient(range),
    creatorScope: Array.isArray(allowedCreatorIds) ? allowedCreatorIds.map(String) : "all",
    retainedRange: retainedRange ? rangeForClient(retainedRange) : null,
    coverage: authority.coverage,
    rows: (rows || []).map((row) => ({
      id: row.id,
      creatorId: row.creatorId,
      memberId: row.memberId,
      memberName: memberName(row.member),
      dialogId: row.dialogId,
      fanId: row.fanId || null,
      sessionId: row.sessionId,
      coverageId: row.coverageId || null,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      wallSeconds: row.wallSeconds,
      activeSeconds: row.activeSeconds,
      seenAt: row.seenAt || null,
      activityEvents: row.activityEvents,
      endReason: row.endReason || null,
      source: row.source,
    })),
  };
}

async function listTeamCoverageSessions({
  agencyId,
  rangeKey = "7d",
  allowedCreatorIds = null,
  memberId = null,
  limit = 100,
} = {}) {
  const authority = await resolveDetailReadAuthority({ agencyId, rangeKey, family: "coverage" });
  const { range, retainedRange } = authority;
  const where = {
    agencyId,
    ...creatorScopeWhere(allowedCreatorIds),
    ...(retainedRange ? whereForRange("startedAt", retainedRange) : { id: "__outside_retained_history__" }),
    ...(clean(memberId, 160) ? { memberId: clean(memberId, 160) } : {}),
  };
  const rows = await prisma.teamCoverageSession.findMany({
    where,
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: clampLimit(limit),
    include: { member: { select: memberSelect() } },
  });
  return {
    ok: true,
    range: rangeForClient(range),
    creatorScope: Array.isArray(allowedCreatorIds) ? allowedCreatorIds.map(String) : "all",
    retainedRange: retainedRange ? rangeForClient(retainedRange) : null,
    coverage: authority.coverage,
    rows: (rows || []).map((row) => ({
      id: row.id,
      creatorId: row.creatorId,
      memberId: row.memberId,
      memberName: memberName(row.member),
      deviceId: row.deviceId || null,
      coverageId: row.coverageId,
      startedAt: row.startedAt,
      endedAt: row.endedAt || null,
      durationSeconds: row.durationSeconds,
      startReason: row.startReason || null,
      endReason: row.endReason || null,
      source: row.source,
    })),
  };
}

module.exports = {
  RESPONSE_CLASSIFICATIONS,
  listTeamResponseCases,
  listTeamDialogSessions,
  listTeamCoverageSessions,
};
