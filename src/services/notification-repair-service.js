"use strict";

const { buildCollectionCommand, stampCollectionAuthorityParams, COLLECTOR_TYPES } = require("./analytics-collector-control-service");
const { isDeepStrictEqual } = require("node:util");
const { NOTIFICATION_TYPES, hasFullNotificationScope } = require("./notification-collection-scope");

// A repair is a new provider traversal, not a replay of an immutable page
// receipt. Keep the old run's receipts intact and bind every new page to a new
// server-owned generation. Narrowing types under the same generation changes
// the receipt checksum even when the source page itself has not changed.
function notificationRepairParams(job, now, result = job?.result) {
  const params = { ...(job?.params || {}) };
  const upgrade = params.notificationNormalizerVersion !== "notification-source-v2";
  const mode = !upgrade && params.notificationMode === "catchup" ? "catchup" : "full";
  if (upgrade) { delete params.knownNotificationIds; delete params.stopAtNotificationId; params.from=new Date(0).toISOString(); params.to=new Date(now.getTime()+300000).toISOString(); }
  delete params.resumeCursors;
  delete params.notificationRepairPass;
  const command = buildCollectionCommand({ collectorType: COLLECTOR_TYPES.NOTIFICATIONS,
    collectionMode: mode, reason: params.collectionReason || params.reason || "notification_repair", now });
  return stampCollectionAuthorityParams({ ...params, ...command,
    notificationMode: mode,
    notificationFrontierVersion: mode === "full" ? 4 : 3,
    types: [...NOTIFICATION_TYPES],
    notificationRepairVersion: 1,
    notificationRepairFromRunId: params.collectionGeneration || result?.scanRunId || null,
  }, now, params.collectionAuthorityRequestedAt || params.collectionRequestedAt);
}

function needsNotificationRepairRotation(job) {
  if (job?.jobKey !== "catchup_notifications_scan") return false;
  const generation = job.params?.collectionGeneration;
  if (!generation) return false;
  // Older repairs persisted only the types seen so far. Rotate before issuing
  // or accepting work, even without a completion marker. Expanding the scope
  // in place would change immutable receipt checksums under the old run ID.
  if (!hasFullNotificationScope(job.params) || job.params?.notificationNormalizerVersion !== "notification-source-v2") return true;
  if (job.params?.notificationMode !== "catchup" && job.params?.notificationFrontierVersion !== 4) return true;
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
  if (Number.isInteger(current?.schemaVersion) && current.schemaVersion < 9) return false;
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

module.exports = { notificationRepairParams, needsNotificationRepairRotation, notificationProgressIsStale, notificationContinuationState };
