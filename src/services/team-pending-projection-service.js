"use strict";

const prisma = require("../prisma");
const { runDbTransaction, lockDbAdvisoryXact } = require("./db-transaction-service");

const PENDING_DERIVATION_VERSION = "team_pending_v2";
const RELEVANT_EVENT_KINDS = new Set(["FAN_MESSAGE_RECEIVED", "DIALOG_SEEN", "MESSAGE_SEND_CONFIRMED"]);
const MANUAL_SOURCES = ["manual", "manual_chat"];

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
    orderBy: { sentAt: "desc" },
  });
}

async function loadIncomingAfter({ agencyId, creatorId, dialogId, after, db = prisma }) {
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
           AND ($4::timestamptz IS NULL OR e."ts">$4)
         ORDER BY COALESCE(NULLIF(e."messageId",''),NULLIF(e."localId",''),e."id"),e."ts" ASC,e."id" ASC
      ), ranked AS (
        SELECT d.*, row_number() OVER (ORDER BY d."ts",d."id") AS rn_first,
               row_number() OVER (ORDER BY d."ts" DESC,d."id" DESC) AS rn_last,
               count(*) OVER () AS total
          FROM dedup d
      )
      SELECT "id","messageId","localId","fanId","ts","rn_first","rn_last","total"
        FROM ranked WHERE rn_first=1 OR rn_last=1 ORDER BY "ts" ASC,"id" ASC`,
      agencyId,creatorId,dialogId,after || null);
    const out = (rows || []).map((row) => ({ id: row.id, messageId: row.messageId, localId: row.localId, fanId: row.fanId, ts: row.ts }));
    out.episodeCount = Number(rows?.[0]?.total || 0);
    return out;
  }
  const rows = await db.teamActivityEvent.findMany({
    where: { agencyId, creatorId, dialogId, eventKind: "FAN_MESSAGE_RECEIVED", ...(after ? { ts: { gt: after } } : {}) },
    orderBy: { ts: "asc" },
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
    orderBy: { ts: "asc" },
  });
  return dedupeSeen(rows);
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
  const incoming = await loadIncomingAfter({ agencyId, creatorId, dialogId, after: replyAt, db });
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

async function applyTeamPendingProjection(row, db = prisma) {
  const kind = kindOf(row);
  if (!RELEVANT_EVENT_KINDS.has(kind)) return null;
  if (kind === "MESSAGE_SEND_CONFIRMED" && !isManualConfirmed(row)) {
    await markProjected(row, db);
    return { skipped: true, reason: "non_manual_send" };
  }

  // Rolling deploy safety: raw telemetry must remain durable even if the
  // additive pending migration has not been applied yet. Do not mark these
  // rows projected; the DB-only backfill will pick them up after migration.
  if (!db.teamPendingDialogState?.findUnique || !db.teamPendingDialogState?.upsert || !db.teamSentMessageLedger?.findFirst) {
    return { skipped: true, reason: "pending_projection_models_unavailable" };
  }

  const result = await reconcilePendingDialog({
    agencyId: row?.agencyId,
    creatorId: row?.creatorId,
    dialogId: row?.dialogId || row?.fanId,
    fanId: row?.fanId,
    sourceEventId: row?.id || row?.localId || null,
    db,
  });
  await markProjected(row, db);
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
