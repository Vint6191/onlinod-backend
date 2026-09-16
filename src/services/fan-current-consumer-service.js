"use strict";

const { readFanCurrent } = require("./fan-data-authority-service");
const { evaluateCandidate, subscriptionBucket } = require("./follow-back-rules");
const { evaluateRefollowCandidate } = require("./follow-automation-rules");
const { targetEligibility } = require("./sfs-rules");


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
    blocked: "POINT_REFRESH_REQUIRED_BEFORE_UNFOLLOW",
    restricted: "POINT_REFRESH_REQUIRED_BEFORE_UNFOLLOW",
    performer: "POINT_REFRESH_REQUIRED_BEFORE_UNFOLLOW",
    subscribePriceCents: "POINT_REFRESH_REQUIRED_BEFORE_UNFOLLOW",
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
  sfs: Object.freeze({
    missingRelationship: "FAIL_CLOSED_POINT_REFRESH_REQUIRED",
    creatorFollowsFan: "POINT_REFRESH_REQUIRED",
    subscribePriceCents: "POINT_REFRESH_REQUIRED_WHEN_FREE_TARGET_POLICY_DEPENDS_ON_PRICE",
  }),
});

const RELATIONSHIP_VERSION_COLUMNS = Object.freeze({
  fanSubscribesToCreator: "fanSubscribesToCreatorAuthorityVersion",
  fanSubscriptionActive: "fanSubscriptionActiveAuthorityVersion",
  fanSubscriptionType: "fanSubscriptionTypeAuthorityVersion",
  fanSubscriptionExpiresAt: "fanSubscriptionExpiresAtAuthorityVersion",
  creatorFollowsFan: "creatorFollowsFanAuthorityVersion",
  creatorFollowExpiresAt: "creatorFollowExpiresAtAuthorityVersion",
  canReceiveChatMessage: "canReceiveChatMessageAuthorityVersion",
  blocked: "blockedAuthorityVersion",
  restricted: "restrictedAuthorityVersion",
  performer: "performerAuthorityVersion",
  lastSeenAt: "lastSeenAtAuthorityVersion",
  subscribePriceCents: "subscribePriceCentsAuthorityVersion",
});

function key(value) { return String(value ?? "").trim(); }
function relationship(current) { return current?.relationship && typeof current.relationship === "object" ? current.relationship : null; }

function asDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function uniqueRelationshipFields(fields = []) {
  return [...new Set((fields || []).map(key).filter((field) => RELATIONSHIP_VERSION_COLUMNS[field]))];
}

function relationshipFieldAuthority(current, field) {
  const rel = relationship(current);
  const authority = rel?.fieldAuthority?.[field];
  if (!authority || typeof authority !== "object") return null;
  const authorityVersion = key(authority.authorityVersion);
  if (!authorityVersion) return null;
  return {
    authorityVersion,
    observedAt: asDate(authority.observedAt),
    source: key(authority.source) || null,
  };
}

function classifyRelationshipFreshness(current, { now = new Date(), maxAgeMs = null, allowStale = false, requiredFields = null } = {}) {
  const rel = relationship(current);
  if (!rel) {
    return { freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.UNKNOWN, refreshRequired: true, code: "fan_current_unknown", refreshFields: uniqueRelationshipFields(requiredFields || []) };
  }

  const exactFields = uniqueRelationshipFields(requiredFields || []);
  if (exactFields.length) {
    const missing = [];
    const fieldObservedAt = {};
    for (const field of exactFields) {
      const authority = relationshipFieldAuthority(current, field);
      if (!authority?.authorityVersion || !authority.observedAt) {
        missing.push(field);
        continue;
      }
      fieldObservedAt[field] = authority.observedAt;
    }
    if (missing.length) {
      return {
        freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.UNKNOWN,
        refreshRequired: true,
        code: "fan_current_field_provenance_unknown",
        refreshFields: missing,
        fieldObservedAt,
      };
    }

    const ageLimit = maxAgeMs === null || maxAgeMs === undefined ? null : Number(maxAgeMs);
    if (ageLimit !== null && Number.isFinite(ageLimit) && ageLimit >= 0) {
      const authorityNow = asDate(now) || new Date();
      const staleFields = exactFields.filter((field) => fieldObservedAt[field].getTime() < authorityNow.getTime() - ageLimit);
      if (staleFields.length) {
        if (allowStale) {
          return {
            freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.STALE_BUT_ALLOWED_BY_PRODUCT,
            refreshRequired: false,
            code: "fan_current_stale_allowed",
            refreshFields: staleFields,
            fieldObservedAt,
          };
        }
        return {
          freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.POINT_REFRESH_REQUIRED,
          refreshRequired: true,
          code: "fan_current_stale",
          refreshFields: staleFields,
          fieldObservedAt,
        };
      }
    }
    return {
      freshnessClass: FAN_CURRENT_FRESHNESS_CLASS.FRESH_ENOUGH,
      refreshRequired: false,
      code: "fan_current_fresh",
      refreshFields: [],
      fieldObservedAt,
    };
  }

  // Compatibility path for callers that only ask whether a relationship row has
  // aggregate provenance. Phase-3 executable consumers pass requiredFields and
  // therefore never use an unrelated field's row-wide observedAt for freshness.
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

function followBackRequiredFields(settings = {}) {
  const fields = ["creatorFollowsFan"];
  if ((settings.activeSubscribers === true) !== (settings.expiredSubscribers === true)) fields.push("fanSubscriptionActive");
  if ((settings.freeSubscribers === true) !== (settings.paidSubscribers === true)) fields.push("fanSubscriptionType");
  return uniqueRelationshipFields(fields);
}

function refollowRequiredFields(current) {
  const rel = relationship(current);
  if (!rel) {
    return uniqueRelationshipFields([
      "fanSubscriptionActive", "creatorFollowsFan", "blocked", "restricted", "performer", "subscribePriceCents",
    ]);
  }
  // Admission is staged: current subscription state alone can reject a returned
  // fan. Safety/price/follow fields become required only for an expired fan that
  // could actually cross into UNFOLLOW. This keeps the field fence exact.
  if (rel.fanSubscriptionActive !== false) return ["fanSubscriptionActive"];
  return uniqueRelationshipFields([
    "fanSubscriptionActive", "creatorFollowsFan", "blocked", "restricted", "performer", "subscribePriceCents",
  ]);
}

function likesRequiredFields(settings = {}, current = null) {
  const rel = relationship(current);
  const fields = ["fanSubscriptionActive"];
  if (rel?.fanSubscriptionActive !== false && (settings.freeSubscribers === true) !== (settings.paidSubscribers === true)) fields.push("fanSubscriptionType");
  return uniqueRelationshipFields(fields);
}

function bumpRequiredFields(source) {
  const fields = ["canReceiveChatMessage"];
  if (source === "paid_subscriber" || source === "free_subscriber") fields.push("fanSubscriptionActive", "fanSubscriptionType");
  return uniqueRelationshipFields(fields);
}

function sfsRequiredFields(settings = {}) {
  const fields = ["creatorFollowsFan"];
  if (settings.freeTargetsOnly === true) fields.push("subscribePriceCents");
  return uniqueRelationshipFields(fields);
}

function buildFanCurrentFieldFence(current, requiredFields) {
  const fields = uniqueRelationshipFields(requiredFields);
  if (!current || !fields.length) return null;
  const versions = {};
  for (const field of fields) {
    const authority = relationshipFieldAuthority(current, field);
    if (!authority?.authorityVersion) return null;
    versions[field] = authority.authorityVersion;
  }
  const fanId = key(current.onlyFansUserId);
  const creatorId = key(current.creatorId);
  if (!fanId || !creatorId) return null;
  return { creatorId, onlyFansUserId: fanId, versions };
}

async function assertFanCurrentFieldFence({ db, agencyId, fence }) {
  if (!fence || !db) return { ok: true };
  const creatorId = key(fence.creatorId);
  const fanId = key(fence.onlyFansUserId);
  const fields = uniqueRelationshipFields(Object.keys(fence.versions || {}));
  if (!creatorId || !fanId || !fields.length) return { ok: false, code: "fan_current_fence_invalid", changedFields: fields };

  let row = null;
  if (typeof db.$queryRawUnsafe === "function") {
    const columns = fields.map((field) => `"${RELATIONSHIP_VERSION_COLUMNS[field]}"`).join(", ");
    const rows = await db.$queryRawUnsafe(
      `SELECT ${columns} FROM "CreatorFanRelationshipCurrent" WHERE "agencyId" = $1 AND "creatorId" = $2 AND "onlyFansUserId" = $3 FOR SHARE`,
      agencyId, creatorId, fanId,
    );
    row = rows?.[0] || null;
  } else if (db.creatorFanRelationshipCurrent?.findUnique) {
    row = await db.creatorFanRelationshipCurrent.findUnique({
      where: { creatorId_onlyFansUserId: { creatorId, onlyFansUserId: fanId } },
    });
    if (row && key(row.agencyId) !== key(agencyId)) row = null;
  }
  if (!row) return { ok: false, code: "fan_current_fence_missing", changedFields: fields };

  const changedFields = fields.filter((field) => key(row[RELATIONSHIP_VERSION_COLUMNS[field]]) !== key(fence.versions[field]));
  if (changedFields.length) return { ok: false, code: "fan_current_fence_stale", changedFields };
  return { ok: true, fields };
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
  const requiredFields = followBackRequiredFields(settings);
  const freshness = classifyRelationshipFreshness(current, { now, ...freshnessPolicy, requiredFields });
  const decision = followBackDecisionCandidate(candidate, current);
  if (!decision || freshness.refreshRequired === true) {
    return {
      eligible: false,
      code: freshness.code || "fan_current_unknown",
      retryable: true,
      refreshRequired: true,
      refreshFields: freshness.refreshFields?.length ? freshness.refreshFields : requiredFields,
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
    // Preserve canonical tri-state values. UNKNOWN must never be collapsed to
    // safe false / free zero before the admission policy sees it.
    ofBlocked: rel.blocked,
    restricted: rel.restricted,
    performer: rel.performer,
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
  const requiredFields = refollowRequiredFields(current);
  const freshness = classifyRelationshipFreshness(current, { now, ...(options.freshnessPolicy || {}), requiredFields });
  const rel = relationship(current);
  if (!rel || freshness.refreshRequired === true) {
    return refollowRefreshRequired(
      freshness.code || "fan_current_unknown",
      freshness.refreshFields?.length ? freshness.refreshFields : requiredFields,
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
  // Hard safety/business-admission facts are tri-state. A canonical field can
  // have valid provenance while its value is still UNKNOWN/null. Do not turn
  // UNKNOWN into safe false / free zero; refresh exactly the missing facts.
  if (rel.fanSubscriptionActive === false) {
    const unknownSafetyFields = ["blocked", "restricted", "performer", "subscribePriceCents"]
      .filter((field) => rel[field] === null || rel[field] === undefined);
    if (unknownSafetyFields.length) {
      return refollowRefreshRequired(
        "refollow_safety_state_unknown",
        unknownSafetyFields,
        freshness.freshnessClass,
      );
    }
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
  const requiredFields = likesRequiredFields(settings, current);
  const freshness = classifyRelationshipFreshness(current, { now, ...freshnessPolicy, requiredFields });
  if (!rel || freshness.refreshRequired === true) {
    return {
      ...likesRefreshRequired(
        freshness.code || "fan_current_unknown",
        FAN_CURRENT_UNKNOWN_POLICY.likes.missingRelationship,
        freshness.refreshFields?.length ? freshness.refreshFields : requiredFields,
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
  const requiredFields = bumpRequiredFields(source);
  const freshness = classifyRelationshipFreshness(current, { now, ...freshnessPolicy, requiredFields });
  const canonical = canonicalBumpCandidate(candidate, current);
  if (!canonical || freshness.refreshRequired === true) {
    return bumpRefreshRequired(
      freshness.code || "fan_current_unknown",
      source,
      freshness.refreshFields?.length ? freshness.refreshFields : requiredFields,
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

function sfsRefreshRequired(code, fields, freshnessClass = FAN_CURRENT_FRESHNESS_CLASS.UNKNOWN) {
  return {
    eligible: false,
    retryable: true,
    refreshRequired: true,
    refreshFields: uniqueRelationshipFields(fields),
    freshnessClass,
    code,
  };
}

function evaluateSfsFollowCurrent(candidate, current, settings = {}, now = new Date(), freshnessPolicy = {}) {
  const requiredFields = sfsRequiredFields(settings);
  const freshness = classifyRelationshipFreshness(current, { now, requiredFields, ...freshnessPolicy });
  if (freshness.refreshRequired) {
    return {
      ...sfsRefreshRequired(freshness.code || "sfs_fan_current_unknown", freshness.refreshFields?.length ? freshness.refreshFields : requiredFields, freshness.freshnessClass),
      candidate,
      current,
    };
  }
  const rel = relationship(current);
  if (!rel) return { ...sfsRefreshRequired("sfs_fan_current_unknown", requiredFields), candidate, current };
  if (rel.creatorFollowsFan === null || rel.creatorFollowsFan === undefined) {
    return { ...sfsRefreshRequired("sfs_follow_edge_unknown", ["creatorFollowsFan"], freshness.freshnessClass), candidate, current };
  }
  if (settings.freeTargetsOnly === true && (rel.subscribePriceCents === null || rel.subscribePriceCents === undefined)) {
    return { ...sfsRefreshRequired("sfs_price_unknown", ["subscribePriceCents"], freshness.freshnessClass), candidate, current };
  }

  const canonicalCandidate = {
    ...candidate,
    creatorFollowing: rel.creatorFollowsFan,
    subscribePriceCents: rel.subscribePriceCents,
  };
  const code = targetEligibility(canonicalCandidate, settings, now);
  if (code === "following_unknown") {
    return { ...sfsRefreshRequired("sfs_follow_edge_unknown", ["creatorFollowsFan"], freshness.freshnessClass), candidate: canonicalCandidate, current };
  }
  if (code === "price_unknown") {
    return { ...sfsRefreshRequired("sfs_price_unknown", ["subscribePriceCents"], freshness.freshnessClass), candidate: canonicalCandidate, current };
  }
  return {
    eligible: code === "eligible",
    retryable: false,
    refreshRequired: false,
    refreshFields: [],
    freshnessClass: freshness.freshnessClass,
    code,
    candidate: canonicalCandidate,
    current,
    requiredFields,
  };
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
  const requiredFields = followBackRequiredFields(settings);
  return { ok: true, candidate, current, fanCurrentFence: buildFanCurrentFieldFence(current, requiredFields) };
}

module.exports = {
  FAN_CURRENT_FRESHNESS_CLASS,
  FAN_CURRENT_UNKNOWN_POLICY,
  classifyRelationshipFreshness,
  relationshipFieldAuthority,
  followBackRequiredFields,
  refollowRequiredFields,
  likesRequiredFields,
  bumpRequiredFields,
  sfsRequiredFields,
  buildFanCurrentFieldFence,
  assertFanCurrentFieldFence,
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
  evaluateSfsFollowCurrent,
  sfsRefreshRequired,
  validateFollowBackDeliveryCurrent,
};
