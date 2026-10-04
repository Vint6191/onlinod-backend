"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const credit = require("./provider-request-credit-authority-service");

function head({ waiterId, ticket, priority, category, ownerInstanceId = "backend-a", creatorId = "creator-a" }) {
  return {
    waiterId,
    ticket: BigInt(ticket),
    priority,
    category,
    ownerInstanceId,
    creatorId,
    agencyId: "agency-1",
    deviceId: `device-${creatorId}`,
    capability: "read",
  };
}

function advance(state, selected) {
  return {
    ...state,
    priorityCursor: selected.nextPriorityCursor,
    backgroundCategoryCursor: selected.nextBackgroundCategoryCursor,
  };
}

test("A13 durable priority cursor preserves 3 critical-write turns but cannot starve background", () => {
  const heads = [
    head({ waiterId: "critical", ticket: 1, priority: "critical_write", category: "default" }),
    head({ waiterId: "background", ticket: 2, priority: "background", category: "background_other", creatorId: "creator-b" }),
  ];
  let state = { priorityCursor: 0, backgroundCategoryCursor: 0 };
  const sequence = [];
  for (let i = 0; i < 4; i += 1) {
    const selected = credit._test.chooseDurableWaiter(state, heads);
    sequence.push(selected.priority);
    state = advance(state, selected);
  }
  assert.deepEqual(sequence, ["critical_write", "critical_write", "critical_write", "background"]);
});

test("A13 background category credits interleave frontier, FanData, other work and directory discovery", () => {
  const heads = [
    head({ waiterId: "frontier", ticket: 1, priority: "background", category: "campaign_frontier" }),
    head({ waiterId: "fan", ticket: 2, priority: "background", category: "fan_data" }),
    head({ waiterId: "other", ticket: 3, priority: "background", category: "background_other" }),
    head({ waiterId: "directory", ticket: 4, priority: "background", category: "campaign_directory" }),
  ];
  let state = { priorityCursor: 7, backgroundCategoryCursor: 0 };
  const categories = [];
  for (let i = 0; i < 6; i += 1) {
    const selected = credit._test.chooseDurableWaiter(state, heads);
    categories.push(selected.category);
    // Force the priority cursor back to the background cycle slot so this unit
    // isolates category credits from the outer priority cycle.
    state = { priorityCursor: 7, backgroundCategoryCursor: selected.nextBackgroundCategoryCursor };
  }
  assert.deepEqual(categories, [
    "campaign_frontier",
    "fan_data",
    "campaign_frontier",
    "fan_data",
    "background_other",
    "campaign_directory",
  ]);
});

test("A13 durable ticket FIFO is replica-neutral inside the selected bucket", () => {
  const selected = credit._test.chooseDurableWaiter(
    { priorityCursor: 7, backgroundCategoryCursor: 4 },
    [
      head({ waiterId: "later-backend-a", ticket: 99, priority: "background", category: "background_other", ownerInstanceId: "backend-a" }),
      head({ waiterId: "older-backend-b", ticket: 7, priority: "background", category: "background_other", ownerInstanceId: "backend-b", creatorId: "creator-b" }),
    ],
  );
  assert.equal(selected.waiter.waiterId, "older-backend-b");
});

test("A13 gate classifies Campaign/FanData background calls server-side while preserving non-background priority", () => {
  const gateSource = fs.readFileSync(path.join(__dirname, "of-request-gate-service.js"), "utf8");
  assert.match(gateSource, /op === "campaigns\.list"[\s\S]*"campaign_directory"/);
  assert.match(gateSource, /op === "campaigns\.claimers"[\s\S]*"campaign_frontier"/);
  assert.match(gateSource, /op === "users\.profile"[\s\S]*fan_data_point_refresh[\s\S]*"fan_data"/);
  assert.match(gateSource, /if \(priority !== "background"\) return "default"/);
  assert.match(gateSource, /registerDurableProviderWaiter/);
  assert.match(gateSource, /permitId = entry\.id/);
  assert.match(gateSource, /heartbeatDurableProviderWaiters/);
});

test("A13 migration creates typed waiter authority, durable cursors and rolling legacy-bypass fence", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260919010000_phase3_provider_gate_durable_waiter_fairness_v1/migration.sql"), "utf8");
  assert.match(schema, /model OfProviderRequestGateWaiter[\s\S]*ticket\s+BigInt[\s\S]*waiterId\s+String\s+@unique[\s\S]*leaseUntil\s+DateTime/);
  assert.match(schema, /model OfProviderRequestGateState[\s\S]*priorityCursor\s+Int[\s\S]*backgroundCategoryCursor\s+Int/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "OfProviderRequestGateWaiter"/);
  assert.match(migration, /onlinod_provider_gate_waiter_registration/);
  assert.match(migration, /NEW\."activePermitId"[\s\S]*OfProviderRequestGateWaiter[\s\S]*waiterId/);
  assert.match(migration, /leaseUntil" > clock_timestamp\(\)/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
});

test("A13 authority prunes expired dead-process waiters before winner selection", () => {
  const source = fs.readFileSync(path.join(__dirname, "provider-request-credit-authority-service.js"), "utf8");
  assert.match(source, /DELETE FROM "OfProviderRequestGateWaiter"[\s\S]*"leaseUntil" <= \$2/);
  assert.match(source, /PROVIDER_GATE_WAITER_LEASE_MS/);
  assert.match(source, /PROVIDER_GATE_WAITER_HEARTBEAT_MS/);
  assert.match(source, /WHERE "ownerInstanceId" = \$1[\s\S]*"waiterId" IN \(SELECT jsonb_array_elements_text\(\$2::jsonb\)\)[\s\S]*"leaseUntil" > clock_timestamp\(\)/);
});

test("A13 durable permit acquisition rejects arbitrary permit ids that are not the registered waiter identity", async () => {
  await assert.rejects(
    () => credit.tryAcquireDurableProviderPermit({
      db: { $transaction: async () => null, $queryRawUnsafe: async () => [] },
      waiterId: "waiter-1",
      permitId: "different-permit",
      ownerInstanceId: "backend-a",
      agencyId: "agency-1",
      creatorId: "creator-a",
      deviceId: "device-a",
      capability: "read",
      intervalMs: 700,
    }),
    (error) => error?.code === "OF_PROVIDER_GATE_WAITER_PERMIT_REQUIRED",
  );
});

test("S2 a contended or disappeared prefix head yields without bypassing FIFO or pruning unlocked rows", async () => {
  const credit = require("./provider-request-credit-authority-service");
  let calls = 0;
  const now = new Date("2026-10-04T00:00:00Z");
  // Query-boundary fixture, not a native PostgreSQL contention simulation.
  const tx = { async $queryRawUnsafe(sql, ...args) {
    calls++;
    assert.equal(calls, 1, "a missing lock prevents every subsequent prune/grant");
    assert.match(sql, /LEFT JOIN LATERAL[\s\S]*FOR UPDATE OF w SKIP LOCKED/);
    assert.equal(JSON.parse(args[0]).length, 8); assert.equal(args[1], 32);
    return [{ prefixTicket: 1n, waiterId: null }, { prefixTicket: 2n, ticket: 2n, waiterId: "later", priority: "normal", category: "default", leaseUntil: new Date(+now + 60000) }];
  } };
  assert.deepEqual(await credit._test.waiterHeads(tx, now), []);
});

test("S2 renewed current lease preserves the earliest exact bigint ticket; cleanup only removes observed expired IDs", async () => {
  const credit = require("./provider-request-credit-authority-service");
  const now = new Date("2026-10-04T00:00:00Z"), future = new Date(+now + 10000);
  let calls = 0;
  const tx = { async $queryRawUnsafe(sql, ...args) {
    if (++calls === 1) return [
      { waiterId: "later", ticket: 9007199254740994n, priority: "normal", category: "default", leaseUntil: future },
      { waiterId: "renewed", ticket: 9007199254740993n, priority: "normal", category: "default", leaseUntil: future },
      { waiterId: "expired", ticket: 4n, priority: "background", category: "fan_data", leaseUntil: now },
    ];
    assert.deepEqual(JSON.parse(args[0]), ["expired"]); assert.equal(args[1], now);
    assert.match(sql, /"waiterId" IN[\s\S]*"leaseUntil" <= \$2/); return [];
  } };
  const heads = await credit._test.waiterHeads(tx, now);
  assert.equal(calls, 2); assert.equal(heads.length, 1); assert.equal(heads[0].waiterId, "renewed");
});
