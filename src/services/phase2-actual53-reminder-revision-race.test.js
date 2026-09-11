"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const {
  reprojectCustomReminderSchedule,
  reminderWorkObjectId,
} = require("./custom-order-reminders");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function dateEq(a, b) {
  const aa = a instanceof Date ? a.getTime() : new Date(a).getTime();
  const bb = b instanceof Date ? b.getTime() : new Date(b).getTime();
  return aa === bb;
}

function matches(row, where = {}) {
  for (const [key, expected] of Object.entries(where || {})) {
    const actual = row?.[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, "not") && actual === expected.not) return false;
      continue;
    }
    if (expected instanceof Date) { if (!dateEq(actual, expected)) return false; }
    else if (actual !== expected) return false;
  }
  return true;
}

function makeDb() {
  const now = new Date("2026-09-10T14:00:00.000Z");
  const firstRevision = new Date("2026-09-10T13:00:00.000Z");
  const externalRevision = new Date("2026-09-10T13:30:00.000Z");
  const order = {
    id: "order-1", agencyId: "agency-1", creatorId: "creator-1", type: "CALL", status: "PENDING",
    telegramTaskMessageId: "tg-task-1", scheduledAt: new Date("2026-09-10T15:00:00.000Z"),
    nextReminderAt: new Date("2026-09-10T14:30:00.000Z"), reminderConfig: null,
    lastReminderAt: null, lastReminderKey: null, updatedAt: firstRevision,
  };
  const work = new Map();
  const t1AtCas = deferred();
  const releaseT1 = deferred();
  let txSeq = 0;

  const domainWorkItem = {
    async findUnique({ where }) {
      if (where?.id) return work.get(where.id) || null;
      const identity = where?.agencyId_workClass_objectType_objectId;
      if (!identity) return null;
      return [...work.values()].find((row) => row.agencyId === identity.agencyId && row.workClass === identity.workClass && row.objectType === identity.objectType && row.objectId === identity.objectId) || null;
    },
    async upsert({ create }) { work.set(create.id, { ...create }); return { ...create }; },
    async update({ where, data }) {
      const row = work.get(where.id);
      if (!row) throw new Error("missing work");
      const next = { ...row };
      for (const [key, value] of Object.entries(data || {})) {
        if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "increment")) next[key] = BigInt(next[key] || 0) + BigInt(value.increment);
        else next[key] = value;
      }
      work.set(where.id, next); return { ...next };
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const [id, row] of [...work.entries()]) {
        if (!matches(row, where)) continue;
        work.set(id, { ...row, ...data }); count += 1;
      }
      return { count };
    },
  };

  const root = {
    domainWorkItem,
    // Public service validates storage capability on the root client before
    // entering the transaction; real calls inside the test use tx-scoped methods below.
    customOrder: { async findFirst() { return { ...order }; }, async updateMany() { return { count: 0 }; } },
    workspaceSetting: {
      async findUnique() { return { value: { call: { enabled: true, offsetsMinutes: [30, 5] } } }; },
    },
    async $transaction(fn) {
      const txId = ++txSeq;
      const tx = {
        domainWorkItem,
        workspaceSetting: root.workspaceSetting,
        customOrder: {
          async findFirst({ where }) { return where.id === order.id && where.agencyId === order.agencyId ? { ...order } : null; },
          async updateMany({ where, data }) {
            if (txId === 1) {
              t1AtCas.resolve();
              await releaseT1.promise;
            }
            if (where.id !== order.id || where.agencyId !== order.agencyId || !dateEq(order.updatedAt, where.updatedAt)) return { count: 0 };
            Object.assign(order, data);
            return { count: 1 };
          },
        },
      };
      return fn(tx);
    },
  };

  return { root, order, work, now, externalRevision, t1AtCas, releaseT1 };
}

test("F53-17 stale sameInstant R1 cannot supersede reminder B published by concurrent R2", async () => {
  const fx = makeDb();
  const policyAKey = "CALL:2026-09-10T15:00:00.000Z:30";
  const policyBKey = "CALL:2026-09-10T16:00:00.000Z:30";
  const initialAId = reminderWorkObjectId("order-1", policyAKey);
  fx.work.set(`seed-a`, {
    id: "seed-a", agencyId: "agency-1", workClass: "CUSTOM_REMINDER", objectType: "CustomReminderObligation",
    objectId: initialAId, parentObjectId: "order-1", partitionKey: "creator-1", creatorId: "creator-1",
    requestedRevision: 1n, completedRevision: 0n, activeGeneration: "phase2_domain_work_v3_actual55", projectionVersion: "phase2_domain_work_v3_actual55",
    state: "READY", isOutstanding: true, availableAt: new Date("2026-09-10T14:30:00.000Z"), claimFence: 0n, claimedRevision: 0n,
  });

  const staleR1 = reprojectCustomReminderSchedule({ agencyId: "agency-1", orderId: "order-1", now: fx.now, db: fx.root });
  await fx.t1AtCas.promise;

  // External canonical mutation creates R2 while T1 is stalled after deriving A/R1.
  fx.order.scheduledAt = new Date("2026-09-10T16:00:00.000Z");
  fx.order.updatedAt = fx.externalRevision;
  const r2 = await reprojectCustomReminderSchedule({ agencyId: "agency-1", orderId: "order-1", now: fx.now, db: fx.root });
  assert.equal(r2.reminderKey, policyBKey);
  fx.releaseT1.resolve();
  const resumed = await staleR1;
  assert.equal(resumed.reminderKey, policyBKey, "stale caller must retry from current R2 rather than republish A");

  assert.equal(new Date(fx.order.nextReminderAt).toISOString(), "2026-09-10T15:30:00.000Z");
  const expectedBId = reminderWorkObjectId("order-1", policyBKey);
  const executable = [...fx.work.values()].filter((row) => row.state !== "DONE" && row.isOutstanding !== false);
  assert.equal(executable.length, 1);
  assert.equal(executable[0].objectId, expectedBId);
  assert.notEqual(executable[0].objectId, initialAId);
});
