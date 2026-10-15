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

test("topology has an independent durable timeline for each creator", () => {
  const contract = topology.providerCapacityTopologyContract(12);
  assert.equal(contract.topologyId, "of-creator");
  assert.equal(contract.scope, "CREATOR_PARALLEL");
  assert.equal(contract.shardCount, 12);
  assert.equal(contract.shardingAllowed, true);
  const credit = require("./provider-request-credit-authority-service");
  assert.equal(credit.providerGateStateId("creator-a"), "of-creator:creator-a");
  assert.notEqual(credit.providerGateStateId("creator-a"), credit.providerGateStateId("creator-b"));
  assert.throws(() => credit.providerGateStateId(null), { code: "OF_PROVIDER_GATE_SCOPE_REQUIRED" });
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
    creatorCapacity: { creatorCount: 4000, directoryDebtCalls: 156286n, fanDebtCalls: 94858n, maxDirectoryCalls: 164000n, maxFanCalls: 100000n, maxRequiredCalls: 264000n },
    campaignDirectory: { dueCreators: 4000, overdueCreators: 4000, requiredCalls: 164000n },
    fanData: { unsatisfiedDemands: 100000n, pendingJobs: 32 },
  });
  assert.equal(snapshot.status, "OVERLOADED");
  assert.equal(snapshot.topologyId, "of-creator");
  assert.equal(snapshot.topologyScope, "CREATOR_PARALLEL");
  assert.equal(snapshot.topologyShardCount, 4000);
  assert.equal(snapshot.topologyShardingAllowed, true);
  assert.equal(snapshot.controlMode, "OVERLOAD_PROTECTED");
  assert.equal(snapshot.operatorActionRequired, true);
  assert.equal(snapshot.campaignDirectoryAdmissionBudgetCalls, snapshot.campaignDirectoryGuaranteedCallsPerSweep);
});

test("periodic directory admission uses a separate budget per creator", () => {
  const service = read("src/services/analytics-recurring-planning-service.js");
  assert.match(service, /guaranteedDirectoryCallsPerSweep/);
  assert.match(service, /AnalyticsPlanningBudget/);
  assert.match(service, /ON CONFLICT/);
  assert.match(service, /campaign-directory:\$\{scopedCreatorId\}/);
  assert.doesNotMatch(service, /deleteMany|readCanonicalCapacityInputs/);
});




