"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const busy = () => Object.assign(new Error("creator busy"), { code: "P2010", meta: { code: "55P03", message: "ERROR: PHASE2_CREATOR_LIFECYCLE_BUSY table=OfProviderRequestGateWaiter" } });
const input = { userId: "u", agencyId: "a", creatorId: "c", deviceId: "d", member: { role: "OWNER", assignedCreators: "all" }, capability: "read", priority: "background", operation: "earnings", timeoutMs: 5000 };
function fixture({ register, grant, access } = {}) {
  const calls = { register: [], grants: 0, cancelled: 0, accesses: 0 };
  const db = {
    $transaction() {}, $queryRawUnsafe: async () => [{ authorityNow: new Date() }],
    workerDevice: { findFirst: async () => ({ id: "d", userId: "u", agencyId: "a", lastSeenAt: new Date() }) },
    creatorAccount: { findFirst: async () => { calls.accesses++; if (access) await access(calls); return { id: "c", agencyId: "a", status: "READY" }; } },
    deviceCreatorBinding: { findFirst: async () => ({ id: "binding" }) },
  };
  require("../../scripts/test-support/billing-execution-fixture").installTrialBillingRows(db);
  const override = (name, exports) => { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  override("../prisma", db);
  override("./provider-request-credit-authority-service", {
    PROVIDER_GATE_PERMIT_TTL_MS: 15000, PROVIDER_GATE_WAITER_LEASE_MS: 60000, PROVIDER_GATE_WAITER_HEARTBEAT_MS: 20000,
    PROVIDER_GATE_FAIRNESS_GENERATION: "fixture", readProviderGateFairnessAuthority: async () => ({ activationState: "ACTIVE" }),
    registerDurableProviderWaiter: async args => { calls.register.push(args.waiterId); if (register) await register(calls); },
    heartbeatDurableProviderWaiters: async () => ({}), cancelDurableProviderWaiter: async () => ({}),
    tryAcquireDurableProviderPermit: async () => {
      calls.grants++; if (grant) await grant(calls);
      return { granted: true, intervalMs: 700, grantedAt: new Date(), expiresAt: new Date(Date.now() + 15000) };
    },
    cancelDurableProviderPermit: async () => { calls.cancelled++; return {}; },
  });
  delete require.cache[require.resolve("./of-request-gate-service")];
  const service = require("./of-request-gate-service");
  return { calls, service };
}

test("creator NOWAIT contention retries the rolled-back admission with the same waiter and original timeout", async () => {
  const f = fixture({ register: async calls => { if (calls.register.length === 1) throw busy(); } });
  try {
    const permit = await f.service.acquireOfRequestSlot(input);
    assert.equal(f.calls.register.length, 2); assert.equal(new Set(f.calls.register).size, 1);
    assert.equal(f.calls.grants, 1); assert.ok(permit.preGrantElapsedMs >= 450);
    assert.equal(Date.parse(permit.expiresAt) - Date.parse(permit.grantedAt), 15000);
  } finally { await f.service.stopOfRequestGate(); }
});

test("cancel during creator contention stops retry; unrelated SQL errors still fail", async () => {
  const controller = new AbortController();
  const f = fixture({ register: async () => { controller.abort(); throw busy(); } });
  try {
    await assert.rejects(f.service.acquireOfRequestSlot({ ...input, signal: controller.signal }), error => error.code === "OF_GATE_CANCELLED");
    assert.equal(f.calls.grants, 0);
  } finally { await f.service.stopOfRequestGate(); }
  const other = fixture({ register: async () => { throw Object.assign(new Error("another lock"), { code: "55P03" }); } });
  try {
    await assert.rejects(other.service.acquireOfRequestSlot(input), /another lock/);
    assert.equal(other.calls.register.length, 1);
  } finally { await other.service.stopOfRequestGate(); }
});

test("post-grant authority failure cancels the grant and is never treated as pre-grant retry", async () => {
  const f = fixture({ access: async calls => { if (calls.grants > 0) throw busy(); } });
  try {
    await assert.rejects(f.service.acquireOfRequestSlot(input), error => error.meta?.code === "55P03");
    assert.equal(f.calls.grants, 1); assert.equal(f.calls.cancelled, 1); assert.equal(f.calls.register.length, 1);
  } finally { await f.service.stopOfRequestGate(); }
});
