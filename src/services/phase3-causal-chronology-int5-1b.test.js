"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

function loadBump(captures) {
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
        stableFingerprint: (value) => require("node:crypto").createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32),
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
      if (request === "./db-time-authority-service") return {
        dbAuthorityNow: async () => new Date("2026-09-16T18:30:00.000Z"),
      };
      if (request === "./fan-data-authority-service") return {
        projectFanObservationBatch: async (_db, args) => {
          captures.authority.push(args);
          return { ok: true, projected: args.items.length };
        },
        scheduleFanDataPointRefresh: async (args) => {
          captures.refresh.push(args);
          return { created: true, jobId: `refresh-${captures.refresh.length}` };
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

test("INT5.1B delayed subscription event is trigger evidence plus causal-barrier refresh, never direct FanData relationship truth", async () => {
  const captures = { authority: [], refresh: [], bumpState: [] };
  const { processRuntimeEvents } = loadBump(captures);
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
      providerEventId: "notification-77",
      // Intentionally old: transport arrives much later. This must not be restamped
      // as new canonical relationship truth by server receipt order.
      createdAt: "2026-09-16T17:00:00.000Z",
      relationship: {
        fanSubscribesToCreator: true,
        fanSubscriptionActive: true,
        fanSubscriptionType: "paid",
      },
    }],
  });

  assert.equal(result.errors.length, 0);
  assert.equal(captures.authority.length, 0);
  assert.equal(captures.refresh.length, 1);
  assert.deepEqual(captures.refresh[0].onlyFansUserIds, ["fan-1"]);
  assert.equal(captures.refresh[0].reason, "bump_runtime_subscription_event_reconcile");
  assert.equal(captures.refresh[0].now.toISOString(), "2026-09-16T18:30:00.000Z");
  assert.match(captures.refresh[0].params.causalBarrierKey, /^runtime-subscription:[a-f0-9]{32}$/);
  assert.deepEqual(captures.refresh[0].params.refreshFields, [
    "fanSubscribesToCreator", "fanSubscriptionActive", "fanSubscriptionType", "canReceiveChatMessage",
  ]);
  assert.equal(result.subscriptionReconcile.fanIds[0], "fan-1");

  assert.equal(captures.bumpState.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(captures.bumpState[0].create, "lastOnlineAt"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(captures.bumpState[0].update, "lastOnlineAt"), false);
  assert.equal(captures.bumpState[0].create.metadata.providerEventId, "notification-77");
  assert.equal(captures.bumpState[0].create.metadata.providerOccurredAt, "2026-09-16T17:00:00.000Z");
});

test("INT5.1B future-skewed presence cannot pin private lastOnlineAt beyond PostgreSQL authority time", async () => {
  const captures = { authority: [], refresh: [], bumpState: [] };
  const { processRuntimeEvents } = loadBump(captures);
  const result = await processRuntimeEvents({
    agencyId: "agency-1",
    creatorId: "creator-1",
    sourceDeviceId: "device-1",
    db: fakeDb(captures),
    events: [{
      type: "presence_online",
      source: "ws_frame",
      fanIds: ["fan-future"],
      createdAt: "2099-01-01T00:00:00.000Z",
    }],
  });

  assert.equal(result.errors.length, 0);
  assert.equal(captures.bumpState.length, 1);
  assert.equal(captures.bumpState[0].create.lastOnlineAt.toISOString(), "2026-09-16T18:30:00.000Z");
  assert.equal(captures.authority.length, 1);
  assert.deepEqual(captures.authority[0].allowedSources, ["PRESENCE_HINT"]);
  assert.equal(captures.authority[0].observedAtPolicy, "SERVER_RECEIPT");
  assert.equal(captures.authority[0].receivedAt.toISOString(), "2026-09-16T18:30:00.000Z");
});

test("INT5.1B source contract has no direct LIVE_NOTIFICATION relationship projection in Bump runtime", () => {
  const source = fs.readFileSync(path.join(__dirname, "bump-service.js"), "utf8");
  assert.match(source, /allowedSources:\s*\["PRESENCE_HINT"\]/);
  assert.doesNotMatch(source, /allowedSources:\s*\[[^\]]*"LIVE_NOTIFICATION"/);
  assert.match(source, /bump_runtime_subscription_event_reconcile/);
  assert.match(source, /causalBarrierKey:\s*`runtime-subscription:\$\{barrier\}`/);
  assert.match(source, /updateLastOnlineAt:\s*false/);
  assert.match(source, /fanObservation:\s*null/);
});
