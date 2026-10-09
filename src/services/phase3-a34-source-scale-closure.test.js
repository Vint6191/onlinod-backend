"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");







test("A34 scheduler outcome contract rejects malformed/nested failures without losing created work", async () => {
  const scheduler = require("./job-scheduler");
  const { SCHEDULER_OUTCOME, normalizeSchedulerDecision, executeSchedulerConsumer } = scheduler._test;

  const malformed = normalizeSchedulerDecision(null);
  assert.equal(malformed.outcome, SCHEDULER_OUTCOME.DEGRADED);
  assert.equal(malformed.reason, "malformed_planner_result");

  const nested = normalizeSchedulerDecision({
    ok: true,
    created: true,
    discovery: { ok: false, created: false, reason: "discovery_failed" },
    planning: { ok: true, created: true },
  });
  assert.equal(nested.outcome, SCHEDULER_OUTCOME.DEGRADED);
  assert.equal(nested.created, true);
  assert.equal(nested.failures[0].path, "result.discovery");

  const calls = [];
  const created = [];
  const skipped = [];
  const degraded = [];
  const outcomes = [];
  await executeSchedulerConsumer({
    work: "first", created, skipped, degraded, outcomes,
    execute: async () => { calls.push("first"); throw Object.assign(new Error("boom"), { code: "first_failed" }); },
  });
  await executeSchedulerConsumer({
    work: "second", created, skipped, degraded, outcomes,
    execute: async () => { calls.push("second"); return { ok: true, created: true, reason: "planned" }; },
  });
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].reason, "first_failed");
  assert.deepEqual(created, ["second"]);
});

test("A34 Likes resolves discovery and planning as one composite authority", () => {
  const { resolveAutomaticLikesResult } = require("./likes-service")._test;
  const discoveryFailed = resolveAutomaticLikesResult({
    discovery: { ok: false, created: true, reason: "discovery_failed" },
    planning: { ok: true, created: true },
  });
  assert.equal(discoveryFailed.ok, false);
  assert.equal(discoveryFailed.created, true);
  assert.equal(discoveryFailed.reason, "discovery_failed");

  const malformed = resolveAutomaticLikesResult({
    discovery: { created: false },
    planning: { ok: true, created: false },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "likes_substep_malformed");
});

test("A34 recurring creator planning is durable, bounded, fair and timer-visible", () => {
  const scheduler = source("src/services/job-scheduler.js");
  const domain = source("src/services/domain-work-authority-service.js");
  const subscriber = source("src/services/subscriber-directory-service.js");
  const start = scheduler.indexOf("async function runRecurringCreatorWork");
  const end = scheduler.indexOf("async function runPhase2MaintenancePump", start);
  const recurring = scheduler.slice(start, end);
  assert.match(domain, /CREATOR_RECURRING_PLANNING/);
  assert.match(recurring, /claimDomainWorkBatch\([\s\S]*CREATOR_RECURRING_PLANNING/);
  assert.match(recurring, /perAgencyQuantum/);
  assert.match(recurring, /perPartitionQuantum:\s*1/);
  assert.match(recurring, /Math\.min\(100/);
  assert.match(recurring, /heartbeatDomainWorkClaim/);
  assert.match(recurring, /failDomainWorkClaim/);
  assert.match(recurring, /yieldDomainWorkClaim/);
  assert.doesNotMatch(recurring, /creatorAccount\.findMany/);
  assert.match(scheduler, /ensureSubscriberScanDue\(\{\s*db,/);
  assert.match(subscriber, /async function ensureSubscriberScanDue\(\{ db = prisma,/);
  assert.match(subscriber, /async function scheduleSubscriberScan\(\{\s*db = prisma,/);
  const lane = require('./maintenance-lane-registry').MAINTENANCE_LANES.find(lane => lane.name === 'creatorRecurringPlanning');
  assert.equal(lane.module, './job-scheduler'); assert.equal(lane.method, 'runRecurringCreatorWork');
  assert.match(scheduler, /resolveMaintenanceLanes/);
  assert.match(scheduler, /runRecurringSweep\(\)[\s\S]*\.then\(handleRecurringSweepTickResult\)/);
  assert.match(scheduler, /sweep resolved degraded/);
  assert.match(scheduler, /getRecurringSchedulerHealthSnapshot/);
});









test("A36 fixture generation classifier accepts only complete legacy or exact-claim generations", () => {
  const {
    PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE,
    classifyPhase3PostgresDestructiveFixtureAuthority,
  } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");

  assert.throws(() => classifyPhase3PostgresDestructiveFixtureAuthority({}), {code:'PHASE3_POSTGRES_FIXTURE_GENERATION_DRIFT'});
  assert.equal(
    classifyPhase3PostgresDestructiveFixtureAuthority({
      topologyMigrationApplied: true,
      exactMigrationApplied: true,
      topologyTablePresent: true,
      exactFunctionInstalled: true,
    }).mode,
    PHASE3_DESTRUCTIVE_FIXTURE_AUTHORITY_MODE.EXACT_LIVE_CLAIM,
  );

  for (const partial of [
    { topologyMigrationApplied: true, topologyTablePresent: true },
    { exactMigrationApplied: true, exactFunctionInstalled: true },
    { topologyTablePresent: true },
    { exactFunctionInstalled: true },
  ]) {
    assert.throws(
      () => classifyPhase3PostgresDestructiveFixtureAuthority(partial),
      (error) => error?.code === "PHASE3_POSTGRES_FIXTURE_GENERATION_DRIFT",
    );
  }
});





test("A34 resolved degradation updates scheduler health instead of disappearing in a fulfilled promise", () => {
  const scheduler = require("./job-scheduler");
  const { recordRecurringSchedulerHealth, handleRecurringSweepTickResult } = scheduler._test;
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = { ok: false, reason: "likes_failed", degradedComponents: [{ component: "recurringCreatorWork", reason: "likes_failed" }] };
    const health = recordRecurringSchedulerHealth(result);
    handleRecurringSweepTickResult(result);
    assert.equal(health.status, "DEGRADED");
    assert.equal(health.lastReason, "likes_failed");
    assert.ok(health.consecutiveDegraded >= 1);
    assert.ok(lines.some((line) => line.includes("sweep resolved degraded")));
  } finally {
    console.error = original;
  }
});

test("Home demand fulfilled failure and rejection remain visible across healthy recurring ticks and skipped overlap", () => {
  const scheduler = require("./job-scheduler");
  const { handleAnalyticsDemandTickResult, recordRecurringSchedulerHealth } = scheduler._test;
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const failed = { ok: false, failures: 2, reason: "analytics_demand_processing_failed", errors: [{ reason: "P1001" }] };
    handleAnalyticsDemandTickResult(failed);
    handleAnalyticsDemandTickResult(failed);
    recordRecurringSchedulerHealth({ ok: true });
    handleAnalyticsDemandTickResult({ ok: true, skipped: true });
    let health = scheduler.getRecurringSchedulerHealthSnapshot();
    assert.equal(health.status, "DEGRADED");
    assert.equal(health.analyticsDemand.failures, 2);
    assert.equal(health.analyticsDemand.consecutiveDegraded, 2);
    assert.equal(lines.length, 1, "identical errors must not flood every timer tick");
    handleAnalyticsDemandTickResult(null, Object.assign(new Error("connection lost"), { code: "P1001" }));
    health = scheduler.getRecurringSchedulerHealthSnapshot();
    assert.equal(health.lastReason, "P1001");
    assert.equal(lines.length, 2);
    handleAnalyticsDemandTickResult({ ok: true, skipped: false });
    assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().status, "HEALTHY");
    assert.match(source("src/services/job-scheduler.js"), /runAnalyticsCollectionDemandSweep\(\{ db: prisma \}\)[\s\S]*?\.then\(\(result\) => handleAnalyticsDemandTickResult\(result\)\)/);
  } finally {
    handleAnalyticsDemandTickResult({ ok: true });
    console.error = original;
  }
});
