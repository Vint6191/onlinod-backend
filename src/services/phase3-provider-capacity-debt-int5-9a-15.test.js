"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const capacityDebt = require("./provider-capacity-debt-authority-service");

test("A15 durable capacity debt marks 4k Campaign directory + 100k FanData lower-bound as overloaded", () => {
  const snapshot = capacityDebt.deriveProviderCapacityDebtSnapshot({
    now: new Date("2026-09-19T00:00:00Z"),
    campaignDirectory: {
      dueCreators: 4_000,
      overdueCreators: 4_000,
      requiredCalls: 164_000n,
      oldestDueAt: new Date("2026-09-16T00:00:00Z"),
    },
    fanData: {
      unsatisfiedDemands: 100_000n,
      pendingJobs: 32,
      oldestRequestedAt: new Date("2026-09-18T00:00:00Z"),
    },
  });
  assert.equal(snapshot.status, "OVERLOADED");
  assert.match(snapshot.overloadReason, /CAMPAIGN_DIRECTORY_CAPACITY_DEBT/);
  assert.match(snapshot.overloadReason, /FAN_DATA_CAPACITY_DEBT/);
  assert.ok(snapshot.campaignDirectoryGuaranteedClearHours > 1500);
  assert.ok(snapshot.fanDataGuaranteedClearHours > 400);
  assert.ok(snapshot.providerExclusiveClearHours > 50, "even exclusive physical gate time is a large lower bound");
});

test("A15 capacity projection distinguishes pressured work from impossible target debt", () => {
  const snapshot = capacityDebt.deriveProviderCapacityDebtSnapshot({
    campaignDirectory: { dueCreators: 1, overdueCreators: 0, requiredCalls: 2n },
    fanData: { unsatisfiedDemands: 10n, pendingJobs: 1 },
  });
  assert.equal(snapshot.status, "PRESSURED");
  assert.equal(snapshot.campaignDirectoryCapacityDebtCalls, 0n);
  assert.equal(snapshot.fanDataCapacityDebtCalls, 0n);

  const healthy = capacityDebt.deriveProviderCapacityDebtSnapshot({ campaignDirectory: {}, fanData: {} });
  assert.equal(healthy.status, "HEALTHY");
  assert.equal(healthy.providerLowerBoundRequiredCalls, 0n);
});

test("A15 canonical input scan counts unsatisfied FanData revisions, not only currently scheduled jobs", async () => {
  let sql = "";
  const db = {
    async $queryRawUnsafe(text) {
      sql = String(text);
      return [{
        dueCreators: 3n, overdueCreators: 2n, requiredCalls: 123n, oldestDueAt: new Date("2026-09-18T00:00:00Z"),
        unsatisfiedDemands: 99n, oldestRequestedAt: new Date("2026-09-18T01:00:00Z"), pendingJobs: 8n,
      }];
    },
  };
  const inputs = await capacityDebt.readCanonicalCapacityInputs({ db, now: new Date("2026-09-19T00:00:00Z") });
  assert.equal(inputs.supported, true);
  assert.equal(inputs.fanData.unsatisfiedDemands, 99n);
  assert.equal(inputs.fanData.pendingJobs, 8n);
  assert.match(sql, /"requestedRevision" > "satisfiedRevision"/);
  assert.match(sql, /campaignDirectoryDiscoveryRequestedRevision/);
  assert.match(sql, /fan_data_point_refresh/);
});

test("A15 persistence is a typed singleton projection with monotonic revision", async () => {
  const calls = [];
  const tx = {
    async $executeRawUnsafe() { return 1; },
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql: String(sql), params });
      if (/pg_try_advisory_xact_lock/.test(sql)) return [{ acquired: true }];
      if (/SELECT clock_timestamp/.test(sql)) return [{ authorityNow: new Date("2026-09-29T00:00:00Z") }];
      if (/SELECT \* FROM "ProviderCapacityProjectionState"/.test(sql)) return [{
        generation: require("./provider-capacity-projection-service").GENERATION, jobKeys: require("./job-catalog").CLAIMABLE_DESKTOP_JOB_KEYS,
        directoryComplete: true, fanComplete: true, jobComplete: true,
      }];
      if (/WITH background_other AS/.test(sql)) return [{ revision: 7n, projectionComplete: true, dueCreators: 1n, overdueCreators: 1n, requiredCalls: 41n, unsatisfiedDemands: 5000n, pendingJobs: 32n }];
      if (/INSERT INTO "ProviderCapacityDebtState"/.test(sql)) return [{ id: capacityDebt.PROVIDER_CAPACITY_STATE_ID, revision: 7n, status: "OVERLOADED" }];
      return [];
    },
  };
  const db = { async $transaction(work) { return work(tx); } };
  const result = await capacityDebt.refreshProviderCapacityDebtSnapshot({ db, now: new Date("2026-09-19T00:00:00Z") });
  assert.equal(result.ok, true);
  const upsert = calls.find((call) => /INSERT INTO "ProviderCapacityDebtState"/.test(call.sql));
  assert.ok(upsert);
  assert.match(upsert.sql, /"revision"="ProviderCapacityDebtState"\."revision" \+ 1/);
  assert.doesNotMatch(upsert.sql, /Json|jsonb/i);
  assert.ok(!calls.some((call) => /WITH directory AS/.test(call.sql)), "refresh must not scan canonical relations");
});



test("recurring admission is bounded by durable budget without full capacity scans in the hot path", () => {
  const source = fs.readFileSync(path.join(__dirname, "analytics-recurring-planning-service.js"), "utf8");
  assert.match(source, /AnalyticsPlanningBudget/);
  assert.match(source, /ON CONFLICT/);
  assert.match(source, /guaranteedDirectoryCallsPerSweep/);
  assert.doesNotMatch(source, /readCanonicalCapacityInputs|refreshProviderCapacityDebtSnapshot/);
});



test("A15 operator diagnostics can read or explicitly refresh the durable capacity projection", () => {
  const script = fs.readFileSync(path.join(__dirname, "../../scripts/phase3-provider-capacity-debt.js"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.equal(pkg.scripts["phase3:provider-capacity"], "node scripts/phase3-provider-capacity-debt.js");
  assert.match(script, /diagnostics/);
  assert.match(script, /refreshProviderCapacityDebtSnapshot/);
  assert.match(script, /readProviderCapacityDebtSnapshot/);
  assert.doesNotMatch(script, /DELETE\s+FROM|DROP\s+TABLE|TRUNCATE/i);
});


