"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { parseStrictIsoDateTime } = require("./strict-date-time");
const { projectSubscriptionFacts, rebuildCreatorDailyMetrics } = require("./creator-analytics-projection-service");
const { dispatchTeamMoneyReconciliationForCanonicalFact } = require("./team-money-reconciliation-service");
const { projectFanIdentityBatch } = require("./fan-data-authority-service");

const SERVICE_VERSION = "notification-facts-v1-history-v8-known-boundary";
const SCHEMA_VERSION = 5;
const COLLECTOR_VERSION = "notifications-history-v8-known-boundary";
const ALL_SCHEMA_VERSION = 4;
const ALL_COLLECTOR_VERSION = "notifications-all-v5";
const LEGACY_SCHEMA_VERSION = 3;
const LEGACY_COLLECTOR_VERSION = "notifications-catchup-v4";
const MAX_EVENTS_PER_BATCH = 2_000;
const NOTIFICATION_TYPES = Object.freeze(["purchases", "tips", "subscriptions", "likes", "comments"]);


function clean(value, max = 220) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function exceedsTextLimit(value, max) {
  return value !== null && value !== undefined && String(value).trim().length > max;
}
function strictDate(value) {
  return parseStrictIsoDateTime(value);
}
function centsOrNull(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) return null;
  return value;
}
function currency(value) {
  const raw = value === null || value === undefined || value === "" ? "USD" : value;
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}
function timezone(value) {
  const zone = clean(value || "UTC", 100);
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return zone;
  } catch {
    return null;
  }
}
function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function identityFingerprint(kind, creatorId, event, occurredAt, amountCents, canonicalEventType = null) {
  const notificationId = clean(event.notificationId, 220);
  const transactionId = clean(event.transactionId, 220);
  const kindId = clean(
    kind === "sale" ? event.purchaseId
      : kind === "tip" ? event.tipId
        : kind === "like" ? event.likeId
          : kind === "comment" ? event.commentId
            : event.externalEventId,
    220,
  );
  const fan = clean(event.fanId || event.dialogId, 180) || "";
  const target = clean(event.messageId || event.postId || event.commentId, 220) || "";
  const eventType = canonicalEventType || clean(event.eventType || event.type, 80) || "";
  if ((kind === "like" || kind === "comment") && kindId) {
    return sha256(`${kind}|${creatorId}|external|${kindId}`);
  }
  if (kind === "subscription") {
    if (transactionId) return sha256(`${kind}|${creatorId}|transaction|${transactionId}|${eventType || "unknown"}`);
    // OnlyFans emits the same subscription through new_message, subscribed and
    // later Notifications ALL. Some variants have a notification id and some do
    // not, but they agree on fan, lifecycle type, price and the UTC minute.
    // Use that shared semantic identity so one subscription is stored once.
    if (fan) {
      const minute = Math.floor(occurredAt.getTime() / 60_000);
      return sha256(`${kind}|${creatorId}|semantic|${fan}|${eventType}|${amountCents ?? ""}|${minute}`);
    }
    if (notificationId) return sha256(`${kind}|${creatorId}|notification|${notificationId}`);
    if (kindId) return sha256(`${kind}|${creatorId}|external|${kindId}|${eventType}`);
  }
  if (notificationId) return sha256(`${kind}|${creatorId}|notification|${notificationId}`);
  if (transactionId) return sha256(`${kind}|${creatorId}|transaction|${transactionId}`);
  if (kindId) return sha256(`${kind}|${creatorId}|external|${kindId}|${canonicalEventType || ""}`);
  const second = Math.floor(occurredAt.getTime() / 1_000);
  return sha256(`${kind}|${creatorId}|fallback|${fan}|${target}|${eventType}|${amountCents ?? ""}|${second}`);
}
function subscriptionType(rawType, amountCents) {
  const type = String(rawType || "").toLowerCase();
  if (/auto.?renew/.test(type) && /(disable|off)/.test(type)) return "AUTO_RENEW_DISABLED";
  if (/auto.?renew/.test(type) && /(enable|on)/.test(type)) return "AUTO_RENEW_ENABLED";
  if (/(refund|chargeback|reversal)/.test(type)) return "REFUNDED";
  if (/(expire|unsubscribe|ended)/.test(type)) return "EXPIRED";
  if (/(resub|re-sub)/.test(type)) return "RESUBSCRIBED";
  if (/renew/.test(type)) return "RENEWED";
  if (/free/.test(type)) return "SUBSCRIBED_FREE";
  if (/paid/.test(type)) return "SUBSCRIBED_PAID";
  if (/unknown|price.?unavailable/.test(type)) return "SUBSCRIBED_UNKNOWN";
  if (/subscrib/.test(type)) {
    if (amountCents === null) return "SUBSCRIBED_UNKNOWN";
    return amountCents > 0 ? "SUBSCRIBED_PAID" : "SUBSCRIBED_FREE";
  }
  return null;
}
function sourceTypeForRawType(rawType) {
  if (rawType.includes("purchase") || rawType.includes("ppv")) return "purchases";
  if (rawType.includes("tip")) return "tips";
  if (/comment/.test(rawType)) return "comments";
  if (/(^|[^a-z])like(d|s|ing)?([^a-z]|$)|favorite/.test(rawType)) return "likes";
  if (/subscription|subscrib|renew|expire|auto.?renew|refund|chargeback|resub/.test(rawType)) return "subscriptions";
  return null;
}
function normalizeEvent(raw, creatorId) {
  const input = object(raw);
  const event = { ...object(input.extra), ...input };
  delete event.extra;
  const rawType = String(event.eventType || event.type || "").toLowerCase();
  const sourceType = sourceTypeForRawType(rawType);
  const reject = (code) => ({ rejected: code, sourceType });
  if (sourceType !== "subscriptions" && /(refund|chargeback|reversal)/.test(rawType)) {
    return reject("UNSUPPORTED_FINANCIAL_REVERSAL_EVENT");
  }
  const boundedFields = [
    [event.eventType || event.type, 80],
    [event.notificationId, 220], [event.transactionId, 220],
    [event.purchaseId, 220], [event.tipId, 220], [event.externalEventId, 220],
    [event.fanId, 180], [event.dialogId, 180],
    [event.messageId, 220], [event.postId, 220], [event.commentId, 220], [event.likeId, 220],
    [event.fanUsername || event.username, 200],
    [event.fanName || event.name, 500],
  ];
  if (boundedFields.some(([value, max]) => exceedsTextLimit(value, max))) return reject("FIELD_TOO_LONG");
  const occurredAt = strictDate(event.purchasedAt || event.subscribedAt || event.likedAt || event.commentedAt || event.receivedAt || event.occurredAt || event.ts);
  if (!occurredAt) return reject("INVALID_OCCURRED_AT");
  const amountCents = centsOrNull(event.amountCents);
  const currencyCode = currency(event.currency);
  if (!currencyCode) return reject("INVALID_CURRENCY");

  const externalFanId = clean(event.fanId || event.dialogId, 180);
  const common = {
    sourceType,
    externalFanId,
    fanUsername: clean(event.fanUsername || event.username, 200),
    fanDisplayName: clean(event.fanName || event.name, 500),
    fanAvatarUrl: clean(event.fanAvatarUrl || event.avatarUrl || event.avatar || object(event.user).avatar || object(event.user).avatarUrl, 1200),
    externalNotificationId: clean(event.notificationId, 220),
    externalTransactionId: clean(event.transactionId, 220),
    amountCents,
    currency: currencyCode,
    occurredAt,
  };

  if (sourceType === "purchases") {
    if (amountCents === null || amountCents <= 0) return reject("INVALID_SALE_AMOUNT_CENTS");
    const messageId = clean(event.messageId, 220);
    const postId = clean(event.postId, 220);
    const fingerprint = identityFingerprint("sale", creatorId, event, occurredAt, amountCents);
    if (!common.externalNotificationId && !common.externalTransactionId && !externalFanId && !messageId && !postId) {
      return reject("SALE_IDENTITY_MISSING");
    }
    return {
      kind: "sale",
      fingerprint,
      ...common,
      saleType: postId ? "POST" : messageId ? "MESSAGE" : "OTHER",
      messageId: postId ? null : messageId,
      postId,
    };
  }

  if (sourceType === "tips") {
    if (amountCents === null || amountCents <= 0) return reject("INVALID_TIP_AMOUNT_CENTS");
    const fingerprint = identityFingerprint("tip", creatorId, event, occurredAt, amountCents);
    if (!common.externalNotificationId && !common.externalTransactionId && !externalFanId) return reject("TIP_IDENTITY_MISSING");
    return { kind: "tip", fingerprint, ...common, messageId: clean(event.messageId, 220) };
  }


  if (sourceType === "likes") {
    const likeId = clean(event.likeId, 220);
    if (!common.externalNotificationId && !likeId) return reject("LIKE_SOURCE_IDENTITY_MISSING");
    const onlyFansPostId = clean(event.postId, 220);
    if (!onlyFansPostId) return reject("LIKE_POST_ID_MISSING");
    const fingerprint = identityFingerprint("like", creatorId, event, occurredAt, null);
    return {
      kind: "like", fingerprint, ...common, amountCents: null, currency: null,
      onlyFansPostId, likeId,
    };
  }

  if (sourceType === "comments") {
    const onlyFansCommentId = clean(event.commentId, 220);
    if (!common.externalNotificationId && !onlyFansCommentId) return reject("COMMENT_SOURCE_IDENTITY_MISSING");
    const onlyFansPostId = clean(event.postId, 220);
    if (!onlyFansPostId) return reject("COMMENT_POST_ID_MISSING");
    const fingerprint = identityFingerprint("comment", creatorId, event, occurredAt, null);
    return {
      kind: "comment", fingerprint, ...common, amountCents: null, currency: null,
      onlyFansPostId, onlyFansCommentId, commentId: onlyFansCommentId,
    };
  }
  if (sourceType === "subscriptions") {
    if (!externalFanId && !common.externalNotificationId && !common.externalTransactionId) return reject("SUBSCRIPTION_IDENTITY_MISSING");
    const eventType = subscriptionType(rawType, amountCents);
    if (!eventType) return reject("UNSUPPORTED_SUBSCRIPTION_EVENT_TYPE");
    if (eventType === "SUBSCRIBED_PAID" && (amountCents === null || amountCents <= 0)) return reject("INVALID_PAID_SUBSCRIPTION_AMOUNT");
    const observedPriceCents = eventType === "SUBSCRIBED_FREE" ? 0 : eventType === "SUBSCRIBED_UNKNOWN" ? null : amountCents;
    const fingerprint = identityFingerprint("subscription", creatorId, event, occurredAt, observedPriceCents, eventType);
    return { kind: "subscription", fingerprint, ...common, amountCents: observedPriceCents, eventType, observedPriceCents };
  }

  return reject("UNSUPPORTED_EVENT_TYPE");
}

function valuesEqual(existing, data, keys) {
  return keys.every((key) => {
    const left = existing?.[key];
    const right = data?.[key];
    if (left instanceof Date || right instanceof Date) return strictDate(left)?.getTime() === strictDate(right)?.getTime();
    return left === right;
  });
}
function requestedTypes(job) {
  const params = object(job?.params);
  if (!Array.isArray(params.types) || params.types.length === 0) return [...NOTIFICATION_TYPES];
  const unique = new Set();
  for (const value of params.types) {
    const type = String(value || "").trim().toLowerCase();
    if (!NOTIFICATION_TYPES.includes(type)) {
      const error = new Error(`Unsupported notification job type: ${type || "<empty>"}`);
      error.code = "NOTIFICATION_JOB_TYPE_UNSUPPORTED";
      throw error;
    }
    unique.add(type);
  }
  return [...unique];
}
function resultCoverage(result, job) {
  const coverage = object(result?.coverage);
  return Object.fromEntries(requestedTypes(job).map((type) => [type, object(coverage[type]).status === "complete" ? "complete" : "partial"]));
}
const COMPLETE_COVERAGE_REASONS = new Set(["source_exhausted", "watermark_reached", "range_boundary_reached"]);
const PARTIAL_COVERAGE_REASONS = new Set([
  "event_limit", "not_scanned", "missing_timestamps", "invalid_rows",
  "cursor_stalled", "page_limit", "coverage_unproven",
]);
function nonNegativeCoverageInteger(value, field, max = 1_000_000) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw Object.assign(new Error(`Notification coverage ${field} is invalid`), {
      code: "NOTIFICATION_COVERAGE_METADATA_INVALID",
    });
  }
  return value;
}
function validateFinalScannerCoverage(result, job, rangeFrom, rangeTo) {
  const coverage = object(result?.coverage);
  for (const type of requestedTypes(job)) {
    const row = object(coverage[type]);
    const status = row.status;
    const reason = typeof row.reason === "string" ? row.reason.trim().toLowerCase() : "";
    if (status !== "complete" && status !== "partial") {
      throw Object.assign(new Error(`Notification coverage status is invalid for ${type}`), {
        code: "NOTIFICATION_COVERAGE_METADATA_INVALID",
      });
    }
    const allowedReasons = status === "complete" ? COMPLETE_COVERAGE_REASONS : PARTIAL_COVERAGE_REASONS;
    if (!allowedReasons.has(reason)) {
      throw Object.assign(new Error(`Notification coverage reason is invalid for ${type}`), {
        code: "NOTIFICATION_COVERAGE_METADATA_INVALID",
      });
    }
    nonNegativeCoverageInteger(row.pages, `${type}.pages`, 1_000_000);
    nonNegativeCoverageInteger(row.events, `${type}.events`);
    const rejected = nonNegativeCoverageInteger(row.rejected, `${type}.rejected`);
    if (status === "complete" && rejected !== 0) {
      throw Object.assign(new Error(`Complete notification coverage cannot contain rejected rows for ${type}`), {
        code: "NOTIFICATION_COVERAGE_METADATA_INVALID",
      });
    }
    const oldest = row.oldestAt === undefined ? null : strictDate(row.oldestAt);
    const newest = row.newestAt === undefined ? null : strictDate(row.newestAt);
    if (row.oldestAt !== undefined && !oldest) {
      throw Object.assign(new Error(`Notification coverage oldestAt is invalid for ${type}`), { code: "NOTIFICATION_COVERAGE_METADATA_INVALID" });
    }
    if (row.newestAt !== undefined && !newest) {
      throw Object.assign(new Error(`Notification coverage newestAt is invalid for ${type}`), { code: "NOTIFICATION_COVERAGE_METADATA_INVALID" });
    }
    if (oldest && newest && oldest > newest) {
      throw Object.assign(new Error(`Notification coverage timestamps are reversed for ${type}`), { code: "NOTIFICATION_COVERAGE_METADATA_INVALID" });
    }
    // Observed pages may include one boundary row outside the requested range,
    // but an entirely disjoint evidence interval cannot prove this job.
    if (oldest && newest && (newest < rangeFrom || oldest > rangeTo)) {
      throw Object.assign(new Error(`Notification coverage evidence is outside the requested range for ${type}`), { code: "NOTIFICATION_COVERAGE_METADATA_INVALID" });
    }
  }
}

function coverageComplete(result, job) {
  const states = resultCoverage(result, job);
  return Object.values(states).length > 0 && Object.values(states).every((status) => status === "complete");
}
async function acquireIngestTransactionLock(db, idempotencyKey) {
  if (typeof db?.$executeRawUnsafe !== "function") return;
  const hex = sha256(idempotencyKey).slice(0, 16);
  let value = BigInt(`0x${hex}`);
  if (value > 0x7fffffffffffffffn) value -= 0x10000000000000000n;
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock($1::bigint)", value.toString());
}
function factIdentityTokens(fact) {
  return [
    `f:${fact.fingerprint}`,
    ...(fact.externalNotificationId ? [`n:${fact.externalNotificationId}`] : []),
    ...(fact.kind === "like" && fact.likeId ? [`l:${fact.likeId}`] : []),
    ...(fact.kind === "comment" && fact.onlyFansCommentId ? [`c:${fact.onlyFansCommentId}`] : []),
    ...(fact.kind !== "subscription" && fact.externalTransactionId ? [`t:${fact.externalTransactionId}`] : []),
  ];
}
function subscriptionFactStrength(fact) {
  if (fact?.externalTransactionId) return 3;
  if (fact?.externalNotificationId) return 2;
  if (fact?.externalFanId) return 1;
  return 0;
}
function subscriptionIdentityConflict(current, incoming) {
  return Boolean(
    current?.externalTransactionId && incoming?.externalTransactionId
      && current.externalTransactionId !== incoming.externalTransactionId,
  ) || Boolean(
    current?.externalNotificationId && incoming?.externalNotificationId
      && current.externalNotificationId !== incoming.externalNotificationId,
  );
}
function mergeSubscriptionFacts(current, incoming) {
  const incomingWins = subscriptionFactStrength(incoming) > subscriptionFactStrength(current);
  const primary = incomingWins ? incoming : current;
  const secondary = incomingWins ? current : incoming;
  return {
    ...secondary,
    ...primary,
    externalNotificationId: primary.externalNotificationId || secondary.externalNotificationId || null,
    externalTransactionId: primary.externalTransactionId || secondary.externalTransactionId || null,
    externalFanId: primary.externalFanId || secondary.externalFanId || null,
    fanUsername: primary.fanUsername || secondary.fanUsername || null,
    fanDisplayName: primary.fanDisplayName || secondary.fanDisplayName || null,
    fanAvatarUrl: primary.fanAvatarUrl || secondary.fanAvatarUrl || null,
  };
}
function mergeFactDataWithExisting(model, existing, incoming) {
  if (model !== "creatorSubscriptionEvent" || !existing) return incoming;
  const existingHasStrongIdentity = Boolean(existing.externalTransactionId || existing.externalNotificationId);
  const incomingHasStrongIdentity = Boolean(incoming.externalTransactionId || incoming.externalNotificationId);
  const preserveExistingSource = existingHasStrongIdentity && !incomingHasStrongIdentity;
  return {
    ...incoming,
    externalNotificationId: existing.externalNotificationId || incoming.externalNotificationId || null,
    externalTransactionId: existing.externalTransactionId || incoming.externalTransactionId || null,
    occurredAt: preserveExistingSource ? existing.occurredAt : incoming.occurredAt,
    sourceDeviceId: preserveExistingSource ? existing.sourceDeviceId : incoming.sourceDeviceId,
    sourceJobId: preserveExistingSource ? existing.sourceJobId : incoming.sourceJobId,
    collectedAt: preserveExistingSource ? existing.collectedAt : incoming.collectedAt,
    fanOnlyFansUserIdAtEvent: preserveExistingSource
      ? (existing.fanOnlyFansUserIdAtEvent || incoming.fanOnlyFansUserIdAtEvent || null)
      : (incoming.fanOnlyFansUserIdAtEvent || existing.fanOnlyFansUserIdAtEvent || null),
    fanUsernameAtEvent: preserveExistingSource
      ? (existing.fanUsernameAtEvent || incoming.fanUsernameAtEvent || null)
      : (incoming.fanUsernameAtEvent || existing.fanUsernameAtEvent || null),
    fanDisplayNameAtEvent: preserveExistingSource
      ? (existing.fanDisplayNameAtEvent || incoming.fanDisplayNameAtEvent || null)
      : (incoming.fanDisplayNameAtEvent || existing.fanDisplayNameAtEvent || null),
    fanAvatarUrlAtEvent: preserveExistingSource
      ? (existing.fanAvatarUrlAtEvent || incoming.fanAvatarUrlAtEvent || null)
      : (incoming.fanAvatarUrlAtEvent || existing.fanAvatarUrlAtEvent || null),
  };
}
function buildFactData({ fact, job, deviceId, fanRecordIds, now }) {
  const identity = {
    id: crypto.randomUUID(),
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    fanRecordId: fact.externalFanId ? fanRecordIds.get(fact.externalFanId) || null : null,
    fanOnlyFansUserIdAtEvent: fact.externalFanId || null,
    fanUsernameAtEvent: fact.fanUsername || null,
    fanDisplayNameAtEvent: fact.fanDisplayName || null,
    fanAvatarUrlAtEvent: fact.fanAvatarUrl || null,
    eventFingerprint: fact.fingerprint,
    externalNotificationId: fact.externalNotificationId,
    collectedAt: now,
    sourceDeviceId: deviceId || null,
    sourceJobId: job.sourceJobId === null ? null : job.id,
    createdAt: now,
    updatedAt: now,
  };
  if (fact.kind === "like") return { ...identity, onlyFansLikeId: fact.likeId, onlyFansPostId: fact.onlyFansPostId, likedAt: fact.occurredAt };
  if (fact.kind === "comment") return { ...identity, onlyFansCommentId: fact.onlyFansCommentId, onlyFansPostId: fact.onlyFansPostId, commentedAt: fact.occurredAt };
  const financial = {
    ...identity,
    externalTransactionId: fact.externalTransactionId,
    currency: fact.currency,
    source: "NOTIFICATION",
    sourceUpdatedAt: null,
  };
  if (fact.kind === "sale") return { ...financial, saleType: fact.saleType, messageId: fact.messageId, postId: fact.postId, amountCents: fact.amountCents, purchasedAt: fact.occurredAt };
  if (fact.kind === "tip") return { ...financial, messageId: fact.messageId, amountCents: fact.amountCents, tippedAt: fact.occurredAt };
  return { ...financial, eventType: fact.eventType, observedPriceCents: fact.observedPriceCents, occurredAt: fact.occurredAt };
}

async function resolveFans(tx, { agencyId, creatorId, facts, now }) {
  const observations = [];
  for (const fact of facts) {
    if (!fact.externalFanId) continue;
    observations.push({
      agencyId,
      creatorId,
      onlyFansUserId: fact.externalFanId,
      username: fact.fanUsername,
      platformDisplayName: fact.fanDisplayName,
      avatarUrl: fact.fanAvatarUrl,
      observedAt: fact.occurredAt,
      activityObservedAt: fact.occurredAt,
      source: "LIVE_NOTIFICATION",
    });
  }
  const projected = await projectFanIdentityBatch(tx, observations);
  return new Map([...projected.values()].map((fan) => [fan.onlyFansUserId, fan.id]));
}

async function existingFacts(tx, model, creatorId, facts) {
  const fingerprints = [...new Set(facts.map((fact) => fact.fingerprint))];
  const notifications = [...new Set(facts.map((fact) => fact.externalNotificationId).filter(Boolean))];
  const likeIds = model === "creatorPostLike"
    ? [...new Set(facts.map((fact) => fact.likeId).filter(Boolean))]
    : [];
  const commentIds = model === "creatorPostComment"
    ? [...new Set(facts.map((fact) => fact.onlyFansCommentId).filter(Boolean))]
    : [];
  const modelHasTransaction = !["creatorSubscriptionEvent", "creatorPostLike", "creatorPostComment"].includes(model);
  const transactions = modelHasTransaction
    ? [...new Set(facts.map((fact) => fact.externalTransactionId).filter(Boolean))]
    : [];
  const OR = [{ eventFingerprint: { in: fingerprints } }];
  if (notifications.length) OR.push({ externalNotificationId: { in: notifications } });
  if (likeIds.length) OR.push({ onlyFansLikeId: { in: likeIds } });
  if (commentIds.length) OR.push({ onlyFansCommentId: { in: commentIds } });
  if (transactions.length) OR.push({ externalTransactionId: { in: transactions } });
  return tx[model].findMany({ where: { creatorId, OR } });
}
async function persistFactGroup(tx, { model, facts, job, deviceId, fanRecordIds, now, compareKeys }) {
  if (!facts.length) return { inserted: 0, updated: 0, unchanged: 0, rejected: 0 };

  // Collapse duplicate identities inside one page before any database work. The
  // last occurrence wins so a corrected amount in the same source page is not
  // silently discarded behind the first copy. Conflicting identity tokens are
  // rejected rather than merged across two different facts.
  const collapsedFacts = [];
  const tokenToIndex = new Map();
  let duplicateInputRows = 0;
  let conflictingInputRows = 0;
  for (const fact of facts) {
    const tokens = factIdentityTokens(fact);
    const matches = new Set(tokens.map((token) => tokenToIndex.get(token)).filter((index) => index !== undefined));
    if (matches.size > 1) { conflictingInputRows += 1; continue; }
    if (matches.size === 1) {
      const index = [...matches][0];
      if (collapsedFacts[index].fingerprint !== fact.fingerprint) { conflictingInputRows += 1; continue; }
      if (fact.kind === "subscription" && subscriptionIdentityConflict(collapsedFacts[index], fact)) {
        conflictingInputRows += 1;
        continue;
      }
      collapsedFacts[index] = fact.kind === "subscription"
        ? mergeSubscriptionFacts(collapsedFacts[index], fact)
        : fact;
      duplicateInputRows += 1;
      for (const token of tokens) tokenToIndex.set(token, index);
      continue;
    }
    const index = collapsedFacts.length;
    collapsedFacts.push(fact);
    for (const token of tokens) tokenToIndex.set(token, index);
  }
  facts = collapsedFacts;

  const existing = await existingFacts(tx, model, job.creatorId, facts);
  const byToken = new Map();
  for (const row of existing) {
    const tokens = [`f:${row.eventFingerprint}`];
    if (row.externalNotificationId) tokens.push(`n:${row.externalNotificationId}`);
    if (model === "creatorPostLike" && row.onlyFansLikeId) tokens.push(`l:${row.onlyFansLikeId}`);
    if (model === "creatorPostComment" && row.onlyFansCommentId) tokens.push(`c:${row.onlyFansCommentId}`);
    if (!["creatorSubscriptionEvent", "creatorPostLike", "creatorPostComment"].includes(model) && row.externalTransactionId) tokens.push(`t:${row.externalTransactionId}`);
    for (const token of tokens) byToken.set(token, row);
  }
  const seenInput = new Map();
  const creates = [];
  const updates = [];
  let unchanged = duplicateInputRows;
  let rejected = conflictingInputRows;
  for (const fact of facts) {
    const tokens = factIdentityTokens(fact);
    const inputMatches = new Set(tokens.map((token) => seenInput.get(token)).filter(Boolean));
    if (inputMatches.size > 1) { rejected += 1; continue; }
    if (inputMatches.size === 1) {
      const prior = [...inputMatches][0];
      if (prior.fingerprint !== fact.fingerprint) rejected += 1;
      else unchanged += 1;
      continue;
    }
    const existingMatches = new Map();
    for (const token of tokens) {
      const row = byToken.get(token);
      if (row) existingMatches.set(row.id, row);
    }
    if (existingMatches.size > 1) { rejected += 1; continue; }
    const row = existingMatches.size === 1 ? [...existingMatches.values()][0] : null;
    if (model === "creatorSubscriptionEvent" && row && subscriptionIdentityConflict(row, fact)) {
      rejected += 1;
      continue;
    }
    const data = mergeFactDataWithExisting(
      model,
      row,
      buildFactData({ fact, job, deviceId, fanRecordIds, now }),
    );
    if (!row) creates.push({ fact, data });
    else if (valuesEqual(row, data, compareKeys)) unchanged += 1;
    else updates.push({ id: row.id, data });
    for (const token of tokens) seenInput.set(token, fact);
  }

  let inserted = 0;
  if (creates.length) {
    const result = await tx[model].createMany({ data: creates.map((item) => item.data), skipDuplicates: true });
    inserted = Number(result?.count || 0);

    // A different overlapping job may win a unique-key race between the
    // prefetch and createMany. Reload only when createMany skipped something;
    // the common all-inserted path avoids an unnecessary hosted-Postgres read.
    if (inserted < creates.length) {
      const reloaded = await existingFacts(tx, model, job.creatorId, creates.map((item) => item.fact));
      const reloadedByToken = new Map();
      for (const row of reloaded) {
        const tokens = [`f:${row.eventFingerprint}`];
        if (row.externalNotificationId) tokens.push(`n:${row.externalNotificationId}`);
    if (model === "creatorPostLike" && row.onlyFansLikeId) tokens.push(`l:${row.onlyFansLikeId}`);
    if (model === "creatorPostComment" && row.onlyFansCommentId) tokens.push(`c:${row.onlyFansCommentId}`);
        if (!["creatorSubscriptionEvent", "creatorPostLike", "creatorPostComment"].includes(model) && row.externalTransactionId) tokens.push(`t:${row.externalTransactionId}`);
        for (const token of tokens) reloadedByToken.set(token, row);
      }
      let raceUpdated = 0;
      let raceRejected = 0;
      for (const item of creates) {
        const matches = new Map();
        for (const token of factIdentityTokens(item.fact)) {
          const row = reloadedByToken.get(token);
          if (row) matches.set(row.id, row);
        }
        if (matches.size !== 1) { raceRejected += 1; continue; }
        const row = [...matches.values()][0];
        if (model === "creatorSubscriptionEvent" && subscriptionIdentityConflict(row, item.fact)) {
          raceRejected += 1;
          continue;
        }
        const mergedData = mergeFactDataWithExisting(model, row, item.data);
        if (!valuesEqual(row, mergedData, compareKeys)) {
          updates.push({ id: row.id, data: mergedData });
          raceUpdated += 1;
        }
      }
      rejected += raceRejected;
      unchanged += Math.max(0, creates.length - inserted - raceUpdated - raceRejected);
    }
  }

  const uniqueUpdates = new Map(updates.map((update) => [update.id, update]));
  for (const update of uniqueUpdates.values()) {
    const data = { ...update.data };
    delete data.id;
    delete data.createdAt;
    await tx[model].update({ where: { id: update.id }, data });
  }
  return { inserted, updated: uniqueUpdates.size, unchanged, rejected };
}

async function ensureBatch(db, data) {
  const existing = await db.analyticsIngestBatch.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
  if (existing) {
    if (existing.payloadChecksum !== data.payloadChecksum) {
      const error = new Error("Notification ingest idempotency key was reused with a different payload");
      error.code = "ANALYTICS_INGEST_IDEMPOTENCY_CONFLICT";
      throw error;
    }
    if (existing.status === "COMMITTED" || existing.status === "PARTIAL") return { batch: existing, terminal: true };
    const reset = await db.analyticsIngestBatch.update({ where: { id: existing.id }, data: { status: "RECEIVED", completedAt: null, lastErrorCode: null, lastErrorMessage: null } });
    return { batch: reset, terminal: false };
  }
  try {
    const batch = await db.analyticsIngestBatch.create({ data });
    return { batch, terminal: false };
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const raced = await db.analyticsIngestBatch.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (!raced || raced.payloadChecksum !== data.payloadChecksum) throw error;
    return { batch: raced, terminal: raced.status === "COMMITTED" || raced.status === "PARTIAL" };
  }
}
function canonicalCoveragePayload(result, job) {
  const coverage = object(result?.coverage);
  return Object.fromEntries(requestedTypes(job).map((type) => {
    const row = object(coverage[type]);
    const oldestAt = strictDate(row.oldestAt);
    const newestAt = strictDate(row.newestAt);
    return [type, {
      status: row.status === "complete" ? "complete" : "partial",
      reason: typeof row.reason === "string" ? row.reason.trim().toLowerCase() : null,
      pages: Number.isInteger(row.pages) ? row.pages : null,
      events: Number.isInteger(row.events) ? row.events : null,
      rejected: Number.isInteger(row.rejected) ? row.rejected : null,
      oldestAt: oldestAt ? oldestAt.toISOString() : null,
      newestAt: newestAt ? newestAt.toISOString() : null,
      cursorStart: clean(row.cursorStart, 220),
      cursorEnd: clean(row.cursorEnd, 220),
    }];
  }));
}

function canonicalPayload(normalized, result, job) {
  const rows = normalized.map((row, index) => row.rejected
    ? { index, rejected: row.rejected, rawChecksum: sha256(stableJson(row.rawForChecksum || null)) }
    : {
        index, kind: row.kind, fingerprint: row.fingerprint, fan: row.externalFanId,
        notification: row.externalNotificationId, transaction: row.externalTransactionId,
        amountCents: row.amountCents, currency: row.currency, occurredAt: row.occurredAt.toISOString(),
        messageId: row.messageId || null, postId: row.postId || null, eventType: row.eventType || null,
      });
  return {
    rows,
    coverage: canonicalCoveragePayload(result, job),
    finalizeCoverage: result?.finalizeCoverage === true,
    notificationType: clean(result?.notificationType, 40),
    sourceTimezone: clean(result?.sourceTimezone, 100) || "UTC",
    schemaVersion: result?.schemaVersion ?? null,
    scanRunId: clean(result?.scanRunId, 80),
  };
}
function terminalReplayResponse(batch, result, job) {
  const requested = requestedTypes(job);
  const coverageByType = batch.status === "COMMITTED"
    ? resultCoverage(result, job)
    : Object.fromEntries(requested.map((type) => [type, "partial"]));
  const coverageIsComplete = batch.status === "COMMITTED"
    && requested.every((type) => coverageByType[type] === "complete");
  return {
    batchId: batch.id, replayed: true, status: batch.status,
    inserted: batch.insertedRows, updated: batch.updatedRows,
    unchanged: batch.unchangedRows, rejected: batch.rejectedRows,
    coverageComplete: coverageIsComplete, coverageByType,
  };
}

async function ingestNotificationFacts({ job, deviceId, result, db = prisma }) {
  if (!job?.id || !job?.agencyId || !job?.creatorId) throw new Error("Notification facts require a creator-scoped job");
  if (!Array.isArray(result?.events)) {
    throw Object.assign(new Error("Notification events must be an explicit array"), { code: "NOTIFICATION_EVENTS_ARRAY_REQUIRED" });
  }
  const rawEvents = result.events;
  if (rawEvents.length > MAX_EVENTS_PER_BATCH) {
    throw Object.assign(new Error(`Notification batch exceeds ${MAX_EVENTS_PER_BATCH} events`), { code: "NOTIFICATION_BATCH_TOO_LARGE" });
  }

  const params = object(job.params);
  const rangeFrom = strictDate(params.from);
  const rangeTo = strictDate(params.to);
  if (!rangeFrom || !rangeTo) {
    throw Object.assign(new Error("Notification jobs require strict ISO from/to bounds"), { code: "NOTIFICATION_RANGE_REQUIRED" });
  }
  if (rangeTo < rangeFrom) throw Object.assign(new Error("Notification rangeTo precedes rangeFrom"), { code: "NOTIFICATION_INVALID_RANGE" });
  if (typeof result?.sourceTimezone !== "string" || !result.sourceTimezone.trim()) {
    throw Object.assign(new Error("Notification sourceTimezone is required"), { code: "NOTIFICATION_INVALID_TIMEZONE" });
  }
  const sourceTimezone = timezone(result.sourceTimezone.trim());
  if (!sourceTimezone) throw Object.assign(new Error("Notification sourceTimezone is invalid"), { code: "NOTIFICATION_INVALID_TIMEZONE" });
  if (sourceTimezone !== "UTC") {
    throw Object.assign(new Error("Notification Facts V1 stores coverage in UTC days only"), {
      code: "NOTIFICATION_TIMEZONE_UNSUPPORTED",
    });
  }
  const incomingSchemaVersion = result?.schemaVersion;
  if (!Number.isInteger(incomingSchemaVersion) || ![LEGACY_SCHEMA_VERSION, ALL_SCHEMA_VERSION, SCHEMA_VERSION].includes(incomingSchemaVersion)) {
    throw Object.assign(new Error(`Unsupported notification schema version: ${incomingSchemaVersion ?? "<missing>"}`), {
      code: "NOTIFICATION_SCHEMA_VERSION_UNSUPPORTED",
    });
  }
  const schemaVersion = incomingSchemaVersion;
  const scanRunIdRaw = typeof result?.scanRunId === "string" ? result.scanRunId.trim() : "";
  const scanRunId = scanRunIdRaw;
  if (!scanRunId || scanRunId.length > 80 || !/^[A-Za-z0-9._-]{8,80}$/.test(scanRunId)) {
    throw Object.assign(new Error("Notification schema v4 requires a valid scanRunId"), {
      code: "NOTIFICATION_SCAN_RUN_ID_REQUIRED",
    });
  }
  const requested = requestedTypes(job);
  const declaredNotificationType = result?.notificationType === undefined || result?.notificationType === null
    ? null
    : String(result.notificationType).trim().toLowerCase();
  if (declaredNotificationType && (!NOTIFICATION_TYPES.includes(declaredNotificationType) || !requested.includes(declaredNotificationType))) {
    throw Object.assign(new Error(`Notification page type is not allowed for this job: ${declaredNotificationType}`), {
      code: "NOTIFICATION_PAGE_TYPE_UNSUPPORTED",
    });
  }

  for (const type of requested) {
    const typeCoverage = object(object(result?.coverage)[type]);
    if (exceedsTextLimit(typeCoverage.cursorEnd, 220) || exceedsTextLimit(typeCoverage.cursorStart, 220)) {
      throw Object.assign(new Error(`Notification coverage cursor is too long for ${type}`), {
        code: "NOTIFICATION_COVERAGE_CURSOR_TOO_LONG",
      });
    }
  }

  const normalized = rawEvents.map((event) => ({ ...normalizeEvent(event, job.creatorId), rawForChecksum: event }));
  if (declaredNotificationType) {
    const mismatch = normalized.find((row) => row.sourceType && row.sourceType !== declaredNotificationType);
    if (mismatch) {
      throw Object.assign(new Error(`Notification page declared ${declaredNotificationType} but contains ${mismatch.sourceType}`), {
        code: "NOTIFICATION_PAGE_TYPE_MISMATCH",
      });
    }
  }
  for (const row of normalized) {
    if (row.rejected || !row.occurredAt) continue;
    if (row.occurredAt < rangeFrom || row.occurredAt > rangeTo) {
      row.rejected = "EVENT_OUTSIDE_REQUESTED_RANGE";
    }
  }
  const facts = normalized.filter((row) => !row.rejected);
  const initiallyRejected = normalized.filter((row) => row.rejected);
  const payloadChecksum = sha256(stableJson(canonicalPayload(normalized, result, job)));
  const rawBatchKey = typeof result?.batchKey === "string" ? result.batchKey.trim() : "";
  if (!rawBatchKey || rawBatchKey.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(rawBatchKey)) {
    throw Object.assign(new Error("Notification batchKey is invalid"), { code: "NOTIFICATION_BATCH_KEY_INVALID" });
  }
  const batchKey = rawBatchKey;
  if (typeof result?.finalizeCoverage !== "boolean") {
    throw Object.assign(new Error("Notification finalizeCoverage must be explicit"), { code: "NOTIFICATION_FINALIZE_FLAG_REQUIRED" });
  }
  const finalizeCoverage = result.finalizeCoverage;
  if (finalizeCoverage) validateFinalScannerCoverage(result, job, rangeFrom, rangeTo);
  const scannerRejectedByType = Object.fromEntries(requested.map((type) => {
    const value = object(object(result?.coverage)[type]).rejected;
    return [type, finalizeCoverage && Number.isInteger(value) ? value : 0];
  }));
  const scannerRejectedTotal = Object.values(scannerRejectedByType).reduce((sum, value) => sum + value, 0);
  const expectedPrefix = finalizeCoverage
    ? `run:${scanRunId}:completion`
    : `run:${scanRunId}:page:${declaredNotificationType}:`;
  const matchesRun = finalizeCoverage ? batchKey === expectedPrefix : batchKey.startsWith(expectedPrefix);
  if (!matchesRun || (!finalizeCoverage && !declaredNotificationType)) {
    throw Object.assign(new Error("Notification batchKey does not match scanRunId/type/finalization"), {
      code: "NOTIFICATION_PAGE_BATCH_KEY_MISMATCH",
    });
  }
  const protocolSuffix = schemaVersion === LEGACY_SCHEMA_VERSION ? "v4" : schemaVersion === ALL_SCHEMA_VERSION ? "v5" : "v6";
  const idempotencyKey = `notification-facts:${job.id}:${batchKey}:${protocolSuffix}`;
  if (idempotencyKey.length > 240) {
    throw Object.assign(new Error("Notification ingest idempotency key exceeds the ledger limit"), {
      code: "NOTIFICATION_IDEMPOTENCY_KEY_TOO_LONG",
    });
  }
  const collectorVersionRaw = typeof result?.collectorVersion === "string"
    ? result.collectorVersion.trim()
    : "";
  const expectedCollectorVersion = schemaVersion === LEGACY_SCHEMA_VERSION
    ? LEGACY_COLLECTOR_VERSION
    : schemaVersion === ALL_SCHEMA_VERSION
      ? ALL_COLLECTOR_VERSION
      : COLLECTOR_VERSION;
  if (!collectorVersionRaw || collectorVersionRaw.length > 80 || collectorVersionRaw !== expectedCollectorVersion) {
    throw Object.assign(new Error("Notification collectorVersion is invalid or unsupported"), {
      code: "NOTIFICATION_COLLECTOR_VERSION_INVALID",
    });
  }
  const now = await dbAuthorityNow({ db, fallbackNow: new Date() });

  const creator = await db.creatorAccount.findFirst({
    where: { id: job.creatorId, agencyId: job.agencyId, deletedAt: null, status: { not: "DISABLED" } },
    select: { id: true },
  });
  if (!creator) throw new Error("Notification facts creator/agency mismatch or creator is disabled");
  if (deviceId) {
    const device = await db.workerDevice.findFirst({ where: { id: deviceId, agencyId: job.agencyId }, select: { id: true } });
    if (!device) throw new Error("Notification facts device/agency mismatch");
  }

  const initial = await ensureBatch(db, {
    agencyId: job.agencyId, creatorId: job.creatorId, sourceDeviceId: deviceId || null, sourceJobId: job.sourceJobId === null ? null : job.id,
    idempotencyKey, dataType: "NOTIFICATIONS", status: "RECEIVED", rangeFrom, rangeTo, sourceTimezone,
    collectorVersion: collectorVersionRaw, schemaVersion, payloadChecksum,
    receivedRows: rawEvents.length + scannerRejectedTotal,
  });
  if (initial.terminal) return terminalReplayResponse(initial.batch, result, job);

  try {
    const applyFacts = async (tx) => {
      // Serialize duplicate deliveries inside the same database transaction.
      // Re-read after acquiring the lock: another request may have committed
      // after our pre-transaction ensureBatch() read.
      await acquireIngestTransactionLock(tx, `notification-facts:${job.agencyId}:${job.creatorId}`);
      const lockedBatch = await tx.analyticsIngestBatch.findUnique({ where: { idempotencyKey } });
      if (lockedBatch?.status === "COMMITTED" || lockedBatch?.status === "PARTIAL") {
        return { replayed: true, response: terminalReplayResponse(lockedBatch, result, job) };
      }
      const fanRecordIds = await resolveFans(tx, { agencyId: job.agencyId, creatorId: job.creatorId, facts, now });
      const groups = {
        sale: facts.filter((fact) => fact.kind === "sale"),
        tip: facts.filter((fact) => fact.kind === "tip"),
        subscription: facts.filter((fact) => fact.kind === "subscription"),
        like: facts.filter((fact) => fact.kind === "like"),
        comment: facts.filter((fact) => fact.kind === "comment"),
      };
      const sale = await persistFactGroup(tx, {
        model: "creatorSale", facts: groups.sale, job, deviceId, fanRecordIds, now,
        compareKeys: ["fanRecordId", "externalNotificationId", "externalTransactionId", "saleType", "messageId", "postId", "amountCents", "currency", "purchasedAt"],
      });
      const tip = await persistFactGroup(tx, {
        model: "creatorTip", facts: groups.tip, job, deviceId, fanRecordIds, now,
        compareKeys: ["fanRecordId", "externalNotificationId", "externalTransactionId", "messageId", "amountCents", "currency", "tippedAt"],
      });
      // Team Analytics consumes the canonical CreatorSale ledger; it never
      // runs a second OF money scanner. Reconcile inside the same transaction
      // so a committed sale cannot exist without its exact-message Team side
      // effect when Team models are available.
      if (groups.sale.length) {
        const persistedSales = await existingFacts(tx, "creatorSale", job.creatorId, groups.sale);
        for (const row of persistedSales) await dispatchTeamMoneyReconciliationForCanonicalFact({ db: tx, agencyId: job.agencyId, creatorId: job.creatorId, sourceType: "PPV", sourceId: row.id, now });
      }
      if (groups.tip.length) {
        const persistedTips = await existingFacts(tx, "creatorTip", job.creatorId, groups.tip);
        for (const row of persistedTips) await dispatchTeamMoneyReconciliationForCanonicalFact({ db: tx, agencyId: job.agencyId, creatorId: job.creatorId, sourceType: "TIP", sourceId: row.id, now });
      }
      const subscription = await persistFactGroup(tx, {
        model: "creatorSubscriptionEvent", facts: groups.subscription, job, deviceId, fanRecordIds, now,
        compareKeys: ["fanRecordId", "externalNotificationId", "externalTransactionId", "eventType", "observedPriceCents", "currency", "occurredAt"],
      });
      if (groups.subscription.length
        && tx.creatorSubscriptionState
        && tx.creatorPaidSubscription
        && typeof tx.creatorSubscriptionEvent?.findMany === "function") {
        const affectedFanIds = [...new Set(groups.subscription
          .map((fact) => fact.externalFanId ? fanRecordIds.get(fact.externalFanId) || null : null)
          .filter(Boolean))];
        if (affectedFanIds.length) {
          await projectSubscriptionFacts({
            db: tx, agencyId: job.agencyId, creatorId: job.creatorId, fanRecordIds: affectedFanIds, now,
          });
        }
      }
      const like = await persistFactGroup(tx, {
        model: "creatorPostLike", facts: groups.like, job, deviceId, fanRecordIds, now,
        compareKeys: ["fanRecordId", "externalNotificationId", "onlyFansLikeId", "onlyFansPostId", "likedAt"],
      });
      const comment = await persistFactGroup(tx, {
        model: "creatorPostComment", facts: groups.comment, job, deviceId, fanRecordIds, now,
        compareKeys: ["fanRecordId", "externalNotificationId", "onlyFansCommentId", "onlyFansPostId", "commentedAt"],
      });
      const perTypePersistenceRejected = {
        purchases: sale.rejected,
        tips: tip.rejected,
        subscriptions: subscription.rejected,
        likes: like.rejected,
        comments: comment.rejected,
      };
      const perTypeInitialRejected = Object.fromEntries(requested.map((type) => [type, scannerRejectedByType[type] || 0]));
      for (const row of initiallyRejected) {
        if (row.sourceType && requested.includes(row.sourceType)) perTypeInitialRejected[row.sourceType] += 1;
        else for (const type of requested) perTypeInitialRejected[type] += 1;
      }
      const counts = {
        inserted: sale.inserted + tip.inserted + subscription.inserted + like.inserted + comment.inserted,
        updated: sale.updated + tip.updated + subscription.updated + like.updated + comment.updated,
        unchanged: sale.unchanged + tip.unchanged + subscription.unchanged + like.unchanged + comment.unchanged,
        rejected: scannerRejectedTotal + initiallyRejected.length + sale.rejected + tip.rejected + subscription.rejected + like.rejected + comment.rejected,
      };
      const scannerCoverage = resultCoverage(result, job);
      const coverageByType = Object.fromEntries(requested.map((type) => [type, scannerCoverage[type] || "partial"]));

      if (finalizeCoverage) {
        const priorBatches = typeof tx.analyticsIngestBatch.findMany === "function"
          ? await tx.analyticsIngestBatch.findMany({
              where: { sourceJobId: job.sourceJobId === null ? null : job.id, id: { not: initial.batch.id } },
              select: { idempotencyKey: true, status: true, rejectedRows: true },
            })
          : [];
        for (const type of requested) {
          const currentRunPageMarker = scanRunId ? `:run:${scanRunId}:page:${type}:` : `:page:${type}:`;
          const priorTypeFailed = priorBatches.some((batch) => {
            const key = String(batch.idempotencyKey || "");
            return (key.endsWith(":v4") || key.endsWith(":v5") || key.endsWith(":v6"))
              && key.includes(currentRunPageMarker)
              && (batch.status !== "COMMITTED" || Number(batch.rejectedRows || 0) > 0);
          });
          const typeRejected = (perTypeInitialRejected[type] || 0) + (perTypePersistenceRejected[type] || 0);
          coverageByType[type] = scannerCoverage[type] === "complete" && typeRejected === 0 && !priorTypeFailed
            ? "complete"
            : "partial";
        }

        // Notifications are a cursor/frontier collector, not a temporal-day collector.
        // Scanner completion + committed page batches prove this collection generation;
        // CreatorNotificationSyncState owns the durable frontier/current collection state.
        // Do not write AnalyticsCoverage(NOTIFICATION_*) here: that would create a second
        // durable collection-state generation for a non-calendar collector.
      }
      const complete = counts.rejected === 0 && (!finalizeCoverage || requested.every((type) => coverageByType[type] === "complete"));
      const partialReason = counts.rejected > 0
        ? "NOTIFICATION_ROWS_REJECTED"
        : complete
          ? null
          : "NOTIFICATION_SCAN_PARTIAL";
      const batch = await tx.analyticsIngestBatch.update({
        where: { id: initial.batch.id },
        data: {
          status: complete ? "COMMITTED" : "PARTIAL", insertedRows: counts.inserted, updatedRows: counts.updated,
          unchangedRows: counts.unchanged, rejectedRows: counts.rejected, completedAt: now,
          lastErrorCode: partialReason,
          lastErrorMessage: counts.rejected > 0
            ? initiallyRejected.slice(0, 5).map((row) => row.rejected).join(", ") || `${counts.rejected} identity conflicts`
            : complete ? null : "One or more notification types have partial coverage",
        },
      });
      return { replayed: false, batch, counts, complete, coverageByType };
    };
    const ownsTransactionBoundary = typeof db.$transaction === "function";
    const applied = ownsTransactionBoundary
      ? await db.$transaction(applyFacts, { maxWait: 10_000, timeout: 60_000 })
      : await applyFacts(db);

    if (applied.replayed) return applied.response;
    // CreatorDailyMetrics is a disposable read cache. Page chunks are already
    // executed inside the fenced /jobs/:id/progress transaction, so rebuilding
    // that cache there unnecessarily keeps the lease transaction open and can
    // make a committed notification page look hung to Desktop. Defer projection
    // until a top-level ingest boundary (completion/realtime), where db owns its
    // own transaction lifecycle. Primary facts remain authoritative either way.
    const metricDates = facts.map((fact) => fact.occurredAt).filter(Boolean);
    if (ownsTransactionBoundary && (finalizeCoverage || metricDates.length > 0) && db.creatorDailyMetrics) {
      let metricsFrom = metricDates.length
        ? new Date(Math.min(...metricDates.map((date) => date.getTime())))
        : rangeFrom;
      const metricsTo = finalizeCoverage
        ? rangeTo
        : new Date(Math.max(...metricDates.map((date) => date.getTime())));
      if (finalizeCoverage && typeof db.creatorNotificationSyncState?.findUnique === "function") {
        try {
          const sync = await db.creatorNotificationSyncState.findUnique({
            where: { creatorId: job.creatorId },
            select: { oldestOccurredAt: true },
          });
          metricsFrom = strictDate(sync?.oldestOccurredAt) || metricsFrom;
        } catch {
          // Read-model projection remains best-effort; primary facts are already durable.
        }
      }
      try {
        await rebuildCreatorDailyMetrics({ db, agencyId: job.agencyId, creatorId: job.creatorId, from: metricsFrom, to: metricsTo, now });
      } catch (projectionError) {
        console.warn("[creator-analytics] daily metrics projection failed after notification ingest:", projectionError?.message || projectionError);
      }
    }
    return { batchId: applied.batch.id, replayed: false, status: applied.batch.status, ...applied.counts, coverageComplete: applied.complete, coverageByType: applied.coverageByType };
  } catch (error) {
    await db.analyticsIngestBatch.update({
      where: { id: initial.batch.id },
      data: { status: "FAILED", completedAt: now, lastErrorCode: clean(error?.code || "NOTIFICATION_FACTS_INGEST_FAILED", 120), lastErrorMessage: clean(error?.message || error, 2_000) },
    }).catch(() => null);
    throw error;
  }
}

module.exports = {
  SERVICE_VERSION,
  SCHEMA_VERSION,
  COLLECTOR_VERSION,
  normalizeEvent,
  identityFingerprint,
  resultCoverage,
  coverageComplete,
  ingestNotificationFacts,
};
