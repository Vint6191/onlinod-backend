"use strict";

const { readFanCurrent } = require("./fan-data-authority-service");
const { evaluateCandidate, subscriptionBucket } = require("./follow-back-rules");
const { evaluateRefollowCandidate } = require("./follow-automation-rules");


const FAN_CURRENT_FRESHNESS_CLASS = Object.freeze({
  FRESH_ENOUGH: "FRESH_ENOUGH",
  STALE_BUT_ALLOWED_BY_PRODUCT: "STALE_BUT_ALLOWED_BY_PRODUCT",
  POINT_REFRESH_REQUIRED: "POINT_REFRESH_REQUIRED",
  UNKNOWN: "UNKNOWN",
});

const FAN_CURRENT_UNKNOWN_POLICY = Object.freeze({
  follow_back: Object.freeze({
    missingRelationship: "FAIL_CLOSED_POINT_REFRESH_REQUIRED",
    fanSubscriptionActive: "ALLOWED_BY_EXPLICIT_PRODUCT_POLICY",
    fanSubscriptionType: "ALLOWED_BY_EXPLICIT_PRODUCT_POLICY",
    creatorFollowsFan: "ALLOWED_BY_EXPLICIT_PRODUCT_POLICY",
  }),
  follow_automation: Object.freeze({
    missingRelationship: "FAIL_CLOSED_POINT_REFRESH_REQUIRED",
    fanSubscriptionActive: "POINT_REFRESH_REQUIRED",
    creatorFollowsFan: "POINT_REFRESH_REQUIRED_WHEN_UNFOLLOW_ADMISSION_DEPENDS_ON_EDGE",
  }),
  bumps: Object.freeze({
    missingRelationship: "FAIL_CLOSED_POINT_REFRESH_REQUIRED",
    canReceiveChatMessage: "POINT_REFRESH_REQUIRED",
    fanSubscriptionActive: "POINT_REFRESH_REQUIRED_FOR_SUBSCRIBER_SOURCES",
    fanSubscriptionType: "POINT_REFRESH_REQUIRED_FOR_SUBSCRIBER_SOURCES",
  }),
  likes: Object.freeze({
    missingRelationship: "POINT_REFRESH_REQUIRED",
    fanSubscriptionActive: "POINT_REFRESH_REQUIRED_WHEN_POLICY_DEPENDS_ON_STATE",
    fanSubscriptionType: "POINT_REFRESH_REQUIRED_WHEN_POLICY_DEPENDS_ON_BUCKET",
  }),
});

function key(value) { return String(value ?? "").trim(); }
function relationship(current) { return current?.relationship && typeof current.relationship === "object" ? current.relationship : null; }

function asDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function classifyRelationshipFreshness(current, { now = new Date(), maxAgeMs = null, allowStale = false } = {}) {
  const rel = relationship(current);
  if (!rel) {
    return { freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.UNKNOWN, refreshRequired: true, code: "fan_current_unknown" };
  }
  const observedAt = asDate(rel.observedAt);
  if (!observedAt) {
    return { freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.UNKNOWN, refreshRequired: true, code: "fan_current_provenance_unknown" };
  }
  const ageLimit = maxAgeMs === null || maxAgeMs === undefined ? null : Number(maxAgeMs);
  if (ageLimit !== null && Number.isFinite(ageLimit) && ageLimit >= 0) {
    const authorityNow = asDate(now) || new Date();
    if (observedAt.getTime() < authorityNow.getTime() - ageLimit) {
      if (allowStale) {
        return { freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.STALE_BUT_ALLOWED_BY_PRODUCT, refreshRequired: false, code: "fan_current_stale_allowed", observedAt };
      }
      return { freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.POINT_REFRESH_REQUIRED, refreshRequired: true, code: "fan_current_stale", observedAt };
    }
  }
  return { freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.FRESH_ENOUGH, refreshRequired: false, code: "fan_current_fresh", observedAt };
}

async function readFanCurrentMap(db, { agencyId, creatorId, fanIds = [] } = {}) {
  const ids = [...new Set((fanIds || []).map(key).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await readFanCurrent(db, { agencyId, creatorId, onlyFansUserIds: ids });
  return new Map(rows.map((row) => [key(row.onlyFansUserId), row]));
}

function followBackDecisionCandidate(candidate, current) {
  const rel = relationship(current);
  if (!candidate || !rel) return null;
  return {
    ...candidate,
    creatorFollowsFan: rel.creatorFollowsFan,
    fanSubscriptionActive: rel.fanSubscriptionActive,
    fanSubscriptionType: rel.fanSubscriptionType,
    canReceiveChatMessage: rel.canReceiveChatMessage,
  };
}

function evaluateFollowBackCurrent(candidate, current, settings, now = new Date(), freshnessPolicy = {}) {
  const freshness = classifyRelationshipFreshness(current, { now, ...freshnessPolicy });
  const decision = followBackDecisionCandidate(candidate, current);
  if (!decision || freshness.refreshRequired === true) {
    return {
      eligible: false,
      code: freshness.code || "fan_current_unknown",
      retryable: true,
      refreshRequired: true,
      refreshFields: ["creatorFollowsFan", "fanSubscriptionActive", "fanSubscriptionType"],
      unknownPolicy: FAN_CURRENT_UNKNOWN_POLICY.follow_back.missingRelationship,
      freshnessClass: freshness.freshnessClass,
    };
  }
  return evaluateCandidate(decision, settings, now);
}

function refollowDecisionCandidate(candidate, current, { phase = null } = {}) {
  const rel = relationship(current);
  if (!candidate || !rel) return null;
  return {
    ...candidate,
    ...(phase ? { phase } : {}),
    fanSubscriptionActive: rel.fanSubscriptionActive,
    fanSubscriptionType: rel.fanSubscriptionType,
    creatorFollowsFan: rel.creatorFollowsFan,
    ofBlocked: rel.blocked === true,
    restricted: rel.restricted === true,
    performer: rel.performer === true,
    subscribePriceCents: rel.subscribePriceCents,
  };
}

function refollowRefreshRequired(code, refreshFields, freshnessClass = FAN_CURRENT_FRESHNESS_CLASS.UNKNOWN) {
  return {
    eligible: false,
    code,
    retryable: true,
    refreshRequired: true,
    refreshFields: [...new Set((refreshFields || []).filter(Boolean))],
    unknownPolicy: FAN_CURRENT_UNKNOWN_POLICY.follow_automation.missingRelationship,
    freshnessClass,
  };
}

function evaluateRefollowCurrent(candidate, current, settings, now = new Date(), options = {}) {
  const freshness = classifyRelationshipFreshness(current, { now, ...(options.freshnessPolicy || {}) });
  const rel = relationship(current);
  if (!rel || freshness.refreshRequired === true) {
    return refollowRefreshRequired(
      freshness.code || "fan_current_unknown",
      ["fanSubscriptionActive", "creatorFollowsFan"],
      freshness.freshnessClass,
    );
  }
  if (rel.fanSubscriptionActive === null || rel.fanSubscriptionActive === undefined) {
    return refollowRefreshRequired(
      "fan_subscription_state_unknown",
      ["fanSubscriptionActive"],
      freshness.freshnessClass,
    );
  }
  // The creator-follow edge is only required when the fan is currently expired.
  // A returned/active fan is already terminally ineligible for a new UNFOLLOW cycle.
  if (rel.fanSubscriptionActive === false && (rel.creatorFollowsFan === null || rel.creatorFollowsFan === undefined)) {
    return refollowRefreshRequired(
      "creator_follow_state_unknown",
      ["creatorFollowsFan"],
      freshness.freshnessClass,
    );
  }
  const decision = refollowDecisionCandidate(candidate, current, options);
  if (!decision) return refollowRefreshRequired("fan_current_unknown", ["fanSubscriptionActive", "creatorFollowsFan"]);
  return evaluateRefollowCandidate(decision, settings, now);
}


function likesRefreshRequired(code, unknownPolicy, refreshFields) {
  return {
    eligible: false,
    code,
    retryable: true,
    refreshRequired: true,
    refreshFields: [...new Set((refreshFields || []).filter(Boolean))],
    unknownPolicy,
  };
}

function evaluateLikesCurrent(current, settings = {}, now = new Date(), freshnessPolicy = {}) {
  const rel = relationship(current);
  const freshness = classifyRelationshipFreshness(current, { now, ...freshnessPolicy });
  if (!rel || freshness.refreshRequired === true) {
    return {
      ...likesRefreshRequired(
        freshness.code || "fan_current_unknown",
        FAN_CURRENT_UNKNOWN_POLICY.likes.missingRelationship,
        ["fanSubscriptionActive", "fanSubscriptionType"],
      ),
      freshnessClass: freshness.freshnessClass,
    };
  }

  const allowActive = settings.activeSubscribers === true;
  const allowExpired = settings.expiredSubscribers === true;
  const active = rel.fanSubscriptionActive;

  if (active === null || active === undefined) {
    if (!(allowActive && allowExpired)) {
      return likesRefreshRequired(
        "fan_subscription_state_unknown",
        FAN_CURRENT_UNKNOWN_POLICY.likes.fanSubscriptionActive,
        ["fanSubscriptionActive"],
      );
    }
  } else if (active === true && !allowActive) {
    return { eligible: false, code: "active_subscribers_disabled" };
  } else if (active === false && !allowExpired) {
    return { eligible: false, code: "expired_subscribers_disabled" };
  }

  if (active === false) return { eligible: true, code: "expired_subscriber" };

  const allowFree = settings.freeSubscribers === true;
  const allowPaid = settings.paidSubscribers === true;
  if (!allowFree && !allowPaid) return { eligible: false, code: "subscriber_type_disabled" };
  if (allowFree && allowPaid) return { eligible: true, code: active === true ? "active_subscriber" : "subscription_state_policy_allows" };

  const bucket = subscriptionBucket(rel.fanSubscriptionType);
  if (bucket === "free") return allowFree ? { eligible: true, code: "free_subscriber" } : { eligible: false, code: "free_subscribers_disabled" };
  if (bucket === "paid") return allowPaid ? { eligible: true, code: "paid_subscriber" } : { eligible: false, code: "paid_subscribers_disabled" };
  if (bucket === "expired") {
    return active === true
      ? likesRefreshRequired(
        "fan_subscription_state_conflict",
        FAN_CURRENT_UNKNOWN_POLICY.likes.fanSubscriptionType,
        ["fanSubscriptionActive", "fanSubscriptionType"],
      )
      : (allowExpired ? { eligible: true, code: "expired_subscriber" } : { eligible: false, code: "expired_subscribers_disabled" });
  }
  return likesRefreshRequired(
    "fan_subscription_type_unknown",
    FAN_CURRENT_UNKNOWN_POLICY.likes.fanSubscriptionType,
    ["fanSubscriptionType"],
  );
}

function canonicalBumpCandidate(candidate, current) {
  const rel = relationship(current);
  if (!candidate || !rel) return null;
  const identity = current?.platformIdentity && typeof current.platformIdentity === "object" ? current.platformIdentity : {};
  return {
    ...candidate,
    username: identity.username ?? candidate.username ?? null,
    displayName: identity.platformDisplayName ?? candidate.displayName ?? null,
    subscriptionType: rel.fanSubscriptionType,
    isActive: rel.fanSubscriptionActive,
    canReceiveChatMessage: rel.canReceiveChatMessage,
  };
}

function bumpRefreshFields(source) {
  const fields = ["canReceiveChatMessage"];
  if (source === "paid_subscriber" || source === "free_subscriber") {
    fields.push("fanSubscriptionActive", "fanSubscriptionType");
  }
  return fields;
}

function bumpRefreshRequired(code, source, fields = null, freshnessClass = FAN_CURRENT_FRESHNESS_CLASS.UNKNOWN) {
  return {
    ok: false,
    code,
    terminal: false,
    retryable: true,
    refreshRequired: true,
    refreshFields: [...new Set((fields || bumpRefreshFields(source)).filter(Boolean))],
    unknownPolicy: FAN_CURRENT_UNKNOWN_POLICY.bumps.missingRelationship,
    freshnessClass,
    candidate: null,
  };
}

function validateBumpCurrentRelationship({ candidate, current, source, now = new Date(), freshnessPolicy = {} }) {
  const freshness = classifyRelationshipFreshness(current, { now, ...freshnessPolicy });
  const canonical = canonicalBumpCandidate(candidate, current);
  if (!canonical || freshness.refreshRequired === true) {
    return bumpRefreshRequired(
      freshness.code || "fan_current_unknown",
      source,
      bumpRefreshFields(source),
      freshness.freshnessClass,
    );
  }
  if (canonical.canReceiveChatMessage !== true) {
    if (canonical.canReceiveChatMessage === false) return { ok: false, terminal: true, code: "cannot_message", candidate: canonical };
    return { ...bumpRefreshRequired("can_receive_unknown", source, ["canReceiveChatMessage"], freshness.freshnessClass), candidate: canonical };
  }
  if (source === "paid_subscriber") {
    if (canonical.isActive !== true) {
      if (canonical.isActive === false) return { ok: false, terminal: true, code: "fan_subscription_inactive", candidate: canonical };
      return { ...bumpRefreshRequired("fan_subscription_unknown", source, ["fanSubscriptionActive"], freshness.freshnessClass), candidate: canonical };
    }
    const type = String(canonical.subscriptionType || "").toLowerCase();
    if (!type) return { ...bumpRefreshRequired("fan_subscription_type_unknown", source, ["fanSubscriptionType"], freshness.freshnessClass), candidate: canonical };
    if (!(type.includes("paid") || type.includes("active"))) return { ok: false, terminal: true, code: "fan_not_paid_current", candidate: canonical };
  }
  if (source === "free_subscriber") {
    if (canonical.isActive !== true) {
      if (canonical.isActive === false) return { ok: false, terminal: true, code: "fan_subscription_inactive", candidate: canonical };
      return { ...bumpRefreshRequired("fan_subscription_unknown", source, ["fanSubscriptionActive"], freshness.freshnessClass), candidate: canonical };
    }
    const type = String(canonical.subscriptionType || "").toLowerCase();
    if (!type) return { ...bumpRefreshRequired("fan_subscription_type_unknown", source, ["fanSubscriptionType"], freshness.freshnessClass), candidate: canonical };
    if (!type.includes("free")) return { ok: false, terminal: true, code: "fan_not_free_current", candidate: canonical };
  }
  return { ok: true, candidate: canonical, freshnessClass: freshness.freshnessClass };
}

async function validateFollowBackDeliveryCurrent({ db, delivery, settings, now = new Date() }) {
  if (!delivery || delivery.moduleKey !== "follow_back" || delivery.actionType !== "FOLLOW_BACK") return { ok: true };
  const candidate = await db.followBackCandidate.findFirst({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.targetId || delivery.fanId },
  });
  if (!candidate) return { ok: false, terminal: true, status: "SKIPPED", code: "invalid_target" };
  if (Number(candidate.generation || 1) !== Number(delivery.generation || 1)) return { ok: false, terminal: true, status: "SKIPPED", code: "stale_candidate" };
  const directory = await db.subscriberDirectoryState.findFirst({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, status: "READY" },
    select: { currentRunId: true },
  });
  if (!directory?.currentRunId || candidate.snapshotRunId !== directory.currentRunId) return { ok: false, terminal: true, status: "SKIPPED", code: "stale_candidate" };
  const currentByFan = await readFanCurrentMap(db, {
    agencyId: delivery.agencyId,
    creatorId: delivery.creatorId,
    fanIds: [candidate.fanId],
  });
  const current = currentByFan.get(key(candidate.fanId)) || null;
  const eligibility = evaluateFollowBackCurrent(candidate, current, settings, now);
  if (!eligibility.eligible) {
    const retryable = eligibility.retryable === true || eligibility.code === "cooldown";
    return {
      ok: false,
      terminal: !retryable,
      status: "SKIPPED",
      code: eligibility.code,
      retryAt: retryable ? (eligibility.code === "cooldown" ? candidate.cooldownUntil : new Date(now.getTime() + 30_000)) : null,
      ...(eligibility.refreshRequired === true ? {
        refreshRequired: true,
        refreshFanIds: candidate.fanId ? [String(candidate.fanId)] : [],
        refreshFields: eligibility.refreshFields || [],
        freshnessClass: eligibility.freshnessClass || null,
      } : {}),
    };
  }
  return { ok: true, candidate, current };
}

module.exports = {
  FAN_CURRENT_FRESHNESS_CLASS,
  FAN_CURRENT_UNKNOWN_POLICY,
  classifyRelationshipFreshness,
  readFanCurrentMap,
  followBackDecisionCandidate,
  evaluateFollowBackCurrent,
  refollowDecisionCandidate,
  evaluateRefollowCurrent,
  refollowRefreshRequired,
  evaluateLikesCurrent,
  likesRefreshRequired,
  canonicalBumpCandidate,
  validateBumpCurrentRelationship,
  bumpRefreshRequired,
  validateFollowBackDeliveryCurrent,
};
