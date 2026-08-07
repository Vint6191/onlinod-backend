"use strict";

const { parseStrictIsoDateTime } = require("./strict-date-time");

const FULL_HISTORY_FROM = new Date("2016-01-01T00:00:00.000Z");
const CATCHUP_OVERLAP_MS = 2 * 60 * 60 * 1000;

function clean(value, max = 220) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function strictDate(value) {
  return parseStrictIsoDateTime(value);
}
function nonNegativeInt(value, max = 100_000_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) return 0;
  return number;
}
function earliestDate(...values) {
  const dates = values.map(strictDate).filter(Boolean);
  return dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
}
function latestDate(...values) {
  const dates = values.map(strictDate).filter(Boolean);
  return dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null;
}
function runtimeRangeTo(now = new Date()) {
  return new Date(now.getTime() + 5 * 60 * 1000);
}

function buildNotificationScanParams({ state = null, now = new Date(), reason = "creator_analytics_refresh", analyticsRangeKey = "all" } = {}) {
  const fullVerified = Boolean(state?.fullBackfillVerifiedAt);
  if (!fullVerified) {
    return {
      from: FULL_HISTORY_FROM.toISOString(),
      to: runtimeRangeTo(now).toISOString(),
      types: ["purchases", "tips", "subscriptions", "likes", "comments"],
      notificationMode: "full",
      pageLimit: 10,
      reason,
      analyticsRangeKey,
    };
  }
  const newest = strictDate(state?.newestOccurredAt) || strictDate(state?.lastCatchupCompletedAt) || strictDate(state?.fullBackfillCompletedAt) || now;
  const from = new Date(Math.max(FULL_HISTORY_FROM.getTime(), newest.getTime() - CATCHUP_OVERLAP_MS));
  const stopAtNotificationId = clean(state?.headNotificationId, 220);
  return {
    from: from.toISOString(),
    to: runtimeRangeTo(now).toISOString(),
    types: ["purchases", "tips", "subscriptions", "likes", "comments"],
    notificationMode: "catchup",
    pageLimit: 10,
    ...(stopAtNotificationId ? { stopAtNotificationId } : {}),
    reason,
    analyticsRangeKey,
  };
}

async function loadNotificationSyncState(db, creatorId) {
  if (!db?.creatorNotificationSyncState?.findUnique) return null;
  return db.creatorNotificationSyncState.findUnique({ where: { creatorId } });
}

function pageOccurredBounds(chunk) {
  const batches = Array.isArray(chunk?.batches) ? chunk.batches : [];
  const dates = [];
  for (const batch of batches) {
    const events = Array.isArray(batch?.events) ? batch.events : [];
    for (const event of events) {
      const date = strictDate(event?.purchasedAt || event?.subscribedAt || event?.likedAt || event?.commentedAt || event?.receivedAt || event?.occurredAt || event?.ts);
      if (date) dates.push(date);
    }
  }
  return {
    oldest: dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null,
    newest: dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null,
  };
}

async function recordNotificationPageProgress({ db, job, deviceId, chunk }) {
  if (!db?.creatorNotificationSyncState?.upsert) return null;
  const mode = chunk?.notificationMode === "catchup" ? "catchup" : "full";
  const scanRunId = clean(chunk?.scanRunId, 80);
  if (!scanRunId || !/^[A-Za-z0-9._-]{8,80}$/.test(scanRunId)) throw new Error("Notification ALL page requires a valid scanRunId");
  const cursorEnd = clean(chunk?.cursorEnd, 220);
  const headNotificationId = clean(chunk?.headNotificationId, 220);
  const tailNotificationId = clean(chunk?.tailNotificationId, 220);
  const sourceExhausted = chunk?.sourceExhausted === true;
  const page = nonNegativeInt(chunk?.page, 1_000_000);
  const totalAcceptedRows = nonNegativeInt(chunk?.totalAcceptedRows ?? chunk?.acceptedRows);
  const totalRejectedRows = nonNegativeInt(chunk?.totalRejectedRows ?? chunk?.rejectedRows);
  const totalIgnoredRows = nonNegativeInt(chunk?.totalIgnoredRows ?? chunk?.ignoredRows);
  const bounds = pageOccurredBounds(chunk);
  const existing = await loadNotificationSyncState(db, job.creatorId);
  const sameRun = existing?.scanRunId === scanRunId;
  const data = {
    status: "SCANNING",
    mode,
    scanRunId,
    nextCursor: sourceExhausted ? null : cursorEnd,
    headNotificationId: headNotificationId || (sameRun ? existing?.headNotificationId : null) || existing?.headNotificationId || null,
    tailNotificationId: tailNotificationId || (sameRun ? existing?.tailNotificationId : null) || null,
    oldestOccurredAt: earliestDate(existing?.oldestOccurredAt, bounds.oldest),
    newestOccurredAt: latestDate(existing?.newestOccurredAt, bounds.newest),
    pagesScanned: sameRun ? Math.max(nonNegativeInt(existing?.pagesScanned), page) : page,
    eventsAccepted: sameRun ? Math.max(nonNegativeInt(existing?.eventsAccepted), totalAcceptedRows) : totalAcceptedRows,
    eventsRejected: sameRun ? Math.max(nonNegativeInt(existing?.eventsRejected), totalRejectedRows) : totalRejectedRows,
    ignoredEvents: sameRun ? Math.max(nonNegativeInt(existing?.ignoredEvents), totalIgnoredRows) : totalIgnoredRows,
    lastErrorCode: null,
    lastErrorMessage: null,
    sourceDeviceId: clean(deviceId, 220),
    sourceJobId: clean(job.id, 220),
  };
  return db.creatorNotificationSyncState.upsert({
    where: { creatorId: job.creatorId },
    create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data },
    update: data,
  });
}

async function completeNotificationSync({ db, job, deviceId, result, successful }) {
  if (!db?.creatorNotificationSyncState?.upsert) return null;
  const now = new Date();
  const mode = result?.notificationMode === "catchup" ? "catchup" : "full";
  const existing = await loadNotificationSyncState(db, job.creatorId);
  const sourceExhausted = result?.sourceExhausted === true;
  const verified = successful === true && sourceExhausted;
  const sourceTraversalComplete = sourceExhausted === true;
  const fullHistoryVerified = mode === "full" ? verified : Boolean(existing?.fullBackfillVerifiedAt);
  const overallComplete = verified && fullHistoryVerified;
  const data = {
    status: overallComplete ? "COMPLETE" : "PARTIAL",
    mode,
    scanRunId: clean(result?.scanRunId, 80),
    nextCursor: sourceTraversalComplete ? null : clean(result?.tailNotificationId, 220),
    headNotificationId: clean(result?.headNotificationId, 220) || existing?.headNotificationId || null,
    tailNotificationId: clean(result?.tailNotificationId, 220) || existing?.tailNotificationId || null,
    pagesScanned: Math.max(nonNegativeInt(existing?.pagesScanned), nonNegativeInt(object(result?.coverage).purchases?.pages, 1_000_000)),
    lastErrorCode: overallComplete ? null
      : verified && mode === "catchup" && !fullHistoryVerified ? "NOTIFICATION_FULL_BACKFILL_PARTIAL"
        : sourceTraversalComplete ? "NOTIFICATION_FACTS_PARTIAL" : "NOTIFICATION_SCAN_PARTIAL",
    lastErrorMessage: overallComplete ? null
      : verified && mode === "catchup" && !fullHistoryVerified
        ? "Catch-up completed, but the initial full notification backfill still contains rejected facts"
        : sourceTraversalComplete
          ? "Notification ALL reached the source boundary, but one or more recognized facts were rejected"
          : "Notification ALL scan did not reach a proven source boundary",
    sourceDeviceId: clean(deviceId, 220),
    sourceJobId: clean(job.id, 220),
    ...(sourceTraversalComplete && mode === "full" ? {
      fullBackfillCompletedAt: existing?.fullBackfillCompletedAt || now,
      // A current full rebuild owns verification truth. A stale verification
      // from the old ALL-only collector must not survive a newer partial full
      // run, otherwise later scheduler passes incorrectly downgrade to catch-up.
      fullBackfillVerifiedAt: verified ? now : null,
    } : {}),
    ...(sourceTraversalComplete && mode === "catchup" ? { lastCatchupCompletedAt: now } : {}),
  };
  return db.creatorNotificationSyncState.upsert({
    where: { creatorId: job.creatorId },
    create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data },
    update: data,
  });
}

async function recordNotificationSyncFailure({ db, job, deviceId = null, error }) {
  if (!db?.creatorNotificationSyncState?.upsert || !job?.creatorId || !job?.agencyId) return null;
  const params = object(job.params);
  const data = {
    status: "FAILED",
    mode: params.notificationMode === "catchup" ? "catchup" : "full",
    lastErrorCode: clean(error?.code || "NOTIFICATION_SCAN_FAILED", 120),
    lastErrorMessage: clean(error?.message || error, 2_000),
    sourceDeviceId: clean(deviceId, 220),
    sourceJobId: clean(job.id, 220),
  };
  return db.creatorNotificationSyncState.upsert({
    where: { creatorId: job.creatorId },
    create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data },
    update: data,
  });
}

async function recordNotificationSocketEvent({ db, agencyId, creatorId, deviceId, occurredAt = new Date() }) {
  if (!db?.creatorNotificationSyncState?.upsert) return null;
  const at = strictDate(occurredAt) || new Date();
  const existing = await loadNotificationSyncState(db, creatorId);
  const fullVerified = Boolean(existing?.fullBackfillVerifiedAt);
  const data = {
    status: fullVerified ? "COMPLETE" : (existing?.status === "SCANNING" ? "SCANNING" : "PARTIAL"),
    mode: fullVerified ? "live" : (existing?.mode || "full"),
    lastSocketEventAt: at,
    newestOccurredAt: latestDate(existing?.newestOccurredAt, at),
    sourceDeviceId: clean(deviceId, 220),
    lastErrorCode: existing?.lastErrorCode || null,
    lastErrorMessage: existing?.lastErrorMessage || null,
  };
  return db.creatorNotificationSyncState.upsert({
    where: { creatorId },
    create: { agencyId, creatorId, ...data },
    update: data,
  });
}

module.exports = {
  FULL_HISTORY_FROM,
  CATCHUP_OVERLAP_MS,
  buildNotificationScanParams,
  loadNotificationSyncState,
  recordNotificationPageProgress,
  completeNotificationSync,
  recordNotificationSyncFailure,
  recordNotificationSocketEvent,
};
