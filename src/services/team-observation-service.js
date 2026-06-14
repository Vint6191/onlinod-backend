"use strict";

const prisma = require("../prisma");
const { upsertPurchaseFromEvent } = require("./team-ppv-ledger-service");
const { ingestTipEvent } = require("./team-tip-ledger-service");

const CATCHUP_JOB_KEY = "catchup_notifications_scan";
const DEFAULT_BUFFER_MS = 2 * 60 * 60 * 1000;
const DEFAULT_OFFLINE_GAP_MS = 10 * 60 * 1000;
const DEFAULT_MAX_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_MS = 10 * 60 * 1000;

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

function minDate(...values) {
  let best = null;
  for (const value of values) {
    const d = dateOrNull(value);
    if (!d) continue;
    if (!best || d.getTime() < best.getTime()) best = d;
  }
  return best;
}

function amountCents(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(String(value).replace(/[^0-9.,-]/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function amountDollarsToCents(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(String(value).replace(/[^0-9.,-]/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 100));
}

function stableHashSeed(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value || ""); }
}

function resolveAccountRefs(account = {}) {
  const remoteId = account?.remoteId === undefined || account?.remoteId === null ? null : String(account.remoteId);
  const username = account?.username ? String(account.username).replace(/^@/, "") : null;
  const candidateIds = [account?.creatorId, account?.backendCreatorId, account?.accountId, account?.id]
    .map((value) => clean(value, 160))
    .filter(Boolean);
  return { remoteId, username, candidateIds };
}

async function resolveCreatorForObservation({ agencyId, account }) {
  const { remoteId, username, candidateIds } = resolveAccountRefs(account);
  const or = [];
  if (candidateIds.length) or.push({ id: { in: candidateIds } });
  if (remoteId) or.push({ remoteId });
  if (username) or.push({ username });
  if (!or.length) return null;
  return prisma.creatorAccount.findFirst({
    where: { agencyId, deletedAt: null, OR: or },
    select: { id: true, username: true, remoteId: true, displayName: true },
  });
}

async function findActiveCatchupJob({ agencyId, creatorId }) {
  return prisma.jobInstance.findFirst({
    where: {
      agencyId,
      creatorId,
      jobKey: CATCHUP_JOB_KEY,
      status: { in: ["SCHEDULED", "CLAIMED"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, nextRunAt: true, leaseUntil: true },
  });
}

async function scheduleCatchupJob({ agencyId, creatorId, accountId, creatorRef, deviceId, from, to, types = ["purchases", "tips"], reason = "offline_gap" }) {
  const active = await findActiveCatchupJob({ agencyId, creatorId });
  if (active) return { created: false, reason: "already_in_flight", jobId: active.id };

  const job = await prisma.jobInstance.create({
    data: {
      jobKey: CATCHUP_JOB_KEY,
      scope: "creator",
      agencyId,
      creatorId,
      priority: 80,
      nextRunAt: new Date(),
      params: {
        accountId: accountId || creatorId,
        creatorRef: creatorRef || null,
        from: from.toISOString(),
        to: to.toISOString(),
        types,
        reason,
        bufferMinutes: Math.round(DEFAULT_BUFFER_MS / 60000),
        requestedByDeviceId: deviceId || null,
      },
    },
  });

  return { created: true, jobId: job.id };
}

function computeCatchupWindow(prev, now = new Date()) {
  const lastObserved = maxDate(prev?.lastObservedAt, prev?.lastRealtimeEventAt, prev?.lastHeartbeatAt, prev?.lastSuccessfulScanAt);
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

  const accountId = clean(account?.accountId || account?.creatorId || account?.backendCreatorId || creator.id, 160) || creator.id;
  const creatorRef = clean(account?.username || creator.username || account?.displayName || creator.displayName || null, 160);

  const prev = await prisma.teamObservationState.findUnique({
    where: { agencyId_creatorId: { agencyId, creatorId: creator.id } },
  }).catch(() => null);

  const window = computeCatchupWindow(prev, now);
  const scanTypes = ["purchases", "tips"];
  let scheduled = null;

  if (window.needed) {
    scheduled = await scheduleCatchupJob({
      agencyId,
      creatorId: creator.id,
      accountId,
      creatorRef,
      deviceId,
      from: window.from,
      to: window.to,
      types: scanTypes,
      reason: window.reason,
    });
  }

  const updateData = {
    accountId,
    creatorRef,
    lastHeartbeatAt: now,
    lastObservedAt: maxDate(now, prev?.lastObservedAt),
    ...(window.needed ? {
      currentScanStatus: scheduled?.created ? "queued" : (prev?.currentScanStatus || "idle"),
      currentScanFrom: window.from,
      currentScanTo: window.to,
      currentScanTypes: scanTypes,
      lockedByDeviceId: scheduled?.created ? clean(deviceId, 160) : (prev?.lockedByDeviceId || null),
      lockedUntil: scheduled?.created ? new Date(now.getTime() + DEFAULT_LOCK_MS) : (prev?.lockedUntil || null),
      lastErrorCode: null,
      lastErrorAt: null,
    } : {}),
  };

  const state = await prisma.teamObservationState.upsert({
    where: { agencyId_creatorId: { agencyId, creatorId: creator.id } },
    create: {
      agencyId,
      creatorId: creator.id,
      ...updateData,
    },
    update: updateData,
  });

  return { ok: true, creatorId: creator.id, accountId, state, catchup: window.needed ? { ...window, scheduled } : { needed: false } };
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

function eventList(result) {
  const raw = result?.events || result?.items || result?.normalizedEvents || [];
  return Array.isArray(raw) ? raw : [];
}

function normalizeEvent(payload = {}) {
  const extra = payload?.extra && typeof payload.extra === "object" ? payload.extra : {};
  return { ...payload, ...extra };
}

async function applyCatchupJobResult({ job, deviceId, userId, result }) {
  const params = job?.params && typeof job.params === "object" ? job.params : {};
  const events = eventList(result);
  const now = new Date();
  const summary = {
    received: events.length,
    ppvCreatedOrUpdated: 0,
    tipCreatedOrUpdated: 0,
    deduped: 0,
    skipped: 0,
    errors: 0,
  };

  for (const raw of events) {
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
            purchaseId: clean(ev.purchaseId || ev.notificationId || ev.transactionId || ev.localId || null, 220) || stableHashSeed([accountId, ev.messageId, ev.fanId, ev.amountCents, ev.occurredAt]),
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
        continue;
      }

      summary.skipped += 1;
    } catch (err) {
      summary.errors += 1;
      if (!summary.errorSamples) summary.errorSamples = [];
      if (summary.errorSamples.length < 5) summary.errorSamples.push(err?.message || String(err));
    }
  }

  const scanTo = dateOrNull(params.to || result?.to) || now;
  const types = Array.isArray(params.types) ? params.types.map(String) : ["purchases", "tips"];
  const data = {
    currentScanStatus: "idle",
    currentScanFrom: null,
    currentScanTo: null,
    currentScanTypes: null,
    lockedByDeviceId: null,
    lockedUntil: null,
    lastSuccessfulScanAt: now,
    lastObservedAt: maxDate(scanTo, now),
    lastScanSummary: { ...summary, jobId: job.id, from: params.from || null, to: params.to || null, scanner: result?.scanner || null },
    lastErrorCode: null,
    lastErrorAt: null,
    ...(types.includes("purchases") ? { lastPurchaseScanTo: scanTo } : {}),
    ...(types.includes("tips") ? { lastTipScanTo: scanTo } : {}),
  };

  await prisma.teamObservationState.upsert({
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

  return { ok: summary.errors === 0, summary };
}

async function recordCatchupJobFailure({ job, error }) {
  if (!job?.agencyId || !job?.creatorId) return null;
  const params = job.params && typeof job.params === "object" ? job.params : {};
  return prisma.teamObservationState.upsert({
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
  applyCatchupJobResult,
  recordCatchupJobFailure,
};
