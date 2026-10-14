"use strict";

const { buildCollectionCommand, stampCollectionAuthorityParams, COLLECTOR_TYPES } = require("./analytics-collector-control-service");
const { isDeepStrictEqual } = require("node:util");
const TYPES = new Set(["purchases", "tips", "subscriptions", "likes", "comments"]);

// A repair is a new provider traversal, not a replay of an immutable page
// receipt. Keep the old run's receipts intact and bind every new page to a new
// server-owned generation. Narrowing types under the same generation changes
// the receipt checksum even when the source page itself has not changed.
function notificationRepairParams(job, now, result = job?.result) {
  const params = { ...(job?.params || {}) };
  const mode = params.notificationMode === "catchup" ? "catchup" : "full";
  const previousTypes = Object.keys(result?.coverage || {}).filter(type => TYPES.has(type));
  const requestedTypes = (Array.isArray(params.types) ? params.types : [...TYPES]).filter(type => TYPES.has(type));
  delete params.resumeCursors;
  delete params.notificationRepairPass;
  const command = buildCollectionCommand({ collectorType: COLLECTOR_TYPES.NOTIFICATIONS,
    collectionMode: mode, reason: params.collectionReason || params.reason || "notification_repair", now });
  return stampCollectionAuthorityParams({ ...params, ...command,
    notificationMode: mode,
    types: previousTypes.length ? previousTypes : requestedTypes,
    notificationRepairVersion: 1,
    notificationRepairFromRunId: params.collectionGeneration || result?.scanRunId || null,
  }, now, params.collectionAuthorityRequestedAt || params.collectionRequestedAt);
}

function needsNotificationRepairRotation(job) {
  if (job?.jobKey !== "catchup_notifications_scan") return false;
  const generation = job.params?.collectionGeneration;
  if (!generation) return false;
  // lastError is cleared at claim, but the previous completion result survives.
  // This also identifies a pre-fix repair already CLAIMED by a live Desktop.
  const result = job.result;
  return result?.scanRunId === generation && result?.completionSideEffect
    && result.completionSideEffect.ok !== true && result.completionSideEffect.verified !== true;
}

function notificationContinuationState(value) {
  // Compare the domain cursor across plain, wrapped and legacy nested leases.
  for (let depth = 0; depth < 10000 && value?.driverPhase === "execute"; depth += 1) {
    value = value.jobContinuation;
  }
  return value ?? null;
}

function notificationProgressIsStale(job, chunk, expectedContinuation) {
  if (job?.jobKey !== "catchup_notifications_scan") return false;
  const current = notificationContinuationState(job.continuation);
  if (expectedContinuation !== undefined
    && !isDeepStrictEqual(current, notificationContinuationState(expectedContinuation))) return true;
  if (current?.driverPhase === "complete") return true;
  // The v8 Desktop deliberately restarts v1-v7 traversal state. Those page
  // counters are not comparable; any conflicting old receipt follows repair.
  if (Number.isInteger(current?.schemaVersion) && current.schemaVersion < 8) return false;
  // Rolling deployment: older Desktops do not send expectedContinuation, but
  // ALL-page numbers are monotonic across typed phases and ALL reconciliation.
  // Never let an already committed page rewind the cursor or re-read its receipt
  // with a new provider payload, even when the caller supplies today's cursor.
  return chunk?.kind === "notification_facts_page_all"
    && chunk.scanRunId === job.params?.collectionGeneration
    && current?.scanRunId === chunk.scanRunId
    && Number.isSafeInteger(chunk.page) && chunk.page > 0
    && Number.isSafeInteger(current.page) && chunk.page <= current.page;
}

module.exports = { notificationRepairParams, needsNotificationRepairRotation, notificationProgressIsStale };
