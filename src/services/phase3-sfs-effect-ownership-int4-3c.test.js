"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = { id: prismaModulePath, filename: prismaModulePath, loaded: true, exports: {} };

const { normalizeSfsSettings } = require("./sfs-rules");

function cacheModule(request, exports) {
  const id = require.resolve(request);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return id;
}
function restore(id) { delete require.cache[id]; }
function fresh(request) { const id = require.resolve(request); delete require.cache[id]; return require(request); }

function loadSfs(db, { scanJob = { id: "scan-1" } } = {}) {
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
    createPlannedJobIfAbsent: async () => ({ job: scanJob, created: true }),
  }));
  ids.push(cacheModule("./automation-pacing-service", { nextAutomationWriteSlot: async () => new Date() }));
  const service = fresh("./sfs-service");
  return { service, cleanup() { restore(require.resolve("./sfs-service")); for (const id of ids) restore(id); } };
}

function baseCandidate(overrides = {}) {
  return {
    id: "candidate-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    targetUserId: "fan-1",
    username: "alice",
    generation: 3,
    state: "FOLLOWING",
    phase: "FOLLOW",
    usedForever: false,
    completedAt: null,
    safetyUnfollowDeliveryId: null,
    metadata: {},
    ...overrides,
  };
}

function followDelivery(overrides = {}) {
  return {
    id: "follow-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    moduleKey: "sfs",
    actionType: "SFS_FOLLOW_TARGET",
    targetId: "fan-1",
    fanId: "fan-1",
    generation: 3,
    writeCommitAt: new Date("2026-09-16T10:00:00.000Z"),
    payload: { candidateId: "candidate-1", originalFollowing: false },
    ...overrides,
  };
}

function cleanupDelivery(overrides = {}) {
  return {
    id: "cleanup-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    moduleKey: "sfs",
    actionType: "SFS_UNFOLLOW_TARGET",
    targetId: "fan-1",
    fanId: "fan-1",
    generation: 3,
    payload: { candidateId: "candidate-1", safetyCleanup: true },
    ...overrides,
  };
}

test("INT4.3C ambiguous/pre-existing SFS follow never starts cleanup ownership", async () => {
  for (const [outcomeCode, expectedOwnership] of [["followed_recovered", "AMBIGUOUS_UNOWNED"], ["already_followed", "PREEXISTING"]]) {
    const candidate = baseCandidate();
    const updates = [];
    const db = {
      sfsTargetCandidate: {
        async findUnique() { return { ...candidate }; },
        async update({ data }) { updates.push(data); Object.assign(candidate, data); return { ...candidate }; },
      },
      automationDelivery: {
        async create() { throw new Error("unsafe cleanup creation"); },
      },
    };
    const loaded = loadSfs(db);
    try {
      const result = await loaded.service.finalizeSfsSuccess({
        db,
        delivery: followDelivery(),
        outcomeCode,
        result: { recoveredAfterAmbiguousWrite: outcomeCode === "followed_recovered" },
        now: new Date("2026-09-16T10:05:00.000Z"),
      });
      assert.equal(result.usedForever, false);
      assert.equal(result.state, "SKIPPED");
      assert.equal(result.metadata.followEffectOwnership, expectedOwnership);
      assert.equal(result.metadata.cleanupAuthorized, false);
      assert.equal(updates.length, 1);
    } finally { loaded.cleanup(); }
  }
});

test("INT4.3C direct committed SFS follow creates cleanup with durable ownership proof", async () => {
  const candidate = baseCandidate();
  const cleanupCreates = [];
  const candidateUpdates = [];
  const db = {
    sfsTargetCandidate: {
      async findUnique() { return { ...candidate }; },
      async update({ data }) { candidateUpdates.push(data); Object.assign(candidate, data); return { ...candidate }; },
    },
    automationDelivery: {
      async create({ data }) {
        cleanupCreates.push(data);
        return { id: "cleanup-1", ...data };
      },
      async findUnique() { return null; },
    },
  };
  const loaded = loadSfs(db);
  try {
    const result = await loaded.service.finalizeSfsSuccess({
      db,
      delivery: followDelivery(),
      outcomeCode: "followed",
      result: { code: "followed" },
      now: new Date("2026-09-16T10:05:00.000Z"),
    });
    assert.equal(cleanupCreates.length, 1);
    assert.equal(cleanupCreates[0].payload.effectOwnership, "OWNED");
    assert.equal(cleanupCreates[0].payload.followDeliveryId, "follow-1");
    assert.equal(cleanupCreates[0].payload.followGeneration, 3);
    assert.equal(result.metadata.followEffectOwnership, "OWNED");
    assert.equal(result.metadata.followEffectDeliveryId, "follow-1");
    assert.equal(result.metadata.cleanupAuthorized, true);
    assert.equal(result.safetyUnfollowDeliveryId, "cleanup-1");
    assert.equal(result.usedForever, false, "oneTargetForever is consumed only after owned cleanup completes");
    assert.equal(candidateUpdates.length, 1);
  } finally { loaded.cleanup(); }
});

test("INT4.3C cleanup validation rejects ambiguous ownership and adopts only prior direct server-proven follow", async () => {
  const candidate = baseCandidate({ state: "UNFOLLOW_DUE", phase: "UNFOLLOW", safetyUnfollowDeliveryId: "cleanup-1" });
  let originalResultCode = "followed_recovered";
  const db = {
    sfsTargetCandidate: { async findFirst() { return { ...candidate }; } },
    automationDelivery: {
      async findFirst() {
        return { id: "follow-1", writeCommitAt: new Date("2026-09-16T10:00:00.000Z"), result: { code: originalResultCode } };
      },
    },
  };
  const loaded = loadSfs(db);
  try {
    const denied = await loaded.service.validateSfsDelivery({ db, delivery: cleanupDelivery(), control: null });
    assert.equal(denied.ok, false);
    assert.equal(denied.terminal, true);
    assert.equal(denied.code, "cleanup_effect_ownership_unproven");

    originalResultCode = "followed";
    const adopted = await loaded.service.validateSfsDelivery({ db, delivery: cleanupDelivery(), control: null });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.cleanupOwnership.kind, "ADOPTED_SERVER_PROOF");
    assert.equal(adopted.cleanupOwnership.followDeliveryId, "follow-1");
  } finally { loaded.cleanup(); }
});

test("INT4.3C completed cleanup marks usedForever only with ownership proof", async () => {
  const candidate = baseCandidate({
    state: "UNFOLLOW_DUE",
    phase: "UNFOLLOW",
    safetyUnfollowDeliveryId: "cleanup-1",
    metadata: { followEffectOwnership: "OWNED", followEffectDeliveryId: "follow-1", followEffectGeneration: 3 },
  });
  const db = {
    sfsTargetCandidate: {
      async findUnique() { return { ...candidate }; },
      async update({ data }) { Object.assign(candidate, data); return { ...candidate }; },
    },
    automationDelivery: { async findFirst() { return null; } },
  };
  const loaded = loadSfs(db);
  try {
    const completed = await loaded.service.finalizeSfsSuccess({
      db,
      delivery: cleanupDelivery({ payload: { candidateId: "candidate-1", safetyCleanup: true, effectOwnership: "OWNED", followDeliveryId: "follow-1", followGeneration: 3 } }),
      outcomeCode: "unfollowed",
      result: { code: "unfollowed" },
      now: new Date("2026-09-16T10:30:00.000Z"),
    });
    assert.equal(completed.state, "COMPLETED");
    assert.equal(completed.usedForever, true);
    assert.equal(completed.metadata.cleanupEffectOwnership, "OWNED");
  } finally { loaded.cleanup(); }
});

test("INT4.3C transient paid/comments-disabled skip is not forever and migration heals historical rows", () => {
  const service = fs.readFileSync(path.join(__dirname, "sfs-service.js"), "utf8");
  const planner = service.slice(service.indexOf("async function planSfsTargets"), service.indexOf("async function scheduleTargetScan"));
  const transientAt = planner.indexOf('["paid_target", "comments_disabled"].includes(reason)');
  assert.ok(transientAt >= 0);
  const transientBlock = planner.slice(transientAt, transientAt + 850);
  assert.match(transientBlock, /usedForever:\s*false/);
  assert.doesNotMatch(transientBlock, /usedForever:\s*true/);
  assert.match(transientBlock, /completedAt:\s*null/);

  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260916203000_phase3_sfs_consumption_semantics/migration.sql"), "utf8");
  assert.match(migration, /"usedForever" = false/);
  assert.match(migration, /"eligibilityReason" IN \('paid_target', 'comments_disabled'\)/);
});

test("INT4.3C backend does not convert ambiguous SFS readback into owned AUTOMATION_WRITE_RESULT", () => {
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /action === "SFS_FOLLOW_TARGET" && code !== "followed"\) return/);
  assert.match(source, /delivery\.actionType === "SFS_FOLLOW_TARGET"[\s\S]*terminalStatus = "SKIPPED"/);
});
