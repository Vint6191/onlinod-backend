"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = { id: prismaModulePath, filename: prismaModulePath, loaded: true, exports: {} };

const { normalizeSfsSettings } = require("./sfs-rules");
const {
  evaluateSfsFollowCurrent,
  sfsRequiredFields,
  buildFanCurrentFieldFence,
} = require("./fan-current-consumer-service");

function version(suffix, at = "2026-09-16T10:00:00.000Z") {
  return `${at}|0700|USER_PROFILE|${suffix}`;
}

function current({ followed = false, price = 0 } = {}) {
  return {
    creatorId: "creator-1",
    onlyFansUserId: "fan-1",
    relationship: {
      creatorFollowsFan: followed,
      subscribePriceCents: price,
      fieldAuthority: {
        creatorFollowsFan: {
          authorityVersion: version("follow"),
          observedAt: new Date("2026-09-16T10:00:00.000Z"),
          source: "USER_PROFILE",
        },
        subscribePriceCents: {
          authorityVersion: version("price"),
          observedAt: new Date("2026-09-16T10:00:00.000Z"),
          source: "USER_PROFILE",
        },
      },
    },
  };
}

function candidate(overrides = {}) {
  return {
    id: "candidate-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    targetUserId: "fan-1",
    username: "alice",
    generation: 3,
    state: "CANDIDATE",
    phase: "IDLE",
    usedForever: false,
    blocked: false,
    ignored: false,
    isWantComments: true,
    discoveryObservedAt: new Date("2026-09-16T10:00:00.000Z"),
    creatorFollowing: false,
    subscribePriceCents: 0,
    ...overrides,
  };
}

function cacheModule(request, exports) {
  const id = require.resolve(request);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return id;
}
function restore(id) { delete require.cache[id]; }
function fresh(request) { const id = require.resolve(request); delete require.cache[id]; return require(request); }

function loadSfs(db) {
  const ids = [];
  ids.push(cacheModule("../prisma", db));
  ids.push(cacheModule("./automation-control-service", {
    requireCreator: async () => ({ id: "creator-1" }),
    assertAutomationEnabled: async () => ({ modules: { sfs: { settings: {} } }, workspace: { settings: {} }, effective: { sfsEnabled: true } }),
    getAutomationControlSnapshot: async () => ({ modules: { sfs: { settings: {} } }, workspace: { settings: {} }, effective: { sfsEnabled: true } }),
    normalizeSfsSettings,
  }));
  ids.push(cacheModule("./job-planning-repository", {
    ensurePlannedJob: async () => ({ job: null, created: false }),
    createPlannedJobIfAbsent: async () => ({ job: null, created: false }),
  }));
  ids.push(cacheModule("./automation-pacing-service", { nextAutomationWriteSlot: async () => new Date() }));
  const service = fresh("./sfs-service");
  return { service, cleanup() { restore(require.resolve("./sfs-service")); for (const id of ids) restore(id); } };
}

function relationshipRow({ followed = false, price = 0 } = {}) {
  return {
    creatorFollowsFan: followed,
    creatorFollowsFanAuthorityVersion: version("follow"),
    subscribePriceCents: price,
    subscribePriceCentsAuthorityVersion: version("price"),
    observedAt: new Date("2026-09-16T10:00:00.000Z"),
    source: "USER_PROFILE",
  };
}

function validationDb({ followed = false, price = 0 } = {}) {
  const row = candidate();
  return {
    sfsTargetCandidate: {
      async findFirst() { return { ...row }; },
      async updateMany({ data }) { Object.assign(row, data); return { count: 1 }; },
    },
    creatorFan: {
      async findMany() {
        return [{
          id: "fan-record-1", agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1",
          username: "alice", displayName: null, avatarUrl: null, headerUrl: null,
          identityObservedAt: null, identitySource: null, identityCompleteness: null,
          relationshipCurrent: relationshipRow({ followed, price }), valueCurrent: null,
        }];
      },
    },
  };
}

const settings = normalizeSfsSettings({ freeTargetsOnly: true, commentsEnabled: true, commentLikesEnabled: true });
const now = new Date("2026-09-16T10:05:00.000Z");

test("INT4.3B SFS ordinary FOLLOW uses canonical price/follow and exact field versions", () => {
  assert.deepEqual(sfsRequiredFields(settings), ["creatorFollowsFan", "subscribePriceCents"]);
  const decision = evaluateSfsFollowCurrent(candidate({ creatorFollowing: true, subscribePriceCents: 9999 }), current({ followed: false, price: 0 }), settings, now);
  assert.equal(decision.eligible, true, "stale candidate copies must not override canonical current");
  assert.equal(decision.candidate.creatorFollowing, false);
  assert.equal(decision.candidate.subscribePriceCents, 0);
  const fence = buildFanCurrentFieldFence(decision.current, decision.requiredFields);
  assert.deepEqual(Object.keys(fence.versions).sort(), ["creatorFollowsFan", "subscribePriceCents"]);
});

test("INT4.3B SFS UNKNOWN canonical fields fail closed and request exact refresh", () => {
  const unknownFollow = current({ followed: null, price: 0 });
  const followDecision = evaluateSfsFollowCurrent(candidate(), unknownFollow, settings, now);
  assert.equal(followDecision.eligible, false);
  assert.equal(followDecision.refreshRequired, true);
  assert.deepEqual(followDecision.refreshFields, ["creatorFollowsFan"]);

  const unknownPrice = current({ followed: false, price: null });
  const priceDecision = evaluateSfsFollowCurrent(candidate(), unknownPrice, settings, now);
  assert.equal(priceDecision.eligible, false);
  assert.equal(priceDecision.refreshRequired, true);
  assert.deepEqual(priceDecision.refreshFields, ["subscribePriceCents"]);
});

test("INT4.3B SFS already-followed current is terminal admission, not another FOLLOW", async () => {
  const db = validationDb({ followed: true, price: 0 });
  const loaded = loadSfs(db);
  try {
    const validation = await loaded.service.validateSfsDelivery({
      db,
      delivery: {
        id: "delivery-1", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "sfs", actionType: "SFS_FOLLOW_TARGET",
        generation: 3, targetId: "fan-1", fanId: "fan-1", payload: { candidateId: "candidate-1" }, notBefore: null,
      },
      control: { effective: { sfsEnabled: true }, modules: { sfs: { settings: { freeTargetsOnly: true } } } },
      now,
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.terminal, true);
    assert.equal(validation.code, "already_followed");
  } finally { loaded.cleanup(); }
});

test("INT4.3B SFS eligible prepare validation returns exact fanCurrentFence", async () => {
  const db = validationDb({ followed: false, price: 0 });
  const loaded = loadSfs(db);
  try {
    const validation = await loaded.service.validateSfsDelivery({
      db,
      delivery: {
        id: "delivery-1", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "sfs", actionType: "SFS_FOLLOW_TARGET",
        generation: 3, targetId: "fan-1", fanId: "fan-1", payload: { candidateId: "candidate-1" }, notBefore: null,
      },
      control: { effective: { sfsEnabled: true }, modules: { sfs: { settings: { freeTargetsOnly: true } } } },
      now,
    });
    assert.equal(validation.ok, true);
    assert.deepEqual(Object.keys(validation.fanCurrentFence.versions).sort(), ["creatorFollowsFan", "subscribePriceCents"]);
  } finally { loaded.cleanup(); }
});

test("INT4.3B already-followed SKIPPED heals workflow state without claiming usedForever", async () => {
  const updates = [];
  const db = { sfsTargetCandidate: { async updateMany(input) { updates.push(input); return { count: 1 }; } } };
  const loaded = loadSfs(db);
  try {
    await loaded.service.finalizeSfsTerminal({
      db,
      delivery: { id: "delivery-1", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "sfs", actionType: "SFS_FOLLOW_TARGET", payload: { candidateId: "candidate-1" } },
      status: "SKIPPED",
      failureCode: "already_followed",
      now,
    });
    const data = updates[0].data;
    assert.equal(data.creatorFollowing, true);
    assert.equal(data.state, "SKIPPED");
    assert.equal(data.phase, "DONE");
    assert.equal(data.eligibilityReason, "already_following");
    assert.equal(data.usedForever, false);
  } finally { loaded.cleanup(); }
});

test("INT4.3B SFS planner/read model use canonical current and bounded refresh outside creator lock", () => {
  const sfs = fs.readFileSync(path.join(__dirname, "sfs-service.js"), "utf8");
  const planner = sfs.slice(sfs.indexOf("async function planSfsTargets"), sfs.indexOf("async function scheduleTargetScan"));
  assert.match(planner, /readFanCurrentMap\(tx/);
  assert.match(planner, /evaluateSfsFollowCurrent\(candidate, current/);
  assert.match(planner, /refreshFanIds: \[\.\.\.refreshFanIds\]\.slice\(0, 500\)/);
  const lockEnd = planner.indexOf("});\n  if (!result?.refreshFanIds?.length)");
  const refreshAt = planner.indexOf("scheduleSfsCurrentRefresh", lockEnd);
  assert.ok(lockEnd >= 0 && refreshAt > lockEnd, "point refresh must be scheduled after the creator planning transaction releases");

  const list = sfs.slice(sfs.indexOf("async function listSfs"), sfs.indexOf("async function setSfsCandidateState"));
  assert.match(list, /readFanCurrentMap\(db/);
  assert.match(list, /creatorFollowing: rel\?\.creatorFollowsFan \?\? null/);
  assert.match(list, /subscribePriceCents: rel\?\.subscribePriceCents \?\? null/);
  assert.match(list, /currentEligibility: decision\.code/);
});

test("INT4.3B SFS exact field fence and refresh are wired through claim/validate/prepare/retry", () => {
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  const prepare = source.slice(source.indexOf("async function prepareWriteActionDelivery"), source.indexOf("async function projectKnownRelationshipOutcome"));
  const sfsValidationAt = prepare.indexOf("validateSfsDelivery");
  const fenceAssignAt = prepare.indexOf("fanCurrentFence = validation.fanCurrentFence", sfsValidationAt);
  const fenceAssertAt = prepare.indexOf("assertFanCurrentFieldFence", sfsValidationAt);
  const committingAt = prepare.indexOf('status: "COMMITTING"', sfsValidationAt);
  assert.ok(sfsValidationAt >= 0 && fenceAssignAt > sfsValidationAt && fenceAssertAt > fenceAssignAt && committingAt > fenceAssertAt);
  assert.match(source, /scheduleValidationFanRefresh\(candidate, validation, "claim"\)/);
  assert.match(source, /scheduleValidationFanRefresh\(delivery, validation, "validate"\)/);
  assert.match(source, /scheduleValidationFanRefresh\(delivery, validation, "retry"\)/);
  assert.match(prepare, /validationActionError\(delivery, validation, "SFS_VALIDATION_FAILED"/);
  assert.match(prepare, /validation\.code === "already_followed"[\s\S]*error\.sfsTerminal/);
  assert.match(prepare, /applySfsValidationTransition\(error\.sfsTerminal\.delivery/);
});
