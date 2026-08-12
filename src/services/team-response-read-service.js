"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient, whereForRange } = require("./range-service");

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

async function listTeamResponseCases({
  agencyId,
  rangeKey = "7d",
  allowedCreatorIds = null,
  memberId = null,
  classification = null,
  limit = 100,
} = {}) {
  const range = resolveRange(rangeKey);
  const normalizedClassification = clean(classification, 32)?.toUpperCase() || null;
  const where = {
    agencyId,
    ...creatorScopeWhere(allowedCreatorIds),
    ...whereForRange("replyAt", range),
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
  const range = resolveRange(rangeKey);
  const where = {
    agencyId,
    ...creatorScopeWhere(allowedCreatorIds),
    ...whereForRange("startedAt", range),
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
  const range = resolveRange(rangeKey);
  const where = {
    agencyId,
    ...creatorScopeWhere(allowedCreatorIds),
    ...whereForRange("startedAt", range),
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
