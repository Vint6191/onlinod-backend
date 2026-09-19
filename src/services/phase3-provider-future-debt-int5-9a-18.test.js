"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const debt = require("./provider-capacity-debt-authority-service");

const ROOT = path.join(__dirname, "../..");
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

test("A18 catalogs every claimable readonly provider job outside Campaign/FanData from the canonical job catalog", () => {
  const { CLAIMABLE_DESKTOP_JOB_KEYS } = require("./job-catalog");
  assert.deepEqual([...debt.BACKGROUND_OTHER_PROVIDER_JOB_KEYS].sort(), CLAIMABLE_DESKTOP_JOB_KEYS.filter((key) => !["fetch_campaigns", "fan_data_point_refresh"].includes(key)).sort());
  assert.deepEqual([...debt.BACKGROUND_OTHER_PROVIDER_JOB_KEYS].sort(), [
    "catchup_notifications_scan",
    "dialog_intelligence_scan",
    "fetch_earnings",
    "financial_transactions_scan",
    "likes_content_discovery",
    "sfs_target_discovery",
    "sfs_target_scan",
    "subscriber_directory_scan",
    "traffic_sources_scan",
    "vault_unsorted_scan",
  ]);
});

test("A18 durable background work without exact call cardinality makes future-debt coverage explicit and fail-conservative", () => {
  const snapshot = debt.deriveProviderCapacityDebtSnapshot({
    now: new Date("2026-09-19T01:00:00Z"),
    campaignDirectory: {},
    fanData: {},
    backgroundOther: { pendingJobs: 7, pendingJobClasses: 3, oldestScheduledAt: new Date("2026-09-18T21:00:00Z") },
  });
  assert.equal(snapshot.backgroundOtherPendingJobs, 7);
  assert.equal(snapshot.backgroundOtherPendingJobClasses, 3);
  assert.equal(snapshot.backgroundOtherCallCardinalityKnown, false);
  assert.equal(snapshot.futureDebtCoverageStatus, "PARTIAL");
  assert.equal(snapshot.futureDebtCoverageReason, "BACKGROUND_OTHER_CALL_CARDINALITY_UNKNOWN");
  assert.equal(snapshot.status, "UNKNOWN");
  assert.match(snapshot.overloadReason, /FUTURE_DEBT_COVERAGE_PARTIAL/);
  assert.equal(snapshot.controlMode, "CONSERVATIVE");
});

test("A18 no durable background_other backlog is complete at the sample without inventing future demand", () => {
  const snapshot = debt.deriveProviderCapacityDebtSnapshot({ campaignDirectory: {}, fanData: {}, backgroundOther: {} });
  assert.equal(snapshot.backgroundOtherPendingJobs, 0);
  assert.equal(snapshot.backgroundOtherCallCardinalityKnown, true);
  assert.equal(snapshot.futureDebtCoverageStatus, "COMPLETE_AT_SAMPLE");
  assert.equal(snapshot.futureDebtCoverageReason, null);
});

test("A18 canonical capacity scan projects JobInstance durable debt but never assumes one job equals one call", async () => {
  let sql = "";
  let params = [];
  const db = { async $queryRawUnsafe(text, ...args) {
    sql = String(text); params = args;
    return [{ backgroundOtherPendingJobs: 11n, backgroundOtherPendingJobClasses: 5n, backgroundOtherOldestScheduledAt: new Date("2026-09-18T20:00:00Z") }];
  }};
  const inputs = await debt.readCanonicalCapacityInputs({ db, now: new Date("2026-09-19T01:00:00Z") });
  assert.equal(inputs.backgroundOther.pendingJobs, 11n);
  assert.equal(inputs.backgroundOther.pendingJobClasses, 5n);
  assert.match(sql, /COUNT\(DISTINCT "jobKey"\)|background_other/);
  assert.match(sql, /"status" IN \('SCHEDULED','CLAIMED','PAUSED'\)/);
  assert.deepEqual(params[2], debt.BACKGROUND_OTHER_PROVIDER_JOB_KEYS);
  assert.doesNotMatch(read("src/services/provider-capacity-debt-authority-service.js"), /backgroundOtherRequiredCalls\s*=\s*backgroundOtherPendingJobs/);
});

test("A18 schema/migration are additive typed future-debt coverage", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260919060000_phase3_provider_future_debt_coverage_v1/migration.sql");
  for (const field of ["backgroundOtherPendingJobs","backgroundOtherPendingJobClasses","backgroundOtherCallCardinalityKnown","futureDebtCoverageStatus","futureDebtCoverageReason"]) {
    assert.match(schema, new RegExp(`${field}\\s+`));
    assert.match(migration, new RegExp(`"${field}"`));
  }
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
});
