"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

function loadBumpWithStubs(captures) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (parent?.filename?.endsWith("bump-service.js")) {
      if (request === "../prisma") return {};
      if (request === "./automation-delivery-adoption-guard") return { assertAutomationDeliveryAdoption: () => {} };
      if (request === "./db-transaction-service") return { withDbAdvisoryXactLock: async ({ work }) => work({}) };
      if (request === "./automation-write-commit-fence-service") return { runWithAutomationWriteCommitFence: async ({ work }) => work({}) };
      if (request === "./automation-pacing-service") return { nextAutomationWriteSlot: async () => new Date() };
      if (request === "./custom-content-delivery-service") return { classifyProgrammaticCustomMediaProvenance: async () => ({ ok: true, customMediaIds: [] }) };
      if (request === "./bump-rules") return {
        stableFingerprint: () => "fingerprint",
        taskToTemplate: (x) => x,
        triggerEnabled: () => true,
        templateTiming: () => ({}),
        eligibility: () => null,
      };
      if (request === "./automation-control-service") return {
        BUMPS_MODULE_KEY: "bumps",
        assertAutomationEnabled: async () => ({ modules: { bumps: { settings: {} } }, workspace: { settings: {} } }),
        getAutomationControlSnapshot: async () => ({
          effective: { bumpsEnabled: false },
          modules: { bumps: { settings: { automatic: false, onlineEnabled: false, subscriptionEventsEnabled: false } } },
        }),
        requireCreator: async () => ({}),
      };
      if (request === "./fan-current-consumer-service") return {
        readFanCurrentMap: async () => new Map(),
        validateBumpCurrentRelationship: () => ({ ok: false, code: "fan_current_unknown" }),
      };
      if (request === "./fan-data-authority-service") return {
        projectFanObservationBatch: async (_db, args) => {
          captures.authority.push(args);
          return { ok: true, projected: args.items.length };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const bumpPath = require.resolve("./bump-service");
  delete require.cache[bumpPath];
  const mod = require("./bump-service");
  Module._load = originalLoad;
  return mod;
}

function fakeDb(captures) {
  return {
    automationBumpFanState: {
      async findMany() { return []; },
      async upsert(args) { captures.bumpState.push(args); return args.create || args.update; },
    },
  };
}

test("Phase3 subscription runtime evidence heals canonical relationship without persisting private relationship metadata", async () => {
  const captures = { authority: [], bumpState: [] };
  const { processRuntimeEvents } = loadBumpWithStubs(captures);
  const result = await processRuntimeEvents({
    agencyId: "agency-1",
    creatorId: "creator-1",
    sourceDeviceId: "device-1",
    db: fakeDb(captures),
    events: [{
      type: "subscription_created",
      source: "ws_frame",
      fanId: "fan-1",
      dialogId: "fan-1",
      createdAt: "2026-09-16T10:00:00.000Z",
      relationship: {
        fanSubscribesToCreator: true,
        fanSubscriptionActive: true,
        fanSubscriptionType: "paid",
      },
    }],
  });
  assert.equal(result.errors.length, 0);
  assert.equal(captures.authority.length, 1);
  assert.equal(captures.authority[0].sourceDeviceId, "device-1");
  assert.deepEqual(captures.authority[0].items, [{
    onlyFansUserId: "fan-1",
    relationship: {
      fanSubscribesToCreator: true,
      fanSubscriptionActive: true,
      fanSubscriptionType: "paid",
      observedAt: new Date("2026-09-16T10:00:00.000Z"),
      source: "LIVE_NOTIFICATION",
    },
  }]);
  assert.equal(captures.bumpState.length, 1);
  const metadata = captures.bumpState[0].create.metadata;
  assert.equal(metadata.source, "ws_frame");
  assert.equal(metadata.dialogId, "fan-1");
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, "relationship"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, "subscriptionType"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, "isActive"), false);
});

test("Phase3 online runtime evidence becomes activity-only FanData observation", async () => {
  const captures = { authority: [], bumpState: [] };
  const { processRuntimeEvents } = loadBumpWithStubs(captures);
  const result = await processRuntimeEvents({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: fakeDb(captures),
    events: [{
      type: "presence_online",
      source: "ws",
      fanIds: ["fan-2"],
      createdAt: "2026-09-16T10:05:00.000Z",
    }],
  });
  assert.equal(result.errors.length, 0);
  assert.equal(captures.authority.length, 1);
  assert.deepEqual(captures.authority[0].items, [{
    onlyFansUserId: "fan-2",
    identity: {
      observedAt: new Date("2026-09-16T10:05:00.000Z"),
      activityObservedAt: new Date("2026-09-16T10:05:00.000Z"),
      source: "PRESENCE_HINT",
    },
  }]);
});

test("Phase3 Bump and Hidden Online current-looking flats are no longer independent current authority", () => {
  const root = __dirname;
  const bump = fs.readFileSync(path.join(root, "bump-service.js"), "utf8");
  const current = fs.readFileSync(path.join(root, "fan-current-consumer-service.js"), "utf8");
  const subscriber = fs.readFileSync(path.join(root, "subscriber-directory-service.js"), "utf8");

  assert.match(bump, /BUMP_PRIVATE_RELATIONSHIP_KEYS/);
  assert.match(bump, /subscriptionType:\s*null,[\s\S]*isActive:\s*null,[\s\S]*canReceiveChatMessage:\s*null/);
  assert.doesNotMatch(bump, /subscriptionType:\s*clean\(fan\.subscriptionType\s*\|\|\s*metadata\.subscriptionType/);
  assert.match(current, /username:\s*identity\.username\s*\?\?\s*candidate\.username/);
  assert.match(current, /subscriptionType:\s*rel\.fanSubscriptionType/);

  assert.match(subscriber, /canReceiveChatMessage:\s*current\?\.relationship\?\.canReceiveChatMessage\s*\?\?\s*null/);
  assert.match(subscriber, /isActive:\s*current\?\.relationship\?\.fanSubscriptionActive\s*\?\?\s*null/);
  assert.match(subscriber, /subscribedOn:\s*current\?\.relationship\?\.fanSubscribesToCreator\s*\?\?\s*null/);
  assert.match(subscriber, /subscribedBy:\s*current\?\.relationship\?\.creatorFollowsFan\s*\?\?\s*null/);
  assert.match(subscriber, /subscriptionType:\s*current\?\.relationship\?\.fanSubscriptionType\s*\?\?\s*null/);
});
