"use strict";

const ACTIVITY_CONTRIBUTION_VERSION = "team_activity_contribution_v2";
const ACTIVITY_ZERO_VERSION = "team_activity_zero_v2";
const ACTIVITY_UNKEYED_VERSION = "team_activity_unkeyed_v2";
const DEFAULT_BATCH = 100;
const MAX_BATCH = 200;

function clean(value, max = 240) {
  const out = String(value ?? "").trim();
  return out ? out.slice(0, max) : null;
}
function bounded(value, fallback = DEFAULT_BATCH) {
  return Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(value) || fallback)));
}
function creatorKey(row) {
  return clean(row?.creatorId || row?.accountId, 160) || "__none__";
}
function semanticKey(row) {
  const scope = creatorKey(row);
  const kind = clean(row?.eventKind, 80);
  if (kind === "MESSAGE_SEND_CONFIRMED") {
    const id = clean(row?.messageId, 220);
    return id ? `${scope}:message:${id}` : null;
  }
  if (kind === "BROADCAST_DISPATCH_CONFIRMED") {
    const id = clean(row?.broadcastDispatchId, 220);
    return id ? `${scope}:broadcast:${id}` : null;
  }
  if (kind === "CONTENT_POST_PUBLISHED_CONFIRMED" || kind === "CONTENT_STORY_PUBLISHED_CONFIRMED") {
    const id = clean(row?.contentId, 220);
    return id ? `${scope}:content:${id}` : null;
  }
  return null;
}
function deriveContribution(row) {
  if (String(row?.source || "") !== "electron_team_v13" || !row?.eventKind || !row?.memberId) {
    return { contributes: false, stable: true, semanticKey: null, version: ACTIVITY_ZERO_VERSION };
  }
  const kind = String(row.eventKind);
  let contribution = null;
  if (kind === "MESSAGE_SEND_CONFIRMED" && row.actionSource === "MANUAL" && row.lifecycle === "CONFIRMED") {
    contribution = { messagesSent: 1, ppvSentMessages: row.isPpv === true || Number(row.priceCents || 0) > 0 ? 1 : 0 };
  } else if (kind === "BROADCAST_DISPATCH_CONFIRMED" && row.lifecycle === "CONFIRMED") {
    contribution = { broadcastDispatches: 1 };
  } else if (kind === "CONTENT_POST_PUBLISHED_CONFIRMED" && row.actionSource === "MANUAL" && row.lifecycle === "CONFIRMED") {
    contribution = { postsCreated: 1, contentActions: 1, contentMediaItemsPublished: Math.max(0, Number(row.mediaCount || 0)) };
  } else if (kind === "CONTENT_STORY_PUBLISHED_CONFIRMED" && row.actionSource === "MANUAL" && row.lifecycle === "CONFIRMED") {
    contribution = { storiesCreated: 1, contentActions: 1, contentMediaItemsPublished: Math.max(0, Number(row.mediaCount || 0)) };
  }
  if (!contribution) return { contributes: false, stable: true, semanticKey: null, version: ACTIVITY_ZERO_VERSION };
  const key = clean(row.semanticEventKey, 500) || semanticKey(row);
  if (!key) return { contributes: true, stable: false, semanticKey: null, version: ACTIVITY_UNKEYED_VERSION };
  const ts = row.ts instanceof Date ? row.ts : new Date(row.ts);
  const day = Number.isFinite(ts.getTime()) ? new Date(Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), ts.getUTCDate())) : null;
  return {
    contributes: true, stable: true, semanticKey: key, version: ACTIVITY_CONTRIBUTION_VERSION,
    contribution: {
      messagesSent: 0, ppvSentMessages: 0, broadcastDispatches: 0, postsCreated: 0, storiesCreated: 0,
      contentActions: 0, contentMediaItemsPublished: 0, ...contribution,
    },
    creatorKey: creatorKey(row), day, sourceEventAt: ts,
  };
}

async function backfillActivityContributionBatch({ db, agencyId, cursor = null, limit = DEFAULT_BATCH } = {}) {
  if (!db?.teamActivityEvent?.findMany || !db?.teamActivityEvent?.update) {
    return { ok: false, code: "TEAM_ACTIVITY_STORAGE_REQUIRED", complete: false, rows: 0, unresolved: 0, nextCursor: cursor };
  }
  const take = bounded(limit);
  const rows = await db.teamActivityEvent.findMany({
    where: {
      agencyId: String(agencyId), source: "electron_team_v13",
      historicalProjectionVersion: "team_activity_daily_v1",
      ...(cursor ? { id: { gt: String(cursor) } } : {}),
    },
    orderBy: { id: "asc" }, take,
  });
  let baseline = 0; let zero = 0; let unresolved = 0;
  for (const row of rows || []) {
    const derived = deriveContribution(row);
    if (derived.contributes && derived.stable) {
      if (!db?.teamActivityContribution?.upsert) {
        return { ok: false, code: "TEAM_ACTIVITY_CONTRIBUTION_STORAGE_REQUIRED", complete: false, rows: baseline + zero + unresolved, unresolved: unresolved + 1, nextCursor: row.id };
      }
      await db.teamActivityContribution.upsert({
        where: { agencyId_eventKind_semanticKey: { agencyId: row.agencyId, eventKind: row.eventKind, semanticKey: derived.semanticKey } },
        create: {
          id: `tac_${require("node:crypto").createHash("md5").update(`${row.agencyId}:${row.eventKind}:${derived.semanticKey}`).digest("hex")}`,
          agencyId: row.agencyId, eventKind: row.eventKind, semanticKey: derived.semanticKey, state: "APPLIED_BASELINE",
          memberId: row.memberId || null, creatorKey: derived.creatorKey, creatorId: row.creatorId || null, day: derived.day,
          ...derived.contribution, sourceEventAt: derived.sourceEventAt, projectionVersion: ACTIVITY_CONTRIBUTION_VERSION,
        },
        update: {},
      });
      await db.teamActivityEvent.update({
        where: { id: row.id },
        data: { semanticEventKey: derived.semanticKey, historicalProjectionVersion: ACTIVITY_CONTRIBUTION_VERSION, historicalProjectedAt: row.historicalProjectedAt || new Date() },
      });
      baseline += 1;
    } else if (!derived.contributes) {
      await db.teamActivityEvent.update({
        where: { id: row.id }, data: { historicalProjectionVersion: ACTIVITY_ZERO_VERSION, historicalProjectedAt: row.historicalProjectedAt || new Date() },
      });
      zero += 1;
    } else {
      // Do not invent a semantic identity from device/localId. Raw evidence remains
      // retention-protected until migration review can classify it.
      await db.teamActivityEvent.update({
        where: { id: row.id }, data: { historicalProjectionVersion: ACTIVITY_UNKEYED_VERSION, historicalProjectedAt: null },
      });
      unresolved += 1;
    }
  }
  const nextCursor = rows?.length ? String(rows[rows.length - 1].id) : cursor;
  return { ok: true, rows: rows?.length || 0, baseline, zero, unresolved, nextCursor, complete: (rows?.length || 0) < take };
}

module.exports = {
  ACTIVITY_CONTRIBUTION_VERSION, ACTIVITY_ZERO_VERSION, ACTIVITY_UNKEYED_VERSION,
  semanticKey, deriveContribution, backfillActivityContributionBatch,
};
