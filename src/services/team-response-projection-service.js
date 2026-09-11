"use strict";

const prisma = require("../prisma");
const { runDbTransaction, lockDbAdvisoryXact } = require("./db-transaction-service");
const { canonicalReplyEventId } = require("./team-event-order-authority");

const RESPONSE_DERIVATION_VERSION = "team_response_v2";
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

async function upsertCoverageSessionUnlocked(row, db = prisma) {
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


function coverageSessionFenceKey(row) {
  const agencyId = clean(row?.agencyId, 160);
  const coverageId = clean(row?.coverageId || row?.correlationId || row?.localId, 220);
  if (!agencyId || !coverageId) return null;
  return `team-coverage:${agencyId}:${coverageId}`;
}

async function upsertCoverageSession(row, db = prisma) {
  const fenceKey = coverageSessionFenceKey(row);
  if (!fenceKey) return upsertCoverageSessionUnlocked(row, db);
  return runDbTransaction(db, async (tx) => {
    // COVERAGE_STARTED and COVERAGE_ENDED are separate canonical events and can be
    // claimed by different replicas. Serialize their read/merge/write cycle by the
    // stable coverage identity so a late START cannot erase a committed END.
    if (typeof tx?.$executeRawUnsafe === "function") {
      await lockDbAdvisoryXact({ db: tx, key: fenceKey, mode: "exclusive" });
    }
    return upsertCoverageSessionUnlocked(row, tx);
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

async function findPreviousManualReply({ agencyId, creatorId, dialogId, replyAt, replyMessageId, replyLedgerId = null, replyEventId = null, db }) {
  const stableLedgerId = clean(replyLedgerId, 220);
  // Reply-family order is always (sentAt, ledger id). telemetryEventId is only
  // the bridge for cross-family incoming<->reply comparison. Mixing the two
  // identities here can skip historical same-time replies with no bridge.
  const sameInstantClause = stableLedgerId ? { sentAt: replyAt, id: { lt: stableLedgerId } } : null;
  const row = await db.teamSentMessageLedger.findFirst({
    where: {
      agencyId, creatorId, dialogId, source: { in: ["manual", "manual_chat"] },
      OR: [{ sentAt: { lt: replyAt } }, ...(sameInstantClause ? [sameInstantClause] : [])],
      ...(replyMessageId ? { NOT: { messageId: replyMessageId } } : {}),
    },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
  });
  return row || null;
}

async function findIncomingAtBoundary({ agencyId, creatorId, dialogId, at, db }) {
  at = dateOrNull(at);
  if (!at || !db?.teamActivityEvent?.findFirst) return null;
  const row = await db.teamActivityEvent.findFirst({
    where: { agencyId, creatorId, dialogId, eventKind: "FAN_MESSAGE_RECEIVED", ts: at },
    orderBy: [{ id: "asc" }],
  });
  return dateOrNull(row?.ts)?.getTime?.() === at.getTime() ? row : null;
}

async function writeCrossFamilyOrderIncomplete({ reply, sample, db, reason = "CROSS_FAMILY_ORDER_UNPROVEN" }) {
  const agencyId = clean(reply?.agencyId, 160); const creatorId = clean(reply?.creatorId, 160);
  const memberId = clean(reply?.memberId, 160); const dialogId = clean(reply?.dialogId || reply?.fanId, 160);
  const replyMessageId = clean(reply?.messageId, 220); const replyAt = dateOrNull(reply?.sentAt || reply?.ts);
  if (!agencyId || !creatorId || !memberId || !dialogId || !replyMessageId || !replyAt) return null;
  const existing = await db.teamResponseCase.findUnique?.({ where: { agencyId_creatorId_replyMessageId: { agencyId, creatorId, replyMessageId } } });
  if (existing) {
    return db.teamResponseCase.update({
      where: { id: existing.id },
      data: {
        derivationVersion: RESPONSE_DERIVATION_VERSION,
        projectionRevision: BigInt(existing.projectionRevision || 0) + 1n,
        projectionState: "INCOMPLETE_HISTORY", repairReason: reason,
        slaEligible: false, sla5Pass: null, sla15Pass: null,
      },
    });
  }
  const incomingAt = dateOrNull(sample?.ts) || replyAt;
  return db.teamResponseCase.upsert({
    where: { agencyId_creatorId_replyMessageId: { agencyId, creatorId, replyMessageId } },
    create: {
      agencyId, creatorId, memberId, dialogId, fanId: clean(reply?.fanId || sample?.fanId || dialogId, 160),
      replyMessageId, firstIncomingMessageId: clean(sample?.messageId, 220), incomingCount: 1,
      incomingAt, lastIncomingAt: incomingAt, replyAt, seenAt: null, coverageId: null, coverageStartedAt: null,
      handoffFromMemberId: null, classification: "UNKNOWN", wallClockSeconds: Math.max(0, secondsBetween(incomingAt, replyAt) || 0),
      coverageResponseSeconds: null, seenResponseSeconds: null, slaEligible: false, sla5Pass: null, sla15Pass: null,
      derivationVersion: RESPONSE_DERIVATION_VERSION, projectionRevision: 1n,
      projectionState: "INCOMPLETE_HISTORY", repairReason: reason,
    },
    update: {
      derivationVersion: RESPONSE_DERIVATION_VERSION, projectionState: "INCOMPLETE_HISTORY", repairReason: reason,
      slaEligible: false, sla5Pass: null, sla15Pass: null,
    },
  });
}

async function findIncomingEpisode({ agencyId, creatorId, dialogId, fromExclusive, fromExclusiveEventId = null, replyAt, replyEventId = null, db }) {
  const lookbackFloor = new Date(Math.max(0, replyAt.getTime() - RESPONSE_LOOKBACK_MS));
  const previousAt = dateOrNull(fromExclusive);
  const floor = previousAt && previousAt > lookbackFloor ? previousAt : lookbackFloor;
  const floorEventId = previousAt && floor.getTime() === previousAt.getTime() ? clean(fromExclusiveEventId, 220) : null;
  const upperEventId = clean(replyEventId, 220);
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      WITH dedup AS (
        SELECT DISTINCT ON (COALESCE(NULLIF(e."messageId",''),NULLIF(e."localId",''),e."id"))
               e."id",e."messageId",e."localId",e."fanId",e."ts"
          FROM "TeamActivityEvent" e
         WHERE e."agencyId"=$1 AND e."creatorId"=$2 AND e."dialogId"=$3
           AND e."eventKind"='FAN_MESSAGE_RECEIVED'
           AND (e."ts">$4 OR (e."ts"=$4 AND $5::text IS NOT NULL AND e."id">$5))
           AND (e."ts"<$6 OR (e."ts"=$6 AND $7::text IS NOT NULL AND e."id"<$7))
         ORDER BY COALESCE(NULLIF(e."messageId",''),NULLIF(e."localId",''),e."id"),e."ts" ASC,e."id" ASC
      ), ranked AS (
        SELECT d.*,row_number() OVER (ORDER BY d."ts",d."id") AS rn_first,
               row_number() OVER (ORDER BY d."ts" DESC,d."id" DESC) AS rn_last,
               count(*) OVER () AS total FROM dedup d
      )
      SELECT "id","messageId","localId","fanId","ts","total"
        FROM ranked WHERE rn_first=1 OR rn_last=1 ORDER BY "ts","id"`,
      agencyId, creatorId, dialogId, floor, floorEventId, replyAt, upperEventId);
    const out = (rows || []).map((row) => ({ id: row.id, messageId: row.messageId, localId: row.localId, fanId: row.fanId, ts: row.ts }));
    out.episodeCount = Number(rows?.[0]?.total || 0);
    return out;
  }
  const lowerOr = [{ ts: { gt: floor } }];
  if (floorEventId) lowerOr.push({ ts: floor, id: { gt: floorEventId } });
  const upperOr = [{ ts: { lt: replyAt } }];
  if (upperEventId) upperOr.push({ ts: replyAt, id: { lt: upperEventId } });
  const rows = await db.teamActivityEvent.findMany({
    where: {
      agencyId, creatorId, dialogId, eventKind: "FAN_MESSAGE_RECEIVED",
      ...(!floorEventId && !upperEventId
        ? { ts: { gt: floor, lt: replyAt } }
        : { AND: [{ OR: lowerOr }, { OR: upperOr }] }),
    },
    orderBy: [{ ts: "asc" }, { id: "asc" }],
  });
  const out = []; const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = clean(row?.messageId, 220) || clean(row?.localId, 220) || clean(row?.id, 220);
    if (key && seen.has(key)) continue; if (key) seen.add(key); out.push(row);
  }
  out.episodeCount = out.length;
  return out;
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
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
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
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
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
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
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
    orderBy: [{ ts: "asc" }, { id: "asc" }],
  });
  return dateOrNull(row?.ts);
}

async function deriveResponseCaseForReplyUnlocked(reply, db = prisma, options = {}) {
  const agencyId = clean(reply?.agencyId, 160);
  const creatorId = clean(reply?.creatorId, 160);
  const memberId = clean(reply?.memberId, 160);
  const dialogId = clean(reply?.dialogId || reply?.fanId, 160);
  const replyMessageId = clean(reply?.messageId, 220);
  const replyAt = dateOrNull(reply?.sentAt || reply?.ts);
  if (!agencyId || !creatorId || !memberId || !dialogId || !replyMessageId || !replyAt || !sourceIsManual(reply?.source || reply?.actionSource)) {
    return null;
  }

  const replyEventId = canonicalReplyEventId(reply);
  const previousReply = await findPreviousManualReply({
    agencyId, creatorId, dialogId, replyAt, replyMessageId, replyLedgerId: clean(reply?.id, 220), replyEventId, db,
  });
  const previousReplyEventId = canonicalReplyEventId(previousReply);

  // Timestamp alone cannot order two different canonical event families. Modern
  // ledgers bridge to TeamActivityEvent through telemetryEventId. Historical rows
  // without that bridge fail explicit INCOMPLETE_HISTORY if an equal-time incoming
  // makes the boundary genuinely ambiguous.
  if (!replyEventId) {
    const sample = await findIncomingAtBoundary({ agencyId, creatorId, dialogId, at: replyAt, db });
    if (sample) return writeCrossFamilyOrderIncomplete({ reply, sample, db });
  }
  if (previousReply?.sentAt && !previousReplyEventId) {
    const sample = await findIncomingAtBoundary({ agencyId, creatorId, dialogId, at: previousReply.sentAt, db });
    if (sample) return writeCrossFamilyOrderIncomplete({ reply, sample, db });
  }

  const incoming = await findIncomingEpisode({
    agencyId, creatorId, dialogId,
    fromExclusive: previousReply?.sentAt || null, fromExclusiveEventId: previousReplyEventId,
    replyAt, replyEventId, db,
  });
  if (!incoming.length) {
    if (db.teamResponseCase?.findUnique && db.teamResponseCase?.update) {
      const existing = await db.teamResponseCase.findUnique({
        where: { agencyId_creatorId_replyMessageId: { agencyId, creatorId, replyMessageId } },
      });
      if (existing) {
        const preserve = options?.preserveOnMissingHistory === true;
        return db.teamResponseCase.update({
          where: { id: existing.id },
          data: {
            derivationVersion: RESPONSE_DERIVATION_VERSION,
            projectionRevision: BigInt(existing.projectionRevision || 0) + 1n,
            projectionState: preserve ? "INCOMPLETE_HISTORY" : "RETIRED",
            repairReason: preserve ? "RAW_EPISODE_EVIDENCE_MISSING" : "NO_INCOMING_EPISODE",
          },
        });
      }
    }
    // Reduced pre-Phase2 test adapters may not expose revisioned update support.
    // Production never physically deletes a response root from the projection path;
    // retention owns destructive compaction after the consumer watermark.
    if (!db.teamResponseCase?.findUnique && db.teamResponseCase?.deleteMany) {
      await db.teamResponseCase.deleteMany({ where: { agencyId, creatorId, replyMessageId } });
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
    incomingCount: Math.max(1, Number(incoming.episodeCount || incoming.length)),
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
    projectionRevision: 1n,
    projectionState: "FULL",
    repairReason: null,
  };

  const existingCase = await db.teamResponseCase.findUnique?.({ where: { agencyId_creatorId_replyMessageId: { agencyId, creatorId, replyMessageId } } });
  if (existingCase?.projectionRevision != null) data.projectionRevision = BigInt(existingCase.projectionRevision || 0) + 1n;
  return db.teamResponseCase.upsert({
    where: { agencyId_creatorId_replyMessageId: { agencyId, creatorId, replyMessageId } },
    create: data,
    update: data,
  });
}


function responseDialogFenceKey(reply) {
  const agencyId = clean(reply?.agencyId, 160);
  const creatorId = clean(reply?.creatorId, 160);
  const dialogId = clean(reply?.dialogId || reply?.fanId, 160);
  if (!agencyId || !creatorId || !dialogId) return null;
  return `team-response:${agencyId}:${creatorId}:${dialogId}`;
}

async function deriveResponseCaseForReply(reply, db = prisma, options = {}) {
  const fenceKey = responseDialogFenceKey(reply);
  if (!fenceKey) return deriveResponseCaseForReplyUnlocked(reply, db, options);
  return runDbTransaction(db, async (tx) => {
    // Inline/current-dialog projection and background range repair must share one
    // commit authority. A worker that derived an older episode cannot overwrite a
    // newer response case after another repair has already committed.
    if (typeof tx?.$executeRawUnsafe === "function") {
      await lockDbAdvisoryXact({ db: tx, key: fenceKey, mode: "exclusive" });
    }
    return deriveResponseCaseForReplyUnlocked(reply, tx, options);
  });
}

async function repairHistoricalResponseCase({ row, db = prisma, agencyId = null } = {}) {
  const scopedAgencyId = clean(agencyId || row?.agencyId, 160);
  const creatorId = clean(row?.creatorId, 160);
  const dialogId = clean(row?.dialogId, 160);
  const replyMessageId = clean(row?.replyMessageId, 220);
  const rowId = clean(row?.id, 220);
  if (!scopedAgencyId || !creatorId || !dialogId || !replyMessageId || !rowId) {
    return { projectionState: "INCOMPLETE_HISTORY", skippedCurrent: true, reason: "RESPONSE_REPAIR_IDENTITY_INCOMPLETE" };
  }

  return runDbTransaction(db, async (tx) => {
    const fenceKey = responseDialogFenceKey({ agencyId: scopedAgencyId, creatorId, dialogId });
    if (fenceKey && typeof tx?.$executeRawUnsafe === "function") {
      await lockDbAdvisoryXact({ db: tx, key: fenceKey, mode: "exclusive" });
    }

    // The enumerator selected NEEDS_REPAIR before this transaction. Re-read after
    // acquiring the same dialog authority as live derivation; a newer FULL repair
    // must never be downgraded by a stale historical page.
    const current = await tx.teamResponseCase.findUnique?.({
      where: { agencyId_creatorId_replyMessageId: { agencyId: scopedAgencyId, creatorId, replyMessageId } },
    });
    if (!current || String(current.projectionState || "") !== "NEEDS_REPAIR") {
      return { projectionState: current?.projectionState || null, skippedCurrent: true, current };
    }

    const ledger = await tx.teamSentMessageLedger.findFirst({
      where: { agencyId: scopedAgencyId, creatorId, messageId: replyMessageId },
    });
    if (ledger) return deriveResponseCaseForReplyUnlocked(ledger, tx, { preserveOnMissingHistory: true });

    return tx.teamResponseCase.update({
      where: { id: current.id },
      data: {
        derivationVersion: RESPONSE_DERIVATION_VERSION,
        projectionRevision: BigInt(current.projectionRevision || 0) + 1n,
        projectionState: "INCOMPLETE_HISTORY",
        repairReason: "REPLY_LEDGER_EVIDENCE_MISSING",
      },
    });
  });
}

async function backfillTeamResponseRangeBatch({ db = prisma, agencyId, cursor = null, limit = 100 } = {}) {
  const scopedAgencyId = clean(agencyId, 160);
  if (!scopedAgencyId) {
    const error = new Error("TEAM_RESPONSE_REPAIR_AGENCY_REQUIRED");
    error.code = "TEAM_RESPONSE_REPAIR_AGENCY_REQUIRED";
    throw error;
  }
  if (!db?.teamResponseCase?.findMany || !db?.teamResponseCase?.update || !db?.teamSentMessageLedger?.findFirst) {
    const error = new Error("TEAM_RESPONSE_REPAIR_STORAGE_REQUIRED");
    error.code = "TEAM_RESPONSE_REPAIR_STORAGE_REQUIRED";
    throw error;
  }
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  const afterId = clean(cursor, 220);
  const rows = await db.teamResponseCase.findMany({
    where: {
      agencyId: scopedAgencyId,
      projectionState: "NEEDS_REPAIR",
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: "asc" },
    take: boundedLimit,
  });

  let repaired = 0;
  let unresolved = 0;
  for (const row of rows || []) {
    const result = await repairHistoricalResponseCase({ row, db, agencyId: scopedAgencyId });
    if (result?.skippedCurrent) continue;
    if (result?.projectionState === "FULL") repaired += 1;
    else unresolved += 1;
  }

  const nextCursor = rows?.length ? String(rows[rows.length - 1].id) : (afterId || null);
  return {
    ok: true,
    selected: Number(rows?.length || 0),
    repaired,
    unresolved,
    nextCursor,
    complete: Number(rows?.length || 0) < boundedLimit,
  };
}

async function findReplyLedgerByEvent(row, db) {
  const agencyId = clean(row?.agencyId, 160);
  const creatorId = clean(row?.creatorId, 160);
  const accountId = clean(row?.accountId, 180);
  const messageId = clean(row?.messageId, 220);
  if (!agencyId || !messageId || (!creatorId && !accountId)) return null;
  return db.teamSentMessageLedger.findFirst({
    where: { agencyId, messageId, ...(creatorId ? { creatorId } : { accountId }) },
  });
}

async function recomputeNextReplyForObservation(row, db = prisma) {
  const agencyId = clean(row?.agencyId, 160); const creatorId = clean(row?.creatorId, 160);
  const dialogId = clean(row?.dialogId || row?.fanId, 160); const after = dateOrNull(row?.ts);
  const eventId = clean(row?.id, 220);
  if (!agencyId || !creatorId || !dialogId || !after || !eventId) return null;
  const upper = new Date(after.getTime() + RESPONSE_LOOKBACK_MS);

  // A historical reply without telemetryEventId at exactly the incoming timestamp
  // is not comparable across families. Derive it explicitly as incomplete rather
  // than silently skipping it in favor of a later reply.
  const ambiguous = await db.teamSentMessageLedger.findFirst({
    where: { agencyId, creatorId, dialogId, source: { in: ["manual", "manual_chat"] }, sentAt: after, telemetryEventId: null },
    orderBy: [{ id: "asc" }],
  });
  if (ambiguous) return deriveResponseCaseForReply(ambiguous, db);

  const reply = await db.teamSentMessageLedger.findFirst({
    where: {
      agencyId, creatorId, dialogId, source: { in: ["manual", "manual_chat"] },
      OR: [{ sentAt: { gt: after, lte: upper } }, { sentAt: after, telemetryEventId: { gt: eventId } }],
    },
    orderBy: [{ sentAt: "asc" }, { telemetryEventId: { sort: "asc", nulls: "last" } }, { id: "asc" }],
  });
  return reply ? deriveResponseCaseForReply(reply, db) : null;
}

async function recomputeSuccessorReply(reply, db = prisma) {
  const agencyId = clean(reply?.agencyId,160); const creatorId = clean(reply?.creatorId,160);
  const dialogId = clean(reply?.dialogId || reply?.fanId,160); const sentAt = dateOrNull(reply?.sentAt);
  if (!agencyId || !creatorId || !dialogId || !sentAt) return null;
  const stableId = clean(reply?.id, 220);
  const upper = new Date(sentAt.getTime() + RESPONSE_LOOKBACK_MS);
  const sameInstant = stableId ? { sentAt, id: { gt: stableId } } : null;
  const successor = await db.teamSentMessageLedger.findFirst({
    where: {
      agencyId, creatorId, dialogId, source: { in: ["manual","manual_chat"] },
      OR: [{ sentAt: { gt: sentAt, lte: upper } }, ...(sameInstant ? [sameInstant] : [])],
    },
    orderBy: [{ sentAt: "asc" }, { id: "asc" }],
  });
  return successor ? deriveResponseCaseForReply(successor, db) : null;
}

async function recomputeRepliesForCoverage(session, db = prisma) {
  if (!session?.agencyId || !session?.creatorId || !session?.memberId || !session?.startedAt) return 0;
  const coverageEnd = session.endedAt || new Date(session.startedAt.getTime() + 12 * 60 * 60 * 1000);
  const upper = new Date(coverageEnd.getTime() + RESPONSE_LOOKBACK_MS);
  const lower = new Date(Math.max(0, session.startedAt.getTime() - RESPONSE_LOOKBACK_MS));
  const replies = await db.teamSentMessageLedger.findMany({
    where: {
      agencyId: session.agencyId,
      creatorId: session.creatorId,
      source: { in: ["manual", "manual_chat"] },
      sentAt: { gte: lower, lte: upper },
    },
    orderBy: [{ sentAt: "asc" }, { id: "asc" }],
  });
  let count = 0;
  for (const reply of replies || []) {
    await deriveResponseCaseForReply(reply, db);
    count += 1;
  }
  return count;
}


async function repairResponseCasesForCoverageEvent({ coverage, db = prisma, cursor = null, limit = 100 } = {}) {
  const agencyId = clean(coverage?.agencyId, 160); const creatorId = clean(coverage?.creatorId, 160);
  const startedAt = dateOrNull(coverage?.startedAt);
  if (!agencyId || !creatorId || !startedAt) return { ok: true, complete: true, repaired: 0, nextCursor: null };
  const endedAt = dateOrNull(coverage?.endedAt) || new Date(startedAt.getTime() + MAX_OPEN_COVERAGE_MS);
  const lower = new Date(Math.max(0, startedAt.getTime() - RESPONSE_LOOKBACK_MS));
  const upper = new Date(endedAt.getTime() + RESPONSE_LOOKBACK_MS);
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
  const afterId = clean(cursor, 220);
  const rows = await db.teamSentMessageLedger.findMany({
    where: { agencyId, creatorId, source: { in: ["manual","manual_chat"] }, sentAt: { gte: lower, lte: upper }, ...(afterId ? { id: { gt: afterId } } : {}) },
    orderBy: { id: "asc" }, take,
  });
  let repaired = 0;
  for (const reply of rows || []) { await deriveResponseCaseForReply(reply, db, { preserveOnMissingHistory: true }); repaired += 1; }
  const nextCursor = rows?.length ? String(rows[rows.length - 1].id) : (afterId || null);
  return { ok: true, complete: Number(rows?.length || 0) < take, hasMore: Number(rows?.length || 0) >= take, repaired, nextCursor };
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
    if (!ledger) return null;
    const current = await deriveResponseCaseForReply(ledger, db);
    await recomputeSuccessorReply(ledger, db);
    return current;
  }

  if (kind === "FAN_MESSAGE_RECEIVED" || kind === "DIALOG_SEEN") {
    return recomputeNextReplyForObservation(row, db);
  }

  return null;
}

module.exports = {
  RESPONSE_DERIVATION_VERSION,
  deriveResponseCaseForReply,
  repairHistoricalResponseCase,
  backfillTeamResponseRangeBatch,
  upsertCoverageSession,
  upsertDialogSession,
  repairResponseCasesForCoverageEvent,
  applyTeamResponseProjection,
};
