"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { heartbeatDurableProviderWaiters, PROVIDER_GATE_MAX_PENDING, PROVIDER_GATE_HEARTBEAT_BATCH_SIZE } = require("./provider-request-credit-authority-service");

function fixture({ failFirst = false } = {}) {
  const renewed = new Set(), batches = [], budgets = [];
  let active = 0, maxActive = 0;
  const db = {
    $queryRawUnsafe() {},
    async $transaction(work, options) {
      budgets.push(options); active += 1; maxActive = Math.max(maxActive, active);
      try {
        return await work({ async $queryRawUnsafe(sql, owner, serialized, ttl) {
          assert.equal(owner, "replica-a"); assert.equal(ttl, 20_000);
          assert.match(sql, /WHERE "ownerInstanceId" = \$1[\s\S]*"leaseUntil" > \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)/);
          const ids = JSON.parse(serialized); batches.push(ids);
          assert.ok(ids.length <= PROVIDER_GATE_HEARTBEAT_BATCH_SIZE);
          await new Promise(resolve => setImmediate(resolve));
          if (failFirst && ids[0] === "waiter-0") throw new Error("prefix SQL failed");
          ids.forEach(id => renewed.add(id)); return ids.map(waiterId => ({ waiterId }));
        } });
      } finally { active -= 1; }
    },
  };
  return { db, renewed, batches, budgets, maxActive: () => maxActive };
}

test("every admitted waiter beyond the old 5000 horizon is renewed in bounded transactions", async () => {
  const f = fixture();
  const ids = Array.from({ length: PROVIDER_GATE_MAX_PENDING }, (_, index) => `waiter-${index}`);
  const result = await heartbeatDurableProviderWaiters({ db: f.db, ownerInstanceId: "replica-a", waiterIds: ids });
  assert.equal(result.touched, ids.length);
  assert.equal(f.renewed.size, ids.length);
  assert.ok(f.renewed.has("waiter-5000")); assert.ok(f.renewed.has(ids.at(-1)));
  assert.equal(f.batches.length, 4); assert.ok(f.maxActive() <= 4);
  assert.ok(f.budgets.every(options => options.timeout > 0 && options.timeout <= 2000 && options.maxWait <= 1000));
});

test("failure of the first heartbeat batch still attempts and renews the tail", async () => {
  const f = fixture({ failFirst: true });
  const ids = Array.from({ length: 5001 }, (_, index) => `waiter-${index}`);
  await assert.rejects(heartbeatDurableProviderWaiters({ db: f.db, ownerInstanceId: "replica-a", waiterIds: ids }),
    error => error.code === "OF_PROVIDER_GATE_HEARTBEAT_PARTIAL" && error.failedBatches === 1);
  assert.equal(f.batches.length, 2); assert.ok(f.renewed.has("waiter-5000"));
});

test("an impossible over-capacity heartbeat fails explicitly instead of silently dropping waiters", async () => {
  const f = fixture();
  await assert.rejects(heartbeatDurableProviderWaiters({ db: f.db, ownerInstanceId: "replica-a", waiterIds: Array.from({ length: PROVIDER_GATE_MAX_PENDING + 1 }, (_, index) => `waiter-${index}`) }),
    error => error.code === "OF_PROVIDER_GATE_HEARTBEAT_CAPACITY");
  assert.equal(f.batches.length, 0);
});
