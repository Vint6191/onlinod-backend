"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { taskToTemplate, templateTiming, eligibility } = require("./bump-rules");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "../prisma" && parent?.filename?.endsWith("automation-control-service.js")) return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { normalizeBumpSettings, DEFAULT_BUMP_SETTINGS } = require("./automation-control-service");
Module._load = originalLoad;

function candidate(overrides = {}) {
  return {
    fanId: "fan-1",
    dialogId: "dialog-1",
    canReceiveChatMessage: true,
    observedAt: new Date("2026-07-15T10:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

test("Bump template snapshot is immutable-friendly and normalizes Alpha content", () => {
  const task = {
    id: "server-template-1",
    clientId: "template-1",
    title: "Warm intro",
    config: {
      messageText: "Hi <fan> & welcome\nSecond line",
      priceCents: 1299,
      media: [{ id: 21 }, { mediaId: "21" }, 34, "bad"],
      lockedText: true,
    },
    triggers: { fanOnline: true },
    rules: { cooldownHours: 24 },
  };
  const first = taskToTemplate(task);
  const second = taskToTemplate(task);

  assert.equal(first.id, "template-1");
  assert.equal(first.price, 12.99);
  assert.deepEqual(first.mediaFiles, [21, 34]);
  assert.equal(first.text, "<p>Hi &lt;fan&gt; &amp; welcome</p><p>Second line</p>");
  assert.equal(first.lockedText, true);
  assert.equal(first.fingerprint, second.fingerprint);
});

test("Bump defaults reject old Alpha 3-10 second pacing", () => {
  const settings = normalizeBumpSettings({ minimumIntervalMs: 3000, maximumIntervalMs: 10000 });
  assert.equal(settings.minimumIntervalMs, 15000);
  assert.equal(settings.maximumIntervalMs, 30000);
  assert.equal(settings.hiddenRetryIntervalMs, 3 * 60 * 60_000);
  assert.equal(settings.verifyRecentMessagesLimit, 20);
});

test("Hidden Online timing keeps one-hour delete and shared cooldowns", () => {
  const timing = templateTiming({ rules: {} }, DEFAULT_BUMP_SETTINGS, "hidden_online");
  assert.equal(timing.deleteAfterNoReplyMs, 60 * 60_000);
  assert.equal(timing.afterReplyCooldownMs, 24 * 60 * 60_000);
  assert.equal(timing.afterSendCooldownMs, 3 * 60 * 60_000);
  assert.equal(timing.sameTemplateCooldownMs, 24 * 60 * 60_000);
});

test("Bump candidate eligibility is server-side and explicit", () => {
  const now = new Date("2026-07-15T10:01:00.000Z");
  const settings = { ...DEFAULT_BUMP_SETTINGS, onlineObservationTtlMs: 2 * 60_000 };

  assert.equal(eligibility({ candidate: candidate(), fanState: { blocked: true }, settings, source: "manual", now }), "blocked");
  assert.equal(eligibility({ candidate: candidate(), fanState: { ignored: true }, settings, source: "manual", now }), "ignored");
  assert.equal(eligibility({ candidate: candidate(), fanState: { pendingMessageId: "m1" }, settings, source: "manual", now }), "pending_reply");
  assert.equal(eligibility({ candidate: candidate(), fanState: { cooldownUntil: new Date("2026-07-15T11:00:00.000Z") }, settings, source: "manual", now }), "fan_cooldown");
  assert.equal(eligibility({ candidate: candidate({ observedAt: new Date("2026-07-15T09:50:00.000Z") }), fanState: null, settings, source: "online", now }), "stale_candidate");
  assert.equal(eligibility({ candidate: candidate({ metadata: { lastSeenIsNull: false } }), fanState: null, settings, source: "hidden_online", now }), "stale_candidate");
  assert.equal(eligibility({ candidate: candidate({ metadata: { lastSeenIsNull: true } }), fanState: null, settings, source: "hidden_online", now }), null);
});

test("Bump planning diagnostics aggregate explicit skip codes", () => {
  const previousLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "../prisma" && parent?.filename?.endsWith("bump-service.js")) return {};
    if (request === "./automation-pacing-service" && parent?.filename?.endsWith("bump-service.js")) {
      return { nextAutomationWriteSlot: async () => new Date() };
    }
    if (request === "./automation-control-service" && parent?.filename?.endsWith("bump-service.js")) {
      return {
        BUMPS_MODULE_KEY: "bumps",
        assertAutomationEnabled: async () => ({}),
        getAutomationControlSnapshot: async () => ({}),
        requireCreator: async () => ({}),
      };
    }
    return previousLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("./bump-service")];
  const { summarizePlanningSkips } = require("./bump-service");
  Module._load = previousLoad;

  assert.deepEqual(
    summarizePlanningSkips([
      { ok: true, skipped: [{ code: "cooldown" }, { code: "cooldown" }, { code: "no_template" }] },
      { ok: false, code: "snapshot_not_ready", skipped: [] },
    ]),
    { cooldown: 2, no_template: 1, snapshot_not_ready: 1 },
  );
});
