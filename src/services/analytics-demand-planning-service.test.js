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
const { planAnalyticsDemandCreator } = require("./analytics-demand-planning-service");
Module._load = originalLoad;

function fixture({ expires = false, staleMember = false, newerRevision = false } = {}) {
  const now = new Date("2026-09-23T12:00:00Z");
  const member = { id: "member", userId: "user", agencyId: "agency", accessEpoch: 2, role: "OWNER", assignedCreators: "all" };
  const demand = { key: "demand", agencyId: "agency", claimToken: "owner", claimedRevision: 3, requestRevision: 3,
    requestedByMemberId: member.id, requestedAccessEpoch: 2, claimUntil: new Date(now.getTime() + 1000), cursorCreatorId: null };
  let row = { ...demand, requestRevision: newerRevision ? 4 : 3 };
  const jobs = [];
  const trace = [];
  let clocks = 0;
  const tx = {
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql) => {
      if (/FROM "Agency"/.test(sql)) { trace.push("agency"); return [{ id: "agency" }]; }
      for (const [table, id] of [["CreatorAccount", "creator"], ["User", "user"], ["AgencyMember", "member"], ["AnalyticsCollectionDemand", "demand"]]) {
        if (sql.includes(`FROM "${table}"`)) { trace.push(table); return [{ id }]; }
      }
      assert.match(sql, /^SELECT clock_timestamp/);
      clocks += 1;
      return [{ authorityNow: new Date(now.getTime() + (expires && clocks > 1 ? 2000 : 0)) }];
    },
    agencyMember: { findFirst: async () => ({ ...member, accessEpoch: staleMember ? 3 : 2 }) },
    creatorAccount: { findFirst: async () => ({ id: "creator" }) },
    analyticsCollectionDemand: {
      findUnique: async () => ({ ...row }),
      updateMany: async ({ where, data }) => {
        if (!(row.claimUntil > where.claimUntil.gt)) return { count: 0 };
        row = { ...row, ...data }; return { count: 1 };
      },
    },
  };
  const db = { $transaction: async (work) => {
    const before = { ...row };
    try { const result = await work(tx); trace.push("commit"); return result; }
    catch (error) { row = before; jobs.length = 0; trace.push("rollback"); throw error; }
  } };
  return { db, tx, now, member, demand, jobs, trace, creator: { id: "creator" }, get row() { return row; } };
}

function plannerStub(t, f) {
  t.mock.method(require("./analytics-collection-planner"), "ensureAnalyticsWindowFreshness", async ({ db }) => {
    assert.equal(db, f.tx);
    f.jobs.push("job");
    repo.publishPlannedJobAvailable({ id: "job", agencyId: "agency" });
    assert.equal(events.length, 0);
    return { created: 1, reused: 0, dueDays: 1 };
  });
}

test("Home planning commits jobs and cursor together before publishing availability", async (t) => {
  events.length = 0;
  const f = fixture(); plannerStub(t, f);
  assert.equal((await planAnalyticsDemandCreator(f)).created, 1);
  assert.equal(f.row.cursorCreatorId, "creator");
  assert.deepEqual(f.trace, ["agency", "CreatorAccount", "User", "AgencyMember", "AnalyticsCollectionDemand", "commit"]);
  assert.equal(events.length, 1);
});

test("Home planning expiry after job creation rolls back both jobs and cursor without notifications", async (t) => {
  events.length = 0;
  const f = fixture({ expires: true }); plannerStub(t, f);
  await assert.rejects(() => planAnalyticsDemandCreator(f), { code: "ANALYTICS_DEMAND_PLANNING_CLAIM_LOST" });
  assert.equal(f.row.cursorCreatorId, null);
  assert.deepEqual(f.jobs, []);
  assert.equal(events.length, 0);
  assert.equal(f.trace.at(-1), "rollback");
});

test("Home planning revalidates live member epoch and demand revision before touching jobs", async (t) => {
  t.mock.method(require("./analytics-collection-planner"), "ensureAnalyticsWindowFreshness", async () => assert.fail("stale authority planned a job"));
  await assert.rejects(() => planAnalyticsDemandCreator(fixture({ staleMember: true })), { code: "MANAGEMENT_ACCESS_STALE" });
  await assert.rejects(() => planAnalyticsDemandCreator(fixture({ newerRevision: true })), { code: "ANALYTICS_DEMAND_PLANNING_CLAIM_LOST" });
});

test("Home planning rejects an outer transaction client that cannot own commit", async () => {
  await assert.rejects(() => planAnalyticsDemandCreator({ db: {} }), { code: "ANALYTICS_DEMAND_TRANSACTION_REQUIRED" });
});
