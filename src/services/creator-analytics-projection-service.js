"use strict";

const crypto = require("node:crypto");

const DAILY_METRICS_VERSION = 1;
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

function utcDay(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayKey(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function asCount(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function asMoney(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
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

async function projectSubscriptionFacts({ db = null, agencyId, creatorId, fanRecordIds = null, now = new Date() }) {
  db = defaultDb(db);
  const filter = { creatorId, fanRecordId: { not: null } };
  if (Array.isArray(fanRecordIds) && fanRecordIds.length) filter.fanRecordId = { in: [...new Set(fanRecordIds.filter(Boolean))] };
  const events = await db.creatorSubscriptionEvent.findMany({
    where: filter,
    orderBy: [{ fanRecordId: "asc" }, { occurredAt: "asc" }, { id: "asc" }],
  });
  const byFan = new Map();
  let paidInserted = 0;
  let paidUpdated = 0;

  for (const event of events) {
    if (!event.fanRecordId) continue;
    const rows = byFan.get(event.fanRecordId) || [];
    rows.push(event);
    byFan.set(event.fanRecordId, rows);

    if (!PAID_EVENT_TYPES.has(event.eventType) || !Number.isInteger(event.observedPriceCents) || event.observedPriceCents <= 0) continue;
    const fingerprint = sha256(`paid-subscription|${creatorId}|${event.eventFingerprint}`);
    const transactionOr = event.externalTransactionId ? [{ externalTransactionId: event.externalTransactionId }] : [];
    const existing = await db.creatorPaidSubscription.findFirst({
      where: {
        creatorId,
        OR: [
          { eventFingerprint: fingerprint },
          { subscriptionEventId: event.id },
          ...transactionOr,
        ],
      },
      select: { id: true },
    });
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
      await db.creatorPaidSubscription.update({ where: { id: existing.id }, data });
      paidUpdated += 1;
    } else {
      await db.creatorPaidSubscription.create({ data: { id: crypto.randomUUID(), createdAt: now, ...data } });
      paidInserted += 1;
    }
  }

  let stateUpserts = 0;
  for (const [fanRecordId, fanEvents] of byFan) {
    const projected = projectSubscriptionState(fanEvents);
    if (!projected) continue;
    await db.creatorSubscriptionState.upsert({
      where: { creatorId_fanRecordId: { creatorId, fanRecordId } },
      create: { id: crypto.randomUUID(), agencyId, creatorId, fanRecordId, ...projected, createdAt: now, updatedAt: now },
      update: { ...projected, updatedAt: now },
    });
    stateUpserts += 1;
  }

  return { stateUpserts, paidInserted, paidUpdated };
}

function makeDayMap(from, to) {
  const start = utcDay(from);
  const end = utcDay(to);
  if (!start || !end || end < start) throw new Error("Daily metrics range is invalid");
  const map = new Map();
  const cursor = new Date(start);
  while (cursor <= end) {
    if (map.size >= 370) throw new Error("Daily metrics range exceeds 370 UTC days");
    const key = cursor.toISOString().slice(0, 10);
    map.set(key, {
      date: new Date(cursor),
      incomingMessages: 0,
      outgoingMessages: 0,
      uniqueDialogs: 0,
      likes: 0,
      uniqueLikingFans: 0,
      comments: 0,
      uniqueCommentingFans: 0,
      newSubscribers: 0,
      renewals: 0,
      expiredSubscribers: 0,
      autoRenewDisabled: 0,
      messageSales: 0,
      postSales: 0,
      uniqueBuyers: 0,
      tipsCount: 0,
      tipsCents: 0,
      paidSubscriptions: 0,
      paidSubscriptionsCents: 0,
      salesCents: 0,
      totalObservedRevenueCents: 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return map;
}

function mergeRows(map, rows, mappings) {
  for (const raw of rows || []) {
    const key = dayKey(raw.day ?? raw.date);
    const row = key ? map.get(key) : null;
    if (!row) continue;
    for (const [target, source, kind] of mappings) {
      row[target] = kind === "money" ? asMoney(raw[source]) : asCount(raw[source]);
    }
  }
}

async function queryDaily(db, sql, creatorId, from, toExclusive) {
  if (typeof db.$queryRawUnsafe !== "function") return [];
  return db.$queryRawUnsafe(sql, creatorId, from, toExclusive);
}

async function rebuildCreatorDailyMetrics({ db = null, agencyId, creatorId, from, to, now = new Date() }) {
  db = defaultDb(db);
  const map = makeDayMap(from, to);
  const start = utcDay(from);
  const end = utcDay(to);
  const endExclusive = new Date(end.getTime() + 86_400_000);

  const [messages, likes, comments, subscriptions, sales, tips, paidSubscriptions] = await Promise.all([
    queryDaily(db, `SELECT "date" AS day, SUM("incomingMessages")::bigint AS incoming, SUM("outgoingMessages")::bigint AS outgoing, MAX("uniqueDialogs")::bigint AS dialogs FROM "CreatorMessagesDaily" WHERE "creatorId"=$1 AND "date">=$2 AND "date"<$3 GROUP BY "date"`, creatorId, start, endExclusive),
    queryDaily(db, `SELECT date_trunc('day', "likedAt") AS day, COUNT(*)::bigint AS count, COUNT(DISTINCT "fanId")::bigint AS fans FROM "CreatorPostLike" WHERE "creatorId"=$1 AND "likedAt">=$2 AND "likedAt"<$3 GROUP BY 1`, creatorId, start, endExclusive),
    queryDaily(db, `SELECT date_trunc('day', "commentedAt") AS day, COUNT(*)::bigint AS count, COUNT(DISTINCT "fanId")::bigint AS fans FROM "CreatorPostComment" WHERE "creatorId"=$1 AND "commentedAt">=$2 AND "commentedAt"<$3 GROUP BY 1`, creatorId, start, endExclusive),
    queryDaily(db, `SELECT date_trunc('day', "occurredAt") AS day, COUNT(*) FILTER (WHERE "eventType" IN ('SUBSCRIBED_FREE','SUBSCRIBED_PAID','SUBSCRIBED_UNKNOWN'))::bigint AS subscribed, COUNT(*) FILTER (WHERE "eventType"='RENEWED')::bigint AS renewed, COUNT(*) FILTER (WHERE "eventType"='EXPIRED')::bigint AS expired, COUNT(*) FILTER (WHERE "eventType"='AUTO_RENEW_DISABLED')::bigint AS auto_renew_disabled FROM "CreatorSubscriptionEvent" WHERE "creatorId"=$1 AND "occurredAt">=$2 AND "occurredAt"<$3 GROUP BY 1`, creatorId, start, endExclusive),
    queryDaily(db, `SELECT date_trunc('day', "purchasedAt") AS day, COUNT(*) FILTER (WHERE "saleType"='MESSAGE')::bigint AS message_sales, COUNT(*) FILTER (WHERE "saleType"='POST')::bigint AS post_sales, COUNT(DISTINCT "fanId")::bigint AS buyers, COALESCE(SUM("amountCents"),0)::bigint AS cents FROM "CreatorSale" WHERE "creatorId"=$1 AND "purchasedAt">=$2 AND "purchasedAt"<$3 GROUP BY 1`, creatorId, start, endExclusive),
    queryDaily(db, `SELECT date_trunc('day', "tippedAt") AS day, COUNT(*)::bigint AS count, COALESCE(SUM("amountCents"),0)::bigint AS cents FROM "CreatorTip" WHERE "creatorId"=$1 AND "tippedAt">=$2 AND "tippedAt"<$3 GROUP BY 1`, creatorId, start, endExclusive),
    queryDaily(db, `SELECT date_trunc('day', "paidAt") AS day, COUNT(*)::bigint AS count, COALESCE(SUM("amountCents"),0)::bigint AS cents FROM "CreatorPaidSubscription" WHERE "creatorId"=$1 AND "paidAt">=$2 AND "paidAt"<$3 GROUP BY 1`, creatorId, start, endExclusive),
  ]);

  mergeRows(map, messages, [["incomingMessages", "incoming"], ["outgoingMessages", "outgoing"], ["uniqueDialogs", "dialogs"]]);
  mergeRows(map, likes, [["likes", "count"], ["uniqueLikingFans", "fans"]]);
  mergeRows(map, comments, [["comments", "count"], ["uniqueCommentingFans", "fans"]]);
  mergeRows(map, subscriptions, [["newSubscribers", "subscribed"], ["renewals", "renewed"], ["expiredSubscribers", "expired"], ["autoRenewDisabled", "auto_renew_disabled"]]);
  mergeRows(map, sales, [["messageSales", "message_sales"], ["postSales", "post_sales"], ["uniqueBuyers", "buyers"], ["salesCents", "cents", "money"]]);
  mergeRows(map, tips, [["tipsCount", "count"], ["tipsCents", "cents", "money"]]);
  mergeRows(map, paidSubscriptions, [["paidSubscriptions", "count"], ["paidSubscriptionsCents", "cents", "money"]]);

  for (const row of map.values()) {
    row.totalObservedRevenueCents = row.salesCents + row.tipsCents + row.paidSubscriptionsCents;
    const data = {
      agencyId,
      creatorId,
      ...row,
      sourceTimezone: "UTC",
      calculatedAt: now,
      dataVersion: DAILY_METRICS_VERSION,
      updatedAt: now,
    };
    await db.creatorDailyMetrics.upsert({
      where: { creatorId_date_sourceTimezone: { creatorId, date: row.date, sourceTimezone: "UTC" } },
      create: { id: crypto.randomUUID(), createdAt: now, ...data },
      update: data,
    });
  }
  return { days: map.size, from: start, to: end };
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
  DAILY_METRICS_VERSION,
  projectSubscriptionState,
  projectSubscriptionFacts,
  rebuildCreatorDailyMetrics,
  upsertLocalMessageCoverage,
};
