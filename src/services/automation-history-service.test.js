"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyAutomationDelivery, groupDeliveriesForArchive, compactAutomationDeliveries } = require("./automation-history-service");

test("semantic counters classify automation actions", () => {
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "SEND_MESSAGE", result: { replied: true } }).sent, 1);
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "SEND_MESSAGE", result: { replied: true } }).replied, 1);
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "FOLLOW_BACK" }).followed, 1);
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "SFS_UNFOLLOW_TARGET" }).unfollowed, 1);
  assert.equal(classifyAutomationDelivery({ status: "FAILED", actionType: "LIKE_POST" }).failed, 1);
});

test("archive groups are separated by creator module action and month", () => {
  const rows = [
    { agencyId: "a", creatorId: "c", moduleKey: "likes", actionType: "LIKE_POST", status: "COMPLETED", finishedAt: new Date("2026-01-02T00:00:00Z") },
    { agencyId: "a", creatorId: "c", moduleKey: "likes", actionType: "LIKE_POST", status: "FAILED", finishedAt: new Date("2026-01-03T00:00:00Z") },
    { agencyId: "a", creatorId: "c", moduleKey: "likes", actionType: "LIKE_POST", status: "COMPLETED", finishedAt: new Date("2026-02-03T00:00:00Z") },
  ];
  const groups = groupDeliveriesForArchive(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].total, 2);
  assert.equal(groups[0].completed, 1);
  assert.equal(groups[0].failed, 1);
});

test("retention never compacts unresolved provider future-effect authority", async () => {
  const selected = [];
  const deleted = [];
  const row = {
    id: "delivery-settled",
    agencyId: "agency-a",
    creatorId: "creator-a",
    moduleKey: "mass",
    actionType: "MASS_QUEUE_CREATE",
    status: "COMPLETED",
    result: {},
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    finishedAt: new Date("2025-01-01T00:00:00Z"),
  };
  const tx = {
    automationMonthlyAggregate: {
      findUnique: async () => null,
      create: async () => null,
    },
    automationDelivery: {
      deleteMany: async ({ where }) => { deleted.push(where); return { count: 1 }; },
    },
  };
  const db = {
    automationDelivery: {
      findMany: async ({ where }) => { selected.push(where); return [row]; },
    },
    $transaction: async (fn) => fn(tx),
  };

  await compactAutomationDeliveries({ olderThan: new Date("2026-01-01T00:00:00Z"), batchSize: 100, db });

  const futureEffectGuard = { OR: [{ remoteLifecycleState: null }, { remoteLifecycleState: "SETTLED" }] };
  const logicalIntentGuard = { OR: [{ actionType: { not: "MASS_QUEUE_CREATE" } }, { intentAcknowledgedAt: { not: null } }] };
  assert.ok(selected[0].AND.some((clause) => JSON.stringify(clause) === JSON.stringify(futureEffectGuard)));
  assert.ok(selected[0].AND.some((clause) => JSON.stringify(clause) === JSON.stringify(logicalIntentGuard)));
  assert.ok(deleted[0].AND.some((clause) => JSON.stringify(clause) === JSON.stringify(futureEffectGuard)));
  assert.ok(deleted[0].AND.some((clause) => JSON.stringify(clause) === JSON.stringify(logicalIntentGuard)));
});

test("retention does not archive a delivery that becomes live at the delete fence", async () => {
  const row = {
    id: "delivery-reappeared",
    agencyId: "agency-a",
    creatorId: "creator-a",
    moduleKey: "mass",
    actionType: "MASS_QUEUE_CREATE",
    status: "COMPLETED",
    result: {},
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    finishedAt: new Date("2025-01-01T00:00:00Z"),
  };
  let aggregateWrites = 0;
  const tx = {
    automationMonthlyAggregate: {
      findUnique: async () => null,
      create: async () => { aggregateWrites += 1; },
    },
    automationDelivery: {
      deleteMany: async () => ({ count: 0 }),
      findMany: async () => [{ id: row.id }],
    },
  };
  const db = {
    automationDelivery: { findMany: async () => [row] },
    $transaction: async (fn) => fn(tx),
  };

  const result = await compactAutomationDeliveries({ olderThan: new Date("2026-01-01T00:00:00Z"), batchSize: 100, db });

  assert.equal(result.archived, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.aggregateUpdates, 0);
  assert.equal(aggregateWrites, 0);
});

test("retention preserves an active pre-INT4.3C SFS follow proof instead of archiving it", async () => {
  const row = {
    id: "follow-proof",
    agencyId: "agency-a",
    creatorId: "creator-a",
    moduleKey: "sfs",
    actionType: "SFS_FOLLOW_TARGET",
    payload: { candidateId: "candidate-a" },
    generation: 3,
    fanId: "fan-a",
    targetId: "fan-a",
    status: "COMPLETED",
    result: { code: "followed" },
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    finishedAt: new Date("2025-01-01T00:00:00Z"),
  };
  let deleteCalls = 0;
  const tx = {
    sfsTargetCandidate: {
      findMany: async () => [{
        id: "candidate-a", generation: 3, state: "UNFOLLOW_DUE", usedForever: false,
        completedAt: null, metadata: {},
      }],
    },
    automationDelivery: { deleteMany: async () => { deleteCalls += 1; return { count: 1 }; } },
    automationMonthlyAggregate: {},
  };
  const db = {
    automationDelivery: { findMany: async () => [row] },
    $transaction: async (fn) => fn(tx),
  };

  const result = await compactAutomationDeliveries({ olderThan: new Date("2026-01-01T00:00:00Z"), batchSize: 100, db });
  assert.equal(result.archived, 0);
  assert.equal(result.aggregateUpdates, 0);
  assert.equal(deleteCalls, 0);
});
