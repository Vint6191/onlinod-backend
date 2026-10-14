"use strict";

const { buildCollectionCommand, stampCollectionAuthorityParams, COLLECTOR_TYPES } = require("./analytics-collector-control-service");
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

module.exports = { notificationRepairParams, needsNotificationRepairRotation };
