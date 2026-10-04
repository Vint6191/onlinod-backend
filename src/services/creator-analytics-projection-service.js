"use strict";

const crypto = require("node:crypto");
const { boundedIds, stateEvents } = require("./subscription-projection-source");
const { writeStates, writePayments } = require("./subscription-projection-store");

const PAID_EVENT_TYPES = new Set(["SUBSCRIBED_PAID", "RENEWED", "RESUBSCRIBED"]);
const ACTIVE_EVENT_TYPES = new Set(["SUBSCRIBED_FREE", "SUBSCRIBED_PAID", "SUBSCRIBED_UNKNOWN", "RENEWED", "RESUBSCRIBED"]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function toDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function paidPaymentType(eventType) {
  if (eventType === "RENEWED") return "RENEWAL";
  if (eventType === "RESUBSCRIBED") return "RESUBSCRIPTION";
  return "INITIAL";
}

function projectSubscriptionState(events) {
  let status = "UNKNOWN";
  let currentPriceCents = null;
  let currency = "USD";
  let startedAt = null;
  let expiresAt = null;
  let lastRenewedAt = null;
  let endedAt = null;
  let autoRenewEnabled = null;
  let lastEvent = null;

  for (const event of events) {
    const occurredAt = toDate(event.occurredAt);
    if (!occurredAt) continue;
    lastEvent = event;
    if (typeof event.currency === "string" && /^[A-Z]{3}$/.test(event.currency)) currency = event.currency;
    if (Number.isInteger(event.observedPriceCents) && event.observedPriceCents >= 0) currentPriceCents = event.observedPriceCents;

    if (ACTIVE_EVENT_TYPES.has(event.eventType)) {
      status = "ACTIVE";
      endedAt = null;
      if (["SUBSCRIBED_FREE", "SUBSCRIBED_PAID", "SUBSCRIBED_UNKNOWN", "RESUBSCRIBED"].includes(event.eventType)) {
        startedAt = occurredAt;
        expiresAt = null;
      }
      if (event.eventType === "RENEWED") lastRenewedAt = occurredAt;
    } else if (event.eventType === "EXPIRED") {
      status = "EXPIRED";
      endedAt = occurredAt;
    } else if (event.eventType === "AUTO_RENEW_ENABLED") {
      autoRenewEnabled = true;
    } else if (event.eventType === "AUTO_RENEW_DISABLED") {
      autoRenewEnabled = false;
    }
    // REFUNDED is a financial fact. It does not prove the subscription itself
    // ended, so it deliberately does not mutate status.
  }

  if (!lastEvent) return null;
  return {
    status,
    currentPriceCents,
    currency,
    startedAt,
    expiresAt,
    lastRenewedAt,
    endedAt,
    autoRenewEnabled,
    lastEventAt: toDate(lastEvent.occurredAt),
    updatedFromEventId: lastEvent.id,
  };
}

function defaultDb(db) {
  return db || require("../prisma");
}

async function projectSubscriptionFacts({ db = null, agencyId, creatorId, fanRecordIds, eventIds, now = new Date() }) {
  db = defaultDb(db);
  const fans = boundedIds(fanRecordIds, "FANS");
  const ids = boundedIds(eventIds, "EVENTS");
  // The caller holds the creator notification-ingest transaction lock. Only
  // this committed batch's canonical events can change paid projections.
  const events = await db.creatorSubscriptionEvent.findMany({
    where: { agencyId, creatorId, id: { in: ids } },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: ids.length,
  });
  const byFan = new Map();
  let paidInserted = 0;
  let paidUpdated = 0;
  const payments = [], inactive = [];
  const fingerprints = events.map(event => sha256(`paid-subscription|${creatorId}|${event.eventFingerprint}`));
  const existingRows = ids.length ? await db.creatorPaidSubscription.findMany({
    where: { creatorId, OR: [{ subscriptionEventId: { in: ids } }, { eventFingerprint: { in: fingerprints } },
      { externalTransactionId: { in: events.map(event => event.externalTransactionId).filter(Boolean) } }] },
    // Three independent unique identities can each resolve one row per event.
    take: ids.length * 3,
  }) : [];
  const byIdentity = new Map();
  function index(row) {
    for (const key of [`f:${row.eventFingerprint}`, ...(row.subscriptionEventId ? [`e:${row.subscriptionEventId}`] : []),
      ...(row.externalTransactionId ? [`t:${row.externalTransactionId}`] : [])]) byIdentity.set(key, row);
  }
  existingRows.forEach(index);

  for (const event of events) {
    if (!PAID_EVENT_TYPES.has(event.eventType) || !Number.isInteger(event.observedPriceCents) || event.observedPriceCents <= 0) {
      // A corrected source event can cease to prove a payment. Remove only its
      // own projection; never remove a different transaction's canonical row.
      inactive.push(event.id);
      continue;
    }
    const fingerprint = sha256(`paid-subscription|${creatorId}|${event.eventFingerprint}`);
    const matches = [...new Map([`f:${fingerprint}`, `e:${event.id}`, ...(event.externalTransactionId ? [`t:${event.externalTransactionId}`] : [])]
      .map(key => byIdentity.get(key)).filter(Boolean).map(row => [row.id, row])).values()];
    if (matches.length > 1 || (matches[0]?.subscriptionEventId && matches[0].subscriptionEventId !== event.id)) {
      throw Object.assign(new Error("Subscription payment identities disagree"), { code: "SUBSCRIPTION_PAYMENT_IDENTITY_CONFLICT" });
    }
    const existing = matches[0];
    const data = {
      agencyId,
      creatorId,
      fanRecordId: event.fanRecordId,
      fanOnlyFansUserIdAtEvent: event.fanOnlyFansUserIdAtEvent || null,
      fanUsernameAtEvent: event.fanUsernameAtEvent || null,
      fanDisplayNameAtEvent: event.fanDisplayNameAtEvent || null,
      fanAvatarUrlAtEvent: event.fanAvatarUrlAtEvent || null,
      eventFingerprint: fingerprint,
      externalTransactionId: event.externalTransactionId || null,
      subscriptionEventId: event.id,
      paymentType: paidPaymentType(event.eventType),
      amountCents: event.observedPriceCents,
      currency: event.currency || "USD",
      paidAt: event.occurredAt,
      periodFrom: event.occurredAt,
      periodTo: null,
      source: event.source || "NOTIFICATION",
      sourceUpdatedAt: event.sourceUpdatedAt || null,
      collectedAt: event.collectedAt || now,
      sourceDeviceId: event.sourceDeviceId || null,
      sourceJobId: event.sourceJobId || null,
      updatedAt: now,
    };
    if (existing) {
      payments.push({ id: existing.id, createdAt: existing.createdAt || now, ...data });
      paidUpdated += 1;
    } else {
      payments.push({ id: crypto.randomUUID(), createdAt: now, ...data });
      paidInserted += 1;
    }
    index(payments[payments.length - 1]);
  }
  if (inactive.length) await db.creatorPaidSubscription.deleteMany({ where: { creatorId, subscriptionEventId: { in: inactive } } });
  await writePayments(db, payments);

  for (const event of await stateEvents(db, creatorId, fans)) {
    const rows = byFan.get(event.fanRecordId) || [];
    rows.push(event);
    byFan.set(event.fanRecordId, rows);
  }
  let stateUpserts = 0;
  const states = [], emptyFans = [];
  for (const fanRecordId of fans) {
    const fanEvents = byFan.get(fanRecordId) || [];
    const projected = projectSubscriptionState(fanEvents);
    if (!projected) {
      emptyFans.push(fanRecordId);
      continue;
    }
    states.push({ id: crypto.randomUUID(), agencyId, creatorId, fanRecordId, ...projected, createdAt: now, updatedAt: now });
    stateUpserts += 1;
  }
  // Release old unique event pointers before assigning the whole affected set.
  // Two corrected events can exchange fans in one batch. This stays within the
  // caller's creator fact transaction, so readers never see the interim state.
  if (fans.length) await db.creatorSubscriptionState.updateMany({ where: { creatorId, fanRecordId: { in: fans } }, data: { updatedFromEventId: null } });
  if (emptyFans.length) await db.creatorSubscriptionState.deleteMany({ where: { creatorId, fanRecordId: { in: emptyFans } } });
  await writeStates(db, states);

  return { stateUpserts, paidInserted, paidUpdated };
}

async function upsertLocalMessageCoverage({
  db = null,
  agencyId,
  creatorId,
  deviceId,
  complete,
  knownDialogs,
  incompleteDialogs,
  oldestMessageAt = null,
  newestMessageAt = null,
  messagesIndexed = 0,
  verifiedAt = new Date(),
}) {
  db = defaultDb(db);
  const oldest = toDate(oldestMessageAt);
  const newest = toDate(newestMessageAt);
  const dialogsCovered = Math.max(0, Number(knownDialogs || 0) - Number(incompleteDialogs || 0));
  const status = Number(knownDialogs || 0) === 0 ? "MISSING" : complete ? "COMPLETE" : "PARTIAL";
  const data = {
    agencyId,
    creatorId,
    deviceId,
    oldestMessageAt: oldest,
    newestMessageAt: newest,
    dialogsCovered,
    messagesIndexed: Math.max(0, Math.floor(Number(messagesIndexed || 0))),
    coverageStatus: status,
    lastVerifiedAt: verifiedAt,
    updatedAt: verifiedAt,
  };
  await db.creatorLocalMessageCoverage.upsert({
    where: { creatorId_deviceId: { creatorId, deviceId } },
    create: { id: crypto.randomUUID(), createdAt: verifiedAt, ...data },
    update: data,
  });
  return data;
}

module.exports = {
  projectSubscriptionState,
  projectSubscriptionFacts,
  upsertLocalMessageCoverage,
};
