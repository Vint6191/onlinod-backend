"use strict";

const prisma = require("../prisma");

const RESPONSE_DERIVATION_VERSION = "team_response_v1";
const RESPONSE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_COVERAGE_MS = 12 * 60 * 60 * 1000;

function clean(value, max = 220) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function dateOrNull(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function secondsBetween(a, b) {
  const start = dateOrNull(a)?.getTime();
  const end = dateOrNull(b)?.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

function extraOf(row) {
  return row?.extra && typeof row.extra === "object" && !Array.isArray(row.extra) ? row.extra : {};
}

function metadataOf(row) {
  const extra = extraOf(row);
  return extra?.metadata && typeof extra.metadata === "object" && !Array.isArray(extra.metadata) ? extra.metadata : {};
}

function isManualConfirmed(row) {
  return String(row?.eventKind || "").toUpperCase() === "MESSAGE_SEND_CONFIRMED"
    && String(row?.actionSource || "").toUpperCase() === "MANUAL"
    && String(row?.lifecycle || "").toUpperCase() === "CONFIRMED";
}

function isCanonicalKind(row, kind) {
  return String(row?.eventKind || "").toUpperCase() === kind;
}

function sourceIsManual(value) {
  const source = String(value || "").trim().toLowerCase();
  return source === "manual" || source === "manual_chat";
}

async function upsertCoverageSession(row, db = prisma) {
  if (!isCanonicalKind(row, "COVERAGE_STARTED") && !isCanonicalKind(row, "COVERAGE_ENDED")) return null;
  const agencyId = clean(row.agencyId, 160);
  const creatorId = clean(row.creatorId, 160);
  const memberId = clean(row.memberId, 160);
  const coverageId = clean(row.coverageId || row.correlationId || row.localId, 220);
  if (!agencyId || !creatorId || !memberId || !coverageId) return null;

  const meta = metadataOf(row);
  const rowTs = dateOrNull(row.ts) || new Date();
  const startedAt = dateOrNull(row.startedAt || meta.startedAt) || rowTs;
  const endedAt = isCanonicalKind(row, "COVERAGE_ENDED")
    ? (dateOrNull(row.endedAt || meta.endedAt) || rowTs)
    : null;
  const durationSeconds = endedAt ? secondsBetween(startedAt, endedAt) : null;
  const startReason = clean(meta.startReason || meta.reason || null, 120);
  const endReason = isCanonicalKind(row, "COVERAGE_ENDED") ? clean(meta.endReason || meta.reason || null, 120) : null;

  const data = {
    agencyId,
    creatorId,
    memberId,
    userId: clean(row.userId, 160),
    deviceId: clean(row.deviceId, 160),
    coverageId,
    startedAt,
    endedAt,
    durationSeconds,
    startReason,
    endReason,
    source: "team_v13",
  };

  const existing = await db.teamCoverageSession.findUnique({
    where: { agencyId_coverageId: { agencyId, coverageId } },
  });
  if (!existing) {
    return db.teamCoverageSession.create({ data });
  }

  const nextEndedAt = endedAt || existing.endedAt || null;
  return db.teamCoverageSession.update({
    where: { id: existing.id },
    data: {
      creatorId: existing.creatorId || creatorId,
      memberId: existing.memberId || memberId,
      userId: existing.userId || data.userId,
      deviceId: existing.deviceId || data.deviceId,
      startedAt: existing.startedAt && existing.startedAt <= startedAt ? existing.startedAt : startedAt,
      endedAt: nextEndedAt,
      durationSeconds: nextEndedAt ? secondsBetween(existing.startedAt && existing.startedAt <= startedAt ? existing.startedAt : startedAt, nextEndedAt) : existing.durationSeconds,
      startReason: existing.startReason || startReason,
      endReason: endReason || existing.endReason,
    },
  });
}

async function upsertDialogSession(row, db = prisma) {
  if (!isCanonicalKind(row, "DIALOG_SESSION")) return null;
  const agencyId = clean(row.agencyId, 160);
  const creatorId = clean(row.creatorId, 160);
  const memberId = clean(row.memberId, 160);
  const dialogId = clean(row.dialogId || row.fanId, 160);
  const sessionId = clean(row.correlationId || row.localId, 220);
  const startedAt = dateOrNull(row.startedAt);
  const endedAt = dateOrNull(row.endedAt || row.ts);
  if (!agencyId || !creatorId || !memberId || !dialogId || !sessionId || !startedAt || !endedAt) return null;

  const meta = metadataOf(row);
  const wallSeconds = Math.max(0, Number(meta.wallSeconds ?? secondsBetween(startedAt, endedAt) ?? 0) || 0);
  const activeSeconds = Math.max(0, Number(meta.activeSeconds ?? row.durationSeconds ?? 0) || 0);
  const activityEvents = Math.max(0, Math.round(Number(meta.activityEvents ?? 0) || 0));
  const seenAt = dateOrNull(meta.seenAt);
  const endReason = clean(meta.endReason || meta.reason || null, 120);
  const coverageId = clean(row.coverageId || meta.coverageId || null, 220);

  return db.teamDialogSession.upsert({
    where: { agencyId_sessionId: { agencyId, sessionId } },
    create: {
      agencyId,
      creatorId,
      memberId,
      userId: clean(row.userId, 160),
      deviceId: clean(row.deviceId, 160),
      dialogId,
      fanId: clean(row.fanId || dialogId, 160),
      sessionId,
      coverageId,
      startedAt,
      endedAt,
      wallSeconds,
      activeSeconds,
      seenAt,
      activityEvents,
      endReason,
      source: "team_v13",
    },
    update: {
      endedAt,
      wallSeconds,
      activeSeconds,
      seenAt,
      activityEvents,
      endReason,
      coverageId,
    },
  });
}

async function findPreviousManualReply({ agencyId, creatorId, dialogId, replyAt, replyMessageId, db }) {
  const row = await db.teamSentMessageLedger.findFirst({
    where: {
      agencyId,
      creatorId,
      dialogId,
      sentAt: { lt: replyAt },
      source: { in: ["manual", "manual_chat"] },
      ...(replyMessageId ? { NOT: { messageId: replyMessageId } } : {}),
    },
    orderBy: { sentAt: "desc" },
  });
  return row || null;
}

async function findIncomingEpisode({ agencyId, creatorId, dialogId, fromExclusive, replyAt, db }) {
  const floor = new Date(Math.max(replyAt.getTime() - RESPONSE_LOOKBACK_MS, fromExclusive?.getTime?.() || 0));
  const rows = await db.teamActivityEvent.findMany({
    where: {
      agencyId,
      creatorId,
      dialogId,
      eventKind: "FAN_MESSAGE_RECEIVED",
      ts: {
        gt: floor,
        lte: replyAt,
      },
    },
    orderBy: { ts: "asc" },
  });
  return Array.isArray(rows) ? rows : [];
}

async function findCoverageAt({ agencyId, creatorId, memberId, at, db }) {
  return db.teamCoverageSession.findFirst({
    where: {
      agencyId,
      creatorId,
      memberId,
      startedAt: {
        lte: at,
        gte: new Date(at.getTime() - MAX_OPEN_COVERAGE_MS),
      },
      OR: [{ endedAt: null }, { endedAt: { gte: at } }],
    },
    orderBy: { startedAt: "desc" },
  });
}

async function findCoverageStartedAfter({ agencyId, creatorId, memberId, after, before, db }) {
  return db.teamCoverageSession.findFirst({
    where: {
      agencyId,
      creatorId,
      memberId,
      startedAt: { gt: after, lte: before },
    },
    orderBy: { startedAt: "asc" },
  });
}

async function findOtherCoverageAt({ agencyId, creatorId, memberId, at, db }) {
  return db.teamCoverageSession.findFirst({
    where: {
      agencyId,
      creatorId,
      memberId: { not: memberId },
      startedAt: {
        lte: at,
        gte: new Date(at.getTime() - MAX_OPEN_COVERAGE_MS),
      },
      OR: [{ endedAt: null }, { endedAt: { gte: at } }],
    },
    orderBy: { startedAt: "desc" },
  });
}

async function findSeenAt({ agencyId, creatorId, dialogId, memberId, incomingAt, replyAt, db }) {
  const row = await db.teamActivityEvent.findFirst({
    where: {
      agencyId,
      creatorId,
      dialogId,
      memberId,
      eventKind: "DIALOG_SEEN",
      ts: { gte: incomingAt, lte: replyAt },
    },
    orderBy: { ts: "asc" },
  });
  return dateOrNull(row?.ts);
}

async function deriveResponseCaseForReply(reply, db = prisma) {
  const agencyId = clean(reply?.agencyId, 160);
  const creatorId = clean(reply?.creatorId, 160);
  const memberId = clean(reply?.memberId, 160);
  const dialogId = clean(reply?.dialogId || reply?.fanId, 160);
  const replyMessageId = clean(reply?.messageId, 220);
  const replyAt = dateOrNull(reply?.sentAt || reply?.ts);
  if (!agencyId || !creatorId || !memberId || !dialogId || !replyMessageId || !replyAt || !sourceIsManual(reply?.source || reply?.actionSource)) {
    return null;
  }

  const previousReply = await findPreviousManualReply({ agencyId, creatorId, dialogId, replyAt, replyMessageId, db });
  const incoming = await findIncomingEpisode({
    agencyId,
    creatorId,
    dialogId,
    fromExclusive: previousReply?.sentAt || null,
    replyAt,
    db,
  });
  if (!incoming.length) {
    if (db.teamResponseCase?.deleteMany) {
      await db.teamResponseCase.deleteMany({ where: { agencyId, replyMessageId } });
    }
    return null;
  }

  const firstIncoming = incoming[0];
  const lastIncoming = incoming[incoming.length - 1];
  const incomingAt = dateOrNull(firstIncoming.ts);
  const lastIncomingAt = dateOrNull(lastIncoming.ts) || incomingAt;
  if (!incomingAt) return null;

  const [coverageAtIncoming, coverageAfterIncoming, otherCoverageAtIncoming, seenAt] = await Promise.all([
    findCoverageAt({ agencyId, creatorId, memberId, at: incomingAt, db }),
    findCoverageStartedAfter({ agencyId, creatorId, memberId, after: incomingAt, before: replyAt, db }),
    findOtherCoverageAt({ agencyId, creatorId, memberId, at: incomingAt, db }),
    findSeenAt({ agencyId, creatorId, dialogId, memberId, incomingAt, replyAt, db }),
  ]);

  let classification = "UNKNOWN";
  let coverage = coverageAtIncoming || coverageAfterIncoming || null;
  if (coverageAtIncoming) classification = "FRESH";
  else if (otherCoverageAtIncoming) classification = "HANDOFF";
  else if (coverageAfterIncoming || seenAt) classification = "BACKLOG";

  const wallClockSeconds = secondsBetween(incomingAt, replyAt) ?? 0;
  const coverageStartedAt = dateOrNull(coverage?.startedAt);
  const coverageEffectiveStart = coverageStartedAt && coverageStartedAt > incomingAt ? coverageStartedAt : incomingAt;
  const coverageResponseSeconds = coverage ? secondsBetween(coverageEffectiveStart, replyAt) : null;
  const seenResponseSeconds = seenAt ? secondsBetween(seenAt, replyAt) : null;
  const slaEligible = classification === "FRESH";

  const data = {
    agencyId,
    creatorId,
    memberId,
    dialogId,
    fanId: clean(reply.fanId || firstIncoming.fanId || dialogId, 160),
    replyMessageId,
    firstIncomingMessageId: clean(firstIncoming.messageId, 220),
    incomingCount: incoming.length,
    incomingAt,
    lastIncomingAt,
    replyAt,
    seenAt,
    coverageId: clean(coverage?.coverageId, 220),
    coverageStartedAt,
    handoffFromMemberId: clean(otherCoverageAtIncoming?.memberId, 160),
    classification,
    wallClockSeconds,
    coverageResponseSeconds,
    seenResponseSeconds,
    slaEligible,
    sla5Pass: slaEligible ? wallClockSeconds <= 5 * 60 : null,
    sla15Pass: slaEligible ? wallClockSeconds <= 15 * 60 : null,
    derivationVersion: RESPONSE_DERIVATION_VERSION,
  };

  return db.teamResponseCase.upsert({
    where: { agencyId_replyMessageId: { agencyId, replyMessageId } },
    create: data,
    update: data,
  });
}

async function findReplyLedgerByEvent(row, db) {
  const agencyId = clean(row?.agencyId, 160);
  const messageId = clean(row?.messageId, 220);
  if (!agencyId || !messageId) return null;
  return db.teamSentMessageLedger.findFirst({ where: { agencyId, messageId } });
}

async function recomputeNextReplyForObservation(row, db = prisma) {
  const agencyId = clean(row?.agencyId, 160);
  const creatorId = clean(row?.creatorId, 160);
  const dialogId = clean(row?.dialogId || row?.fanId, 160);
  const after = dateOrNull(row?.ts);
  if (!agencyId || !creatorId || !dialogId || !after) return null;
  const reply = await db.teamSentMessageLedger.findFirst({
    where: {
      agencyId,
      creatorId,
      dialogId,
      source: { in: ["manual", "manual_chat"] },
      sentAt: { gte: after, lte: new Date(after.getTime() + RESPONSE_LOOKBACK_MS) },
    },
    orderBy: { sentAt: "asc" },
  });
  return reply ? deriveResponseCaseForReply(reply, db) : null;
}

async function recomputeRepliesForCoverage(session, db = prisma) {
  if (!session?.agencyId || !session?.creatorId || !session?.memberId || !session?.startedAt) return 0;
  const upper = session.endedAt || new Date(session.startedAt.getTime() + 12 * 60 * 60 * 1000);
  const replies = await db.teamSentMessageLedger.findMany({
    where: {
      agencyId: session.agencyId,
      creatorId: session.creatorId,
      memberId: session.memberId,
      source: { in: ["manual", "manual_chat"] },
      sentAt: { gte: session.startedAt, lte: upper },
    },
    orderBy: { sentAt: "asc" },
  });
  let count = 0;
  for (const reply of replies || []) {
    await deriveResponseCaseForReply(reply, db);
    count += 1;
  }
  return count;
}

async function applyTeamResponseProjection(row, db = prisma) {
  if (!row?.eventKind) return null;
  const kind = String(row.eventKind).toUpperCase();

  if (kind === "COVERAGE_STARTED" || kind === "COVERAGE_ENDED") {
    const session = await upsertCoverageSession(row, db);
    if (session) await recomputeRepliesForCoverage(session, db);
    return session;
  }

  if (kind === "DIALOG_SESSION") {
    return upsertDialogSession(row, db);
  }

  if (isManualConfirmed(row)) {
    const ledger = await findReplyLedgerByEvent(row, db);
    return ledger ? deriveResponseCaseForReply(ledger, db) : null;
  }

  if (kind === "FAN_MESSAGE_RECEIVED" || kind === "DIALOG_SEEN") {
    return recomputeNextReplyForObservation(row, db);
  }

  return null;
}

module.exports = {
  RESPONSE_DERIVATION_VERSION,
  deriveResponseCaseForReply,
  upsertCoverageSession,
  upsertDialogSession,
  applyTeamResponseProjection,
};
