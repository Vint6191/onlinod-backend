"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { reconcileCampaignFanRefreshDemandsFromCanonicalObservations } = require("./campaign-fan-refresh-queue-service");
const { deriveCampaignPresentationStatus } = require("./campaign-scan-status-authority");

const root = path.resolve(__dirname, "../..");

for (const count of [1, 20, 500]) {
  test(`A20 canonical observation healing keeps constant production SQL topology for ${count} matching demands`, async () => {
    let rawCalls = 0;
    const db = {
      $queryRawUnsafe: async (sql, creatorId, fanIds) => {
        rawCalls += 1;
        assert.match(sql, /WITH candidate AS/);
        assert.match(sql, /demand_update AS/);
        assert.match(sql, /work_update AS/);
        assert.match(sql, /delta AS/);
        assert.match(sql, /coverage_update AS/);
        assert.equal(creatorId, "c1");
        assert.equal(fanIds.length, count);
        return [{ healed: count, workTransitioned: count, coverageRunsUpdated: 1 }];
      },
    };
    const fanIds = Array.from({ length: count }, (_, index) => `f${index + 1}`);
    const result = await reconcileCampaignFanRefreshDemandsFromCanonicalObservations({ db, creatorId: "c1", fanIds, now: new Date("2040-01-01T00:00:00.000Z") });
    assert.equal(rawCalls, 1, "production reconciliation must remain one SQL round trip independent of demand count");
    assert.equal(result.healed, count);
    assert.equal(result.topology, "set_based_v1");
  });
}

test("A20 delegated debt remains refresh-pending after PARTIAL/FAILED/CANCELLED collector outcomes", () => {
  for (const collectorStatus of ["PARTIAL", "FAILED", "CANCELLED"]) {
    const status = deriveCampaignPresentationStatus({
      collectorStatus,
      fanRefreshDelegated: true,
      membershipCoverageStatus: "COMPLETE",
      campaignFrontierFreshnessStatus: "COMPLETE",
      fanValuesComplete: false,
      fanValuesOutstanding: 2,
      fanValueFreshnessStatus: "QUEUED",
    });
    assert.equal(status.refreshPending, true, `${collectorStatus} must not hide delegated debt`);
    assert.equal(status.coverageStatus, "PENDING");
    assert.equal(status.collectorStatus, collectorStatus);
  }
});

test("A20 reader separates manual collector generation from current canonical coverage generation", () => {
  const control = fs.readFileSync(path.join(root, "src/services/campaign-scan-control-service.js"), "utf8");
  assert.match(control, /currentCoverageScanRunId/);
  assert.match(control, /manualGenerationSuperseded/);
  assert.match(control, /coverageMatchesManualGeneration/);
  assert.match(control, /canonicalCoveragePresent/);
  assert.match(control, /FanData counters always come[\s\S]*current canonical coverage generation/);
});

test("A20 mixed observation batch reconciles only fans that actually projected value data", () => {
  const authority = fs.readFileSync(path.join(root, "src/services/fan-data-authority-service.js"), "utf8");
  assert.match(authority, /const valueFanIds = rows\.filter\(\(row\) => row\.value\)\.map\(\(row\) => row\.onlyFansUserId\)/);
  const calls = authority.match(/fanIds: valueFanIds/g) || [];
  assert.equal(calls.length, 2, "both SQL production and adapter fallback paths must scope healing to value observations");
  assert.doesNotMatch(authority, /fanIds: touchedFanIds/);
});
