"use strict";

const TIP_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000;
const TIP_SOFT_REVIEW_WINDOW_MS = 15 * 60 * 1000;
const NON_HUMAN_SOURCE_MARKERS = ["automation", "auto_", "broadcast", "mass", "campaign", "queue", "system", "scheduler", "welcome", "bump"];

function clean(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 160) : null;
}

function classifySentSource(row) {
  const source = String(row?.source || "").trim().toLowerCase();
  if (!source) return "UNKNOWN";
  if (NON_HUMAN_SOURCE_MARKERS.some((marker) => source.includes(marker))) return "NON_HUMAN";
  return source.includes("manual") ? "MANUAL" : "UNKNOWN";
}

async function findRecentTipCandidates({ db, agencyId, creatorId, accountId, fanId, dialogId, receivedAt }) {
  const agency = clean(agencyId);
  const creator = clean(creatorId || accountId);
  const dialogs = [...new Set([clean(fanId), clean(dialogId)].filter(Boolean))];
  const to = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  const receivedMs = to.getTime();

  // An unknown buyer is not a wildcard over the creator's other conversations.
  // The retained event identity is supplied by reconciliation when the live fan
  // relation has gone away. Missing scope remains unresolved for manager review.
  if (!agency || !creator || !dialogs.length || !Number.isFinite(receivedMs) || receivedMs <= 0) {
    return { primary: [], weak: [] };
  }
  const from = new Date(receivedMs - TIP_SOFT_REVIEW_WINDOW_MS);
  let rows;
  if (typeof db?.$queryRaw === "function") {
    // Reduce manual evidence per worker in PostgreSQL. Limiting raw messages
    // before this reduction lets one busy worker hide another eligible worker.
    // The result is bounded by distinct workers in this one dialog/window.
    rows = await db.$queryRaw`
      SELECT DISTINCT ON ("memberId")
        "memberId", "userId", "deviceId", "shiftKey", "sentAt", "source",
        "agencyId", "creatorId", "accountId", "fanId", "dialogId", "id"
      FROM "TeamSentMessageLedger"
      WHERE "agencyId" = ${agency}
        AND ("creatorId" = ${creator} OR ("creatorId" IS NULL AND "accountId" = ${creator}))
        AND ("fanId" = ANY(${dialogs}::text[]) OR "dialogId" = ANY(${dialogs}::text[]))
        AND "memberId" IS NOT NULL
        AND "sentAt" >= ${from} AND "sentAt" <= ${to}
        AND strpos(lower(COALESCE("source", '')), 'manual') > 0
        AND NOT EXISTS (
          SELECT 1 FROM unnest(${NON_HUMAN_SOURCE_MARKERS}::text[]) AS markers(marker)
          WHERE strpos(lower(COALESCE("source", '')), marker) > 0
        )
      ORDER BY "memberId", "sentAt" DESC, "id" ASC
    `;
  } else {
    // Compatibility for reduced clients without raw SQL; use the same complete
    // evidence set and never truncate before distinct-worker classification.
    if (!db?.teamSentMessageLedger?.findMany) return { primary: [], weak: [] };
    rows = await db.teamSentMessageLedger.findMany({
      where: {
        agencyId: agency,
        memberId: { not: null },
        sentAt: { gte: from, lte: to },
        AND: [
          { OR: [{ creatorId: creator }, { creatorId: null, accountId: creator }] },
          { OR: [{ fanId: { in: dialogs } }, { dialogId: { in: dialogs } }] },
        ],
      },
      orderBy: [{ sentAt: "desc" }, { id: "asc" }],
    });
  }

  const byMember = new Map();
  for (const row of rows || []) {
    if (!row.memberId || classifySentSource(row) !== "MANUAL") continue;
    if (row.agencyId !== agency || !(row.creatorId === creator || (!row.creatorId && row.accountId === creator))) continue;
    if (!dialogs.includes(row.fanId) && !dialogs.includes(row.dialogId)) continue;
    const sentAtMs = row.sentAt instanceof Date ? row.sentAt.getTime() : new Date(row.sentAt).getTime();
    const ageMs = receivedMs - sentAtMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > TIP_SOFT_REVIEW_WINDOW_MS) continue;
    const previous = byMember.get(row.memberId);
    if (previous && previous.sentAtMs >= sentAtMs) continue;
    byMember.set(row.memberId, {
      memberId: row.memberId, userId: row.userId || null, deviceId: row.deviceId || null,
      shiftKey: row.shiftKey || null, sentAtMs,
      ageMinutes: Math.round(ageMs / 60000),
      source: "recent_manual_message_evidence_only",
    });
  }
  const candidates = [...byMember.values()].sort((a, b) => b.sentAtMs - a.sentAtMs || a.memberId.localeCompare(b.memberId));
  return {
    primary: candidates.filter((candidate) => receivedMs - candidate.sentAtMs <= TIP_ATTRIBUTION_WINDOW_MS),
    weak: candidates.filter((candidate) => receivedMs - candidate.sentAtMs > TIP_ATTRIBUTION_WINDOW_MS),
  };
}

module.exports = { classifySentSource, findRecentTipCandidates, TIP_ATTRIBUTION_WINDOW_MS, TIP_SOFT_REVIEW_WINDOW_MS };
