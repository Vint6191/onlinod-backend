"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const limits = require("./provider-gate-resource-limits");

function fixture(resourceLimits = limits) {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const db = {
    $transaction() {}, $queryRawUnsafe: async () => [{ authorityNow: new Date() }],
    workerDevice: { findFirst: async ({ where }) => ({ id: where.id, agencyId: where.agencyId, lastSeenAt: new Date() }) },
    deviceCreatorBinding: { findFirst: async () => ({ id: "binding" }) },
  };
  const credit = {
    PROVIDER_GATE_PERMIT_TTL_MS: 15000, PROVIDER_GATE_WAITER_LEASE_MS: 20000, PROVIDER_GATE_WAITER_HEARTBEAT_MS: 5000,
    PROVIDER_GATE_FAIRNESS_GENERATION: "creator_provider_gate_v1",
    readProviderGateFairnessAuthority: async () => { await hold; return { activationState: "ACTIVE" }; },
    registerDurableProviderWaiter: async () => ({}), heartbeatDurableProviderWaiters: async () => ({}),
    cancelDurableProviderWaiter: async () => ({}), cancelDurableProviderPermit: async () => ({}),
  };
  const filename = require.resolve("./of-request-gate-service");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const overrides = {
    "../prisma": db,
    "./provider-gate-resource-limits": resourceLimits,
    "./provider-request-credit-authority-service": credit,
    "./billing-execution-access-service": { assertProviderBillingAccess: async () => ({ allowed: true }) },
    "../middleware/automation-permissions": {
      requireCreatorAccess: async ({ creatorId, agencyId }) => ({ id: creatorId, agencyId, status: "READY" }),
      canAccessCreator: () => true,
    },
  };
  const context = vm.createContext({
    module, exports: module.exports, process, performance, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    require: id => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id),
  });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  const service = module.exports;
  const pending = [];
  function queue(creatorId, deviceId, agencyId = "agency-a") {
    const controller = new AbortController();
    const promise = service.acquireOfRequestSlot({ agencyId, userId: "user-a", deviceId, creatorId,
      member: { id: "member-a" }, capability: "read", priority: "normal", operation: "test", signal: controller.signal });
    const settled = promise.then(value => ({ value }), error => ({ error }));
    pending.push(settled);
    return { controller, settled };
  }
  return { service, queue, allocatedQueueEntries: () => vm.runInContext(
    "[...coordinators.values()].reduce((sum, coordinator) => sum + [...coordinator.buckets.values()].reduce((count, bucket) => count + [...bucket.byCreator.values()].reduce((total, queue) => total + queue.length, 0), 0), 0)", context,
  ), async close() {
    const stopped = service.stopOfRequestGate(); release(); await stopped; await Promise.all(pending);
  } };
}

test("creator and device queue caps isolate overload; cancellation returns admission capacity", async () => {
  const f = fixture({ ...limits, PROVIDER_GATE_MAX_PENDING: 10, PROVIDER_GATE_MAX_PENDING_PER_DEVICE: 3, PROVIDER_GATE_MAX_PENDING_PER_CREATOR: 2 });
  try {
    const a = f.queue("creator-a", "device-a");
    f.queue("creator-a", "device-a");
    await new Promise(resolve => setImmediate(resolve));
    const creatorFull = await f.queue("creator-a", "device-b").settled;
    assert.equal(creatorFull.error.code, "OF_GATE_QUEUE_CAPACITY");
    f.queue("creator-b", "device-a");
    await new Promise(resolve => setImmediate(resolve));
    const deviceFull = await f.queue("creator-c", "device-a").settled;
    assert.equal(deviceFull.error.code, "OF_GATE_QUEUE_CAPACITY");
    assert.equal(deviceFull.error.status, 503); assert.equal(deviceFull.error.retryable, true);
    f.queue("creator-c", "device-b");
    await new Promise(resolve => setImmediate(resolve));
    a.controller.abort(); await a.settled;
    const replacement = f.queue("creator-a", "device-a");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.getOfRequestGateSnapshot().queued, 2);
    replacement.controller.abort();
    assert.equal((await replacement.settled).error.code, "OF_GATE_CANCELLED");
  } finally { await f.close(); }
});

test("repeated cancellation frees physical queue storage while a creator pump is blocked", async () => {
  const f = fixture({ ...limits, PROVIDER_GATE_MAX_PENDING_PER_CREATOR: 2 });
  try {
    f.queue("creator-a", "device-a");
    await new Promise(resolve => setImmediate(resolve));
    for (let index = 0; index < 100; index += 1) {
      const queued = f.queue("creator-a", "device-a");
      await new Promise(resolve => setImmediate(resolve));
      queued.controller.abort();
      assert.equal((await queued.settled).error.code, "OF_GATE_CANCELLED");
    }
    assert.equal(f.allocatedQueueEntries(), 0);
  } finally { await f.close(); }
});

test("instance admission is finite across many independent creator/device scopes", async () => {
  const f = fixture({ ...limits, PROVIDER_GATE_MAX_PENDING: 4 });
  try {
    for (let index = 0; index < 4; index += 1) f.queue(`creator-${index}`, `device-${index}`);
    await new Promise(resolve => setImmediate(resolve));
    const full = await f.queue("another-creator", "another-device", "another-agency").settled;
    assert.equal(full.error.code, "OF_GATE_QUEUE_CAPACITY");
    assert.equal(f.service.getOfRequestGateSnapshot().activeCreators, 4);
  } finally { await f.close(); }
});

test("production queue admission supports 4000 independent creators and drains cleanly on shutdown", async () => {
  const f = fixture();
  for (let index = 0; index < 4000; index += 1) f.queue(`creator-${index}`, `device-${index % 100}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.getOfRequestGateSnapshot().activeCreators, 4000);
  await f.close();
  assert.equal(f.service.getOfRequestGateSnapshot().activeCreators, 0);
});
