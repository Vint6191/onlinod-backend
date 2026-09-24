"use strict";
const { runDbTransaction } = require("./db-transaction-service");

const { randomUUID } = require("node:crypto");
const { runRootCommit } = require("./db-commit-kernel");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const PAID_TYPES = new Set(["paid_subscribed", "subscription_renewed", "subscription_resubscribed"]);
function clean(value, max = 220) { return String(value ?? "").trim().slice(0, max) || null; }
function fault(code) { return Object.assign(new Error(code), { code, status: 409 }); }

// Sole application producer of the paid compatibility receipt. Inputs must be
// projections of scoped canonical DB facts, never raw client money events.
async function projectWithinTransaction({ db, job, fact, historyPolicy }) {
  const agencyId = job.agencyId, creatorId = job.creatorId;
  const eventHash = clean(fact.eventHash);
  const eventType = String(fact.eventType || "").toLowerCase();
  if (!PAID_TYPES.has(eventType)) {
    if (!eventHash) return { ignored: true };
    const removed = await db.creatorSubscriptionLedger.deleteMany({ where: {
      agencyId, creatorId, eventHash, source: "canonical_subscription_fact",
    } });
    return { ignored: true, invalidReceiptRemoved: removed.count };
  }
  const fanId = clean(fact.fanId, 180), amountCents = Number(fact.amountCents || 0);
  if (!fanId || amountCents <= 0) return { ignored: true };
  if (!eventHash) throw fault("NOTIFICATION_FACT_IDENTITY_REQUIRED");
  const occurredAt = new Date(fact.subscribedAt || fact.occurredAt || NaN);
  if (!Number.isFinite(occurredAt.getTime())) throw fault("NOTIFICATION_FACT_TIME_REQUIRED");
  const source = await db.trafficSourceMember.findFirst({
    where: { agencyId, creatorId, fanId, source: { is: { agencyId, creatorId } } },
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }], select: { sourceId: true },
  });
  if (historyPolicy?.organicCutoff && !source?.sourceId && occurredAt < historyPolicy.organicCutoff) {
    return { ignored: true, retentionExcluded: true };
  }
  // ON CONFLICT DO NOTHING works across old/new processes too: no aborted
  // transaction after a Prisma P2002, and no preliminary read/insert race.
  const inserted = await db.creatorSubscriptionLedger.createMany({ data: [{
    id: `sub_${randomUUID()}`, agencyId, creatorId, accountId: job.params?.accountId || creatorId,
    fanId, sourceId: source?.sourceId || null, eventHash, eventType, amountCents,
    currency: clean(fact.currency, 8) || "USD", occurredAt,
    externalEventId: clean(fact.externalEventId || fact.notificationId || eventHash),
    source: "canonical_subscription_fact",
  }], skipDuplicates: true });
  const row = await db.creatorSubscriptionLedger.findUnique({ where: { agencyId_eventHash: { agencyId, eventHash } } });
  if (!row) throw fault("NOTIFICATION_RECEIPT_MISSING");
  if (row.creatorId !== creatorId || row.fanId !== fanId) throw fault("NOTIFICATION_FACT_SCOPE_MISMATCH");
  if (row.sourceId) {
    const where = { agencyId, creatorId, sourceId: row.sourceId, fanId };
    await db.trafficSourceMember.updateMany({ where, data: { needsValueRefresh: true } });
    await db.trafficSourceMember.updateMany({ where: { ...where,
      OR: [{ lastRevenueAt: null }, { lastRevenueAt: { lt: row.occurredAt } }] }, data: { lastRevenueAt: row.occurredAt } });
    await db.trafficSourceMember.updateMany({ where: { ...where,
      OR: [{ convertedAt: null }, { convertedAt: { gt: row.occurredAt } }] }, data: { convertedAt: row.occurredAt } });
  }
  return { ignored: false, ledgerId: row.id, sourceId: row.sourceId, duplicate: inserted.count === 0 };
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
    return projectWithinTransaction({ db: tx, job, fact, historyPolicy });
  }, { profile: "JOB_CHUNK", authority: { kind: "CANONICAL_SUBSCRIPTION_PROJECTION", agencyId: job.agencyId, creatorId: job.creatorId } });
}

module.exports = { projectCanonicalSubscriptionReceipt };
