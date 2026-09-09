"use strict";

const { parseStrictIsoDateTime } = require("./strict-date-time");
const { trustedCollectionTimestamp } = require("./analytics-freshness-policy");
const { collectionCommand, COLLECTOR_TYPES, withCollectorStateLock, commandAuthority, sameGeneration } = require("./analytics-collector-control-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

const FULL_HISTORY_FROM = new Date("2016-01-01T00:00:00.000Z");

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

function assertNotificationCollectionResult({ job, scanRunId, notificationMode = null } = {}) {
  const command = collectionCommand(job, COLLECTOR_TYPES.NOTIFICATIONS);
  const incomingRunId = clean(scanRunId, 120);
  if (!incomingRunId || incomingRunId !== command.generation) {
    const error = new Error("Notification result does not belong to the active server collection generation");
    error.code = "ANALYTICS_COLLECTION_GENERATION_MISMATCH";
    throw error;
  }
  if (notificationMode !== null && notificationMode !== undefined) {
    const incomingMode = String(notificationMode || "").trim().toLowerCase() === "catchup" ? "catchup" : "full";
    if (incomingMode !== command.mode) {
      const error = new Error("Notification result mode does not match the server collection command");
      error.code = "ANALYTICS_COLLECTION_MODE_MISMATCH";
      throw error;
    }
  }
  return command;
}

function buildNotificationScanParams({ state = null, now = new Date(), reason = "creator_analytics_refresh", analyticsRangeKey = "all" } = {}) {
  // Source traversal completion and durable proof are intentionally different.
  // A PARTIAL full scan may have reached the historical boundary while rejecting
  // canonical facts; that state must never unlock bounded catch-up as if the
  // baseline were proven. Only the durable verification timestamp is authority.
  const historicalBaseline = Boolean(trustedCollectionTimestamp(state?.fullBackfillVerifiedAt, now));
  if (!historicalBaseline) {
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
  // Catch-up traversal is ID-frontier bounded, not wall-clock bounded.
  // `newestOccurredAt` can move from realtime/socket provenance before the
  // durable notification frontier is verified. Using it as the lower event
  // filter can silently ignore an offline/delayed gap while the cursor still
  // reaches the old verified head. Keep the event floor at supported history;
  // the verified head/known-ID frontier bounds work and proves completion.
  const stopAtNotificationId = clean(state?.headNotificationId, 220);
  return {
    from: FULL_HISTORY_FROM.toISOString(),
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


function boundedNotificationIds(values, limit = 300) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = clean(value, 220);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

async function verifiedFrontierIds({ db, job, mode, headNotificationId, existingIds }) {
  const head = clean(headNotificationId, 220);
  // FULL history ends with an ALL reconciliation, but its scan-audit page numbers
  // also contain the earlier typed phases. The exact verified head is therefore
  // the only safe generic frontier we can derive without mixing phase histories.
  if (mode !== "catchup" || !db?.creatorNotificationScanItem?.findMany) {
    return boundedNotificationIds([head, ...(Array.isArray(existingIds) ? existingIds : [])]);
  }
  const rows = await db.creatorNotificationScanItem.findMany({
    where: { creatorId: job.creatorId, sourceJobId: job.id },
    orderBy: [{ page: "asc" }, { ordinal: "asc" }],
    take: 300,
    select: { notificationId: true },
  });
  return boundedNotificationIds([head, ...(rows || []).map((row) => row?.notificationId)]);
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
  const mode = chunk?.notificationMode === "catchup" ? "catchup" : "full";
  const command = assertNotificationCollectionResult({ job, scanRunId: chunk?.scanRunId, notificationMode: mode });
  if (!db?.creatorNotificationSyncState?.upsert) return null;
  const scanRunId = clean(chunk?.scanRunId, 120);
  if (!scanRunId || !/^[A-Za-z0-9._-]{8,120}$/.test(scanRunId)) throw new Error("Notification ALL page requires a valid scanRunId");
  const cursorEnd = clean(chunk?.cursorEnd, 220);
  const tailNotificationId = clean(chunk?.tailNotificationId, 220);
  const sourceExhausted = chunk?.sourceExhausted === true;
  const page = nonNegativeInt(chunk?.page, 1_000_000);
  const totalAcceptedRows = nonNegativeInt(chunk?.totalAcceptedRows ?? chunk?.acceptedRows);
  const totalRejectedRows = nonNegativeInt(chunk?.totalRejectedRows ?? chunk?.rejectedRows);
  const totalIgnoredRows = nonNegativeInt(chunk?.totalIgnoredRows ?? chunk?.ignoredRows);
  const bounds = pageOccurredBounds(chunk);
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.NOTIFICATIONS, creatorId: job.creatorId, work: async (tx) => {
    const existing = await loadNotificationSyncState(tx, job.creatorId);
    const authority = commandAuthority(existing, command);
    if (authority === "STALE") {
      const error = new Error("Notification page belongs to a stale server collection generation");
      error.code = "ANALYTICS_COLLECTION_GENERATION_STALE";
      throw error;
    }
    if (sameGeneration(existing, command) && ["COMPLETE", "PARTIAL"].includes(String(existing?.status || "").toUpperCase())) {
      return existing;
    }
    const sameRun = existing?.scanRunId === scanRunId;
    const data = {
      status: "SCANNING",
      mode,
      scanRunId,
      activeGeneration: command.generation,
      activeRequestedAt: command.requestedAt,
      nextCursor: sourceExhausted ? null : cursorEnd,
      // headNotificationId is the durable *verified* frontier. Working scan head
      // lives in the Desktop continuation/result until completion is proven.
      headNotificationId: existing?.headNotificationId || null,
      tailNotificationId: tailNotificationId || (sameRun ? existing?.tailNotificationId : null) || null,
      oldestOccurredAt: earliestDate(existing?.oldestOccurredAt, bounds.oldest),
      newestOccurredAt: latestDate(existing?.newestOccurredAt, bounds.newest),
      pagesScanned: sameRun ? Math.max(nonNegativeInt(existing?.pagesScanned), page) : page,
      eventsAccepted: sameRun ? Math.max(nonNegativeInt(existing?.eventsAccepted), totalAcceptedRows) : totalAcceptedRows,
      eventsRejected: sameRun ? Math.max(nonNegativeInt(existing?.eventsRejected), totalRejectedRows) : totalRejectedRows,
      ignoredEvents: sameRun ? Math.max(nonNegativeInt(existing?.ignoredEvents), totalIgnoredRows) : totalIgnoredRows,
      // The known-ID page fence is also proof-bearing. Never promote page IDs
      // from an in-progress/partial generation into the next catch-up frontier.
      knownNotificationIds: boundedNotificationIds(existing?.knownNotificationIds),
      retryAfterAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      sourceDeviceId: clean(deviceId, 220),
      sourceJobId: clean(job.id, 220),
    };
    return tx.creatorNotificationSyncState.upsert({
      where: { creatorId: job.creatorId },
      create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data },
      update: data,
    });
  }});
}

async function completeNotificationSync({ db, job, deviceId, result, successful }) {
  const mode = result?.notificationMode === "catchup" ? "catchup" : "full";
  const command = assertNotificationCollectionResult({ job, scanRunId: result?.scanRunId, notificationMode: mode });
  if (!db?.creatorNotificationSyncState?.upsert) return null;
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.NOTIFICATIONS, creatorId: job.creatorId, work: async (tx) => {
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const existing = await loadNotificationSyncState(tx, job.creatorId);
    const authority = commandAuthority(existing, command);
    if (authority === "STALE") {
      const error = new Error("Notification completion belongs to a stale server collection generation");
      error.code = "ANALYTICS_COLLECTION_GENERATION_STALE";
      throw error;
    }
    if (sameGeneration(existing, command) && String(existing?.status || "").toUpperCase() === "COMPLETE") return existing;
    const sourceExhausted = result?.sourceExhausted === true;
    const allSourceExhausted = result?.allSourceExhausted === true;
    // A full backfill is verified only after both proof layers are complete:
    // every typed source is exhausted by the desktop continuation and the final
    // unfiltered ALL reconciliation independently reaches hasMore=false.
    const sourceTraversalComplete = sourceExhausted && (mode !== "full" || allSourceExhausted);
    const verified = successful === true && sourceTraversalComplete;
    const trustedPriorFullHistoryVerifiedAt = trustedCollectionTimestamp(existing?.fullBackfillVerifiedAt, now);
    const priorFullHistoryVerified = Boolean(trustedPriorFullHistoryVerifiedAt);
    // A later failed/partial FULL refresh must never erase an already durable
    // historical proof. The latest attempt outcome and the last proven baseline
    // are separate facts: PARTIAL/FAILED may make the collector stale/deferred,
    // but it cannot turn previously verified history back into UNKNOWN.
    const fullHistoryVerified = mode === "full" ? (verified || priorFullHistoryVerified) : priorFullHistoryVerified;
    const overallComplete = verified && fullHistoryVerified;
    const verifiedKnownIds = verified
      ? await verifiedFrontierIds({
        db: tx, job, mode, headNotificationId: result?.headNotificationId, existingIds: existing?.knownNotificationIds,
      })
      : boundedNotificationIds(existing?.knownNotificationIds);
    const data = {
      status: overallComplete ? "COMPLETE" : "PARTIAL",
      mode,
      scanRunId: clean(result?.scanRunId, 120),
      activeGeneration: command.generation,
      activeRequestedAt: command.requestedAt,
      nextCursor: sourceTraversalComplete ? null : clean(result?.tailNotificationId, 220),
      headNotificationId: verified
        ? clean(result?.headNotificationId, 220) || existing?.headNotificationId || null
        : existing?.headNotificationId || null,
      tailNotificationId: clean(result?.tailNotificationId, 220) || existing?.tailNotificationId || null,
      knownNotificationIds: verifiedKnownIds,
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
      retryAfterAt: null,
      sourceDeviceId: clean(deviceId, 220),
      sourceJobId: clean(job.id, 220),
      ...(sourceTraversalComplete && mode === "full" ? {
        fullBackfillCompletedAt: existing?.fullBackfillCompletedAt || now,
        fullBackfillVerifiedAt: verified ? now : (trustedPriorFullHistoryVerifiedAt ? existing?.fullBackfillVerifiedAt : null),
      } : {}),
      ...(sourceTraversalComplete && mode === "catchup" ? {
        lastCatchupCompletedAt: now,
        ...(verified ? { lastCatchupVerifiedAt: now } : {}),
      } : {}),
    };
    return tx.creatorNotificationSyncState.upsert({
      where: { creatorId: job.creatorId },
      create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data },
      update: data,
    });
  }});
}

async function recordNotificationSyncFailure({ db, job, deviceId = null, error, terminal = true, retryAfterAt = null }) {
  if (!db?.creatorNotificationSyncState?.upsert || !job?.creatorId || !job?.agencyId) return null;
  let command;
  try { command = collectionCommand(job, COLLECTOR_TYPES.NOTIFICATIONS); } catch { return null; }
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.NOTIFICATIONS, creatorId: job.creatorId, work: async (tx) => {
    const existing = await loadNotificationSyncState(tx, job.creatorId);
    const authority = commandAuthority(existing, command);
    if (authority === "STALE" || (sameGeneration(existing, command) && String(existing?.status || "").toUpperCase() === "COMPLETE")) return existing;
    const params = object(job.params);
    const retryAt = terminal ? null : (strictDate(retryAfterAt) || new Date((await dbAuthorityNow({ db: tx, fallbackNow: new Date() })).getTime() + 5 * 60 * 1000));
    const data = {
      status: "FAILED",
      mode: params.notificationMode === "catchup" ? "catchup" : "full",
      scanRunId: command.generation,
      activeGeneration: command.generation,
      activeRequestedAt: command.requestedAt,
      retryAfterAt: retryAt,
      lastErrorCode: clean(error?.code || "NOTIFICATION_SCAN_FAILED", 120),
      lastErrorMessage: clean(error?.message || error, 2_000),
      sourceDeviceId: clean(deviceId, 220),
      sourceJobId: clean(job.id, 220),
    };
    return tx.creatorNotificationSyncState.upsert({
      where: { creatorId: job.creatorId },
      create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data },
      update: data,
    });
  }});
}

async function recordNotificationSocketEvent({ db, agencyId, creatorId, deviceId, occurredAt = new Date() }) {
  if (!db?.creatorNotificationSyncState?.upsert) return null;
  const at = strictDate(occurredAt) || new Date();
  const existing = await loadNotificationSyncState(db, creatorId);
  const realtime = {
    lastSocketEventAt: at,
    newestOccurredAt: latestDate(existing?.newestOccurredAt, at),
    sourceDeviceId: clean(deviceId, 220),
  };
  // Realtime is provenance, not collection-control authority. Never let a
  // socket event overwrite SCANNING / COMPLETE / PARTIAL / FAILED, mode,
  // generation, retry or error semantics owned by the collection command.
  return db.creatorNotificationSyncState.upsert({
    where: { creatorId },
    create: { agencyId, creatorId, status: "PARTIAL", mode: "live", ...realtime },
    update: realtime,
  });
}

module.exports = {
  FULL_HISTORY_FROM,
  buildNotificationScanParams,
  assertNotificationCollectionResult,
  loadNotificationSyncState,
  recordNotificationPageProgress,
  completeNotificationSync,
  recordNotificationSyncFailure,
  recordNotificationSocketEvent,
};
