"use strict";

// Each state attribute is the last event that can change that attribute.
// Seven indexed top-one reads replace a fan's unbounded historical replay.
// Keep these literal predicates aligned with analytics-traffic-index-contract.
const WINNERS = Object.freeze([
  ["latest", "TRUE"],
  ["currency", `e."currency" ~ '^[A-Z]{3}$'`],
  ["price", `e."observedPriceCents" >= 0`],
  ["status", `e."eventType" IN ('SUBSCRIBED_FREE','SUBSCRIBED_PAID','SUBSCRIBED_UNKNOWN','RENEWED','RESUBSCRIBED','EXPIRED')`],
  ["started", `e."eventType" IN ('SUBSCRIBED_FREE','SUBSCRIBED_PAID','SUBSCRIBED_UNKNOWN','RESUBSCRIBED')`],
  ["renewed", `e."eventType" = 'RENEWED'`],
  ["renewal", `e."eventType" IN ('AUTO_RENEW_ENABLED','AUTO_RENEW_DISABLED')`],
]);
const MAX_PROJECTION_INPUT = 2000;
const sql = `SELECT DISTINCT winners.* FROM unnest($2::text[]) AS fans(id)
  CROSS JOIN LATERAL (
    ${WINNERS.map(([, predicate]) => `(SELECT e.* FROM "CreatorSubscriptionEvent" e
      WHERE e."creatorId"=$1 AND e."fanId"=fans.id AND ${predicate}
      ORDER BY e."occurredAt" DESC,e.id DESC LIMIT 1)`).join("\nUNION ALL\n")}
  ) winners ORDER BY winners."fanId",winners."occurredAt",winners.id`;

function boundedIds(values, kind) {
  // A corrected event may move from one fan to another, repairing both owners.
  const limit = kind === "FANS" ? MAX_PROJECTION_INPUT * 2 : MAX_PROJECTION_INPUT;
  if (!Array.isArray(values) || values.length > limit) {
    throw new Error(`SUBSCRIPTION_PROJECTION_${kind}_BOUND_REQUIRED`);
  }
  return [...new Set(values.filter(value => typeof value === "string" && value.length > 0))];
}

async function stateEvents(db, creatorId, fanRecordIds) {
  const fans = boundedIds(fanRecordIds, "FANS");
  if (!fans.length) return [];
  const rows = await db.$queryRawUnsafe(sql, creatorId, fans);
  return rows.map(row => ({ ...row, fanRecordId: row.fanId }));
}

module.exports = { WINNERS, MAX_PROJECTION_INPUT, boundedIds, stateEvents, sql };
