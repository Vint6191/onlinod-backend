"use strict";

function refollowUnfollowKey({ creatorId, fanId, generation }) {
  return `refollow_unfollow:${creatorId}:${fanId}:${generation}`;
}
function refollowFollowKey({ creatorId, fanId, generation }) {
  return `refollow_follow:${creatorId}:${fanId}:${generation}`;
}
function evaluateRefollowCandidate(candidate, settings, now = new Date()) {
  if (!candidate) return { eligible: false, code: "invalid_target" };
  if (candidate.blocked || candidate.ofBlocked) return { eligible: false, code: "blocked" };
  if (candidate.ignored) return { eligible: false, code: "ignored" };
  if (candidate.state === "STALE") return { eligible: false, code: "stale_candidate" };
  if (candidate.restricted) return { eligible: false, code: "restricted" };
  if (candidate.performer) return { eligible: false, code: "performer" };
  if (Number(candidate.subscribePriceCents || 0) > 0) return { eligible: false, code: "paid_subscription_required" };
  if (settings.refollowEnabled !== true) return { eligible: false, code: "refollow_disabled" };
  if (candidate.phase && !["IDLE", "WAIT_RETURN", "DONE"].includes(candidate.phase)) {
    return { eligible: false, code: "active_delivery" };
  }
  if (candidate.fanSubscriptionActive === true) {
    return { eligible: false, code: Number(candidate.nudgeCount || 0) > 0 ? "fan_returned" : "fan_active" };
  }
  if (candidate.fanSubscriptionActive !== false) return { eligible: false, code: "subscription_state_unknown" };
  if (candidate.creatorFollowsFan !== true) return { eligible: false, code: "creator_not_following" };
  if (candidate.cooldownUntil && candidate.cooldownUntil > now) return { eligible: false, code: "cooldown" };
  if (Number(candidate.nudgeCount || 0) >= Number(settings.maxNudgesPerFan || 1)) {
    return { eligible: false, code: "max_refollow_nudges_reached" };
  }
  return { eligible: true, code: "fan_expired_creator_following" };
}

module.exports = {
  refollowUnfollowKey,
  refollowFollowKey,
  evaluateRefollowCandidate,
};
