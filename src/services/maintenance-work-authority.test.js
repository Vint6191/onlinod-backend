"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const authority = require("./maintenance-work-authority");

function makeDb(now = new Date("2026-09-09T20:00:00.000Z")) {
  const rows = new Map();
  const tx = {
    async $executeRawUnsafe() { return 1; },
    async $queryRawUnsafe(sql) {
      if (/clock_timestamp/.test(String(sql))) return [{ authorityNow: new Date(now) }];
      return [];
    },
    maintenanceLaneState: {
      async findUnique({ where }) { return rows.get(where.key) || null; },
      async upsert({ where, create, update }) {
        const current = rows.get(where.key);
        const next = current ? { ...current, ...update, updatedAt: new Date(now) } : { ...create, createdAt: new Date(now), updatedAt: new Date(now) };
        rows.set(where.key, next);
        return next;
      },
      async updateMany({ where, data }) {
        const current = rows.get(where.key);
        if (!current) return { count: 0 };
        if (where.generation && current.generation !== where.generation) return { count: 0 };
        if (where.ownerToken && current.ownerToken !== where.ownerToken) return { count: 0 };
        if (Object.prototype.hasOwnProperty.call(where, "completedAt") && where.completedAt === null && current.completedAt != null) return { count: 0 };
        rows.set(where.key, { ...current, ...data, updatedAt: new Date(now) });
        return { count: 1 };
      },
    },
  };
  const db = {
    async $transaction(work) { return work(tx); },
    ...tx,
  };
  return { db, rows, setNow(value) { now = new Date(value); } };
}

test("one-time maintenance generation completes durably and is not reclaimed", async () => {
  const fx = makeDb();
  let runs = 0;
  const first = await authority.runMaintenanceLane({
    db: fx.db, key: "legacy", generation: "v1", oneTime: true,
    work: async () => { runs += 1; return { complete: true, progress: { cleared: 7 } }; },
  });
  assert.equal(first.complete, true);
  const second = await authority.runMaintenanceLane({
    db: fx.db, key: "legacy", generation: "v1", oneTime: true,
    work: async () => { runs += 1; return { complete: true }; },
  });
  assert.equal(second.reason, "generation_complete");
  assert.equal(runs, 1);
  assert.equal(fx.rows.get("legacy").progress.cleared, 7);
});

test("generation change explicitly reopens a completed maintenance lane", async () => {
  const fx = makeDb();
  await authority.runMaintenanceLane({ db: fx.db, key: "lane", generation: "v1", oneTime: true, work: async () => ({ complete: true }) });
  let ran = false;
  const next = await authority.runMaintenanceLane({ db: fx.db, key: "lane", generation: "v2", oneTime: true, work: async () => { ran = true; return { complete: true }; } });
  assert.equal(next.complete, true);
  assert.equal(ran, true);
  assert.equal(fx.rows.get("lane").generation, "v2");
});

test("live lease prevents another replica from owning the same lane", async () => {
  const fx = makeDb();
  const first = await authority.claimMaintenanceLane({ db: fx.db, key: "shared", generation: "v1", ownerToken: "replica-a", leaseMs: 120_000 });
  assert.equal(first.acquired, true);
  const second = await authority.claimMaintenanceLane({ db: fx.db, key: "shared", generation: "v1", ownerToken: "replica-b", leaseMs: 120_000 });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "lease_held");
});

test("recurring lane honors durable nextRunAt instead of process-local cadence", async () => {
  const fx = makeDb();
  let runs = 0;
  await authority.runMaintenanceLane({
    db: fx.db, key: "recurring", generation: "v1", minIntervalMs: 60_000,
    work: async () => { runs += 1; return { complete: false }; },
  });
  const early = await authority.runMaintenanceLane({
    db: fx.db, key: "recurring", generation: "v1", minIntervalMs: 60_000,
    work: async () => { runs += 1; return { complete: false }; },
  });
  assert.equal(early.reason, "not_due");
  assert.equal(runs, 1);
  fx.setNow("2026-09-09T20:01:01.000Z");
  const due = await authority.runMaintenanceLane({
    db: fx.db, key: "recurring", generation: "v1", minIntervalMs: 60_000,
    work: async () => { runs += 1; return { complete: false }; },
  });
  assert.equal(due.acquired, true);
  assert.equal(runs, 2);
});

test("expired maintenance lease is recoverable by another replica", async () => {
  const fx = makeDb();
  const first = await authority.claimMaintenanceLane({ db: fx.db, key: "recoverable", generation: "v1", ownerToken: "replica-a", leaseMs: 60_000 });
  assert.equal(first.acquired, true);
  fx.setNow("2026-09-09T20:01:01.000Z");
  const second = await authority.claimMaintenanceLane({ db: fx.db, key: "recoverable", generation: "v1", ownerToken: "replica-b", leaseMs: 60_000 });
  assert.equal(second.acquired, true);
  assert.equal(second.ownerToken, "replica-b");
});
