"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const events = [];
const originalLoad = Module._load;
Module._load = function (request, parent, main) {
  if (request === "./desktop-control-events") return { publishDesktopControlEvent: (event) => events.push(event) };
  return originalLoad.call(this, request, parent, main);
};
const repo = require("./job-planning-repository");
const service = require("./analytics-recurring-planning-service");
Module._load = originalLoad;

test("Analytics job publication waits for commit and discards rolled-back jobs", async () => {
  events.length = 0;
  await assert.rejects(() => repo.afterPlanningCommit(async () => {
    repo.publishPlannedJobAvailable({ id: "rollback", agencyId: "a" });
    assert.equal(events.length, 0);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(events.length, 0);
  await repo.afterPlanningCommit(async () => {
    repo.publishPlannedJobAvailable({ id: "committed", agencyId: "a" });
    await repo.afterPlanningCommit(async () => repo.publishPlannedJobAvailable({ id: "committed", agencyId: "a" }));
    assert.equal(events.length, 0);
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].jobId, "committed");
});

function fixture({ expireAtFinal = false } = {}) {
  const now = new Date("2026-09-23T12:00:00Z");
  const item = { id: "work", workClass: "CREATOR_RECURRING_PLANNING", creatorId: "creator", agencyId: "agency", ownerToken: "owner", claimFence: 2n, claimedRevision: 3n };
  const trace = [];
  let fences = 0;
  let rolledBack = false;
  const tx = { $queryRawUnsafe: async (sql) => {
    if (/FROM "Agency"/.test(sql)) { trace.push("agency"); return [{ id: item.agencyId }]; }
    if (/FROM "CreatorAccount"/.test(sql)) { trace.push("creator"); return [{ id: item.creatorId }]; }
    if (/FROM "DomainWorkItem"/.test(sql)) {
      fences += 1; trace.push("work-lock");
      return [{ ...item, state: "CLAIMED", requestedRevision: 3n, activeGeneration: "phase2_domain_work_v3_actual55", leaseUntil: new Date(now.getTime() + (expireAtFinal && fences > 1 ? -1 : 60_000)) }];
    }
    assert.match(sql, /clock_timestamp/); trace.push("clock"); return [{ authorityNow: now }];
  } };
  const db = { $queryRawUnsafe: tx.$queryRawUnsafe, $transaction: async (work) => {
    try { const r = await work(tx); trace.push("commit"); return r; }
    catch (e) { rolledBack = true; trace.push("rollback"); throw e; }
  } };
  return { db, tx, item, now, trace, get rolledBack() { return rolledBack; } };
}

test("Analytics planning locks tenant then creator then live work; failure after planning rolls back", async (t) => {
  const earnings = require("./analytics-collection-planner");
  const analytics = require("./creator-analytics-sync-orchestrator");
  t.mock.method(earnings, "ensureOperationalAnalyticsFreshness", async ({ db }) => {
    assert.equal(typeof db.$transaction, "undefined");
    repo.publishPlannedJobAvailable({ id: "planned", agencyId: "agency" }); return { created: 1 };
  });
  t.mock.method(analytics, "ensureRecurringCreatorAnalyticsCatchups", async () => ({ created: [], skipped: [] }));
  events.length = 0;
  const f = fixture({ expireAtFinal: true });
  await assert.rejects(() => service.planRecurringCreatorAnalytics({ db: f.db, item: f.item, now: f.now }), { code: "ANALYTICS_PLANNING_CLAIM_LOST" });
  assert.equal(f.rolledBack, true);
  assert.deepEqual(f.trace.slice(0, 4), ["agency", "creator", "work-lock", "clock"]);
  assert.equal(events.length, 0);
});

test("Analytics successful plan commits before announcing its jobs", async (t) => {
  const f = fixture();
  const earnings = require("./analytics-collection-planner");
  const analytics = require("./creator-analytics-sync-orchestrator");
  events.length = 0;
  t.mock.method(earnings, "ensureOperationalAnalyticsFreshness", async () => {
    repo.publishPlannedJobAvailable({ id: "committed-plan", agencyId: "agency" }); return { created: 1 };
  });
  t.mock.method(analytics, "ensureRecurringCreatorAnalyticsCatchups", async ({ reserveCampaignDirectory }) => {
    assert.equal(typeof reserveCampaignDirectory, "function"); assert.equal(events.length, 0); return { created: ["notifications"], skipped: [] };
  });
  const result = await service.planRecurringCreatorAnalytics({ db: f.db, item: f.item, now: f.now });
  assert.equal(result.created, 2);
  assert.equal(f.trace.at(-1), "commit");
  assert.equal(events.length, 1);
});

test("Analytics unavailable transaction fails closed before any planning", async () => {
  await assert.rejects(() => service.planRecurringCreatorAnalytics({ db: {}, item: {} }), { code: "ANALYTICS_PLANNING_TRANSACTION_REQUIRED" });
});

test("an unrelated work class cannot authorize Analytics planning", async () => {
  const f = fixture();
  f.item.workClass = "CUSTOM_REMINDER";
  await assert.rejects(() => service.planRecurringCreatorAnalytics({ db: f.db, item: f.item, now: f.now }), { code: "ANALYTICS_PLANNING_SCOPE_MISMATCH" });
  assert.equal(f.rolledBack, true);
});

test("directory admission sends a fixed-size reservation independent of catalog size", async () => {
  const now = new Date("2026-09-23T12:34:00Z");
  const calls = [];
  const db = { $queryRawUnsafe: async (sql, ...args) => {
    if (/SELECT clock_timestamp/.test(sql)) return [{ authorityNow: now }];
    calls.push({ sql, args }); return [];
  } };
  assert.equal(await service.reserveDirectoryAdmission({ db, state: { campaignDirectoryCampaignCount: 2000 }, now }), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0].toISOString(), "2026-09-23T12:00:00.000Z");
  assert.equal(calls[0].args[1], 41);
  assert.match(calls[0].sql, /ON CONFLICT/);
  assert.match(calls[0].sql, /"reservedJobs" < 100/);
});
