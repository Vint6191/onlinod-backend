"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient, whereForRange } = require("./range-service");
const { getRetentionSettings } = require("./retention-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { retainedDetailFrom, latestAvailableFrom, clampRangeToAvailableFrom, coverageState } = require("./team-historical-range-authority-service");
const { phase2CoverageStatus, FAMILY: PHASE2_COVERAGE_FAMILY, GENERATION: PHASE2_COVERAGE_GENERATION } = require("./phase2-work-coverage-authority-service");

const CURRENT_RESPONSE_DERIVATION_VERSION = "team_response_v2";

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

async function responseProjectionAuthority({ agencyId, db = prisma, includeIncomplete = true } = {}) {
  let dialog;
  let response;
  try {
    [dialog, response] = await Promise.all([
      phase2CoverageStatus({ db, agencyId, family: PHASE2_COVERAGE_FAMILY.TEAM_DIALOG_PROJECTION, generation: PHASE2_COVERAGE_GENERATION.TEAM_DIALOG_PROJECTION }),
      phase2CoverageStatus({ db, agencyId, family: PHASE2_COVERAGE_FAMILY.TEAM_RESPONSE_RANGE_REPAIR, generation: PHASE2_COVERAGE_GENERATION.TEAM_RESPONSE_RANGE_REPAIR }),
    ]);
  } catch (_) {
    dialog = { historicalReady: false, fresh: false, semanticState: "UNKNOWN" };
    response = { historicalReady: false, fresh: false, semanticState: "UNKNOWN" };
  }
  const fresh = dialog?.currentReady === true && response?.currentReady === true;
  return {
    fresh,
    state: !dialog?.historicalReady || !response?.historicalReady
      ? "TRANSITION"
      : fresh ? "CURRENT_FRESH" : "CURRENT_STALE",
    dialog,
    response,
    // Current physical authority only. Never fail-open to compatibility rows.
    where: {
      derivationVersion: CURRENT_RESPONSE_DERIVATION_VERSION,
      projectionState: includeIncomplete ? { in: ["FULL", "INCOMPLETE_HISTORY"] } : "FULL",
    },
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
  const projectionAuthority = await responseProjectionAuthority({ agencyId, db: prisma, includeIncomplete: true });
  const generationWhere = projectionAuthority.where;
  const where = {
    agencyId,
    ...generationWhere,
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
    projectionAuthority: {
      state: projectionAuthority.state,
      fresh: projectionAuthority.fresh === true,
      dialogOutstanding: projectionAuthority.dialog?.live?.outstandingCount ?? null,
      responseOutstanding: projectionAuthority.response?.live?.outstandingCount ?? null,
      generation: CURRENT_RESPONSE_DERIVATION_VERSION,
    },
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
      projectionState: row.projectionState || "UNKNOWN",
      repairReason: row.repairReason || null,
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
  CURRENT_RESPONSE_DERIVATION_VERSION, responseProjectionAuthority,
  RESPONSE_CLASSIFICATIONS,
  listTeamResponseCases,
  listTeamDialogSessions,
  listTeamCoverageSessions,
};
