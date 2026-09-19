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
  const db = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql: String(sql), params });
      if (/WITH directory AS/.test(String(sql))) {
        return [{ dueCreators: 1n, overdueCreators: 1n, requiredCalls: 41n, oldestDueAt: new Date("2026-09-18T00:00:00Z"), unsatisfiedDemands: 5000n, pendingJobs: 32n, oldestRequestedAt: new Date("2026-09-18T00:00:00Z") }];
      }
      if (/INSERT INTO "ProviderCapacityDebtState"/.test(String(sql))) return [{ id: capacityDebt.PROVIDER_CAPACITY_STATE_ID, revision: 7n, status: "OVERLOADED" }];
      return [];
    },
  };
  const result = await capacityDebt.refreshProviderCapacityDebtSnapshot({ db, now: new Date("2026-09-19T00:00:00Z") });
  assert.equal(result.ok, true);
  const upsert = calls.find((call) => /INSERT INTO "ProviderCapacityDebtState"/.test(call.sql));
  assert.ok(upsert);
  assert.match(upsert.sql, /"revision"="ProviderCapacityDebtState"\."revision" \+ 1/);
  assert.doesNotMatch(upsert.sql, /Json|jsonb/i);
});

test("A15 schema/migration keep capacity debt relational and additive", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260919031500_phase3_provider_capacity_debt_v1/migration.sql"), "utf8");
  assert.match(schema, /model ProviderCapacityDebtState/);
  for (const field of ["campaignDirectoryCapacityDebtCalls", "fanDataCapacityDebtCalls", "providerExclusiveClearHours", "status", "sampledAt"]) {
    assert.match(schema, new RegExp(`${field}\\s+`));
    assert.match(migration, new RegExp(`"${field}"`));
  }
  assert.doesNotMatch(schema.slice(schema.indexOf("model ProviderCapacityDebtState"), schema.indexOf("model LegacyFanObservationClock")), /\bJson\??\b/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
  assert.match(migration, /HEALTHY.*PRESSURED.*OVERLOADED.*UNKNOWN/);
});

test("A15 recurring analytics sweep persists capacity projection without replaying provider work on projection failure", () => {
  const source = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  const block = source.slice(source.indexOf("async function runCreatorAnalyticsCatchupSweep"), source.indexOf("async function runRecurringCreatorWork"));
  assert.match(block, /refreshProviderCapacityDebtSnapshot/);
  assert.match(block, /capacity_projection_failed/);
  assert.match(block, /providerCapacityDebt/);
  assert.ok(block.indexOf("refreshProviderCapacityDebtSnapshot") < block.indexOf("completeAnalyticsSweepCycle"));
});

test("A15 PostgreSQL proof harness rehearses clean-current and A13-applied upgrade without mutating primary by default", () => {
  const script = fs.readFileSync(path.join(__dirname, "../../scripts/audit/phase3-a15-postgres-proof.js"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.equal(pkg.scripts["audit:phase3-a15-postgres"], "node scripts/audit/phase3-a15-postgres-proof.js");
  assert.match(script, /ONLINOD_AUDIT_DATABASE_URL is required/);
  assert.match(script, /refusing to mutate the primary database implicitly/);
  assert.match(script, /rolling-a13-migrate/);
  assert.match(script, /rolling-a13-to-current-migrate/);
  assert.match(script, /clean-current-migrate/);
  assert.match(script, /ONLINOD_POSTGRES_INTEGRATION:\s*"1"/);
  assert.match(script, /DROP SCHEMA IF EXISTS/);
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

test("A15 preserves already-shipped A13/A14 migration bytes", () => {
  const crypto = require("node:crypto");
  const hashes = [
    ["20260919010000_phase3_provider_gate_durable_waiter_fairness_v1", "fd56bc1cf7a816aecc9e7a05ea9f2561656b2589206348a40f771ee1c6baaf89"],
    ["20260919023000_phase3_provider_gate_fairness_activation_v2", "749039ebe1bf579a98e751be685e35df5a8c9b5ad61cc862bcdef16de637dd77"],
  ];
  for (const [name, expected] of hashes) {
    const bytes = fs.readFileSync(path.join(__dirname, `../../prisma/migrations/${name}/migration.sql`));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expected, `${name} must remain immutable`);
  }
});
