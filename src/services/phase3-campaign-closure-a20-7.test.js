"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { recordCampaignFanRefreshChunk, campaignFanValueCoverageFromState } = require("./campaign-fan-refresh-queue-service");
const preflight = require("../../scripts/database/phase3-campaign-coverage-generation-online-preflight");

const ROOT = path.resolve(__dirname, "../..");

function chunkDb(count, calls) {
  const fanIds = Array.from({ length: count }, (_, index) => `fan-${String(count - index).padStart(4, "0")}`);
  return {
    fanIds,
    db: {
      creatorFanRefreshDemand: {
        async findMany() { calls.demandFindMany += 1; throw new Error("production canonical chunk hook must not enter per-demand fallback"); },
        async update() { calls.demandUpdate += 1; throw new Error("production canonical chunk hook must not update demands per row"); },
      },
      creatorFan: {
        async findMany() { calls.fanFindMany += 1; throw new Error("production canonical chunk hook must not refetch fans through fallback"); },
      },
      creatorCampaignFanRefreshWork: {
        async findMany() { calls.workFindMany += 1; throw new Error("production canonical chunk hook must not refetch work through fallback"); },
        async updateMany() { calls.workUpdateMany += 1; throw new Error("production canonical chunk hook must not update work per demand"); },
      },
      creatorCampaignCollectionState: {},
      async $queryRawUnsafe(sql, ...args) {
        calls.raw += 1;
        const text = String(sql);
        if (/SELECT clock_timestamp\(\)/.test(text)) return [{ authorityNow: new Date("2040-04-01T00:00:00.000Z") }];
        assert.match(text, /WITH candidate AS/);
        assert.match(text, /demand_update AS/);
        assert.match(text, /work_update AS/);
        assert.match(text, /coverage_update AS/);
        assert.equal(args[0], "creator-1");
        assert.deepEqual(args[1], [...fanIds].sort(), "canonical chunk catch-up must lock/process opaque ids deterministically");
        return [{ healed: 0, workTransitioned: 0, coverageRunsUpdated: 0, coverageTransitionLost: 0 }];
      },
    },
  };
}

for (const count of [1, 20, 50]) {
  test(`A20.7 successful point-refresh chunk hook stays bounded for ${count} returned fans`, async () => {
    const calls = { raw: 0, demandFindMany: 0, demandUpdate: 0, fanFindMany: 0, workFindMany: 0, workUpdateMany: 0 };
    const { db, fanIds } = chunkDb(count, calls);
    const result = await recordCampaignFanRefreshChunk({
      db,
      job: { id: "refresh-job-1", jobKey: "fan_data_point_refresh", creatorId: "creator-1" },
      chunkResult: { items: fanIds.map((onlyFansUserId) => ({ onlyFansUserId, value: { availability: "AVAILABLE" } })) },
      applied: { type: "fan_data_point_refresh", ok: true, projected: count, valueProjected: count },
    });
    assert.equal(result.topology, "canonical_projection_v1");
    assert.equal(result.applied, 0);
    assert.equal(calls.raw, 0, "value-bearing production chunks were already reconciled by canonical projection and must add no DB round trips");
    assert.equal(calls.demandFindMany, 0);
    assert.equal(calls.demandUpdate, 0);
    assert.equal(calls.fanFindMany, 0);
    assert.equal(calls.workFindMany, 0);
    assert.equal(calls.workUpdateMany, 0);
  });
}

test("A20.7 canonical receipt keeps non-value item catch-up set-based instead of falling back per demand", async () => {
  const calls = { raw: 0, demandFindMany: 0, demandUpdate: 0, fanFindMany: 0, workFindMany: 0, workUpdateMany: 0 };
  const { db, fanIds } = chunkDb(50, calls);
  const result = await recordCampaignFanRefreshChunk({
    db,
    job: { id: "refresh-job-1", jobKey: "fan_data_point_refresh", creatorId: "creator-1" },
    chunkResult: { items: fanIds.map((onlyFansUserId) => ({ onlyFansUserId })) },
    applied: { type: "fan_data_point_refresh", ok: true, projected: 50, valueProjected: 0 },
  });
  assert.equal(result.topology, "canonical_set_based_catchup_v1");
  assert.equal(calls.raw, 2, "non-value catch-up is one DB clock + one set-based CTE");
  assert.equal(calls.demandFindMany, 0);
  assert.equal(calls.demandUpdate, 0);
});

test("A20.7 chunk hook keeps legacy direct/in-memory semantics when no canonical projection receipt exists", async () => {
  const source = fs.readFileSync(path.join(ROOT, "src/services/campaign-fan-refresh-queue-service.js"), "utf8");
  const start = source.indexOf("async function recordCampaignFanRefreshChunk");
  const end = source.indexOf("async function finalizeCampaignFanRefreshJob", start);
  const section = source.slice(start, end);
  assert.match(section, /canonicalProjectionCommitted/);
  assert.match(section, /reconcileCampaignFanRefreshDemandsFromCanonicalObservations/);
  assert.match(section, /const fans = await db\.creatorFan\.findMany/);
  assert.match(section, /for \(const demand of demands\)/, "compatibility fallback remains available for old in-memory adapters/direct tests");
});

test("A20.7 job-result authority passes the canonical projection receipt into the chunk hook", () => {
  const jobResult = fs.readFileSync(path.join(ROOT, "src/services/job-result-service.js"), "utf8");
  assert.match(jobResult, /const applied = await applyFanDataPointRefreshChunk\(\{ db: tx, job, deviceId, chunkResult \}\);/);
  assert.match(jobResult, /recordCampaignFanRefreshChunk\(\{ db: tx, job, chunkResult, applied \}\)/);
});

test("A20.7 nullable Campaign timestamps stay null instead of silently becoming Unix epoch", () => {
  const coverage = campaignFanValueCoverageFromState({
    fanValueCoverageScanRunId: "run-1",
    fanValueFreshnessCutoffAt: null,
  }, "run-1");
  assert.equal(coverage.cutoffAt, null);
});

test("A20.7 migration resolve tolerates only a proven concurrent peer apply", async () => {
  const concurrent = await preflight.resolveApplied({
    db: {},
    prismaEntry: "/tmp/fake-prisma.js",
    spawn: () => ({ status: 1, error: null }),
    isApplied: async () => true,
  });
  assert.deepEqual(concurrent, { resolved: false, concurrentPeer: true });

  await assert.rejects(
    () => preflight.resolveApplied({
      db: {},
      prismaEntry: "/tmp/fake-prisma.js",
      spawn: () => ({ status: 1, error: null }),
      isApplied: async () => false,
    }),
    /prisma migrate resolve exited 1/,
  );
});

test("A20.7 strict PostgreSQL proof now includes successful chunk post-projection idempotency", () => {
  const runner = fs.readFileSync(path.join(ROOT, "scripts/audit/phase3-a20-postgres-proof.js"), "utf8");
  const integration = fs.readFileSync(path.join(ROOT, "src/services/phase3-campaign-closure-a20-5.integration.test.js"), "utf8");
  assert.match(runner, /EXPECTED_PROOF_TEST_COUNT = 40/);
  assert.match(runner, /A20_7_POSTGRES_CHUNK_POST_PROJECTION/);
  assert.match(runner, /Number\(chunk\?\.queryRaw\) !== 0/);
  assert.match(integration, /canonical point-refresh projection plus chunk hook is idempotent and bounded/);
  assert.match(integration, /fanValueSucceeded, 50, "chunk hook must not double-increment coverage"/);
});
