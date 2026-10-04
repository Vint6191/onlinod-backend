"use strict";
const crypto = require("node:crypto");

// Keep the existing notification lock identity: current Financial and even a
// draining old Notification writer must serialize before reading shared facts.
async function lockCreatorFacts(db, agencyId, creatorId) {
  if (typeof db?.$executeRawUnsafe !== "function") return;
  const key = `notification-facts:${agencyId}:${creatorId}`;
  const value = crypto.createHash("sha256").update(key).digest().readBigInt64BE(0);
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock($1::bigint)", value.toString());
}

function mergeNotificationMoney(model, existing, incoming) {
  if (!existing || !["creatorSale", "creatorTip"].includes(model)) return incoming;
  const merged = { ...incoming,
    externalTransactionId: existing.externalTransactionId || incoming.externalTransactionId || null,
    externalNotificationId: existing.externalNotificationId || incoming.externalNotificationId || null,
    messageId: incoming.messageId || existing.messageId || null,
  };
  if (model === "creatorSale") merged.postId = incoming.postId || existing.postId || null;
  if (existing.source !== "ONLYFANS_API" || !existing.externalTransactionId) return merged;
  // Notification identifies message/post ownership; payout is the money
  // authority. A late or incomplete notification cannot demote the payout row.
  // sourceJobId/collectedAt remain the current ingest association used by the
  // existing consequence dispatcher. Payout provenance is held by the separate
  // CreatorFinancialTransaction ledger; do not steal the notification receipt.
  for (const field of ["amountCents", "currency", "source", "sourceUpdatedAt",
    ...(model === "creatorSale" ? ["saleType", "purchasedAt"] : ["tippedAt"])]) merged[field] = existing[field];
  if (existing.fanRecordId) {
    for (const field of ["fanRecordId", "fanOnlyFansUserIdAtEvent", "fanUsernameAtEvent", "fanDisplayNameAtEvent", "fanAvatarUrlAtEvent"]) {
      if (existing[field] != null) merged[field] = existing[field];
    }
  }
  if (model === "creatorSale") {
    if (existing.saleType === "MESSAGE") merged.postId = null;
    if (existing.saleType === "POST") merged.messageId = null;
  }
  return merged;
}

function retainKnownFan(existing, incoming) {
  if (!existing || (incoming.fanRecordId && incoming.fanRecordId !== existing.fanRecordId)) return incoming;
  const merged = { ...incoming };
  for (const field of ["fanRecordId", "fanOnlyFansUserId", "fanOnlyFansUserIdAtEvent", "fanUsernameAtEvent", "fanDisplayNameAtEvent", "fanAvatarUrlAtEvent"]) {
    if (Object.hasOwn(incoming, field) && incoming[field] == null && existing[field] != null) merged[field] = existing[field];
  }
  return merged;
}

function transactionIdentityConflict(existing, incoming) {
  return Boolean(existing?.externalTransactionId && incoming?.externalTransactionId
    && existing.externalTransactionId !== incoming.externalTransactionId);
}

module.exports = { lockCreatorFacts, mergeNotificationMoney, transactionIdentityConflict, retainKnownFan };
