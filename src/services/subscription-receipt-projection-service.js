"use strict";
const { runDbTransaction } = require("./db-transaction-service");

const { randomUUID, createHash } = require("node:crypto");
const { runRootCommit } = require("./db-commit-kernel");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { lockCreatorFacts } = require("./creator-fact-write-authority");
const { isCanonicalUsdCurrency } = require("./usd-money-contract");
const PAID_TYPES = new Set(["paid_subscribed", "subscription_renewed", "subscription_resubscribed"]);
const SOURCE = "canonical_subscription_fact";
function clean(value, max = 220) { return String(value ?? "").trim().slice(0, max) || null; }
function fault(code) { return Object.assign(new Error(code), { code, status: 409 }); }
function canonicalReceiptIdentity(agencyId, creatorId, eventId) {
  return createHash("sha256").update(JSON.stringify(["canonical-subscription-receipt-v2", agencyId, creatorId, eventId])).digest("hex");
}
function receiptScope(job, fact, eventHash) {
  const aliases = [
    { eventHash },
    ...(fact.eventHash && fact.eventHash !== eventHash ? [{ eventHash: fact.eventHash }] : []),
    ...(fact.canonicalEventId && fact.notificationId ? [{ externalEventId: fact.notificationId }] : []),
  ];
  return { agencyId: job.agencyId, creatorId: job.creatorId, source: SOURCE,
    ...(aliases.length === 1 ? aliases[0] : { OR: aliases }) };
}

// A source reclassification can retire the canonical event altogether. Its
// retained correction receipt supplies the exact former ID and fingerprint.
// Delete only this owner's receipts; a newly recreated current event remains
// authoritative and will be reconciled by the normal projection path.
async function retireCanonicalSubscriptionReceipt({ db, job, event }) {
  const current = await db.creatorSubscriptionEvent.findFirst({ where: {
    agencyId: job.agencyId, creatorId: job.creatorId,
    OR: [{ id: event.id }, { eventFingerprint: event.eventFingerprint },
      ...(event.externalNotificationId ? [{ externalNotificationId: event.externalNotificationId }] : [])],
  }, select: { id: true } });
  if (current) return { ignored: true, currentCanonicalEvent: true };
  return db.creatorSubscriptionLedger.deleteMany({ where: receiptScope(job, {
    canonicalEventId: event.id, eventHash: event.eventFingerprint, notificationId: event.externalNotificationId,
  }, canonicalReceiptIdentity(job.agencyId, job.creatorId, event.id)) });
}

// Sole application producer of the paid compatibility receipt. Inputs must be
// projections of scoped canonical DB facts, never raw client money events.
async function projectWithinTransaction({ db, job, fact, historyPolicy }) {
  const agencyId = job.agencyId, creatorId = job.creatorId;
  // Only a scoped canonical row authorizes changing its fan. Reading under the
  // shared creator fact lock also makes an old queued projection use the latest
  // correction instead of restoring a previously captured amount or identity.
  if (fact.canonicalEventId) {
    const current = await db.creatorSubscriptionEvent.findFirst({ where: {
      id: fact.canonicalEventId, agencyId, creatorId,
    }, include: { fan: { select: { onlyFansUserId: true, username: true, displayName: true } } } });
    if (!current) throw fault("NOTIFICATION_FACT_SCOPE_MISMATCH");
    fact = require("./team-observation-service").projectSubscriptionProjectionFact(current);
  }
  const eventHash = fact.canonicalEventId
    ? canonicalReceiptIdentity(agencyId, creatorId, fact.canonicalEventId) : clean(fact.eventHash);
  const eventType = String(fact.eventType || "").toLowerCase();
  const fanId = clean(fact.fanId, 180), amountCents = fact.amountCents;
  if (!isCanonicalUsdCurrency(fact.currency) || !PAID_TYPES.has(eventType) || !fanId || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    if (!eventHash) return { ignored: true };
    const removed = await db.creatorSubscriptionLedger.deleteMany({ where: receiptScope(job, fact, eventHash) });
    return { ignored: true, invalidReceiptRemoved: removed.count };
  }
  if (!eventHash) throw fault("NOTIFICATION_FACT_IDENTITY_REQUIRED");
  const occurredAt = new Date(fact.subscribedAt || fact.occurredAt || NaN);
  if (!Number.isFinite(occurredAt.getTime())) throw fault("NOTIFICATION_FACT_TIME_REQUIRED");

  let row = await db.creatorSubscriptionLedger.findUnique({ where: { agencyId_eventHash: { agencyId, eventHash } } });
  if (row && (row.creatorId !== creatorId || (!fact.canonicalEventId && row.fanId !== fanId))) throw fault("NOTIFICATION_FACT_SCOPE_MISMATCH");
  if (row && row.source !== SOURCE) throw fault("NOTIFICATION_FACT_SOURCE_MISMATCH");
  // Legacy keys used a mutable event fingerprint. Strengthening notification
  // identity with a transaction, or correcting a legacy price, must not leave
  // a second paid receipt. Exact notification ownership is indexed and scoped.
  const scope = receiptScope(job, fact, eventHash);
  const legacy = fact.canonicalEventId ? await db.creatorSubscriptionLedger.findMany({
    where: { ...scope, eventHash: { not: eventHash } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100,
  }) : [];
  if (!row) row = legacy.find(item => item.fanId === fanId && item.sourceId) || legacy.find(item => item.fanId === fanId) || legacy[0] || null;
  const sameFan = row?.fanId === fanId;
  const source = sameFan ? { sourceId: row.sourceId } : await db.trafficSourceMember.findFirst({
    where: { agencyId, creatorId, fanId, source: { is: { agencyId, creatorId } } },
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }], select: { sourceId: true },
  });
  if (historyPolicy?.organicCutoff && !source?.sourceId && occurredAt < historyPolicy.organicCutoff) {
    const removed = await db.creatorSubscriptionLedger.deleteMany({ where: scope });
    return { ignored: true, retentionExcluded: true, invalidReceiptRemoved: removed.count };
  }
  const data = {
    accountId: job.params?.accountId || row?.accountId || creatorId,
    fanId, sourceId: source?.sourceId || null, eventHash, eventType, amountCents,
    currency: "USD", occurredAt,
    externalEventId: clean(fact.externalEventId || fact.notificationId || eventHash),
    source: SOURCE,
    ...(row && !sameFan ? { attributionAttempts: 0, organicConfirmed: false } : {}),
  };
  let inserted = { count: 0 }, updated = false;
  if (!row) {
    inserted = await db.creatorSubscriptionLedger.createMany({ data: [{ id: `sub_${randomUUID()}`, agencyId, creatorId, ...data }], skipDuplicates: true });
    row = await db.creatorSubscriptionLedger.findUnique({ where: { agencyId_eventHash: { agencyId, eventHash } } });
  }
  if (!row) throw fault("NOTIFICATION_RECEIPT_MISSING");
  if (row.creatorId !== creatorId || (!fact.canonicalEventId && row.fanId !== fanId)) throw fault("NOTIFICATION_FACT_SCOPE_MISMATCH");
  if (row.source !== SOURCE) throw fault("NOTIFICATION_FACT_SOURCE_MISMATCH");
  if (Object.entries(data).some(([key, value]) => key === "occurredAt" ? +new Date(row[key]) !== +value : row[key] !== value)) {
    row = await db.creatorSubscriptionLedger.update({ where: { id: row.id }, data });
    updated = true;
  }
  const adopted = fact.canonicalEventId ? await db.creatorSubscriptionLedger.deleteMany({ where: { ...scope, id: { not: row.id } } }) : { count: 0 };
  // The receipt capture trigger publishes TRAFFIC_FACT in this transaction.
  // The Traffic worker owns member conversion metadata and monetary deltas.
  // A canonical producer must not lock derived member rows after publishing.
  return { ignored: false, ledgerId: row.id, sourceId: row.sourceId, duplicate: inserted.count === 0, updated, duplicateReceiptsRemoved: adopted.count };
}

async function projectCanonicalSubscriptionReceipt({ db, job, fact, historyPolicy = null }) {
  if (!db || !job?.agencyId || !job?.creatorId) throw fault("NOTIFICATION_FACT_SCOPE_REQUIRED");
  if (typeof db.$transaction !== "function") {
    // Durable/history consumers join only their live kernel-issued attempt.
    return runDbTransaction(db, tx => projectWithinTransaction({ db: tx, job, fact, historyPolicy }));
  }
  // Full-mode compatibility may run after collector commit. Its individual
  // receipt still needs an atomic root and a current tenant lifecycle fence.
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: job.agencyId });
    const creators = await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE', job.creatorId, job.agencyId);
    if (!lifecycle.row || lifecycle.row.deletedAt || !creators.length) throw fault("NOTIFICATION_PROJECTION_SCOPE_RETIRED");
    await lockCreatorFacts(tx, job.agencyId, job.creatorId);
    return projectWithinTransaction({ db: tx, job, fact, historyPolicy });
  }, { profile: "JOB_CHUNK", authority: { kind: "CANONICAL_SUBSCRIPTION_PROJECTION", agencyId: job.agencyId, creatorId: job.creatorId } });
}

module.exports = { projectCanonicalSubscriptionReceipt, canonicalReceiptIdentity, retireCanonicalSubscriptionReceipt };
