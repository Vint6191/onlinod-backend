"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");

const topology = require("./provider-capacity-topology-control-service");
const debt = require("./provider-capacity-debt-authority-service");

const ROOT = path.join(__dirname, "../..");
function read(relative) { return fs.readFileSync(path.join(ROOT, relative), "utf8"); }
function sha(relative) { return crypto.createHash("sha256").update(read(relative)).digest("hex"); }

test("A16 topology is one fleet-global shard and source does not authorize sharding", () => {
  const contract = topology.providerCapacityTopologyContract();
  assert.equal(contract.topologyId, "of-global");
  assert.equal(contract.scope, "FLEET_GLOBAL");
  assert.equal(contract.shardCount, 1);
  assert.equal(contract.shardingAllowed, false);
  const gate = read("src/services/provider-request-credit-authority-service.js");
  assert.match(gate, /PROVIDER_GATE_STATE_ID\s*=\s*"of-global"/);
  assert.doesNotMatch(gate, /PROVIDER_GATE_STATE_ID\s*=.*creatorId/);
});

test("A16 overload protection admits periodic directory work only at guaranteed weighted capacity", () => {
  const sampledAt = new Date("2026-09-19T00:00:00Z");
  const overloaded = topology.deriveProviderOverloadControl({
    snapshot: { status: "OVERLOADED", overloadReason: "FAN_DATA_CAPACITY_DEBT", sampledAt },
    now: sampledAt,
    normalDirectoryAdmissionCalls: 2400,
  });
  assert.equal(overloaded.controlMode, "OVERLOAD_PROTECTED");
  assert.equal(overloaded.operatorActionRequired, true);
  assert.equal(overloaded.canonicalDebtPreserved, true);
  assert.equal(overloaded.shedsCanonicalWork, false);
  assert.equal(overloaded.campaignDirectoryAdmissionBudgetCalls, overloaded.campaignDirectoryGuaranteedCallsPerSweep);
  assert.ok(overloaded.campaignDirectoryAdmissionBudgetCalls >= 100);
  assert.ok(overloaded.campaignDirectoryAdmissionBudgetCalls < 2400);
});

test("A16 missing or stale capacity snapshot fails conservative instead of opening the large discovery budget", () => {
  const now = new Date("2026-09-19T04:00:00Z");
  const missing = topology.deriveProviderOverloadControl({ snapshot: null, now, normalDirectoryAdmissionCalls: 2400 });
  assert.equal(missing.controlMode, "CONSERVATIVE");
  assert.equal(missing.operatorActionRequired, false);
  assert.equal(missing.campaignDirectoryAdmissionBudgetCalls, missing.campaignDirectoryGuaranteedCallsPerSweep);

  const stale = topology.deriveProviderOverloadControl({
    snapshot: { status: "HEALTHY", sampledAt: new Date("2026-09-19T00:00:00Z") },
    now,
    normalDirectoryAdmissionCalls: 2400,
    snapshotMaxAgeMs: 60 * 60 * 1000,
  });
  assert.equal(stale.controlMode, "CONSERVATIVE");
  assert.equal(stale.campaignDirectoryAdmissionBudgetCalls, stale.campaignDirectoryGuaranteedCallsPerSweep);
});

test("A16 fresh non-overloaded capacity keeps normal directory admission budget", () => {
  const now = new Date("2026-09-19T04:00:00Z");
  const control = topology.deriveProviderOverloadControl({
    snapshot: { status: "PRESSURED", sampledAt: now },
    now,
    normalDirectoryAdmissionCalls: 2400,
  });
  assert.equal(control.controlMode, "NORMAL");
  assert.equal(control.operatorActionRequired, false);
  assert.equal(control.campaignDirectoryAdmissionBudgetCalls, 2400);
});

test("A16 debt projection persists topology and overload-control facts without becoming canonical work", () => {
  const snapshot = debt.deriveProviderCapacityDebtSnapshot({
    now: new Date("2026-09-19T00:00:00Z"),
    campaignDirectory: { dueCreators: 4000, overdueCreators: 4000, requiredCalls: 164000n },
    fanData: { unsatisfiedDemands: 100000n, pendingJobs: 32 },
  });
  assert.equal(snapshot.status, "OVERLOADED");
  assert.equal(snapshot.topologyId, "of-global");
  assert.equal(snapshot.topologyScope, "FLEET_GLOBAL");
  assert.equal(snapshot.topologyShardCount, 1);
  assert.equal(snapshot.topologyShardingAllowed, false);
  assert.equal(snapshot.controlMode, "OVERLOAD_PROTECTED");
  assert.equal(snapshot.operatorActionRequired, true);
  assert.equal(snapshot.campaignDirectoryAdmissionBudgetCalls, snapshot.campaignDirectoryGuaranteedCallsPerSweep);
});

test("periodic directory admission uses one fleet budget under conservative capacity", () => {
  const service = read("src/services/analytics-recurring-planning-service.js");
  assert.match(service, /guaranteedDirectoryCallsPerSweep/);
  assert.match(service, /AnalyticsPlanningBudget/);
  assert.match(service, /ON CONFLICT/);
  assert.doesNotMatch(service, /deleteMany|readCanonicalCapacityInputs/);
});

test("A16 schema and migration encode an additive one-shard topology/control projection", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260919043000_phase3_provider_capacity_topology_control_v1/migration.sql");
  assert.match(schema, /topologyId\s+String\s+@default\("of-global"\)/);
  assert.match(schema, /topologyShardCount\s+Int\s+@default\(1\)/);
  assert.match(schema, /topologyShardingAllowed\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /controlMode\s+String\s+@default\("CONSERVATIVE"\)/);
  assert.match(migration, /CHECK \([\s\S]*"topologyId" = 'of-global'[\s\S]*"topologyShardCount" = 1[\s\S]*"topologyShardingAllowed" = FALSE/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
});

test("A16 preserves historical A13/A14/A15 migrations byte-for-byte", () => {
  assert.equal(sha("prisma/migrations/20260919010000_phase3_provider_gate_durable_waiter_fairness_v1/migration.sql"), "fd56bc1cf7a816aecc9e7a05ea9f2561656b2589206348a40f771ee1c6baaf89");
  assert.equal(sha("prisma/migrations/20260919023000_phase3_provider_gate_fairness_activation_v2/migration.sql"), "749039ebe1bf579a98e751be685e35df5a8c9b5ad61cc862bcdef16de637dd77");
  assert.equal(sha("prisma/migrations/20260919031500_phase3_provider_capacity_debt_v1/migration.sql"), "bed2b91a8f18764f1d4abb11c6001210a1f9339656361ee7fbc08c2b56b235b0");
});
