"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = { id: prismaModulePath, filename: prismaModulePath, loaded: true, exports: {} };

const { evaluateRefollowCurrent } = require("./fan-current-consumer-service");
const { evaluateRefollowCandidate } = require("./follow-automation-rules");
const { scheduleRefollowCurrentRefresh, validateFollowAutomationDelivery } = require("./follow-automation-service");

const SAFETY_FIELDS = ["blocked", "restricted", "performer", "subscribePriceCents"];

function authorityVersion(field) {
  return `2026-09-16T10:00:00.000Z|0700|USER_PROFILE|int4-2b-${field}`;
}

function canonical(overrides = {}) {
  const relationship = {
    fanSubscriptionActive: false,
    creatorFollowsFan: true,
    blocked: false,
    restricted: false,
    performer: false,
    subscribePriceCents: 0,
    ...overrides,
  };
  relationship.fieldAuthority = Object.fromEntries(
    Object.keys(relationship)
      .filter((field) => field !== "fieldAuthority")
      .map((field) => [field, {
        authorityVersion: authorityVersion(field),
        observedAt: new Date("2026-09-16T10:00:00.000Z"),
        source: "USER_PROFILE",
      }]),
  );
  return {
    creatorId: "creator-1",
    onlyFansUserId: "fan-1",
    relationship,
  };
}

function candidate() {
  return {
    fanId: "fan-1",
    blocked: false,
    ignored: false,
    state: "CANDIDATE",
    phase: "IDLE",
    nudgeCount: 0,
    cooldownUntil: null,
    // Deliberately stale-safe copies: canonical UNKNOWN must win over them.
    ofBlocked: false,
    restricted: false,
    performer: false,
    subscribePriceCents: 0,
    fanSubscriptionActive: false,
    creatorFollowsFan: true,
  };
}

const settings = { refollowEnabled: true, maxNudgesPerFan: 2 };

test("INT4.2B Refollow canonical UNKNOWN safety values fail closed and request only exact unknown fields", () => {
  for (const field of SAFETY_FIELDS) {
    const result = evaluateRefollowCurrent(candidate(), canonical({ [field]: null }), settings, new Date("2026-09-16T10:01:00.000Z"), { phase: "IDLE" });
    assert.equal(result.eligible, false, field);
    assert.equal(result.retryable, true, field);
    assert.equal(result.refreshRequired, true, field);
    assert.equal(result.code, "refollow_safety_state_unknown", field);
    assert.deepEqual(result.refreshFields, [field], field);
  }
});

test("INT4.2B multiple UNKNOWN safety fields are deduplicated into one bounded refresh request", async () => {
  const result = evaluateRefollowCurrent(
    candidate(),
    canonical({ blocked: null, performer: null, subscribePriceCents: null }),
    settings,
    new Date("2026-09-16T10:01:00.000Z"),
    { phase: "IDLE" },
  );
  assert.deepEqual(result.refreshFields, ["blocked", "performer", "subscribePriceCents"]);

  const calls = [];
  const scheduled = await scheduleRefollowCurrentRefresh({
    agencyId: "agency-1",
    creatorId: "creator-1",
    fanIds: ["fan-1", "fan-1"],
    refreshFields: [...result.refreshFields, "blocked"],
    scheduleFanRefresh: async (input) => { calls.push(input); return { created: true, id: "job-1" }; },
  });
  assert.equal(scheduled.requested, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].onlyFansUserIds, ["fan-1"]);
  assert.deepEqual(calls[0].params.refreshFields, ["blocked", "performer", "subscribePriceCents"]);
});

test("INT4.2B UNKNOWN price is never interpreted as free and known safety facts keep existing terminal semantics", () => {
  const unknownPrice = evaluateRefollowCurrent(candidate(), canonical({ subscribePriceCents: null }), settings);
  assert.equal(unknownPrice.code, "refollow_safety_state_unknown");
  assert.equal(unknownPrice.refreshRequired, true);

  assert.equal(evaluateRefollowCurrent(candidate(), canonical({ blocked: true }), settings).code, "blocked");
  assert.equal(evaluateRefollowCurrent(candidate(), canonical({ restricted: true }), settings).code, "restricted");
  assert.equal(evaluateRefollowCurrent(candidate(), canonical({ performer: true }), settings).code, "performer");
  assert.equal(evaluateRefollowCurrent(candidate(), canonical({ subscribePriceCents: 500 }), settings).code, "paid_subscription_required");
});

test("INT4.2B lower-level Refollow rules also fail closed instead of coercing unknown safety values", () => {
  const base = {
    ...candidate(),
    ofBlocked: false,
    restricted: false,
    performer: false,
    subscribePriceCents: 0,
  };
  for (const field of ["ofBlocked", "restricted", "performer", "subscribePriceCents"]) {
    assert.equal(evaluateRefollowCandidate({ ...base, [field]: null }, settings).code, "safety_state_unknown", field);
  }
});

test("INT4.2B Refollow metrics use the same fail-closed UNKNOWN contract as executable admission", () => {
  const source = fs.readFileSync(path.join(__dirname, "follow-automation-service.js"), "utf8");
  const start = source.indexOf("async function countCanonicalEligibleRefollowCandidates");
  const end = source.indexOf("async function listFollowAutomation", start);
  const metric = source.slice(start, end);
  for (const field of ["blocked", "restricted", "performer", "subscribePriceCents"]) {
    assert.match(metric, new RegExp(`r\\.\"${field}\" IS NOT NULL`), field);
  }
  assert.doesNotMatch(metric, /COALESCE\(r\."blocked", false\)/);
  assert.doesNotMatch(metric, /COALESCE\(r\."restricted", false\)/);
  assert.doesNotMatch(metric, /COALESCE\(r\."performer", false\)/);
  assert.doesNotMatch(metric, /COALESCE\(r\."subscribePriceCents", 0\)/);
});

test("INT4.2B planning carries exact Refollow refresh fields out of the advisory transaction", () => {
  const source = fs.readFileSync(path.join(__dirname, "follow-automation-service.js"), "utf8");
  const locked = source.slice(source.indexOf("async function planFollowAutomationLocked"), source.indexOf("async function scheduleRefollowCurrentRefresh"));
  const outer = source.slice(source.indexOf("async function planFollowAutomation(input)"), source.indexOf("async function ensureAutomaticFollowAutomation"));
  assert.match(locked, /const refreshFields = new Set\(\)/);
  assert.match(locked, /eligibility\.refreshFields[\s\S]*refreshFields\.add/);
  assert.match(locked, /refreshFields: \[\.\.\.refreshFields\]/);
  assert.match(outer, /refreshFields: result\.refreshFields \|\| \[\]/);
});



test("INT4.2B prepare-write Refollow validator returns exact safety refresh instead of granting UNFOLLOW", async () => {
  const observedAt = new Date("2026-09-16T10:00:00.000Z");
  const relationshipCurrent = {
    fanSubscriptionActive: false,
    creatorFollowsFan: true,
    blocked: null,
    restricted: false,
    performer: false,
    subscribePriceCents: 0,
    observedAt,
    source: "USER_PROFILE",
    fanSubscriptionActiveAuthorityVersion: authorityVersion("fanSubscriptionActive"),
    creatorFollowsFanAuthorityVersion: authorityVersion("creatorFollowsFan"),
    blockedAuthorityVersion: authorityVersion("blocked"),
    restrictedAuthorityVersion: authorityVersion("restricted"),
    performerAuthorityVersion: authorityVersion("performer"),
    subscribePriceCentsAuthorityVersion: authorityVersion("subscribePriceCents"),
  };
  const db = {
    followAutomationCandidate: {
      async findFirst() { return { ...candidate(), snapshotRunId: "run-1", generation: 4 }; },
    },
    subscriberDirectoryState: {
      async findFirst() { return { currentRunId: "run-1" }; },
    },
    creatorFan: {
      async findMany() {
        return [{
          id: "fan-record-1", agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1",
          username: null, displayName: null, avatarUrl: null, headerUrl: null,
          identityObservedAt: null, identitySource: null, identityCompleteness: null,
          relationshipCurrent, valueCurrent: null,
        }];
      },
    },
  };
  const delivery = {
    id: "delivery-1", agencyId: "agency-1", creatorId: "creator-1",
    moduleKey: "follow", actionType: "UNFOLLOW_FAN",
    targetId: "fan-1", fanId: "fan-1", generation: 4,
  };
  const control = { modules: { follow: { settings: { refollowEnabled: true, maxNudgesPerFan: 2 } } } };
  const result = await validateFollowAutomationDelivery({ delivery, control, now: new Date("2026-09-16T10:01:00.000Z"), db });
  assert.equal(result.ok, false);
  assert.equal(result.terminal, false);
  assert.equal(result.code, "refollow_safety_state_unknown");
  assert.equal(result.refreshRequired, true);
  assert.deepEqual(result.refreshFields, ["blocked"]);
});

test("INT4.2B compensation FOLLOW remains outside ordinary Refollow current-safety admission", () => {
  const source = fs.readFileSync(path.join(__dirname, "follow-automation-service.js"), "utf8");
  const validate = source.slice(source.indexOf("async function validateFollowAutomationDelivery"), source.indexOf("async function finalizeFollowAutomationSuccess"));
  const followBranch = validate.slice(validate.indexOf("delivery.actionType === FOLLOW_FAN_ACTION_TYPE"), validate.indexOf("delivery.actionType !== UNFOLLOW_FAN_ACTION_TYPE"));
  assert.match(followBranch, /recovery/);
  assert.doesNotMatch(followBranch, /evaluateRefollowCurrent/);
  assert.doesNotMatch(followBranch, /refollow_safety_state_unknown/);
});
