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
  assert.match(scheduler, /\["creatorRecurringPlanning", \(\) => runRecurringCreatorWork/);
  assert.match(scheduler, /runRecurringSweep\(\)[\s\S]*\.then\(handleRecurringSweepTickResult\)/);
  assert.match(scheduler, /sweep resolved degraded/);
  assert.match(scheduler, /getRecurringSchedulerHealthSnapshot/);
});

test("A35 recurring work closes physical Creator deletion without an absent-identity UPDATE", () => {
  const migration = source("prisma/migrations/20260922170000_phase3_a35_creator_recurring_delete_closure_v1/migration.sql");
  const fixture = source("scripts/audit/phase3-postgres-proof-fixture-authority.js");
  const deleteStart = migration.indexOf("IF TG_OP='DELETE' THEN");
  const deleteEnd = migration.indexOf("END IF;", deleteStart);
  const deleteBranch = migration.slice(deleteStart, deleteEnd);

  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  assert.match(deleteBranch, /DELETE FROM "DomainWorkItem"/);
  assert.match(deleteBranch, /"workClass"=v_work_class/);
  assert.match(deleteBranch, /"objectType"='CreatorAccount'/);
  assert.match(deleteBranch, /"objectId"=OLD\."id"/);
  assert.doesNotMatch(deleteBranch, /UPDATE "DomainWorkItem"/);
  assert.match(migration, /IF v_old_eligible AND NOT \(v_new_eligible AND v_same_identity\)[\s\S]*UPDATE "DomainWorkItem"/);

  const drainCall = fixture.indexOf("drainPhase3PostgresAgencyDomainWork(tx, id)", fixture.indexOf("async function cleanupPhase3PostgresAgencyFixture"));
  const creatorDelete = fixture.indexOf("tx.creatorAccount.deleteMany", drainCall);
  const agencyDelete = fixture.indexOf("tx.agency.deleteMany", creatorDelete);
  assert.ok(drainCall >= 0 && creatorDelete > drainCall && agencyDelete > creatorDelete,
    "fixture teardown must drain DomainWork, then Creators, then Agency");
});

test("A34 Hidden status has one canonical writer boundary and an atomic projection migration", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const likes = source("src/services/likes-service.js");
  const admin = source("src/routes/admin-data.js");
  const migration = source("prisma/migrations/20260922120000_phase3_a34_source_scale_closure_v1/migration.sql");
  const setterStart = subscriber.indexOf("async function setHiddenOnlineStatus");
  const setterEnd = subscriber.indexOf("module.exports", setterStart);
  const setter = subscriber.slice(setterStart, setterEnd);

  assert.match(setter, /runWithAutomationWriteCommitFence/);
  assert.match(setter, /lockSubscriberPublicationCreator/);
  assert.match(setter, /tx\.hiddenOnlineUser\.upsert/);
  assert.doesNotMatch(setter, /automationBumpFanState\.upsert/);
  assert.match(subscriber, /lockDbAdvisoryXact\(\{ db, key: `subscriber-publication:/);
  assert.doesNotMatch(subscriber, /pg_advisory_xact_lock/);
  assert.doesNotMatch(likes, /automationBumpFanState\.findMany/);

  assert.match(migration, /phase3_project_hidden_status_to_bump/);
  assert.match(migration, /HiddenOnlineUser_status_authority_check/);
  assert.match(migration, /a34_bump_status_migration/);
  assert.match(migration, /trg_phase3_hidden_status_projection/);
  assert.match(migration, /CREATOR_RECURRING_PLANNING/);
  assert.match(migration, /trg_phase3_creator_recurring_work/);
  assert.match(migration, /FROM "CreatorAccount" c[\s\S]*WHERE c\."status"='READY'/);

  assert.match(admin, /hiddenOnlineUser:[^\n]*deleteProtected:\s*true/);
  assert.match(admin, /followBackTask:[^\n]*deleteProtected:\s*true/);
  assert.match(admin, /if \(m\.deleteProtected\)[\s\S]*ADMIN_DELETE_PROTECTED/);
  assert.match(admin, /hiddenOnlineUser\.findMany\(\{ where: \{ fanId: q \}/);
  assert.doesNotMatch(admin, /hiddenOnlineUser\.findMany\(\{ where: \{ OR:/);
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
