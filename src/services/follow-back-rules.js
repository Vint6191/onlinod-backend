"use strict";

function subscriptionBucket(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("expired")) return "expired";
  if (text.includes("free")) return "free";
  if (text.includes("paid") || text.includes("active")) return "paid";
  return "unknown";
}

function evaluateCandidate(candidate, settings, now = new Date()) {
  if (!candidate) return { eligible: false, code: "invalid_target" };
  if (candidate.blocked) return { eligible: false, code: "blocked" };
  if (candidate.ignored) return { eligible: false, code: "ignored" };
  if (candidate.state === "STALE") return { eligible: false, code: "stale_candidate" };
  if (candidate.cooldownUntil && candidate.cooldownUntil > now) return { eligible: false, code: "cooldown" };
  if (candidate.creatorFollowsFan === true) return { eligible: false, code: "already_followed" };
  if (Number(candidate.generation || 1) > 1) {
    return {
      eligible: false,
      code: settings.refollowEnabled === true ? "refollow_action_pending" : "refollow_disabled",
    };
  }

  const active = candidate.fanSubscriptionActive !== false;
  if (active && !settings.activeSubscribers) return { eligible: false, code: "active_subscribers_disabled" };
  if (!active && !settings.expiredSubscribers) return { eligible: false, code: "expired_subscribers_disabled" };
  const bucket = subscriptionBucket(candidate.fanSubscriptionType);
  if (bucket === "free" && !settings.freeSubscribers) return { eligible: false, code: "free_subscribers_disabled" };
  if (bucket === "paid" && !settings.paidSubscribers) return { eligible: false, code: "paid_subscribers_disabled" };
  if (bucket === "expired" && !settings.expiredSubscribers) return { eligible: false, code: "expired_subscribers_disabled" };
  return { eligible: true, code: active ? "active_subscriber" : "expired_subscriber" };
}

module.exports = { evaluateCandidate, subscriptionBucket };
