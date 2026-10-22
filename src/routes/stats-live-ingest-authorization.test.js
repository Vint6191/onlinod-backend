"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { withRealtimeIngestGenerationFence } = require("../services/realtime-ingest-generation-fence-service");

function fixture({ commitEpoch = 7, commitBinding = true, source = false } = {}) {
  const now = new Date("2026-10-17T22:00:00.000Z");
  const calls = [];
  const member = { id: "member-a", userId: "user-a", agencyId: "agency-a", accessEpoch: 7, role: "CHATTER", assignedCreators: ["creator-a"] };
  const creator = { id: "creator-a", agencyId: "agency-a", status: "READY" };
  const checkBinding = (where) => {
    assert.equal(where.deviceId, "device-a");
    assert.equal(where.creatorId, "creator-a");
    assert.equal(where.agencyId, "agency-a");
    assert.equal(where.realtimeReady, true);
    assert.equal(where.accessEpoch, 7);
  };
  const device = { findFirst: async ({ where }) => {
    assert.equal(where.id, "device-a"); assert.equal(where.userId, "user-a"); assert.equal(where.agencyId, "agency-a");
    return { id: "device-a" };
  } };
  const tx = {
    async $queryRawUnsafe(sql) {
      if (sql.includes("clock_timestamp")) return [{ authorityNow: now }];
      assert.match(sql, /FROM "AgencyMember"[\s\S]*FOR SHARE/);
      calls.push("member-fence");
      return [{ ...member, accessEpoch: commitEpoch }];
    },
    creatorAccount: { findFirst: async () => creator },
    workerDevice: device,
    deviceCreatorBinding: { findFirst: async ({ where }) => {
      checkBinding(where); calls.push("binding-fence"); return commitBinding ? { id: "binding-a" } : null;
    } },
  };
  const db = {
    creatorAccount: { findFirst: async () => creator },
    workerDevice: device,
    deviceCreatorBinding: { findFirst: async ({ where }) => { checkBinding(where); calls.push("binding-admission"); return { id: "binding-a" }; } },
    $queryRawUnsafe: async () => [{ authorityNow: now }],
    async $transaction(work) {
      calls.push("begin");
      try { const result = await work(tx); calls.push("commit"); return result; }
      catch (error) { calls.push("rollback"); throw error; }
    },
  };
  const write = (kind) => async ({ db: supplied }) => {
    assert.equal(supplied, tx, `${kind} must join the fenced transaction`);
    assert.ok(calls.includes("binding-fence"));
    calls.push(kind); return { inserted: 1 };
  };
  const overrides = {
    "../prisma": db,
    "../middleware/auth": { requireAuthDevice: (req, id) => { assert.equal(id, req.auth.deviceId); return id; } },
    "../middleware/automation-permissions": { requireCreatorAccess: async () => creator },
    "../services/team-access-control": { resolveEffectivePermissions: async () => ({}) },
    "../services/notification-facts-service": {
      normalizeEvent: () => ({ sourceType: "tips", occurredAt: now }), ingestNotificationFacts: write("facts"),
    },
    "../services/notification-source-ledger-service": {
      normalizeObservation: () => ({ occurredAt: now }), ingestNotificationSourcePage: write("source"),
    },
    "../services/live-earnings-projection-service": { ingestLive: write("earnings") },
    "../services/notification-sync-state-service": { recordNotificationSocketEvent: write("socket") },
    "../services/creator-live-sync-service": { acceptDelivery: async ({ db: supplied, ingest }) => {
      assert.equal(supplied, tx); calls.push("delivery"); return { results: await ingest() };
    } },
    "../services/realtime-ingest-generation-fence-service": { withRealtimeIngestGenerationFence },
  };
  // Exercise the extracted processor with the same transaction-aware owner
  // doubles; the route must pass its fenced tx rather than opening a new root.
  const processorFile = path.resolve(__dirname, "../services/data-change-processor-service.js");
  const processorModule = { exports: {} };
  const processorRequire = createRequire(processorFile);
  vm.runInNewContext(fs.readFileSync(processorFile, "utf8"), {
    module: processorModule, exports: processorModule.exports,
    require(id) { return overrides[id.replace(/^\.\//, "../services/")] || processorRequire(id); },
  }, { filename: processorFile });
  overrides["../services/data-change-processor-service"] = processorModule.exports;
  const filename = path.resolve(__dirname, "stats.js");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, console: { error() {} },
    require(id) {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.startsWith("../services/") && !["../services/db-time-authority-service", "../services/capability-freshness-authority-service"].includes(id)) return {};
      return localRequire(id);
    },
  }, { filename });
  const handler = module.exports.stack.find(layer => layer.route?.path === "/creators/:creatorId/notifications/live").route.stack.at(-1).handle;
  const request = {
    auth: { agencyId: "agency-a", userId: "user-a", deviceId: "device-a", membership: member },
    params: { creatorId: "creator-a" },
    body: { deviceId: "device-a", batchId: "live-batch-one", observedAt: now.toISOString(), events: source
      ? [{ normalizerVersion: "notification-source-v2", notificationObservation: { category: "tips", disposition: "FACT" }, notificationFact: {} }]
      : [{ eventType: "tip" }],
      delivery: { version: 1, sessionId: "delivery-session-one", entries: [{ seq: 1, capturedAt: now.toISOString() }] },
    },
  };
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  return { calls, response, run: () => handler(request, response) };
}

test("both live notification formats commit facts, money, socket progress and receipt under one current member fence", async () => {
  for (const source of [false, true]) {
    const f = fixture({ source }); await f.run();
    assert.equal(f.response.statusCode, 200);
    assert.deepEqual(f.calls, ["binding-admission", "begin", "member-fence", "binding-fence", "delivery", source ? "source" : "facts", "earnings", "socket", "commit"]);
  }
});

test("access revocation between HTTP admission and commit rejects every live writer", async () => {
  const f = fixture({ commitEpoch: 8 }); await f.run();
  assert.equal(f.response.statusCode, 409);
  assert.equal(f.response.body.code, "EXECUTION_ACCESS_EPOCH_STALE");
  assert.deepEqual(f.calls, ["binding-admission", "begin", "member-fence", "rollback"]);
});

test("realtime binding loss after admission cannot write facts or acknowledge delivery", async () => {
  const f = fixture({ commitBinding: false }); await f.run();
  assert.equal(f.response.statusCode, 409);
  assert.equal(f.response.body.code, "LIVE_NOTIFICATION_REALTIME_UNAVAILABLE");
  assert.deepEqual(f.calls, ["binding-admission", "begin", "member-fence", "binding-fence", "rollback"]);
});
