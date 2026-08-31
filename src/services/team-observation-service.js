"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { upsertPurchaseFromEvent } = require("./team-ppv-ledger-service");
const { ingestTipEvent } = require("./team-tip-ledger-service");
const { ingestSubscriptionEvent, markTrafficFanValueDirty } = require("./traffic-service");
const { processRuntimeEvents: processBumpRuntimeEvents } = require("./bump-service");
const { ingestNotificationFacts } = require("./notification-facts-service");
const { completeNotificationSync, recordNotificationSyncFailure } = require("./notification-sync-state-service");

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

function amountCents(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(
    String(value)
      .replace(/[^0-9.,-]/g, "")
      .replace(",", ".")
  );
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
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

async function upsertObservationHeartbeat({ agencyId, deviceId, account, now = new Date() }) {
  const creator = await resolveCreatorForObservation({ agencyId, account });
  if (!creator?.id) return { ok: false, code: "CREATOR_NOT_FOUND" };

  const accountId =
    clean(account?.accountId || account?.creatorId || account?.backendCreatorId || creator.id, 160) || creator.id;
  const creatorRef = clean(
    account?.username || creator.username || account?.displayName || creator.displayName || null,
    160
  );

  const prev = await prisma.teamObservationState
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

  let state = await prisma.teamObservationState.upsert({
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

async function updateObservationFromHeartbeat({ agencyId, deviceId, accounts = [] }) {
  const list = Array.isArray(accounts) ? accounts : [];
  const now = new Date();
  const results = [];
  for (const account of list) {
    const status = String(account?.status || "").toUpperCase();
    if (status && status !== "READY") continue;
    try {
      const result = await upsertObservationHeartbeat({ agencyId, deviceId, account, now });
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

const NOTIFICATION_COMPATIBILITY_PAGE_SIZE = 500;
const BUMP_COMPATIBILITY_PAGE_SIZE = 200;
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

function projectTipCompatibilityEvent(row) {
  return {
    eventType: "tip_received",
    fanId: row.fan?.onlyFansUserId || null,
    fanUsername: row.fan?.username || null,
    fanName: row.fan?.displayName || null,
    dialogId: row.fan?.onlyFansUserId || null,
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

function projectSubscriptionCompatibilityEvent(row) {
  return {
    eventType: LEGACY_SUBSCRIPTION_EVENT_TYPES[row.eventType] || String(row.eventType || "").toLowerCase(),
    fanId: row.fan?.onlyFansUserId || null,
    fanUsername: row.fan?.username || null,
    fanName: row.fan?.displayName || null,
    dialogId: row.fan?.onlyFansUserId || null,
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

async function* iterateModelRows({ model, where, select }) {
  let cursor = null;
  while (true) {
    const rows = await model.findMany({
      where,
      orderBy: { id: "asc" },
      take: NOTIFICATION_COMPATIBILITY_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, ...select },
    });
    for (const row of rows) yield row;
    if (rows.length < NOTIFICATION_COMPATIBILITY_PAGE_SIZE) break;
    const nextCursor = rows.at(-1)?.id;
    if (!nextCursor || nextCursor === cursor) {
      throw Object.assign(new Error("Notification compatibility pagination cursor stalled"), {
        code: "NOTIFICATION_COMPATIBILITY_CURSOR_STALLED",
      });
    }
    cursor = nextCursor;
  }
}

async function* iterateLedgerCompatibilityEvents({ db, job, legacyEvents }) {
  const seen = new Set();
  const yieldUnique = function* (events) {
    for (const event of events) {
      const key = compatibilityEventKey(event)
        || stableHashSeed([event?.eventType, event?.fanId, event?.messageId, event?.amountCents, event?.occurredAt]);
      if (seen.has(key)) continue;
      seen.add(key);
      yield event;
    }
  };

  yield* yieldUnique(legacyEvents);
  if (!db?.creatorTip?.findMany || !db?.creatorSubscriptionEvent?.findMany) return;

  const tipRows = iterateModelRows({
    model: db.creatorTip,
    where: { creatorId: job.creatorId, sourceJobId: job.id },
    select: {
      eventFingerprint: true, externalNotificationId: true, externalTransactionId: true,
      messageId: true, amountCents: true, currency: true, tippedAt: true,
      fan: { select: { onlyFansUserId: true, username: true, displayName: true } },
    },
  });
  for await (const row of tipRows) yield* yieldUnique([projectTipCompatibilityEvent(row)]);

  const subscriptionRows = iterateModelRows({
    model: db.creatorSubscriptionEvent,
    where: { creatorId: job.creatorId, sourceJobId: job.id },
    select: {
      eventFingerprint: true, externalNotificationId: true, externalTransactionId: true,
      eventType: true, observedPriceCents: true, currency: true, occurredAt: true,
      fan: { select: { onlyFansUserId: true, username: true, displayName: true } },
    },
  });
  for await (const row of subscriptionRows) yield* yieldUnique([projectSubscriptionCompatibilityEvent(row)]);
}

async function applyCatchupJobResult({ db = prisma, job, deviceId, userId, result }) {
  const params = job?.params && typeof job.params === "object" ? job.params : {};
  const events = eventList(result);
  const now = new Date();
  const bumpSubscriptionEvents = [];
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
    analyticsCoverageByType: ledger.coverageByType || {},
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

  const flushBumpSubscriptionEvents = async () => {
    if (!bumpSubscriptionEvents.length) return;
    const batch = bumpSubscriptionEvents.splice(0, BUMP_COMPATIBILITY_PAGE_SIZE);
    summary.bumpSubscriptionEvents += batch.length;
    try {
      const bumpResult = await processBumpRuntimeEvents({
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        userId,
        events: batch,
      });
      summary.bumpPlanned += Number(bumpResult?.planned || 0);
      summary.bumpErrors += Array.isArray(bumpResult?.errors) ? bumpResult.errors.length : 0;
    } catch (error) {
      // Bump automation is a compatibility side effect, not the source of
      // truth for the notification ledger. Record it without discarding facts.
      summary.bumpErrors += 1;
      if (!summary.errorSamples) summary.errorSamples = [];
      if (summary.errorSamples.length < 5) summary.errorSamples.push(`bump:${error?.message || String(error)}`);
    }
  };

  const markTrafficDirty = async (ev, reason) => {
    const fanId = clean(ev.fanId || ev.dialogId, 160);
    if (!fanId) return null;
    const dirty = await markTrafficFanValueDirty({
      agencyId: job.agencyId,
      creatorId: job.creatorId,
      fanId,
      occurredAt: dateOrNull(ev.receivedAt || ev.purchasedAt || ev.occurredAt || ev.ts) || now,
      reason,
    });
    if (dirty?.matched) summary.trafficValueDirtyMembers += Number(dirty.matched || 0);
    return dirty;
  };

  for await (const raw of iterateLedgerCompatibilityEvents({ db, job, legacyEvents: events })) {
    summary.compatibilityCandidates += 1;
    summary.compatibilityProcessed += 1;
    const ev = normalizeEvent(raw);
    const type = String(ev.type || ev.eventType || "").toLowerCase();
    const accountId = clean(ev.accountId || params.accountId || job.creatorId || "unknown", 160) || "unknown";
    const creatorRef = clean(ev.creatorRef || params.creatorRef || null, 160);
    try {
      if (type.includes("purchase") || type.includes("ppv")) {
        await upsertPurchaseFromEvent({
          type: ev.attributedMemberId ? "ppv_purchase_attributed" : "ppv_purchase_unresolved",
          agencyId: job.agencyId,
          accountId,
          creatorId: job.creatorId,
          creatorRef,
          fanId: clean(ev.fanId || ev.dialogId, 160),
          memberId: clean(ev.attributedMemberId, 160),
          userId: clean(ev.attributedUserId, 160),
          deviceId,
          ts: dateOrNull(ev.occurredAt || ev.purchasedAt || ev.ts)?.getTime?.() || Date.now(),
          localId: clean(ev.localId || ev.purchaseId || ev.notificationId || ev.messageId || null, 220),
          extra: {
            // Scanner already canonicalizes purchaseId to match realtime. Keep
            // notificationId first as a final backend guard for old scanner builds.
            purchaseId:
              clean(ev.notificationId || ev.purchaseId || ev.transactionId || ev.localId || null, 220) ||
              stableHashSeed([accountId, ev.messageId, ev.fanId, ev.amountCents, ev.occurredAt]),
            notificationId: clean(ev.notificationId, 220),
            messageId: clean(ev.messageId, 160),
            dialogId: clean(ev.dialogId || ev.fanId, 160),
            fanId: clean(ev.fanId || ev.dialogId, 160),
            amountCents: amountCents(ev.amountCents) || amountDollarsToCents(ev.amount),
            currency: clean(ev.currency || "USD", 16) || "USD",
            purchasedAt: dateOrNull(ev.purchasedAt || ev.occurredAt || ev.ts) || now,
            source: "catchup_notifications_scan",
            deviceId,
          },
        });
        summary.ppvCreatedOrUpdated += 1;
        await markTrafficDirty(ev, "catchup_ppv_purchase");
        continue;
      }

      if (type.includes("tip")) {
        const tipResult = await ingestTipEvent({
          agencyId: job.agencyId,
          userId,
          payload: {
            accountId,
            creatorId: job.creatorId,
            creatorRef,
            fanId: clean(ev.fanId || ev.dialogId, 160),
            dialogId: clean(ev.dialogId || ev.fanId, 160),
            messageId: clean(ev.messageId, 160),
            amountCents: amountCents(ev.amountCents) || amountDollarsToCents(ev.amount),
            currency: clean(ev.currency || "USD", 8) || "USD",
            occurredAt: dateOrNull(ev.receivedAt || ev.occurredAt || ev.ts) || now,
            ts: dateOrNull(ev.receivedAt || ev.occurredAt || ev.ts) || now,
            eventHash: clean(ev.eventHash, 220),
            tipId: clean(ev.tipId || ev.notificationId || ev.localId, 220),
            notificationId: clean(ev.notificationId, 220),
            toastId: clean(ev.toastId, 220),
            targetUrl: clean(ev.targetUrl, 500),
            source: "catchup_notifications_scan",
          },
        });
        if (tipResult?.deduped) summary.deduped += 1;
        else summary.tipCreatedOrUpdated += 1;
        await markTrafficDirty(ev, "catchup_tip");
        continue;
      }

      if (type.includes("subscription") || type.includes("subscrib")) {
        const subscriptionFanId = clean(ev.fanId || ev.dialogId, 160);
        const subscriptionLifecycleType = String(ev.eventType || type).toLowerCase();
        const shouldPlanBump = /(subscribed|resubscribed|renewed)/.test(subscriptionLifecycleType)
          && !/(expired|refund|chargeback|auto.?renew)/.test(subscriptionLifecycleType);
        if (subscriptionFanId && shouldPlanBump) {
          bumpSubscriptionEvents.push({
            type: "subscription_created",
            fanId: subscriptionFanId,
            dialogId: clean(ev.dialogId || subscriptionFanId, 160) || subscriptionFanId,
            createdAt: dateOrNull(ev.subscribedAt || ev.occurredAt || ev.ts) || now,
            source: "catchup_notifications_scan",
            fanSnapshot: {
              id: subscriptionFanId,
              username: clean(ev.fanUsername || ev.username, 120),
              name: clean(ev.fanName || ev.name, 160),
              subscriptionType: String(ev.eventType || type).toLowerCase().includes("paid") ? "paid" : "free",
              isActive: true,
              canReceiveChatMessage: true,
              dialogId: clean(ev.dialogId || subscriptionFanId, 160) || subscriptionFanId,
            },
          });
          if (bumpSubscriptionEvents.length >= BUMP_COMPATIBILITY_PAGE_SIZE) await flushBumpSubscriptionEvents();
        }
        if (/(refund|chargeback|reversal)/.test(subscriptionLifecycleType)) {
          // The legacy CreatorSubscriptionLedger is positive-revenue only and
          // its aggregates do not filter eventType. Projecting a refund there
          // would increase historical subscription revenue. The relational
          // CreatorSubscriptionEvent remains the authoritative refund record.
          summary.subscriptionRefundIgnored += 1;
          summary.skipped += 1;
          continue;
        }
        const subscriptionAmountCents = amountCents(ev.amountCents) || amountDollarsToCents(ev.amount || ev.price);
        if (subscriptionAmountCents <= 0) {
          summary.subscriptionFreeIgnored += 1;
          summary.skipped += 1;
          continue;
        }

        const subscriptionResult = await ingestSubscriptionEvent({
          agencyId: job.agencyId,
          deviceId,
          userId,
          creatorId: job.creatorId,
          accountId,
          event: {
            fanId: clean(ev.fanId || ev.dialogId, 160),
            eventType: clean(ev.eventType || "paid_subscribed", 80) || "paid_subscribed",
            amountCents: subscriptionAmountCents,
            amount: ev.amount,
            price: ev.price,
            currency: clean(ev.currency || "USD", 8) || "USD",
            occurredAt: dateOrNull(ev.subscribedAt || ev.occurredAt || ev.ts) || now,
            externalEventId: clean(ev.externalEventId || ev.notificationId || ev.localId, 220),
            eventHash: clean(ev.eventHash, 220),
            notificationId: clean(ev.notificationId, 220),
            source: "catchup_notifications_scan",
            metadata: {
              fanUsername: clean(ev.fanUsername || ev.username, 120),
              fanName: clean(ev.fanName || ev.name, 160),
              targetUrl: clean(ev.targetUrl, 500),
            },
          },
        });
        if (subscriptionResult?.duplicate) summary.deduped += 1;
        else if (!subscriptionResult?.ignored) summary.subscriptionCreatedOrUpdated += 1;
        continue;
      }

      summary.skipped += 1;
    } catch (err) {
      summary.errors += 1;
      if (!summary.errorSamples) summary.errorSamples = [];
      if (summary.errorSamples.length < 5) summary.errorSamples.push(err?.message || String(err));
    }
  }

  await flushBumpSubscriptionEvents();

  // P9 wave 1 is read-only discovery. Revenue events mark existing traffic
  // members dirty, but fan-value hydration is intentionally deferred to the
  // later Fan Intel/Vault wave instead of spawning a hidden second scanner.
  summary.trafficHydrateScheduled = false;

  const scanTo = dateOrNull(params.to || result?.to) || now;
  const types = Array.isArray(params.types)
    ? [...new Set(params.types.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))]
    : ["purchases", "tips", "subscriptions", "likes", "comments"];
  const coverageByType = ledger.coverageByType || {};
  const typeComplete = (type) => coverageByType[type] === "complete";
  const allRequestedComplete = types.length > 0 && types.every(typeComplete);
  const compatibilityComplete = summary.errors === 0;
  const fullySuccessful = ledger.status === "COMMITTED"
    && allRequestedComplete
    && compatibilityComplete
    && ledger.rejected === 0;
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
    ...(types.includes("purchases") && typeComplete("purchases") && ledger.rejected === 0
      ? { lastPurchaseScanTo: scanTo }
      : {}),
    ...(types.includes("tips") && typeComplete("tips") && ledger.rejected === 0
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
  await completeNotificationSync({ db, job, deviceId, result, successful: fullySuccessful });
  // Schema-4 ALL collectors can only reach completion after the explicit OF
  // source boundary. Rejected recognized facts remain visible as PARTIAL in the
  // sync state, but repeating the entire historical traversal cannot repair a
  // source row that lacks identity. Treat the transport as technically done and
  // reserve JobInstance retries for actual exceptions / lost leases.
  const sourceTraversalComplete = Number(result?.schemaVersion || 0) >= 4
    && result?.sourceExhausted === true
    && ["COMMITTED", "PARTIAL"].includes(ledger.status);
  return { ok: sourceTraversalComplete || fullySuccessful, verified: fullySuccessful, sourceTraversalComplete, summary };
}

async function recordCatchupJobFailure({ job, error, db = prisma }) {
  if (!job?.agencyId || !job?.creatorId) return null;
  const params = job.params && typeof job.params === "object" ? job.params : {};
  await recordNotificationSyncFailure({ db, job, error }).catch(() => null);
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
  CATCHUP_JOB_KEY,
  updateObservationFromHeartbeat,
  recordRealtimeObservationPing,
  realtimeFrameSampleAt,
  applyCatchupJobResult,
  recordCatchupJobFailure,
};
