"use strict";

const prisma = require("../prisma");
const { runDbTransaction, lockDbAdvisoryXact } = require("./db-transaction-service");
const { canonicalReplyEventId, compareCanonicalEventOrder, replyBoundary, sameReplyBoundary } = require("./team-event-order-authority");

const PENDING_DERIVATION_VERSION = "team_pending_v2";
const RELEVANT_EVENT_KINDS = new Set(["FAN_MESSAGE_RECEIVED", "DIALOG_SEEN", "MESSAGE_SEND_CONFIRMED"]);
const MANUAL_SOURCES = ["manual", "manual_chat"];
const PENDING_REPAIR_CURSOR_VERSION = "team_pending_repair_v1";
const PENDING_REPAIR_BATCH_LIMIT = 100;

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

function kindOf(row) {
  return String(row?.eventKind || "").trim().toUpperCase();
}

function isManualConfirmed(row) {
  return kindOf(row) === "MESSAGE_SEND_CONFIRMED"
    && String(row?.actionSource || "").trim().toUpperCase() === "MANUAL"
    && String(row?.lifecycle || "").trim().toUpperCase() === "CONFIRMED";
}

function eventIdentity(row) {
  return clean(row?.messageId, 220) || clean(row?.localId, 220) || clean(row?.id, 220);
}

function incomingIdentity(row) {
  return clean(row?.messageId, 220) || clean(row?.localId, 220) || clean(row?.id, 220);
}

function dedupeIncoming(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = incomingIdentity(row) || `${new Date(row?.ts || 0).getTime()}|${clean(row?.fanId || row?.dialogId, 160) || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  out.sort((a, b) => {
    const delta = new Date(a?.ts || 0).getTime() - new Date(b?.ts || 0).getTime();
    if (delta) return delta;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
  return out;
}

function dedupeSeen(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const memberId = clean(row?.memberId, 160);
    if (!memberId) continue;
    const key = clean(row?.localId, 220) || clean(row?.id, 220) || `${memberId}|${new Date(row?.ts || 0).getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  out.sort((a, b) => {
    const delta = new Date(a?.ts || 0).getTime() - new Date(b?.ts || 0).getTime();
    if (delta) return delta;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
  return out;
}

async function latestManualReply({ agencyId, creatorId, dialogId, db = prisma }) {
  return db.teamSentMessageLedger.findFirst({
    where: {
      agencyId,
      creatorId,
      dialogId,
      source: { in: MANUAL_SOURCES },
    },
    // Reply-to-reply chronology stays on the durable ledger identity.
    // telemetryEventId is used only when a reply must be compared to TeamActivityEvent.
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
  });
}

async function loadIncomingAfter({ agencyId, creatorId, dialogId, after, afterEventId = null, db = prisma }) {
  // Production must not materialize an arbitrarily large unanswered dialog in Node.
  // Return only first/last canonical incoming plus the exact deduped count.
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      WITH dedup AS (
        SELECT DISTINCT ON (COALESCE(NULLIF(e."messageId",''),NULLIF(e."localId",''),e."id"))
               e."id",e."messageId",e."localId",e."fanId",e."ts"
          FROM "TeamActivityEvent" e
         WHERE e."agencyId"=$1 AND e."creatorId"=$2 AND e."dialogId"=$3
           AND e."eventKind"='FAN_MESSAGE_RECEIVED'
           AND ($4::timestamptz IS NULL OR e."ts">$4
                OR (e."ts"=$4 AND $5::text IS NOT NULL AND e."id">$5))
         ORDER BY COALESCE(NULLIF(e."messageId",''),NULLIF(e."localId",''),e."id"),e."ts" ASC,e."id" ASC
      ), ranked AS (
        SELECT d.*, row_number() OVER (ORDER BY d."ts",d."id") AS rn_first,
               row_number() OVER (ORDER BY d."ts" DESC,d."id" DESC) AS rn_last,
               count(*) OVER () AS total
          FROM dedup d
      )
      SELECT "id","messageId","localId","fanId","ts","rn_first","rn_last","total"
        FROM ranked WHERE rn_first=1 OR rn_last=1 ORDER BY "ts" ASC,"id" ASC`,
      agencyId,creatorId,dialogId,after || null,afterEventId || null);
    const out = (rows || []).map((row) => ({ id: row.id, messageId: row.messageId, localId: row.localId, fanId: row.fanId, ts: row.ts }));
    out.episodeCount = Number(rows?.[0]?.total || 0);
    return out;
  }
  const rows = await db.teamActivityEvent.findMany({
    where: {
      agencyId, creatorId, dialogId, eventKind: "FAN_MESSAGE_RECEIVED",
      ...(after ? (afterEventId
        ? { OR: [{ ts: { gt: after } }, { ts: after, id: { gt: afterEventId } }] }
        : { ts: { gt: after } }) : {}),
    },
    orderBy: [{ ts: "asc" }, { id: "asc" }],
  });
  const out = dedupeIncoming(rows);
  out.episodeCount = out.length;
  return out;
}

async function loadSeenAfter({ agencyId, creatorId, dialogId, after, db = prisma }) {
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      WITH dedup AS (
        SELECT DISTINCT ON (COALESCE(NULLIF(e."localId",''),e."id")) e."id",e."localId",e."memberId",e."ts"
          FROM "TeamActivityEvent" e
         WHERE e."agencyId"=$1 AND e."creatorId"=$2 AND e."dialogId"=$3
           AND e."eventKind"='DIALOG_SEEN' AND e."memberId" IS NOT NULL AND e."ts">=$4
         ORDER BY COALESCE(NULLIF(e."localId",''),e."id"),e."ts" ASC,e."id" ASC
      ), ranked AS (
        SELECT d.*,row_number() OVER (ORDER BY d."ts",d."id") AS rn_first,
               row_number() OVER (ORDER BY d."ts" DESC,d."id" DESC) AS rn_last
          FROM dedup d
      )
      SELECT "id","localId","memberId","ts" FROM ranked WHERE rn_first=1 OR rn_last=1 ORDER BY "ts","id"`,
      agencyId,creatorId,dialogId,after);
    return rows || [];
  }
  const rows = await db.teamActivityEvent.findMany({
    where: { agencyId, creatorId, dialogId, eventKind: "DIALOG_SEEN", memberId: { not: null }, ts: { gte: after } },
    orderBy: [{ ts: "asc" }, { id: "asc" }],
  });
  return dedupeSeen(rows);
}


async function findIncomingAtExactBoundary({ agencyId, creatorId, dialogId, at, db = prisma }) {
  at = dateOrNull(at);
  if (!at || !db?.teamActivityEvent?.findFirst) return null;
  return db.teamActivityEvent.findFirst({
    where: { agencyId, creatorId, dialogId, eventKind: "FAN_MESSAGE_RECEIVED", ts: at },
    orderBy: [{ id: "asc" }],
  });
}

function incomingRepairSnapshot(row) {
  if (!row) return null;
  const at = dateOrNull(row.ts);
  return {
    id: clean(row.id, 220),
    messageId: clean(row.messageId, 220),
    localId: clean(row.localId, 220),
    fanId: clean(row.fanId, 160),
    ts: at ? at.toISOString() : null,
  };
}

async function loadIncomingRepairPage({ agencyId, creatorId, dialogId, replyAt = null, replyEventId = null, cursorAt = null, cursorId = null, limit = PENDING_REPAIR_BATCH_LIMIT, db = prisma }) {
  const take = Math.max(1, Math.min(500, Math.floor(Number(limit) || PENDING_REPAIR_BATCH_LIMIT)));
  replyAt = dateOrNull(replyAt);
  cursorAt = dateOrNull(cursorAt);
  replyEventId = clean(replyEventId, 220);
  cursorId = clean(cursorId, 220);
  if (typeof db?.$queryRawUnsafe === "function") {
    return db.$queryRawUnsafe(`
      SELECT e."id",e."messageId",e."localId",e."fanId",e."ts"
        FROM "TeamActivityEvent" e
       WHERE e."agencyId"=$1 AND e."creatorId"=$2 AND e."dialogId"=$3
         AND e."eventKind"='FAN_MESSAGE_RECEIVED'
         AND ($4::timestamptz IS NULL OR e."ts">$4
              OR (e."ts"=$4 AND $5::text IS NOT NULL AND e."id">$5))
         AND ($6::timestamptz IS NULL OR e."ts">$6 OR (e."ts"=$6 AND e."id">$7))
         AND NOT EXISTS (
           SELECT 1 FROM "TeamActivityEvent" prior
            WHERE prior."agencyId"=e."agencyId" AND prior."creatorId"=e."creatorId" AND prior."dialogId"=e."dialogId"
              AND prior."eventKind"='FAN_MESSAGE_RECEIVED'
              AND COALESCE(NULLIF(prior."messageId",''),NULLIF(prior."localId",''),prior."id")
                  = COALESCE(NULLIF(e."messageId",''),NULLIF(e."localId",''),e."id")
              AND (prior."ts"<e."ts" OR (prior."ts"=e."ts" AND prior."id"<e."id"))
         )
       ORDER BY e."ts" ASC,e."id" ASC
       LIMIT $8`,
      agencyId, creatorId, dialogId, replyAt, replyEventId, cursorAt, cursorId || "", take);
  }
  const lower = [];
  if (replyAt) lower.push(replyEventId
    ? { OR: [{ ts: { gt: replyAt } }, { ts: replyAt, id: { gt: replyEventId } }] }
    : { ts: { gt: replyAt } });
  if (cursorAt && cursorId) lower.push({ OR: [{ ts: { gt: cursorAt } }, { ts: cursorAt, id: { gt: cursorId } }] });
  return db.teamActivityEvent.findMany({
    where: { agencyId, creatorId, dialogId, eventKind: "FAN_MESSAGE_RECEIVED", ...(lower.length ? { AND: lower } : {}) },
    orderBy: [{ ts: "asc" }, { id: "asc" }],
    take,
  });
}

async function loadSeenEdgesBounded({ agencyId, creatorId, dialogId, after, db = prisma }) {
  const where = { agencyId, creatorId, dialogId, eventKind: "DIALOG_SEEN", memberId: { not: null }, ts: { gte: after } };
  if (db?.teamActivityEvent?.findFirst) {
    const first = await db.teamActivityEvent.findFirst({ where, orderBy: [{ ts: "asc" }, { id: "asc" }] });
    const last = await db.teamActivityEvent.findFirst({ where, orderBy: [{ ts: "desc" }, { id: "desc" }] });
    return { first: first || null, last: last || null };
  }
  if (db?.teamActivityEvent?.findMany) {
    const rows = await db.teamActivityEvent.findMany({ where, orderBy: [{ ts: "asc" }, { id: "asc" }], take: 500 });
    const seen = dedupeSeen(rows);
    return { first: seen[0] || null, last: seen[seen.length - 1] || null };
  }
  return { first: null, last: null };
}

async function writeAmbiguousPendingBoundary({ agencyId, creatorId, dialogId, fanId, reply, sourceEventId, sample, db }) {
  const existing = await existingState({ agencyId, creatorId, dialogId, db });
  if (existing) {
    const row = await db.teamPendingDialogState.update({
      where: { id: existing.id },
      data: {
        projectionState: "INCOMPLETE_HISTORY",
        projectionRevision: BigInt(existing.projectionRevision || 0) + 1n,
        lastProjectionSourceId: clean(sourceEventId, 220) || existing.lastProjectionSourceId || null,
        derivationVersion: PENDING_DERIVATION_VERSION,
      },
    });
    return { status: String(row.status || "PENDING"), row, incompleteHistory: true, reason: "CROSS_FAMILY_ORDER_UNPROVEN" };
  }
  const at = dateOrNull(sample?.ts) || dateOrNull(reply?.sentAt);
  if (!at || !sample) return { status: "UNKNOWN", row: null, incompleteHistory: true, reason: "CROSS_FAMILY_ORDER_UNPROVEN" };
  const eventId = clean(sample.id, 220);
  const messageId = clean(sample.messageId, 220);
  const data = {
    agencyId, creatorId, dialogId, fanId: clean(sample.fanId || fanId || dialogId, 160), status: "PENDING",
    episodeKey: incomingIdentity(sample), firstIncomingEventId: eventId, lastIncomingEventId: eventId,
    firstIncomingMessageId: messageId, lastIncomingMessageId: messageId,
    firstIncomingAt: at, lastIncomingAt: at, incomingCount: 1,
    firstSeenAt: null, firstSeenMemberId: null, lastSeenAt: null, lastSeenMemberId: null,
    ownerMemberId: null, ownerAssignedAt: null, ownerReason: null,
    replyAt: null, replyMessageId: null, repliedByMemberId: null,
    derivationVersion: PENDING_DERIVATION_VERSION, projectionRevision: 1n,
    projectionState: "INCOMPLETE_HISTORY", lastProjectionSourceId: clean(sourceEventId, 220),
    lastAppliedEventAt: null, lastAppliedEventId: null,
  };
  const row = await db.teamPendingDialogState.upsert({
    where: { agencyId_creatorId_dialogId: { agencyId, creatorId, dialogId } }, create: data, update: data,
  });
  return { status: "PENDING", row, incompleteHistory: true, reason: "CROSS_FAMILY_ORDER_UNPROVEN" };
}

async function repairPendingDialogBatchUnlocked({ agencyId, creatorId, dialogId, fanId = null, sourceEventId = null, progress = null, limit = PENDING_REPAIR_BATCH_LIMIT, db = prisma }) {
  agencyId = clean(agencyId, 160); creatorId = clean(creatorId, 160); dialogId = clean(dialogId, 160);
  fanId = clean(fanId || dialogId, 160);
  if (!agencyId || !creatorId || !dialogId) return { skipped: true, complete: true, reason: "missing_dialog_identity" };

  const reply = await latestManualReply({ agencyId, creatorId, dialogId, db });
  const boundary = replyBoundary(reply);
  if (boundary.at && !boundary.eventId) {
    const ambiguous = await findIncomingAtExactBoundary({ agencyId, creatorId, dialogId, at: boundary.at, db });
    if (ambiguous) {
      const result = await writeAmbiguousPendingBoundary({ agencyId, creatorId, dialogId, fanId, reply, sourceEventId, sample: ambiguous, db });
      return { ...result, repairPending: false, complete: true, progress: null };
    }
  }

  const canResume = progress?.version === PENDING_REPAIR_CURSOR_VERSION && sameReplyBoundary(progress, reply);
  const state = canResume ? progress : null;
  const page = await loadIncomingRepairPage({
    agencyId, creatorId, dialogId, replyAt: boundary.at, replyEventId: boundary.eventId,
    cursorAt: state?.cursorAt || null, cursorId: state?.cursorId || null, limit, db,
  });
  const first = state?.first || incomingRepairSnapshot(page?.[0]);
  const last = incomingRepairSnapshot(page?.[page.length - 1]) || state?.last || null;
  const incomingCount = Math.max(0, Number(state?.incomingCount || 0)) + Number(page?.length || 0);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || PENDING_REPAIR_BATCH_LIMIT)));
  if (Number(page?.length || 0) >= safeLimit) {
    return {
      status: "REPAIRING", row: null, repairPending: true, complete: false,
      progress: {
        version: PENDING_REPAIR_CURSOR_VERSION,
        replyAt: boundary.at ? boundary.at.toISOString() : null,
        replyEventId: boundary.eventId,
        replyLedgerId: boundary.ledgerId,
        cursorAt: last?.ts || null,
        cursorId: last?.id || null,
        incomingCount,
        first,
        last,
      },
    };
  }

  const existing = await existingState({ agencyId, creatorId, dialogId, db });
  if (!first || incomingCount === 0) {
    if (!existing) return { status: "CLEAR", row: null, repairPending: false, complete: true, progress: null };
    if (String(existing.status || "").toUpperCase() !== "PENDING") return { status: "CLEAR", row: existing, repairPending: false, complete: true, progress: null };
    if (!boundary.at) {
      const preserved = await db.teamPendingDialogState.update({
        where: { id: existing.id },
        data: {
          projectionRevision: BigInt(existing.projectionRevision || 0) + 1n,
          projectionState: "INCOMPLETE_HISTORY",
          lastProjectionSourceId: clean(sourceEventId, 220) || existing.lastProjectionSourceId || null,
          derivationVersion: PENDING_DERIVATION_VERSION,
        },
      });
      return { status: "PENDING", row: preserved, incompleteHistory: true, repairPending: false, complete: true, progress: null };
    }
    const row = await db.teamPendingDialogState.update({
      where: { id: existing.id },
      data: {
        status: "CLEAR", replyAt: boundary.at, replyMessageId: clean(reply?.messageId, 220) || existing.replyMessageId || null,
        repliedByMemberId: clean(reply?.memberId, 160) || existing.repliedByMemberId || null,
        projectionRevision: BigInt(existing.projectionRevision || 0) + 1n, projectionState: "FULL",
        derivationVersion: PENDING_DERIVATION_VERSION, lastProjectionSourceId: clean(sourceEventId, 220) || existing.lastProjectionSourceId || null,
      },
    });
    return { status: "CLEAR", row, repairPending: false, complete: true, progress: null };
  }

  const firstAt = dateOrNull(first.ts); const lastAt = dateOrNull(last?.ts) || firstAt;
  if (!firstAt) return { skipped: true, complete: true, reason: "incoming_without_time" };
  const seen = await loadSeenEdgesBounded({ agencyId, creatorId, dialogId, after: firstAt, db });
  const firstSeenMemberId = clean(seen.first?.memberId, 160);
  const lastSeenMemberId = clean(seen.last?.memberId, 160);
  const ownerReason = lastSeenMemberId
    ? (firstSeenMemberId && firstSeenMemberId !== lastSeenMemberId ? "DIALOG_SEEN_HANDOFF" : "DIALOG_SEEN")
    : null;
  const data = {
    agencyId, creatorId, dialogId, fanId: clean(last?.fanId || first?.fanId || fanId || dialogId, 160), status: "PENDING",
    episodeKey: clean(first.messageId, 220) || clean(first.localId, 220) || clean(first.id, 220),
    firstIncomingEventId: clean(first.id, 220), lastIncomingEventId: clean(last?.id, 220),
    firstIncomingMessageId: clean(first.messageId, 220), lastIncomingMessageId: clean(last?.messageId, 220),
    firstIncomingAt: firstAt, lastIncomingAt: lastAt, incomingCount: Math.max(1, incomingCount),
    firstSeenAt: dateOrNull(seen.first?.ts), firstSeenMemberId, lastSeenAt: dateOrNull(seen.last?.ts), lastSeenMemberId,
    ownerMemberId: lastSeenMemberId, ownerAssignedAt: dateOrNull(seen.last?.ts), ownerReason,
    replyAt: null, replyMessageId: null, repliedByMemberId: null,
    derivationVersion: PENDING_DERIVATION_VERSION, projectionRevision: BigInt(existing?.projectionRevision || 0) + 1n,
    projectionState: "FULL", lastProjectionSourceId: clean(sourceEventId, 220),
  };
  const row = await db.teamPendingDialogState.upsert({
    where: { agencyId_creatorId_dialogId: { agencyId, creatorId, dialogId } }, create: data, update: data,
  });
  return { status: "PENDING", row, repairPending: false, complete: true, progress: null };
}

async function existingState({ agencyId, creatorId, dialogId, db = prisma }) {
  return db.teamPendingDialogState.findUnique({
    where: { agencyId_creatorId_dialogId: { agencyId, creatorId, dialogId } },
  });
}

async function reconcilePendingDialogUnlocked({ agencyId, creatorId, dialogId, fanId = null, sourceEventId = null, db = prisma }) {
  agencyId = clean(agencyId, 160);
  creatorId = clean(creatorId, 160);
  dialogId = clean(dialogId, 160);
  fanId = clean(fanId || dialogId, 160);
  if (!agencyId || !creatorId || !dialogId) return { skipped: true, reason: "missing_dialog_identity" };

  const reply = await latestManualReply({ agencyId, creatorId, dialogId, db });
  const replyAt = dateOrNull(reply?.sentAt);
  const replyEventId = canonicalReplyEventId(reply);
  if (replyAt && !replyEventId) {
    const ambiguous = await findIncomingAtExactBoundary({ agencyId, creatorId, dialogId, at: replyAt, db });
    if (ambiguous) return writeAmbiguousPendingBoundary({ agencyId, creatorId, dialogId, fanId, reply, sourceEventId, sample: ambiguous, db });
  }
  const incoming = await loadIncomingAfter({ agencyId, creatorId, dialogId, after: replyAt, afterEventId: replyEventId, db });
  const existing = await existingState({ agencyId, creatorId, dialogId, db });

  if (!incoming.length) {
    if (!existing) return { status: "CLEAR", row: null };
    if (String(existing.status || "").toUpperCase() !== "PENDING") return { status: "CLEAR", row: existing };
    // Raw Team detail retention is not proof that a pending episode received a reply.
    // Preserve the known current obligation when the compact state says PENDING but
    // the historical raw incoming rows are no longer available.
    if (!replyAt) {
      const preserved = await db.teamPendingDialogState.update({
        where: { id: existing.id },
        data: {
          projectionRevision: BigInt(existing.projectionRevision || 0) + 1n,
          projectionState: "INCOMPLETE_HISTORY",
          lastProjectionSourceId: clean(sourceEventId, 220) || existing.lastProjectionSourceId || null,
          derivationVersion: PENDING_DERIVATION_VERSION,
        },
      });
      return { status: "PENDING", row: preserved, incompleteHistory: true };
    }
    const clearData = {
      status: "CLEAR",
      replyAt: replyAt || existing.replyAt || null,
      replyMessageId: clean(reply?.messageId, 220) || existing.replyMessageId || null,
      repliedByMemberId: clean(reply?.memberId, 160) || existing.repliedByMemberId || null,
      ownerMemberId: existing.ownerMemberId || null,
      ownerAssignedAt: existing.ownerAssignedAt || null,
      derivationVersion: PENDING_DERIVATION_VERSION,
      projectionRevision: BigInt(existing.projectionRevision || 0) + 1n,
      projectionState: "FULL",
      lastProjectionSourceId: clean(sourceEventId, 220) || existing.lastProjectionSourceId || null,
    };
    const row = await db.teamPendingDialogState.update({ where: { id: existing.id }, data: clearData });
    return { status: "CLEAR", row };
  }

  const first = incoming[0];
  const last = incoming[incoming.length - 1];
  const firstIncomingAt = dateOrNull(first.ts);
  const lastIncomingAt = dateOrNull(last.ts) || firstIncomingAt;
  if (!firstIncomingAt) return { skipped: true, reason: "incoming_without_time" };

  const seen = await loadSeenAfter({ agencyId, creatorId, dialogId, after: firstIncomingAt, db });
  const firstSeen = seen[0] || null;
  const lastSeen = seen[seen.length - 1] || null;
  const firstSeenMemberId = clean(firstSeen?.memberId, 160);
  const lastSeenMemberId = clean(lastSeen?.memberId, 160);
  const ownerReason = lastSeenMemberId
    ? (firstSeenMemberId && firstSeenMemberId !== lastSeenMemberId ? "DIALOG_SEEN_HANDOFF" : "DIALOG_SEEN")
    : null;

  const data = {
    agencyId,
    creatorId,
    dialogId,
    fanId: clean(last?.fanId || first?.fanId || fanId || dialogId, 160),
    status: "PENDING",
    episodeKey: incomingIdentity(first),
    firstIncomingEventId: clean(first?.id, 220),
    lastIncomingEventId: clean(last?.id, 220),
    firstIncomingMessageId: clean(first?.messageId, 220),
    lastIncomingMessageId: clean(last?.messageId, 220),
    firstIncomingAt,
    lastIncomingAt,
    incomingCount: Math.max(1, Number(incoming.episodeCount || incoming.length)),
    firstSeenAt: dateOrNull(firstSeen?.ts),
    firstSeenMemberId,
    lastSeenAt: dateOrNull(lastSeen?.ts),
    lastSeenMemberId,
    ownerMemberId: lastSeenMemberId,
    ownerAssignedAt: dateOrNull(lastSeen?.ts),
    ownerReason,
    replyAt: null,
    replyMessageId: null,
    repliedByMemberId: null,
    derivationVersion: PENDING_DERIVATION_VERSION,
    projectionRevision: BigInt(existing?.projectionRevision || 0) + 1n,
    projectionState: "FULL",
    lastProjectionSourceId: clean(sourceEventId, 220),
  };

  const row = await db.teamPendingDialogState.upsert({
    where: { agencyId_creatorId_dialogId: { agencyId, creatorId, dialogId } },
    create: data,
    update: data,
  });
  return { status: "PENDING", row };
}


function compareEventOrder(aAt, aId, bAt, bId) {
  const a = dateOrNull(aAt); const b = dateOrNull(bAt);
  const ams = a ? a.getTime() : Number.NEGATIVE_INFINITY;
  const bms = b ? b.getTime() : Number.NEGATIVE_INFINITY;
  if (ams !== bms) return ams < bms ? -1 : 1;
  return String(aId || "").localeCompare(String(bId || ""));
}

async function duplicateIncomingBefore({ row, agencyId, creatorId, dialogId, db }) {
  const messageId = clean(row?.messageId, 220);
  if (!messageId || !db?.teamActivityEvent?.findFirst) return false;
  const ts = dateOrNull(row?.ts);
  const id = clean(row?.id, 220);
  if (!ts || !id) return false;
  const prior = await db.teamActivityEvent.findFirst({
    where: {
      agencyId, creatorId, dialogId, eventKind: "FAN_MESSAGE_RECEIVED", messageId,
      OR: [{ ts: { lt: ts } }, { ts, id: { lt: id } }],
    },
    select: { id: true },
    orderBy: [{ ts: "asc" }, { id: "asc" }],
  });
  return Boolean(prior);
}

async function applyIncrementalPendingEventUnlocked({ row, existing, agencyId, creatorId, dialogId, fanId, db }) {
  const kind = kindOf(row);
  const eventAt = dateOrNull(row?.ts);
  const eventId = clean(row?.id, 220) || clean(row?.localId, 220);
  if (!eventAt || !eventId) return { needsRepair: true, reason: "event_order_missing" };
  const marker = { lastAppliedEventAt: eventAt, lastAppliedEventId: eventId, lastProjectionSourceId: eventId, derivationVersion: PENDING_DERIVATION_VERSION };

  if (kind === "FAN_MESSAGE_RECEIVED") {
    if (await duplicateIncomingBefore({ row, agencyId, creatorId, dialogId, db })) {
      if (!existing) return { status: "CLEAR", row: null, duplicate: true };
      const updated = await db.teamPendingDialogState.update({
        where: { id: existing.id },
        data: { ...marker, projectionRevision: BigInt(existing.projectionRevision || 0) + 1n },
      });
      return { status: String(updated.status || "CLEAR"), row: updated, duplicate: true };
    }

    const identity = incomingIdentity(row);
    if (existing && String(existing.status || "").toUpperCase() === "PENDING") {
      const updated = await db.teamPendingDialogState.update({
        where: { id: existing.id },
        data: {
          fanId: clean(row?.fanId || fanId || existing.fanId || dialogId, 160),
          lastIncomingEventId: eventId,
          lastIncomingMessageId: clean(row?.messageId, 220) || existing.lastIncomingMessageId || null,
          lastIncomingAt: eventAt,
          incomingCount: Math.max(0, Number(existing.incomingCount || 0)) + 1,
          projectionRevision: BigInt(existing.projectionRevision || 0) + 1n,
          projectionState: "FULL",
          ...marker,
        },
      });
      return { status: "PENDING", row: updated, incremental: true };
    }

    // If seen evidence is already durable (for example replay/out-of-order ingest),
    // recover its first/last edges with two bounded index seeks rather than replaying
    // the whole dialog.
    const seenEdges = await loadSeenEdgesBounded({ agencyId, creatorId, dialogId, after: eventAt, db });
    const firstSeenMemberId = clean(seenEdges.first?.memberId, 160);
    const lastSeenMemberId = clean(seenEdges.last?.memberId, 160);
    const data = {
      agencyId, creatorId, dialogId, fanId: clean(row?.fanId || fanId || dialogId, 160),
      status: "PENDING", episodeKey: identity,
      firstIncomingEventId: eventId, lastIncomingEventId: eventId,
      firstIncomingMessageId: clean(row?.messageId, 220), lastIncomingMessageId: clean(row?.messageId, 220),
      firstIncomingAt: eventAt, lastIncomingAt: eventAt, incomingCount: 1,
      firstSeenAt: dateOrNull(seenEdges.first?.ts), firstSeenMemberId,
      lastSeenAt: dateOrNull(seenEdges.last?.ts), lastSeenMemberId,
      ownerMemberId: lastSeenMemberId, ownerAssignedAt: dateOrNull(seenEdges.last?.ts),
      ownerReason: lastSeenMemberId ? (firstSeenMemberId && firstSeenMemberId !== lastSeenMemberId ? "DIALOG_SEEN_HANDOFF" : "DIALOG_SEEN") : null,
      replyAt: null, replyMessageId: null, repliedByMemberId: null,
      derivationVersion: PENDING_DERIVATION_VERSION,
      projectionRevision: BigInt(existing?.projectionRevision || 0) + 1n,
      projectionState: "FULL", ...marker,
    };
    const updated = await db.teamPendingDialogState.upsert({
      where: { agencyId_creatorId_dialogId: { agencyId, creatorId, dialogId } },
      create: data, update: data,
    });
    return { status: "PENDING", row: updated, incremental: true };
  }

  if (kind === "DIALOG_SEEN") {
    if (!existing) return { status: "CLEAR", row: null, ignored: true };
    const memberId = clean(row?.memberId, 160);
    const isPending = String(existing.status || "").toUpperCase() === "PENDING";
    const afterEpisodeStart = !existing.firstIncomingAt || compareEventOrder(eventAt, eventId, existing.firstIncomingAt, existing.firstIncomingEventId) >= 0;
    const data = { ...marker, projectionRevision: BigInt(existing.projectionRevision || 0) + 1n };
    if (isPending && memberId && afterEpisodeStart) {
      data.firstSeenAt = existing.firstSeenAt || eventAt;
      data.firstSeenMemberId = existing.firstSeenMemberId || memberId;
      data.lastSeenAt = eventAt;
      data.lastSeenMemberId = memberId;
      data.ownerMemberId = memberId;
      data.ownerAssignedAt = eventAt;
      data.ownerReason = existing.firstSeenMemberId && existing.firstSeenMemberId !== memberId ? "DIALOG_SEEN_HANDOFF" : "DIALOG_SEEN";
      data.projectionState = "FULL";
    }
    const updated = await db.teamPendingDialogState.update({ where: { id: existing.id }, data });
    return { status: String(updated.status || "CLEAR"), row: updated, incremental: true };
  }

  if (kind === "MESSAGE_SEND_CONFIRMED" && isManualConfirmed(row)) {
    if (!existing) return { status: "CLEAR", row: null, ignored: true };
    const data = {
      ...marker,
      status: "CLEAR",
      replyAt: eventAt,
      replyMessageId: clean(row?.messageId, 220) || existing.replyMessageId || null,
      repliedByMemberId: clean(row?.memberId, 160) || existing.repliedByMemberId || null,
      projectionRevision: BigInt(existing.projectionRevision || 0) + 1n,
      projectionState: "FULL",
    };
    const updated = await db.teamPendingDialogState.update({ where: { id: existing.id }, data });
    return { status: "CLEAR", row: updated, incremental: true };
  }

  return { needsRepair: true, reason: "unsupported_incremental_kind" };
}

function pendingDialogFenceKey({ agencyId, creatorId, dialogId }) {
  return `team-pending:${clean(agencyId,160) || ""}:${clean(creatorId,160) || ""}:${clean(dialogId,160) || ""}`;
}

async function reconcilePendingDialog({ agencyId, creatorId, dialogId, fanId = null, sourceEventId = null, db = prisma }) {
  const identity = { agencyId: clean(agencyId,160), creatorId: clean(creatorId,160), dialogId: clean(dialogId,160) };
  if (!identity.agencyId || !identity.creatorId || !identity.dialogId) return { skipped: true, reason: "missing_dialog_identity" };
  return runDbTransaction(db, async (tx) => {
    if (typeof tx?.$executeRawUnsafe === "function") {
      await lockDbAdvisoryXact({ db: tx, key: pendingDialogFenceKey(identity), mode: "exclusive" });
    }
    return reconcilePendingDialogUnlocked({ agencyId: identity.agencyId, creatorId: identity.creatorId, dialogId: identity.dialogId, fanId, sourceEventId, db: tx });
  });
}

async function markProjected(row, db = prisma) {
  const id = clean(row?.id, 220);
  if (!id || !db.teamActivityEvent?.update) return;
  await db.teamActivityEvent.update({
    where: { id },
    data: { pendingProjectionVersion: PENDING_DERIVATION_VERSION, pendingProjectedAt: new Date() },
  });
}

async function applyTeamPendingProjection(row, db = prisma, options = {}) {
  const kind = kindOf(row);
  if (!RELEVANT_EVENT_KINDS.has(kind)) return null;
  if (kind === "MESSAGE_SEND_CONFIRMED" && !isManualConfirmed(row)) {
    await markProjected(row, db);
    return { skipped: true, reason: "non_manual_send", complete: true };
  }

  if (!db.teamPendingDialogState?.findUnique || !db.teamPendingDialogState?.upsert || !db.teamSentMessageLedger?.findFirst) {
    return { skipped: true, reason: "pending_projection_models_unavailable", complete: false };
  }

  const identity = {
    agencyId: clean(row?.agencyId, 160), creatorId: clean(row?.creatorId, 160),
    dialogId: clean(row?.dialogId || row?.fanId, 160), fanId: clean(row?.fanId || row?.dialogId, 160),
  };
  if (!identity.agencyId || !identity.creatorId || !identity.dialogId) {
    await markProjected(row, db);
    return { skipped: true, reason: "missing_dialog_identity", complete: true };
  }

  const executeRepair = options?.executeRepair === true;
  const result = await runDbTransaction(db, async (tx) => {
    if (typeof tx?.$executeRawUnsafe === "function") {
      await lockDbAdvisoryXact({ db: tx, key: pendingDialogFenceKey(identity), mode: "exclusive" });
    }
    const existing = await existingState({ agencyId: identity.agencyId, creatorId: identity.creatorId, dialogId: identity.dialogId, db: tx });
    const eventAt = dateOrNull(row?.ts);
    const eventId = clean(row?.id, 220) || clean(row?.localId, 220);
    const markerAt = dateOrNull(existing?.lastAppliedEventAt);
    const markerId = clean(existing?.lastAppliedEventId, 220);

    // First FAN event is also a current-state-sized mutation; do not force it
    // through historical reconstruction merely because no state row exists yet.
    if (!existing && kind === "FAN_MESSAGE_RECEIVED") {
      const reply = await latestManualReply({ agencyId: identity.agencyId, creatorId: identity.creatorId, dialogId: identity.dialogId, db: tx });
      const boundary = replyBoundary(reply);
      if (boundary.at) {
        const relative = compareCanonicalEventOrder(eventAt, eventId, boundary.at, boundary.eventId);
        if (relative != null && relative < 0) {
          return { status: "CLEAR", row: null, alreadyAnswered: true, complete: true };
        }
        // Equal timestamps without a canonical reply event id are genuinely
        // ambiguous across families; never guess via the inline fast path.
        if (relative == null && eventAt?.getTime?.() === boundary.at.getTime()) {
          if (!executeRepair) return { status: "UNKNOWN", row: null, repairPending: true, complete: false, deferred: true };
        }
      }
      const incremental = await applyIncrementalPendingEventUnlocked({ row, existing: null, ...identity, db: tx });
      if (!incremental?.needsRepair) return { ...incremental, complete: true };
    }

    if (existing && markerAt && markerId && eventAt && eventId) {
      const order = compareEventOrder(eventAt, eventId, markerAt, markerId);
      if (order === 0) return { status: String(existing.status || "CLEAR"), row: existing, idempotent: true, complete: true };
      if (order > 0) {
        const incremental = await applyIncrementalPendingEventUnlocked({ row, existing, ...identity, db: tx });
        if (!incremental?.needsRepair) return { ...incremental, complete: true };
      }
    }

    // Inline ingestion must never turn one late event into an unbounded history
    // rebuild. The canonical event's DWI remains outstanding and the scheduler
    // resumes this repair in bounded pages using DomainWorkItem.progressCursor.
    if (!executeRepair && typeof tx?.$queryRawUnsafe === "function") {
      return { status: String(existing?.status || "UNKNOWN"), row: existing || null, repairPending: true, complete: false, deferred: true };
    }
    if (!executeRepair) {
      const compatibility = await reconcilePendingDialogUnlocked({
        agencyId: identity.agencyId, creatorId: identity.creatorId, dialogId: identity.dialogId,
        fanId: identity.fanId, sourceEventId: eventId, db: tx,
      });
      return { ...compatibility, complete: true };
    }

    const repaired = await repairPendingDialogBatchUnlocked({
      agencyId: identity.agencyId, creatorId: identity.creatorId, dialogId: identity.dialogId,
      fanId: identity.fanId, sourceEventId: eventId, progress: options?.repairProgress || null,
      limit: options?.repairLimit || PENDING_REPAIR_BATCH_LIMIT, db: tx,
    });
    if (repaired?.complete && repaired?.row && eventAt && eventId) {
      const currentAt = dateOrNull(repaired.row.lastAppliedEventAt);
      const currentId = clean(repaired.row.lastAppliedEventId, 220);
      if (!currentAt || compareEventOrder(eventAt, eventId, currentAt, currentId) > 0) {
        repaired.row = await tx.teamPendingDialogState.update({
          where: { id: repaired.row.id }, data: { lastAppliedEventAt: eventAt, lastAppliedEventId: eventId },
        });
      }
    }
    return repaired;
  });
  if (result?.complete !== false) await markProjected(row, db);
  return result;
}

async function backfillTeamPendingProjectionBatch({ db = prisma, limit = 500 } = {}) {
  if (!db.teamPendingDialogState?.upsert || !db.teamPendingDialogState?.findUnique || !db.teamSentMessageLedger?.findFirst || !db.teamActivityEvent?.findMany || !db.teamActivityEvent?.updateMany) {
    return { skipped: true, reason: "pending_projection_models_unavailable", selected: 0, dialogs: 0, projected: 0 };
  }
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
  const rows = await db.teamActivityEvent.findMany({
    where: {
      eventKind: { in: Array.from(RELEVANT_EVENT_KINDS) },
      OR: [
        { pendingProjectionVersion: null },
        { pendingProjectionVersion: { not: PENDING_DERIVATION_VERSION } },
      ],
    },
    orderBy: [{ ts: "asc" }, { id: "asc" }],
    take: safeLimit,
  });
  if (!rows.length) return { skipped: false, selected: 0, dialogs: 0, projected: 0 };

  const groups = new Map();
  const invalidIds = [];
  for (const row of rows) {
    const agencyId = clean(row?.agencyId, 160);
    const creatorId = clean(row?.creatorId, 160);
    const dialogId = clean(row?.dialogId || row?.fanId, 160);
    if (!agencyId || !creatorId || !dialogId) {
      if (row?.id) invalidIds.push(row.id);
      continue;
    }
    const key = `${agencyId}|${creatorId}|${dialogId}`;
    if (!groups.has(key)) groups.set(key, { agencyId, creatorId, dialogId, fanId: clean(row?.fanId, 160), ids: [] });
    if (row?.id) groups.get(key).ids.push(row.id);
  }

  let projected = 0;
  for (const group of groups.values()) {
    await reconcilePendingDialog({ ...group, db });
    if (group.ids.length) {
      const updated = await db.teamActivityEvent.updateMany({
        where: { id: { in: group.ids } },
        data: { pendingProjectionVersion: PENDING_DERIVATION_VERSION, pendingProjectedAt: new Date() },
      });
      projected += Number(updated?.count || group.ids.length);
    }
  }
  if (invalidIds.length) {
    const updated = await db.teamActivityEvent.updateMany({
      where: { id: { in: invalidIds } },
      data: { pendingProjectionVersion: PENDING_DERIVATION_VERSION, pendingProjectedAt: new Date() },
    });
    projected += Number(updated?.count || invalidIds.length);
  }

  return { skipped: false, selected: rows.length, dialogs: groups.size, projected };
}

module.exports = {
  PENDING_DERIVATION_VERSION,
  RELEVANT_EVENT_KINDS,
  reconcilePendingDialog,
  applyTeamPendingProjection,
  backfillTeamPendingProjectionBatch,
};
