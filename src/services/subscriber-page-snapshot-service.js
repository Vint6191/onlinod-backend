"use strict";

// A run owns one current observation per fan; page receipts own raw traversal.
// Keep production updates set-based and bounded by the 100-row page limit.
const UPDATE_COLUMNS = [
  "pageOffset", "dialogId", "username", "name", "avatarUrl", "totalSpentCents",
  "messagesSpentCents", "tipsSpentCents", "subscriptionsSpentCents", "postsSpentCents", "streamsSpentCents",
  "valueAvailability", "lastSeenAt", "lastSeenIsNull", "canReceiveChatMessage", "isActive", "subscribedOn", "subscribedBy",
  "subscriptionType", "fanSubscribesToCreator", "fanSubscriptionActive", "fanSubscriptionExpiresAt", "creatorFollowsFan",
  "creatorFollowExpiresAt", "blocked", "restricted", "performer", "subscribePriceCents", "contentHash", "metadata", "observedAt",
];

async function writeSubscriberPageSnapshot(db, { items, priorByFan, runId, agencyId, creatorId }) {
  const added = items.filter(item => !priorByFan.has(item.fanId));
  const repeated = items.filter(item => priorByFan.has(item.fanId));
  let written = 0;
  if (added.length) {
    const result = await db.subscriberScanItem.createMany({ data: added });
    written += Number(result.count);
  }
  if (repeated.length && typeof db.$executeRawUnsafe === "function") {
    written += Number(await db.$executeRawUnsafe(`
      UPDATE "SubscriberScanItem" AS target
      SET ${UPDATE_COLUMNS.map(name => `"${name}" = source."${name}"`).join(', ')}
      FROM jsonb_populate_recordset(NULL::"SubscriberScanItem", $1::jsonb) AS source
      WHERE target."runId" = $2 AND target."agencyId" = $3 AND target."creatorId" = $4
        AND source."runId" = $2 AND source."agencyId" = $3 AND source."creatorId" = $4
        AND target."fanId" = source."fanId"
    `, JSON.stringify(repeated), runId, agencyId, creatorId));
  } else {
    // Semantic adapter for in-memory tests; PostgreSQL always takes one UPDATE.
    for (const item of repeated) {
      const data = Object.fromEntries(UPDATE_COLUMNS.map(name => [name, item[name]]));
      await db.subscriberScanItem.update({ where: { runId_fanId: { runId, fanId: item.fanId } }, data });
      written++;
    }
  }
  if (written !== items.length) {
    throw Object.assign(new Error("Subscriber snapshot write count does not match the page"), { code: "SUBSCRIBER_SNAPSHOT_WRITE_CONFLICT" });
  }
  return {
    addedCount: added.length,
    hiddenDelta: items.reduce((sum, item) => sum + Number(item.lastSeenIsNull === true)
      - Number(priorByFan.get(item.fanId)?.lastSeenIsNull === true), 0),
  };
}

module.exports = { writeSubscriberPageSnapshot };
