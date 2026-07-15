"use strict";

const FOLLOW_AUTOMATION_MODULE_KEY = "follow";
const UNFOLLOW_FAN_ACTION_TYPE = "UNFOLLOW_FAN";
const FOLLOW_FAN_ACTION_TYPE = "FOLLOW_FAN";
const FOLLOW_AUTOMATION_ACTION_TYPES = [UNFOLLOW_FAN_ACTION_TYPE, FOLLOW_FAN_ACTION_TYPE];
const ACTIVE_FOLLOW_AUTOMATION_STATUSES = ["QUEUED", "CLAIMED", "RUNNING", "RETRY_SCHEDULED"];
const AMBIGUOUS_UNFOLLOW_FAILURE_CODES = new Set([
  "network_error",
  "timeout",
  "temporary_of_error",
  "of_temporary_error",
  "backend_unavailable",
  "lease_lost",
]);

function isFollowRecoveryDelivery(delivery) {
  return delivery?.moduleKey === FOLLOW_AUTOMATION_MODULE_KEY
    && delivery?.actionType === FOLLOW_FAN_ACTION_TYPE
    && delivery?.payload
    && typeof delivery.payload === "object"
    && delivery.payload.recovery === true;
}

function isAmbiguousUnfollowFailure(delivery, failureCode = null) {
  if (delivery?.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY || delivery?.actionType !== UNFOLLOW_FAN_ACTION_TYPE) return false;
  const code = String(failureCode || delivery?.failureCode || "").toLowerCase();
  const result = delivery?.result && typeof delivery.result === "object" ? delivery.result : {};
  return delivery?.status === "RUNNING" || Boolean(result.attemptStartedAt) || AMBIGUOUS_UNFOLLOW_FAILURE_CODES.has(code);
}

function mustPreserveRefollowSaga(delivery, failureCode = null) {
  return isFollowRecoveryDelivery(delivery) || isAmbiguousUnfollowFailure(delivery, failureCode);
}

module.exports = {
  FOLLOW_AUTOMATION_MODULE_KEY,
  UNFOLLOW_FAN_ACTION_TYPE,
  FOLLOW_FAN_ACTION_TYPE,
  FOLLOW_AUTOMATION_ACTION_TYPES,
  ACTIVE_FOLLOW_AUTOMATION_STATUSES,
  AMBIGUOUS_UNFOLLOW_FAILURE_CODES,
  isFollowRecoveryDelivery,
  isAmbiguousUnfollowFailure,
  mustPreserveRefollowSaga,
};
