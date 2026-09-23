"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = {
  id: prismaModulePath,
  filename: prismaModulePath,
  loaded: true,
  exports: {},
};
const {
  evaluateFollowBackCurrent,
  evaluateRefollowCurrent,
  evaluateLikesCurrent,
  classifyRelationshipFreshness,
  FAN_CURRENT_FRESHNESS_CLASS,
  FAN_CURRENT_UNKNOWN_POLICY,
  validateBumpCurrentRelationship,
} = require("./fan-current-consumer-service");

const RELATIONSHIP_VERSION_FIELDS = Object.freeze({
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

function authorityVersion(field, observedAt = new Date("2026-09-16T10:00:00.000Z")) {
  return `${observedAt.toISOString()}|0700|USER_PROFILE|test-${field}`;
}

function versionedRelationshipRow(fields, observedAt = new Date("2026-09-16T10:00:00.000Z")) {
  const row = { observedAt, source: "USER_PROFILE", ...fields };
  for (const [field, versionField] of Object.entries(RELATIONSHIP_VERSION_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(fields || {}, field)) row[versionField] = authorityVersion(field, observedAt);
  }
  return row;
}

function current(relationship) {
  if (!relationship || typeof relationship !== "object") return { onlyFansUserId: "fan-1", creatorId: "creator-1", relationship, platformIdentity: null, value: null };
  const observedAt = relationship.observedAt instanceof Date ? relationship.observedAt : new Date("2026-09-16T10:00:00.000Z");
  const fieldAuthority = {};
  for (const field of Object.keys(RELATIONSHIP_VERSION_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(relationship, field)) continue;
    fieldAuthority[field] = { authorityVersion: authorityVersion(field, observedAt), observedAt, source: "USER_PROFILE" };
  }
  const rel = { observedAt, source: "USER_PROFILE", ...relationship, fieldAuthority: { ...fieldAuthority, ...(relationship.fieldAuthority || {}) } };
  return { onlyFansUserId: "fan-1", creatorId: "creator-1", relationship: rel, platformIdentity: null, value: null };
}

test("Phase3 Follow Back eligibility is canonical-current, not candidate-copy current", () => {
  const candidate = {
    fanId: "fan-1", blocked: false, ignored: false, state: "CANDIDATE", generation: 1,
    creatorFollowsFan: false, fanSubscriptionActive: false, fanSubscriptionType: "expired",
  };
  const settings = { activeSubscribers: true, expiredSubscribers: false, freeSubscribers: true, paidSubscribers: true, refollowEnabled: false };
  const canonical = current({ creatorFollowsFan: false, fanSubscriptionActive: true, fanSubscriptionType: "paid" });
  assert.deepEqual(evaluateFollowBackCurrent(candidate, canonical, settings), { eligible: true, code: "active_subscriber" });

  const already = current({ creatorFollowsFan: true, fanSubscriptionActive: true, fanSubscriptionType: "paid" });
  assert.equal(evaluateFollowBackCurrent(candidate, already, settings).code, "already_followed");
});

test("Phase3 Refollow UNFOLLOW is denied when canonical relationship says fan returned", () => {
  const candidate = {
    fanId: "fan-1", blocked: false, ignored: false, ofBlocked: false, restricted: false, performer: false,
    subscribePriceCents: 0, phase: "IDLE", state: "CANDIDATE", nudgeCount: 0,
    fanSubscriptionActive: false, creatorFollowsFan: true,
  };
  const settings = { refollowEnabled: true, maxNudgesPerFan: 2 };
  const canonical = current({
    fanSubscriptionActive: true, creatorFollowsFan: true, blocked: false, restricted: false, performer: false, subscribePriceCents: 0,
  });
  assert.deepEqual(evaluateRefollowCurrent(candidate, canonical, settings, new Date(), { phase: "IDLE" }), { eligible: false, code: "fan_active" });
});

test("Phase3 Bump cohort copy cannot override canonical current message/subscription eligibility", () => {
  const stalePaid = { fanId: "fan-1", dialogId: "fan-1", subscriptionType: "paid", isActive: true, canReceiveChatMessage: true };
  const canonicalFree = current({ fanSubscriptionActive: true, fanSubscriptionType: "free", canReceiveChatMessage: true });
  assert.equal(validateBumpCurrentRelationship({ candidate: stalePaid, current: canonicalFree, source: "paid_subscriber" }).code, "fan_not_paid_current");
  const cannotMessage = current({ fanSubscriptionActive: true, fanSubscriptionType: "paid", canReceiveChatMessage: false });
  assert.equal(validateBumpCurrentRelationship({ candidate: stalePaid, current: cannotMessage, source: "paid_subscriber" }).code, "cannot_message");
  assert.equal(validateBumpCurrentRelationship({ candidate: stalePaid, current: null, source: "paid_subscriber" }).code, "fan_current_unknown");
});

test("Phase3 prepare-write has Follow Back canonical fence and Refollow keeps compensation semantics", () => {
  const root = path.resolve(__dirname);
  const action = fs.readFileSync(path.join(root, "automation-action-delivery-service.js"), "utf8");
  const follow = fs.readFileSync(path.join(root, "follow-automation-service.js"), "utf8");
  assert.match(action, /prepareWriteActionDelivery[\s\S]*validateFollowBackDeliveryCurrent/);
  assert.match(follow, /delivery\.actionType === FOLLOW_FAN_ACTION_TYPE[\s\S]*recovery[\s\S]*return \{ ok: true, candidate \}/);
  assert.match(follow, /UNFOLLOW_FAN_ACTION_TYPE[\s\S]*readFanCurrentMap[\s\S]*evaluateRefollowCurrent/);
});

test("Phase3 known relationship write results heal canonical FanDataAuthority through causal refresh", () => {
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /relationshipEffectRefreshTarget/);
  assert.match(source, /FOLLOW_BACK[\s\S]*FOLLOW_FAN[\s\S]*SFS_FOLLOW_TARGET[\s\S]*UNFOLLOW_FAN[\s\S]*SFS_UNFOLLOW_TARGET/);
  assert.match(source, /fanDataReconcileRequired/);
  assert.match(source, /ensureRelationshipEffectFanRefresh\(finalDelivery\)/);
  assert.match(source, /automation_relationship_effect_reconcile/);
});



test("Phase3 Likes freezes audience settings as canonical current-execution policy", () => {
  const settings = { activeSubscribers: true, expiredSubscribers: false, freeSubscribers: false, paidSubscribers: true };
  const staleSnapshotWouldSayPaid = current({ fanSubscriptionActive: true, fanSubscriptionType: "free" });
  assert.equal(evaluateLikesCurrent(staleSnapshotWouldSayPaid, settings).code, "free_subscribers_disabled");

  const canonicalPaid = current({ fanSubscriptionActive: true, fanSubscriptionType: "paid" });
  assert.deepEqual(evaluateLikesCurrent(canonicalPaid, settings), { eligible: true, code: "paid_subscriber" });

  const unknownType = current({ fanSubscriptionActive: true, fanSubscriptionType: null });
  const unknown = evaluateLikesCurrent(unknownType, settings);
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.retryable, true);
  assert.equal(unknown.unknownPolicy, "POINT_REFRESH_REQUIRED_WHEN_POLICY_DEPENDS_ON_BUCKET");

  assert.equal(FAN_CURRENT_UNKNOWN_POLICY.follow_back.fanSubscriptionActive, "ALLOWED_BY_EXPLICIT_PRODUCT_POLICY");
  assert.equal(FAN_CURRENT_UNKNOWN_POLICY.follow_back.missingRelationship, "FAIL_CLOSED_POINT_REFRESH_REQUIRED");
  assert.equal(FAN_CURRENT_UNKNOWN_POLICY.follow_automation.fanSubscriptionActive, "POINT_REFRESH_REQUIRED");
  assert.equal(FAN_CURRENT_UNKNOWN_POLICY.bumps.canReceiveChatMessage, "POINT_REFRESH_REQUIRED");
  assert.equal(FAN_CURRENT_UNKNOWN_POLICY.likes.missingRelationship, "POINT_REFRESH_REQUIRED");
});

test("Phase3 Likes discovery is cohort-only while planning and commit use canonical fan current", () => {
  const source = fs.readFileSync(path.join(__dirname, "likes-service.js"), "utf8");
  assert.doesNotMatch(source, /function subscriptionWhere\(/);
  assert.doesNotMatch(source, /subscriberScanItem\.findMany\([\s\S]{0,1000}AND:\s*subscriptionWhere/);
  assert.match(source, /planLikesLocked[\s\S]*readFanCurrentMap[\s\S]*evaluateLikesCurrent/);
  assert.match(source, /validateLikeDelivery[\s\S]*readFanCurrentMap[\s\S]*evaluateLikesCurrent/);
});

test("Phase3 Likes commit validation rejects stale audience state from canonical relationship", async () => {
  const { validateLikeDelivery } = require("./likes-service");
  const candidate = {
    id: "like-candidate-1", agencyId: "agency-1", creatorId: "creator-1", ownerFanId: "fan-1",
    contentType: "post", contentId: "post-1", snapshotRunId: "run-1", state: "ELIGIBLE",
    isFavorite: false, canToggleFavorite: true, canViewMedia: true, cooldownUntil: null,
  };
  const relationshipCurrent = versionedRelationshipRow({
    fanSubscribesToCreator: true, fanSubscriptionActive: true, fanSubscriptionType: "free",
    fanSubscriptionExpiresAt: null, creatorFollowsFan: false, creatorFollowExpiresAt: null,
    canReceiveChatMessage: true, blocked: false, restricted: false, performer: false,
    lastSeenAt: null, subscribePriceCents: 0,
  });
  const db = {
    automationContentCandidate: { async findFirst() { return candidate; } },
    subscriberDirectoryState: { async findFirst() { return { currentRunId: "run-1", publishedAt: new Date() }; } },
    hiddenOnlineUser: { async findMany() { return []; } },
    automationBumpFanState: { async findMany() { return []; } },
    creatorFan: { async findMany() { return [{ id: "record-1", creatorId: "creator-1", onlyFansUserId: "fan-1", relationshipCurrent, valueCurrent: null }]; } },
    automationDelivery: { async count() { return 0; } },
  };
  const delivery = { id: "delivery-1", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "likes", actionType: "LIKE_POST", targetId: "post-1", fanId: "fan-1", payload: {} };
  const control = { modules: { likes: { settings: { activeSubscribers: true, expiredSubscribers: false, freeSubscribers: false, paidSubscribers: true, dailyLimit: 100 } } } };
  const result = await validateLikeDelivery({ delivery, control, db, now: new Date("2026-09-16T10:05:00.000Z") });
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.code, "free_subscribers_disabled");
});

test("Phase3 Likes commit validation makes missing canonical current retryable instead of admitting the write", async () => {
  const { validateLikeDelivery } = require("./likes-service");
  const candidate = {
    id: "like-candidate-2", agencyId: "agency-1", creatorId: "creator-1", ownerFanId: "fan-missing",
    contentType: "post", contentId: "post-2", snapshotRunId: "run-1", state: "ELIGIBLE",
    isFavorite: false, canToggleFavorite: true, canViewMedia: true, cooldownUntil: null,
  };
  const db = {
    automationContentCandidate: { async findFirst() { return candidate; } },
    subscriberDirectoryState: { async findFirst() { return { currentRunId: "run-1", publishedAt: new Date() }; } },
    hiddenOnlineUser: { async findMany() { return []; } },
    automationBumpFanState: { async findMany() { return []; } },
    creatorFan: { async findMany() { return []; } },
    automationDelivery: { async count() { return 0; } },
  };
  const delivery = { id: "delivery-2", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "likes", actionType: "LIKE_POST", targetId: "post-2", fanId: "fan-missing", payload: {} };
  const control = { modules: { likes: { settings: { activeSubscribers: true, expiredSubscribers: false, freeSubscribers: true, paidSubscribers: true, dailyLimit: 100 } } } };
  const result = await validateLikeDelivery({ delivery, control, db, now: new Date("2026-09-16T10:05:00.000Z") });
  assert.equal(result.ok, false);
  assert.equal(result.terminal, false);
  assert.equal(result.code, "fan_current_unknown");
  assert.ok(result.retryAt instanceof Date);
  assert.equal(result.refreshRequired, true);
  assert.deepEqual(result.refreshFanIds, ["fan-missing"]);
  assert.deepEqual(result.refreshFields, ["fanSubscriptionActive"]);
});

test("Phase3 Likes UNKNOWN decisions carry explicit bounded refresh requirements", () => {
  const settings = { activeSubscribers: true, expiredSubscribers: false, freeSubscribers: false, paidSubscribers: true };
  const missing = evaluateLikesCurrent(null, settings);
  assert.equal(missing.retryable, true);
  assert.equal(missing.refreshRequired, true);
  assert.deepEqual(missing.refreshFields, ["fanSubscriptionActive", "fanSubscriptionType"]);

  const missingState = evaluateLikesCurrent(current({ fanSubscriptionActive: null, fanSubscriptionType: "paid" }), settings);
  assert.equal(missingState.code, "fan_subscription_state_unknown");
  assert.deepEqual(missingState.refreshFields, ["fanSubscriptionActive"]);

  const missingType = evaluateLikesCurrent(current({ fanSubscriptionActive: true, fanSubscriptionType: null }), settings);
  assert.equal(missingType.code, "fan_subscription_type_unknown");
  assert.deepEqual(missingType.refreshFields, ["fanSubscriptionType"]);
});

test("Phase3 Likes point refresh request is one bounded deduplicated batch, never one call per candidate", async () => {
  const { scheduleLikesCurrentRefresh } = require("./likes-service");
  const calls = [];
  const fanIds = [];
  for (let index = 0; index < 620; index += 1) fanIds.push(`fan-${index}`);
  fanIds.push("fan-1", "fan-2", "fan-3");

  const result = await scheduleLikesCurrentRefresh({
    agencyId: "agency-1",
    creatorId: "creator-1",
    fanIds,
    priority: 40,
    scheduleFanRefresh: async (input) => {
      calls.push(input);
      return { created: true, id: "refresh-job-1" };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].onlyFansUserIds.length, 500);
  assert.equal(new Set(calls[0].onlyFansUserIds).size, 500);
  assert.equal(calls[0].reason, "likes_current_unknown");
  assert.equal(calls[0].priority, 85);
  assert.deepEqual(calls[0].params, { consumer: "likes", trigger: "planning" });
  assert.equal(result.requested, 500);
  assert.equal(result.fanIds.length, 500);
});

test("Phase3 Likes planning collects only refresh-required current failures before out-of-transaction scheduling", () => {
  const source = fs.readFileSync(path.join(__dirname, "likes-service.js"), "utf8");
  assert.match(source, /eligibility\.refreshRequired === true[\s\S]*refreshFanIds\.add/);
  assert.match(source, /planLikes\(input\)[\s\S]*withCreatorLock[\s\S]*scheduleLikesCurrentRefresh/);
  assert.match(source, /scheduleLikesCurrentRefresh[\s\S]*scheduleDurableFanDataRefreshDebt[\s\S]*scheduleFanRefresh/);
  assert.doesNotMatch(source, /for \(const candidate of available\)[\s\S]{0,900}scheduleFanDataPointRefresh/);
});


test("Phase3 fan-current freshness plumbing distinguishes fresh, stale-required and stale-allowed without inventing a runtime TTL", () => {
  const known = current({ fanSubscriptionActive: true, fanSubscriptionType: "paid" });
  const noAgePolicy = classifyRelationshipFreshness(known, { now: new Date("2026-09-16T12:00:00.000Z") });
  assert.equal(noAgePolicy.freshnessClass, FAN_CURRENT_FRESHNESS_CLASS.FRESH_ENOUGH);
  assert.equal(noAgePolicy.refreshRequired, false);

  const staleRequired = classifyRelationshipFreshness(known, {
    now: new Date("2026-09-16T12:00:00.000Z"),
    maxAgeMs: 30 * 60_000,
  });
  assert.equal(staleRequired.freshnessClass, FAN_CURRENT_FRESHNESS_CLASS.POINT_REFRESH_REQUIRED);
  assert.equal(staleRequired.refreshRequired, true);
  assert.equal(staleRequired.code, "fan_current_stale");

  const staleAllowed = classifyRelationshipFreshness(known, {
    now: new Date("2026-09-16T12:00:00.000Z"),
    maxAgeMs: 30 * 60_000,
    allowStale: true,
  });
  assert.equal(staleAllowed.freshnessClass, FAN_CURRENT_FRESHNESS_CLASS.STALE_BUT_ALLOWED_BY_PRODUCT);
  assert.equal(staleAllowed.refreshRequired, false);

  const unknownProvenance = classifyRelationshipFreshness(
    { onlyFansUserId: "fan-1", relationship: { fanSubscriptionActive: true, fanSubscriptionType: "paid" } },
    { now: new Date("2026-09-16T12:00:00.000Z") },
  );
  assert.equal(unknownProvenance.freshnessClass, FAN_CURRENT_FRESHNESS_CLASS.UNKNOWN);
  assert.equal(unknownProvenance.refreshRequired, true);
  assert.equal(unknownProvenance.code, "fan_current_provenance_unknown");
});

test("Phase3 Follow Back missing/provenance-unknown canonical relationship fails closed with bounded-refresh metadata", async () => {
  const candidate = {
    id: "follow-candidate-1", agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-1",
    snapshotRunId: "run-1", state: "CANDIDATE", generation: 1, blocked: false, ignored: false, cooldownUntil: null,
  };
  const settings = { activeSubscribers: true, expiredSubscribers: false, freeSubscribers: true, paidSubscribers: true, refollowEnabled: false };
  const missing = evaluateFollowBackCurrent(candidate, null, settings, new Date("2026-09-16T12:00:00.000Z"));
  assert.equal(missing.eligible, false);
  assert.equal(missing.retryable, true);
  assert.equal(missing.refreshRequired, true);
  assert.deepEqual(missing.refreshFields, ["creatorFollowsFan", "fanSubscriptionActive"]);

  const noProvenance = evaluateFollowBackCurrent(candidate, {
    onlyFansUserId: "fan-1",
    relationship: { creatorFollowsFan: false, fanSubscriptionActive: true, fanSubscriptionType: "paid" },
  }, settings, new Date("2026-09-16T12:00:00.000Z"));
  assert.equal(noProvenance.code, "fan_current_field_provenance_unknown");
  assert.equal(noProvenance.refreshRequired, true);
});

test("Phase3 commit-time refresh scheduling occurs outside prepare-write transaction and covers Likes + Follow Back", () => {
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /validationActionError[\s\S]*error\.fanRefresh/);
  assert.match(source, /prepareWriteActionDelivery[\s\S]*prisma\.\$transaction[\s\S]*catch \(error\)[\s\S]*scheduleValidationFanRefresh[\s\S]*"prepare_write"/);
  assert.match(source, /moduleKey === "follow_back"[\s\S]*validateFollowBackDeliveryCurrent[\s\S]*validationActionError/);
  assert.match(source, /moduleKey === "likes"[\s\S]*validateLikeDelivery[\s\S]*validationActionError/);
});

test("Phase3 Follow Back planning collects refresh-required fans and schedules one bounded batch after advisory lock", () => {
  const source = fs.readFileSync(path.join(__dirname, "follow-back-service.js"), "utf8");
  assert.match(source, /eligibility\.refreshRequired === true[\s\S]*refreshFanIds\.add/);
  assert.match(source, /scheduleFollowBackCurrentRefresh[\s\S]*scheduleDurableFanDataRefreshDebt[\s\S]*scheduleFanRefresh/);
  assert.match(source, /planFollowBack\(input\)[\s\S]*withDbAdvisoryXactLock[\s\S]*scheduleFollowBackCurrentRefresh/);
});

test("Phase3 Follow Back point refresh request is one bounded deduplicated batch", async () => {
  const { scheduleFollowBackCurrentRefresh } = require("./follow-back-service");
  const calls = [];
  const fanIds = [];
  for (let index = 0; index < 620; index += 1) fanIds.push(`follow-fan-${index}`);
  fanIds.push("follow-fan-1", "follow-fan-2");

  const result = await scheduleFollowBackCurrentRefresh({
    agencyId: "agency-1",
    creatorId: "creator-1",
    fanIds,
    priority: 40,
    trigger: "planning",
    scheduleFanRefresh: async (input) => {
      calls.push(input);
      return { created: true, id: "follow-refresh-job-1" };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].onlyFansUserIds.length, 500);
  assert.equal(new Set(calls[0].onlyFansUserIds).size, 500);
  assert.equal(calls[0].reason, "follow_back_current_unknown");
  assert.equal(calls[0].priority, 85);
  assert.deepEqual(calls[0].params, { consumer: "follow_back", trigger: "planning" });
  assert.equal(result.requested, 500);
});

test("Phase3 Refollow missing/unprovenanced canonical current fails closed and requests bounded point refresh", () => {
  const candidate = {
    fanId: "fan-1", blocked: false, ignored: false, ofBlocked: false, restricted: false, performer: false,
    subscribePriceCents: 0, phase: "IDLE", state: "CANDIDATE", nudgeCount: 0,
    fanSubscriptionActive: false, creatorFollowsFan: true,
  };
  const settings = { refollowEnabled: true, maxNudgesPerFan: 2 };
  const missing = evaluateRefollowCurrent(candidate, null, settings, new Date("2026-09-16T12:00:00.000Z"), { phase: "IDLE" });
  assert.equal(missing.eligible, false);
  assert.equal(missing.retryable, true);
  assert.equal(missing.refreshRequired, true);
  assert.deepEqual(missing.refreshFields, ["fanSubscriptionActive", "creatorFollowsFan", "blocked", "restricted", "performer", "subscribePriceCents"]);

  const noProvenance = evaluateRefollowCurrent(candidate, {
    onlyFansUserId: "fan-1",
    relationship: { fanSubscriptionActive: false, creatorFollowsFan: true },
  }, settings, new Date("2026-09-16T12:00:00.000Z"), { phase: "IDLE" });
  assert.equal(noProvenance.code, "fan_current_field_provenance_unknown");
  assert.equal(noProvenance.refreshRequired, true);
});

test("Phase3 Refollow refreshes only the edge required for expired-fan UNFOLLOW admission", () => {
  const candidate = {
    fanId: "fan-1", blocked: false, ignored: false, ofBlocked: false, restricted: false, performer: false,
    subscribePriceCents: 0, phase: "IDLE", state: "CANDIDATE", nudgeCount: 0,
  };
  const settings = { refollowEnabled: true, maxNudgesPerFan: 2 };
  const unknownSubscription = evaluateRefollowCurrent(candidate, current({ fanSubscriptionActive: null, creatorFollowsFan: true, blocked: false, restricted: false, performer: false, subscribePriceCents: 0 }), settings, new Date(), { phase: "IDLE" });
  assert.equal(unknownSubscription.code, "fan_subscription_state_unknown");
  assert.deepEqual(unknownSubscription.refreshFields, ["fanSubscriptionActive"]);

  const unknownFollowEdge = evaluateRefollowCurrent(candidate, current({ fanSubscriptionActive: false, creatorFollowsFan: null, blocked: false, restricted: false, performer: false, subscribePriceCents: 0 }), settings, new Date(), { phase: "IDLE" });
  assert.equal(unknownFollowEdge.code, "creator_follow_state_unknown");
  assert.deepEqual(unknownFollowEdge.refreshFields, ["creatorFollowsFan"]);

  const returnedFan = evaluateRefollowCurrent(candidate, current({ fanSubscriptionActive: true, creatorFollowsFan: null, blocked: false, restricted: false, performer: false, subscribePriceCents: 0 }), settings, new Date(), { phase: "IDLE" });
  assert.equal(returnedFan.code, "fan_active");
  assert.equal(returnedFan.refreshRequired, undefined);
});

test("Phase3 Refollow planning schedules one bounded deduplicated refresh batch after advisory lock", async () => {
  const { scheduleRefollowCurrentRefresh } = require("./follow-automation-service");
  const calls = [];
  const fanIds = Array.from({ length: 620 }, (_, index) => `refollow-fan-${index}`);
  fanIds.push("refollow-fan-1", "refollow-fan-2");
  const result = await scheduleRefollowCurrentRefresh({
    agencyId: "agency-1",
    creatorId: "creator-1",
    fanIds,
    priority: 45,
    scheduleFanRefresh: async (input) => { calls.push(input); return { created: true, id: "refresh-refollow-1" }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].onlyFansUserIds.length, 500);
  assert.equal(new Set(calls[0].onlyFansUserIds).size, 500);
  assert.equal(calls[0].reason, "refollow_current_unknown");
  assert.equal(calls[0].priority, 85);
  assert.deepEqual(calls[0].params, { consumer: "follow_automation", trigger: "planning" });
  assert.equal(result.requested, 500);
});

test("Phase3 Refollow source preserves compensation-safe FOLLOW while UNFOLLOW refresh is out of transaction", () => {
  const follow = fs.readFileSync(path.join(__dirname, "follow-automation-service.js"), "utf8");
  const action = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(follow, /delivery\.actionType === FOLLOW_FAN_ACTION_TYPE[\s\S]*recovery[\s\S]*return \{ ok: true, candidate \}/);
  assert.match(follow, /eligibility\.refreshRequired === true[\s\S]*refreshFanIds\.add/);
  assert.match(follow, /planFollowAutomation\(input\)[\s\S]*withDbAdvisoryXactLock[\s\S]*scheduleRefollowCurrentRefresh/);
  assert.match(action, /moduleKey === FOLLOW_AUTOMATION_MODULE_KEY[\s\S]*validateFollowAutomationDelivery[\s\S]*validationActionError/);
});

test("Phase3 Bump missing/unprovenanced current requests only source-required relationship fields", () => {
  const candidate = { fanId: "fan-1", dialogId: "fan-1" };
  const onlineMissing = validateBumpCurrentRelationship({ candidate, current: null, source: "online" });
  assert.equal(onlineMissing.refreshRequired, true);
  assert.equal(onlineMissing.terminal, false);
  assert.deepEqual(onlineMissing.refreshFields, ["canReceiveChatMessage"]);

  const paidMissing = validateBumpCurrentRelationship({ candidate, current: null, source: "paid_subscriber" });
  assert.equal(paidMissing.refreshRequired, true);
  assert.deepEqual(paidMissing.refreshFields, ["canReceiveChatMessage", "fanSubscriptionActive", "fanSubscriptionType"]);

  const noProvenance = validateBumpCurrentRelationship({
    candidate,
    current: { onlyFansUserId: "fan-1", relationship: { canReceiveChatMessage: true, fanSubscriptionActive: true, fanSubscriptionType: "paid" } },
    source: "paid_subscriber",
  });
  assert.equal(noProvenance.code, "fan_current_field_provenance_unknown");
  assert.equal(noProvenance.refreshRequired, true);
});

test("Phase3 Bump unknown required field refreshes while known negative current remains terminal", () => {
  const candidate = { fanId: "fan-1", dialogId: "fan-1" };
  const messageUnknown = validateBumpCurrentRelationship({ candidate, current: current({ canReceiveChatMessage: null }), source: "online" });
  assert.equal(messageUnknown.code, "can_receive_unknown");
  assert.equal(messageUnknown.refreshRequired, true);
  assert.deepEqual(messageUnknown.refreshFields, ["canReceiveChatMessage"]);

  const messageDenied = validateBumpCurrentRelationship({ candidate, current: current({ canReceiveChatMessage: false }), source: "online" });
  assert.equal(messageDenied.code, "cannot_message");
  assert.equal(messageDenied.terminal, true);
  assert.equal(messageDenied.refreshRequired, undefined);

  const paidTypeUnknown = validateBumpCurrentRelationship({ candidate, current: current({ canReceiveChatMessage: true, fanSubscriptionActive: true, fanSubscriptionType: null }), source: "paid_subscriber" });
  assert.equal(paidTypeUnknown.code, "fan_subscription_type_unknown");
  assert.deepEqual(paidTypeUnknown.refreshFields, ["fanSubscriptionType"]);
});

test("Phase3 Bump planning point refresh is one bounded deduplicated batch", async () => {
  const { scheduleBumpCurrentRefresh } = require("./bump-service");
  const calls = [];
  const fanIds = Array.from({ length: 620 }, (_, index) => `bump-fan-${index}`);
  fanIds.push("bump-fan-1", "bump-fan-2");
  const result = await scheduleBumpCurrentRefresh({
    agencyId: "agency-1",
    creatorId: "creator-1",
    fanIds,
    priority: 45,
    refreshFields: ["canReceiveChatMessage", "fanSubscriptionActive"],
    scheduleFanRefresh: async (input) => { calls.push(input); return { created: true, id: "refresh-bump-1" }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].onlyFansUserIds.length, 500);
  assert.equal(new Set(calls[0].onlyFansUserIds).size, 500);
  assert.equal(calls[0].reason, "bump_current_unknown");
  assert.equal(calls[0].priority, 85);
  assert.deepEqual(calls[0].params, {
    consumer: "bumps",
    trigger: "planning",
    refreshFields: ["canReceiveChatMessage", "fanSubscriptionActive"],
  });
  assert.equal(result.requested, 500);
});

test("Phase3 Bump planning + commit refresh scheduling remains outside write transactions", () => {
  const bump = fs.readFileSync(path.join(__dirname, "bump-service.js"), "utf8");
  const action = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(bump, /currentDecision\.refreshRequired === true[\s\S]*refreshFanIds\.add/);
  assert.match(bump, /withDbAdvisoryXactLock[\s\S]*scheduleBumpCurrentRefresh/);
  assert.match(action, /moduleKey === "bumps"[\s\S]*validateBumpDelivery[\s\S]*validationActionError/);
  assert.match(action, /catch \(error\)[\s\S]*scheduleValidationFanRefresh[\s\S]*"prepare_write"/);
});

test("Phase3 Refollow UNFOLLOW commit validator requests refresh while compensating FOLLOW remains independent", async () => {
  const { validateFollowAutomationDelivery } = require("./follow-automation-service");
  const candidate = {
    id: "refollow-candidate-commit", agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-commit",
    snapshotRunId: "run-1", generation: 2, phase: "UNFOLLOW", state: "QUEUED_UNFOLLOW",
    blocked: false, ignored: false, ofBlocked: false, restricted: false, performer: false,
    subscribePriceCents: 0, nudgeCount: 0, cooldownUntil: null, creatorFollowsFan: true,
  };
  const db = {
    followAutomationCandidate: { async findFirst() { return candidate; } },
    subscriberDirectoryState: { async findFirst() { return { currentRunId: "run-1" }; } },
    creatorFan: { async findMany() { return []; } },
  };
  const control = { modules: { follow: { settings: { refollowEnabled: true, dailyLimit: 10, maxNudgesPerFan: 2 } } } };
  const unfollow = await validateFollowAutomationDelivery({
    delivery: { id: "d-unfollow", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "follow", actionType: "UNFOLLOW_FAN", targetId: "fan-commit", fanId: "fan-commit", generation: 2, payload: {} },
    control,
    db,
    now: new Date("2026-09-16T12:00:00.000Z"),
  });
  assert.equal(unfollow.ok, false);
  assert.equal(unfollow.terminal, false);
  assert.equal(unfollow.refreshRequired, true);
  assert.deepEqual(unfollow.refreshFanIds, ["fan-commit"]);

  candidate.phase = "RECOVERY";
  const recovery = await validateFollowAutomationDelivery({
    delivery: { id: "d-follow", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "follow", actionType: "FOLLOW_FAN", targetId: "fan-commit", fanId: "fan-commit", generation: 2, payload: { recovery: true } },
    control,
    db,
    now: new Date("2026-09-16T12:00:00.000Z"),
  });
  assert.equal(recovery.ok, true);
  assert.equal(recovery.refreshRequired, undefined);
});

test("Phase3 Bump SEND commit validator turns missing canonical current into retryable refresh admission", async () => {
  const { validateBumpDelivery } = require("./bump-service");
  const db = {
    automationBumpFanState: { async findUnique() { return null; } },
    creatorFan: { async findMany() { return []; } },
  };
  const control = { modules: { bumps: { settings: { onlineObservationTtlMs: 3 * 60 * 60_000 } } } };
  const result = await validateBumpDelivery({
    delivery: {
      id: "bump-d-1", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "bumps", actionType: "SEND_MESSAGE",
      fanId: "fan-bump", targetId: "fan-bump", dialogId: "dialog-bump", payload: { source: "manual", template: { id: "template-1", mediaFiles: [] } },
    },
    control,
    db,
    now: new Date("2026-09-16T12:00:00.000Z"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.terminal, false);
  assert.equal(result.refreshRequired, true);
  assert.deepEqual(result.refreshFanIds, ["fan-bump"]);
  assert.deepEqual(result.refreshFields, ["canReceiveChatMessage"]);
});


test("Phase3 fresh-source read metrics cannot resurrect unprovenanced Follow Back current truth", () => {
  const source = fs.readFileSync(path.join(__dirname, "follow-back-service.js"), "utf8");
  const fn = source.match(/async function countEligibleCandidates[\s\S]*?return Number\(rows\?\.\[0\]\?\.count \|\| 0\);\n}/)?.[0] || "";
  assert.match(fn, /JOIN "CreatorFanRelationshipCurrent" r/);
  assert.match(fn, /creatorFollowsFanAuthorityVersion/);
  assert.doesNotMatch(fn, /r\."observedAt" IS NOT NULL/);
  assert.doesNotMatch(source, /function automaticEligibilityWhere\(/);
});

test("Phase3 Refollow eligible metric is canonical-current instead of candidate state", () => {
  const source = fs.readFileSync(path.join(__dirname, "follow-automation-service.js"), "utf8");
  const helper = source.match(/async function countCanonicalEligibleRefollowCandidates[\s\S]*?return Number\(rows\?\.\[0\]\?\.count \|\| 0\);\n}/)?.[0] || "";
  assert.match(helper, /JOIN "CreatorFanRelationshipCurrent" r/);
  assert.match(helper, /fanSubscriptionActiveAuthorityVersion/);
  assert.match(helper, /creatorFollowsFanAuthorityVersion/);
  assert.doesNotMatch(helper, /r\."observedAt" IS NOT NULL/);
  assert.match(helper, /r\."fanSubscriptionActive" = false/);
  assert.match(helper, /r\."creatorFollowsFan" = true/);
  assert.match(source, /metrics[\s\S]*countCanonicalEligibleRefollowCandidates\(\{ agencyId, creatorId, settings, now, db \}\)/);
  assert.doesNotMatch(source, /metrics[\s\S]{0,800}state: "CANDIDATE"/);
});

test("Phase3 scale pre-closure keeps fan-current planning and refresh batches bounded at 500", () => {
  const likes = fs.readFileSync(path.join(__dirname, "likes-service.js"), "utf8");
  const followBack = fs.readFileSync(path.join(__dirname, "follow-back-service.js"), "utf8");
  const refollow = fs.readFileSync(path.join(__dirname, "follow-automation-service.js"), "utf8");
  const bump = fs.readFileSync(path.join(__dirname, "bump-service.js"), "utf8");
  assert.match(likes, /const take = Math\.min\(500, Math\.max\(capacity \* 4, 100\)\)/);
  assert.match(likes, /consumerKey: "likes:planning", limit: take/);
  assert.doesNotMatch(likes, /take: Math\.min\(2000/);
  assert.match(followBack, /batchSize = fanId \? 1 : 500/);
  assert.match(followBack, /refreshFanIds\.size < 500/);
  assert.match(followBack, /consumerKey: "follow_back:planning", limit: batchSize/);
  assert.doesNotMatch(followBack, /while \(!exhausted/);
  assert.match(refollow, /batchSize = fanId \? 1 : 500/);
  assert.match(refollow, /refreshFanIds\.size < 500/);
  assert.match(refollow, /consumerKey: "follow_automation:planning", limit: batchSize/);
  assert.doesNotMatch(refollow, /for \(;;\)/);
  assert.match(bump, /candidateBatchSize[\s\S]*Math\.max\(1, Number\(limit\)/);
});


test("Phase3 recovery FOLLOW admission is a workflow obligation, never a stale relationship-copy shortcut", async () => {
  const { validateFollowAutomationDelivery } = require("./follow-automation-service");
  const candidate = {
    id: "refollow-recovery-obligation", agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-1",
    snapshotRunId: "run-1", generation: 3, phase: "WAIT_RETURN", state: "WAITING_RETURN",
    creatorFollowsFan: true,
  };
  const db = { followAutomationCandidate: { async findFirst() { return candidate; } } };
  const delivery = {
    id: "recovery-delivery", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "follow",
    actionType: "FOLLOW_FAN", targetId: "fan-1", fanId: "fan-1", generation: 3, payload: { recovery: true },
  };
  const control = { modules: { follow: { settings: { refollowEnabled: true } } } };
  const mismatch = await validateFollowAutomationDelivery({ delivery, control, db, now: new Date("2026-09-16T12:00:00.000Z") });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "recovery_state_mismatch");

  candidate.phase = "FOLLOW";
  candidate.creatorFollowsFan = false;
  const obligation = await validateFollowAutomationDelivery({ delivery, control, db, now: new Date("2026-09-16T12:00:00.000Z") });
  assert.equal(obligation.ok, true);
});

test("Phase3 Follow Back workflow restore and delivery payload do not resurrect candidate relationship copies", () => {
  const source = fs.readFileSync(path.join(__dirname, "follow-back-service.js"), "utf8");
  const restore = source.match(/if \(normalized === "restore"\)[\s\S]*?return \{ ok: true, candidate: updated \};\n  }/)?.[0] || "";
  assert.match(restore, /state: "CANDIDATE"/);
  assert.match(restore, /eligibilityReason: "restored"/);
  assert.doesNotMatch(restore, /candidate\.creatorFollowsFan|candidate\.fanSubscriptionActive|candidate\.fanSubscriptionType/);
  assert.match(source, /subscriptionType: current\?\.relationship\?\.fanSubscriptionType \?\? null/);
  assert.doesNotMatch(source, /subscriptionType: candidate\.fanSubscriptionType/);
});


test("Phase3 Likes read model and eligible metric use canonical current audience truth", () => {
  const source = fs.readFileSync(path.join(__dirname, "likes-service.js"), "utf8");
  const helper = source.match(/async function countCanonicalEligibleLikeCandidates[\s\S]*?return Number\(rows\?\.\[0\]\?\.count \|\| 0\);\n}/)?.[0] || "";
  assert.match(helper, /JOIN "CreatorFanRelationshipCurrent" r/);
  assert.match(helper, /fanSubscriptionActiveAuthorityVersion/);
  assert.doesNotMatch(helper, /r\."observedAt" IS NOT NULL/);
  assert.match(helper, /c\."state" IN \('ELIGIBLE', 'DISCOVERED'\)/);
  assert.match(source, /countCanonicalEligibleLikeCandidates\(\{ agencyId, creatorId, settings, db \}\)/);
  assert.match(source, /listLikes[\s\S]*readFanCurrentMap[\s\S]*evaluateLikesCurrent/);
  assert.match(source, /currentEligibility: audience\.code/);
  assert.match(source, /eligible: workflowEligible && audience\.eligible === true/);
});
