"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { ingestNotificationFacts } = require("./notification-facts-service");
const { completeNotificationSync, recordNotificationSyncFailure, assertNotificationCollectionResult } = require("./notification-sync-state-service");

const CATCHUP_JOB_KEY = "catchup_notifications_scan";
const DEFAULT_BUFFER_MS = 2 * 60 * 60 * 1000;
const DEFAULT_OFFLINE_GAP_MS = 10 * 60 * 1000;
const DEFAULT_MAX_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_MS = 10 * 60 * 1000;
const REALTIME_FRAME_FRESH_MS = 3 * 60 * 1000;
const REALTIME_CLOCK_SKEW_MS = 30 * 1000;

function clean(value, max = 255) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function dateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function maxDate(...values) {
  let best = null;
  for (const value of values) {
    const d = dateOrNull(value);
    if (!d) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}


function realtimeFrameSampleAt(account, now = new Date()) {
  const current = dateOrNull(now) || new Date();
  const frameAt = dateOrNull(account?.lastWsFrameAt);
  if (!frameAt) return null;
  const ageMs = current.getTime() - frameAt.getTime();
  if (ageMs < -REALTIME_CLOCK_SKEW_MS || ageMs > REALTIME_FRAME_FRESH_MS) return null;
  return frameAt.getTime() > current.getTime() ? current : frameAt;
}

function amountDollarsToCents(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(
    String(value)
      .replace(/[^0-9.,-]/g, "")
      .replace(",", ".")
  );
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 100));
}

function stableHashSeed(value) {
  let raw = "";
  try {
    raw = JSON.stringify(value);
  } catch {
    raw = String(value || "");
  }
  return `ppv_${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 24)}`;
}

function resolveAccountRefs(account = {}) {
  const remoteId = account?.remoteId === undefined || account?.remoteId === null ? null : String(account.remoteId);
  const username = account?.username ? String(account.username).replace(/^@/, "") : null;
  const candidateIds = [account?.creatorId, account?.backendCreatorId, account?.accountId, account?.id]
    .map((value) => clean(value, 160))
    .filter(Boolean);
  return { remoteId, username, candidateIds };
}

async function resolveCreatorForObservation({ agencyId, account, db = prisma }) {
  const { remoteId, username, candidateIds } = resolveAccountRefs(account);
  const or = [];
  if (candidateIds.length) or.push({ id: { in: candidateIds } });
  if (remoteId) or.push({ remoteId });
  if (username) or.push({ username });
  if (!or.length) return null;
  return db.creatorAccount.findFirst({
    where: { agencyId, deletedAt: null, OR: or },
    select: { id: true, username: true, remoteId: true, displayName: true },
  });
}

function computeCatchupWindow(prev, now = new Date()) {
  const lastObserved = maxDate(
    prev?.lastObservedAt,
    prev?.lastRealtimeEventAt,
    prev?.lastHeartbeatAt,
    prev?.lastSuccessfulScanAt
  );
  const firstRun = !prev || !lastObserved;
  const gapMs = lastObserved ? now.getTime() - lastObserved.getTime() : DEFAULT_BUFFER_MS;
  if (!firstRun && gapMs < DEFAULT_OFFLINE_GAP_MS) {
    return { needed: false, reason: "still_observed", lastObserved, gapMs };
  }

  const maxLookbackFrom = new Date(now.getTime() - DEFAULT_MAX_LOOKBACK_MS);
  const bufferedFrom = new Date((lastObserved ? lastObserved.getTime() : now.getTime()) - DEFAULT_BUFFER_MS);
  const from = maxDate(maxLookbackFrom, bufferedFrom);
  const to = now;
  return {
    needed: true,
    reason: firstRun ? "initial_observation" : "offline_gap",
    lastObserved,
    gapMs,
    from,
    to,
  };
}

async function upsertObservationHeartbeat({ agencyId, deviceId, account, now = new Date(), db = prisma }) {
  const creator = await resolveCreatorForObservation({ agencyId, account, db });
  if (!creator?.id) return { ok: false, code: "CREATOR_NOT_FOUND" };

  const accountId =
    clean(account?.accountId || account?.creatorId || account?.backendCreatorId || creator.id, 160) || creator.id;
  const creatorRef = clean(
    account?.username || creator.username || account?.displayName || creator.displayName || null,
    160
  );

  const prev = await db.teamObservationState
    .findUnique({
      where: { agencyId_creatorId: { agencyId, creatorId: creator.id } },
    })
    .catch(() => null);

  const window = computeCatchupWindow(prev, now);
  const scanTypes = ["purchases", "tips", "subscriptions", "likes", "comments"];

  const updateData = {
    accountId,
    creatorRef,
    lastHeartbeatAt: now,
    lastObservedAt: maxDate(now, prev?.lastObservedAt),
  };

  let state = await db.teamObservationState.upsert({
    where: { agencyId_creatorId: { agencyId, creatorId: creator.id } },
    create: {
      agencyId,
      creatorId: creator.id,
      ...updateData,
    },
    update: updateData,
  });

  // Creator Analytics is now the single owner of notification catch-up jobs.
  // Team observation still records realtime/offline coverage, but it must not
  // create a second catchup_notifications_scan producer with a different
  // continuation contract. The recurring/initial analytics orchestrator decides
  // when to schedule the bounded HEAD catch-up.
  const scheduled = window.needed
    ? { created: false, reason: 'creator_analytics_orchestrator_owned', jobId: null }
    : null;

  return {
    ok: true,
    creatorId: creator.id,
    accountId,
    state,
    catchup: window.needed ? { ...window, scheduled } : { needed: false },
  };
}

async function updateObservationFromHeartbeat({ agencyId, deviceId, accounts = [], now = new Date(), db = prisma }) {
  const list = Array.isArray(accounts) ? accounts : [];
  const current = dateOrNull(now) || new Date();
  const results = [];
  for (const account of list) {
    const status = String(account?.status || "").toUpperCase();
    if (status && status !== "READY") continue;
    try {
      const result = await upsertObservationHeartbeat({ agencyId, deviceId, account, now: current, db });
      results.push(result);
    } catch (err) {
      results.push({ ok: false, code: "OBSERVATION_HEARTBEAT_FAILED", error: err?.message || String(err) });
    }
  }
  return {
    ok: true,
    observed: results.filter((r) => r?.ok).length,
    scheduled: results.filter((r) => r?.catchup?.scheduled?.created).length,
    results,
  };
}

async function recordRealtimeObservationPing({
  agencyId,
  deviceId,
  account,
  now = new Date(),
  advanceRealtimeCoverage = true,
  db = prisma,
}) {
  const creator = await resolveCreatorForObservation({ agencyId, account, db });
  if (!creator?.id) return { ok: false, code: "CREATOR_NOT_FOUND" };

  const accountId =
    clean(account?.accountId || account?.creatorId || account?.backendCreatorId || creator.id, 160) || creator.id;
  const creatorRef = clean(
    account?.username || creator.username || account?.displayName || creator.displayName || null,
    160
  );
  const current = dateOrNull(now) || new Date();
  const frameAt = realtimeFrameSampleAt(account, current);
  const coverageAt = advanceRealtimeCoverage === true ? frameAt : null;

  // Heartbeat receipt time proves only that the desktop process answered. The
  // contiguous realtime boundary may advance no further than the actual inbound
  // frame sampled by that heartbeat. This also makes a request started before
  // sleep harmless when it completes after resume.
  let state = await db.teamObservationState.upsert({
    where: { agencyId_creatorId: { agencyId, creatorId: creator.id } },
    create: {
      agencyId,
      creatorId: creator.id,
      accountId,
      creatorRef,
      lastHeartbeatAt: current,
      lastObservedAt: current,
      lockedByDeviceId: clean(deviceId, 160),
      ...(coverageAt ? { lastRealtimeEventAt: coverageAt } : {}),
    },
    update: {
      accountId,
      creatorRef,
      lastHeartbeatAt: current,
      lastObservedAt: current,
    },
  });

  if (coverageAt && db.teamObservationState.updateMany) {
    // Multiple devices can heartbeat concurrently. Never let a delayed older
    // sample move the creator-wide boundary backwards. A previously polluted
    // far-future timestamp is the one exception and is repaired by the next
    // valid frame.
    await db.teamObservationState.updateMany({
      where: {
        agencyId,
        creatorId: creator.id,
        OR: [
          { lastRealtimeEventAt: null },
          { lastRealtimeEventAt: { lt: coverageAt } },
          { lastRealtimeEventAt: { gt: new Date(current.getTime() + REALTIME_CLOCK_SKEW_MS) } },
        ],
      },
      data: { lastRealtimeEventAt: coverageAt },
    });
    if (db.teamObservationState.findUnique) {
      state = await db.teamObservationState.findUnique({
        where: { agencyId_creatorId: { agencyId, creatorId: creator.id } },
      }).catch(() => state);
    }
  }

  return {
    ok: true,
    creatorId: creator.id,
    accountId,
    coverageAdvanced: Boolean(coverageAt),
    coverageAt: coverageAt?.toISOString() || null,
    state,
  };
}

function eventList(result) {
  const raw = result?.events || result?.items || result?.normalizedEvents || [];
  return Array.isArray(raw) ? raw : [];
}

function normalizeEvent(payload = {}) {
  const extra = payload?.extra && typeof payload.extra === "object" ? payload.extra : {};
  return { ...payload, ...extra };
}

const LEGACY_SUBSCRIPTION_EVENT_TYPES = Object.freeze({
  SUBSCRIBED_FREE: "free_subscribed",
  SUBSCRIBED_PAID: "paid_subscribed",
  RENEWED: "subscription_renewed",
  RESUBSCRIBED: "subscription_resubscribed",
  EXPIRED: "subscription_expired",
  AUTO_RENEW_ENABLED: "auto_renew_enabled",
  AUTO_RENEW_DISABLED: "auto_renew_disabled",
  REFUNDED: "subscription_refunded",
});

function compatibilityEventKey(event) {
  const direct = clean(
    event?.notificationId
      || event?.tipId
      || event?.purchaseId
      || event?.eventHash
      || event?.externalEventId,
    220,
  );
  if (direct) return direct;
  const transactionId = clean(event?.transactionId, 180);
  if (!transactionId) return null;
  const eventType = clean(event?.eventType || event?.type || "event", 80) || "event";
  return clean(`${transactionId}:${eventType}`, 220);
}

function projectSaleProjectionFact(row) {
  return {
    kind: "sale",
    fanId: row.fanOnlyFansUserIdAtEvent || row.fan?.onlyFansUserId || null,
    messageId: row.messageId || null,
    amountCents: row.amountCents,
    currency: row.currency,
    occurredAt: row.purchasedAt,
    purchaseId: row.externalNotificationId || row.externalTransactionId || row.eventFingerprint,
    eventHash: row.eventFingerprint,
  };
}

function projectTipProjectionFact(row) {
  return {
    kind: "tip",
    eventType: "tip_received",
    fanId: row.fanOnlyFansUserIdAtEvent || row.fan?.onlyFansUserId || null,
    fanUsername: row.fan?.username || null,
    fanName: row.fan?.displayName || null,
    dialogId: row.fanOnlyFansUserIdAtEvent || row.fan?.onlyFansUserId || null,
    messageId: row.messageId || null,
    amountCents: row.amountCents,
    currency: row.currency,
    occurredAt: row.tippedAt,
    receivedAt: row.tippedAt,
    notificationId: row.externalNotificationId || null,
    transactionId: row.externalTransactionId || null,
    tipId: row.externalNotificationId || row.externalTransactionId || row.eventFingerprint,
    eventHash: row.eventFingerprint,
    source: "notification_facts_ledger_projection",
  };
}

function projectSubscriptionProjectionFact(row) {
  return {
    kind: "subscription",
    eventType: LEGACY_SUBSCRIPTION_EVENT_TYPES[row.eventType] || String(row.eventType || "").toLowerCase(),
    fanId: row.fanOnlyFansUserIdAtEvent || row.fan?.onlyFansUserId || null,
    fanUsername: row.fan?.username || null,
    fanName: row.fan?.displayName || null,
    dialogId: row.fanOnlyFansUserIdAtEvent || row.fan?.onlyFansUserId || null,
    amountCents: row.observedPriceCents,
    currency: row.currency,
    occurredAt: row.occurredAt,
    subscribedAt: row.occurredAt,
    notificationId: row.externalNotificationId || null,
    transactionId: row.externalTransactionId || null,
    externalEventId: row.externalNotificationId || row.eventFingerprint,
    eventHash: row.eventFingerprint,
    source: "notification_facts_ledger_projection",
  };
}

async function applyCatchupJobResult({ db = prisma, job, deviceId, result }) {
  const params = job?.params && typeof job.params === "object" ? job.params : {};
  assertNotificationCollectionResult({ job, scanRunId: result?.scanRunId, notificationMode: result?.notificationMode });
  const events = eventList(result);
  const now = await require("./db-time-authority-service").dbAuthorityNow({ db, fallbackNow: new Date() });
  const ledger = await ingestNotificationFacts({
    job,
    deviceId,
    db,
    result: {
      ...result,
      // Schema-3 collectors commit facts page-by-page and completion carries
      // an explicit empty array. Legacy schema-1/2 continuations are discarded
      // by the desktop protocol fence before reaching this boundary.
      events,
      // Preserve the collector-owned run identity. The notification ingest
      // contract rejects a generic completion key because it cannot be fenced
      // from another scan pass of the same JobInstance.
      batchKey: result?.batchKey,
      finalizeCoverage: true,
    },
  });

  const summary = {
    received: Number.isInteger(result?.totalAcceptedEvents) && result.totalAcceptedEvents >= 0
      ? result.totalAcceptedEvents
      : events.length,
    analyticsBatchId: ledger.batchId,
    analyticsBatchStatus: ledger.status,
    analyticsInserted: ledger.inserted,
    analyticsUpdated: ledger.updated,
    analyticsUnchanged: ledger.unchanged,
    analyticsRejected: ledger.rejected,
    analyticsCoverageComplete: ledger.coverageComplete === true,
    collectionCoverageByType: ledger.coverageByType || {},
    analyticsReplay: ledger.replayed === true,
    compatibilityCandidates: 0,
    compatibilityProcessed: 0,
    compatibilityTruncated: false,
    ppvCreatedOrUpdated: 0,
    tipCreatedOrUpdated: 0,
    subscriptionCreatedOrUpdated: 0,
    subscriptionFreeIgnored: 0,
    subscriptionRefundIgnored: 0,
    trafficValueDirtyMembers: 0,
    trafficHydrateScheduled: false,
    deduped: 0,
    skipped: 0,
    errors: 0,
    bumpSubscriptionEvents: 0,
    bumpPlanned: 0,
    bumpErrors: 0,
  };

  // Completion proves canonical collection only. Required projections have a
  // durable intent in the same root as the terminal Job/SyncState transition.
  await require("./notification-consequence-service").publishNotificationConsequences({ db, job });
  summary.compatibilityDeferred = true;

  const scanTo = dateOrNull(params.to || result?.to) || now;
  const types = Array.isArray(params.types)
    ? [...new Set(params.types.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))]
    : ["purchases", "tips", "subscriptions", "likes", "comments"];
  const pageProof = await require("./notification-page-receipt-service").notificationCommittedPageProof(db, job, result);
  summary.pageProof = pageProof;
  const coverageByType = ledger.coverageByType || {};
  const typeComplete = (type) => coverageByType[type] === "complete";
  const allRequestedComplete = types.length > 0 && types.every(typeComplete);
  const compatibilityComplete = false; // Independently acknowledged by durable work.
  // Collection verification belongs only to canonical source traversal/facts.
  // Optional compatibility automation may fail and remain visible in the Team
  // activity projection, but it must never invalidate Analytics proof or cause
  // another OnlyFans traversal.
  const collectionFactsVerified = ledger.status === "COMMITTED"
    && allRequestedComplete
    && ledger.rejected === 0
    && pageProof.verified;
  const fullySuccessful = collectionFactsVerified;
  const data = {
    currentScanStatus: fullySuccessful ? "idle" : "error",
    currentScanFrom: fullySuccessful ? null : dateOrNull(params.from),
    currentScanTo: fullySuccessful ? null : scanTo,
    currentScanTypes: fullySuccessful ? null : types,
    lockedByDeviceId: null,
    lockedUntil: null,
    ...(fullySuccessful ? {
      lastSuccessfulScanAt: now,
      lastObservedAt: maxDate(scanTo, now),
      lastErrorCode: null,
      lastErrorAt: null,
    } : {
      lastErrorCode: summary.errors > 0
        ? "notification_compatibility_partial"
        : ledger.rejected > 0
          ? "notification_rows_rejected"
          : "notification_scan_partial",
      lastErrorAt: now,
    }),
    lastScanSummary: {
      ...summary,
      jobId: job.id,
      from: params.from || null,
      to: params.to || null,
      scanner: result?.scanner || null,
      requestedTypes: types,
      coverageByType,
      fullySuccessful,
    },
    ...(types.includes("purchases") && typeComplete("purchases") && ledger.rejected === 0 && pageProof.verified
      ? { lastPurchaseScanTo: scanTo }
      : {}),
    ...(types.includes("tips") && typeComplete("tips") && ledger.rejected === 0 && pageProof.verified
      ? { lastTipScanTo: scanTo }
      : {}),
  };

  await db.teamObservationState.upsert({
    where: { agencyId_creatorId: { agencyId: job.agencyId, creatorId: job.creatorId } },
    create: {
      agencyId: job.agencyId,
      creatorId: job.creatorId,
      accountId: clean(params.accountId || job.creatorId || "unknown", 160) || "unknown",
      creatorRef: clean(params.creatorRef, 160),
      ...data,
    },
    update: data,
  });
  await completeNotificationSync({ db, job, deviceId, result, successful: collectionFactsVerified });
  const notificationMode = String(result?.notificationMode || params.notificationMode || "full").trim().toLowerCase() === "catchup"
    ? "catchup" : "full";
  const sourceTraversalComplete = result?.sourceExhausted === true
    && (notificationMode !== "full" || result?.allSourceExhausted === true)
    && ["COMMITTED", "PARTIAL"].includes(ledger.status);
  const collectionVerified = collectionFactsVerified && sourceTraversalComplete;
  // A PARTIAL canonical collection must return ok=false so JobInstance and the
  // durable SyncState enter the same bounded retry/quarantine lifecycle. A
  // compatibility-only failure is deliberately excluded from this decision.
  return {
    ok: collectionVerified,
    verified: collectionVerified,
    sourceTraversalComplete,
    compatibilityComplete,
    fullySuccessful,
    summary,
  };
}

async function recordCatchupJobFailure({ job, error, db = prisma, terminal = true, retryAfterAt = null }) {
  if (!job?.agencyId || !job?.creatorId) return null;
  const params = job.params && typeof job.params === "object" ? job.params : {};
  // Collection-control retry/quarantine is part of the same durable failure
  // decision as JobInstance. Never swallow a sync-state write failure here: a
  // terminal Job with a stale PARTIAL state would let the planner emit a new
  // generation and silently bypass quarantine.
  await recordNotificationSyncFailure({ db, job, error, terminal, retryAfterAt });
  return db.teamObservationState.upsert({
    where: { agencyId_creatorId: { agencyId: job.agencyId, creatorId: job.creatorId } },
    create: {
      agencyId: job.agencyId,
      creatorId: job.creatorId,
      accountId: clean(params.accountId || job.creatorId || "unknown", 160) || "unknown",
      creatorRef: clean(params.creatorRef, 160),
      currentScanStatus: "error",
      lastErrorCode: clean(error, 500) || "catchup_failed",
      lastErrorAt: new Date(),
    },
    update: {
      currentScanStatus: "error",
      lockedByDeviceId: null,
      lockedUntil: null,
      lastErrorCode: clean(error, 500) || "catchup_failed",
      lastErrorAt: new Date(),
    },
  });
}

module.exports = {
  projectSaleProjectionFact,
  projectTipProjectionFact,
  projectSubscriptionProjectionFact,
  CATCHUP_JOB_KEY,
  updateObservationFromHeartbeat,
  recordRealtimeObservationPing,
  realtimeFrameSampleAt,
  applyCatchupJobResult,
  recordCatchupJobFailure,
};
