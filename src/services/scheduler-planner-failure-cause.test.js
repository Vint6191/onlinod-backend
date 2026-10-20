"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { attachSchedulerFailureCause, readSchedulerFailureCause, SCHEDULER_FAILURE_CAUSE } = require("./scheduler-failure-cause");
const { isTransientDatabaseError } = require("./db-retry-policy");
const { domainWorkFailureOutcome } = require("./domain-work-failure-policy");
const { scheduleDurableFanDataRefreshDebt } = require("./fan-data-authority-service");
const { _test: { executeSchedulerConsumer } } = require("./job-scheduler");

const temporary = (code = "P2024") => Object.assign(new Error("controlled database outage"), { code });
const scope = { agencyId: "agency", creatorId: "creator" };

// Exercise the actual public service functions and their result wrappers. Only
// their storage/transaction boundaries are replaced; the refresh scheduler and
// failure policy remain production implementations.
function loadService(name, overrides = {}) {
  const file = require.resolve(name), cached = require.cache[file], original = Module._load;
  delete require.cache[file];
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === file && Object.hasOwn(overrides, request)) return overrides[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(name); }
  finally {
    Module._load = original;
    if (cached) require.cache[file] = cached;
    else delete require.cache[file];
  }
}

const settings = { automatic: true, refollowEnabled: true, huntingEnabled: true, discoveryBatchSize: 10,
  dailyLimit: 50, candidateBatchSize: 10, onlineEnabled: true, hiddenOnlineEnabled: true, paidSubscribersEnabled: true };
const control = { effective: { likesEnabled: true, sfsEnabled: true, followBackEnabled: true, followEnabled: true, bumpsEnabled: true },
  modules: Object.fromEntries(["likes", "sfs", "follow_back", "follow", "bumps"].map(key => [key, { settings }])), workspace: { settings: {} } };
const controlAdapter = { getAutomationControlSnapshot: async () => control, requireCreator: async () => ({}),
  assertAutomationEnabled: async () => control, normalizeLikesSettings: value => value, normalizeSfsSettings: value => value };

async function schedulerOutcome(execute) {
  const created = [], skipped = [], degraded = [], outcomes = [];
  const result = await executeSchedulerConsumer({ work: "likes_plan", execute, created, skipped, degraded, outcomes });
  assert.equal(degraded.length, 1);
  const cause = degraded[0][SCHEDULER_FAILURE_CAUSE];
  const failure = Object.assign(cause ? new AggregateError([cause], "planner failed") : new Error("planner failed"),
    { code: "CREATOR_RECURRING_PLANNING_DEGRADED" });
  return { result, degraded, policy: domainWorkFailureOutcome({ error: failure, workClass: "CREATOR_RECURRING_PLANNING", consecutiveFailures: 12 }) };
}

test("actual Likes control outage reaches scheduler retry policy without adding Error fields to the DTO", async () => {
  const error = temporary();
  const service = loadService("./likes-service", { "./automation-control-service": {
    ...controlAdapter, getAutomationControlSnapshot: async () => { throw error; },
  } });
  const outcome = await schedulerOutcome(() => service.ensureAutomaticLikes({ ...scope, db: {} }));
  assert.equal(readSchedulerFailureCause(outcome.result.decision), error);
  assert.equal(outcome.policy.state, "READY");
  assert.equal(outcome.policy.errorClass, "TRANSIENT_DATABASE");
  assert.equal(JSON.stringify(outcome.result.decision), '{"ok":false,"created":false,"reason":"P2024"}');
  assert.deepEqual(Object.keys(outcome.result.decision), ["ok", "created", "reason"]);
});

test("actual SFS control outage stays a typed thrown error at the scheduler boundary", async () => {
  const error = temporary("P1001");
  const service = loadService("./sfs-service", { "./automation-control-service": {
    ...controlAdapter, getAutomationControlSnapshot: async () => { throw error; },
  } });
  const outcome = await schedulerOutcome(() => service.ensureAutomaticSfs({ ...scope, db: {} }));
  assert.equal(outcome.degraded[0][SCHEDULER_FAILURE_CAUSE], error);
  assert.equal(outcome.policy.state, "READY");
});

for (const [name, method] of [["likes", "ensureAutomaticLikes"], ["sfs", "ensureAutomaticSfs"]]) {
  test(`actual ${name} discovery/planning wrappers retain all errors and keep mixed contract failures bounded`, async () => {
    for (const failures of [[temporary(), null], [null, temporary()], [temporary(), temporary("P1001")],
      [temporary(), new TypeError("invalid planner contract")]]) {
      let calls = 0;
      const service = loadService(`./${name}-service`, {
        "./automation-control-service": controlAdapter,
        "./db-transaction-service": {
          runDbTransaction: async (db, work) => work(db),
          withDbAdvisoryXactLock: async () => {
            const error = failures[calls++];
            if (error) throw error;
            return { ok: true, created: false, refreshFanIds: [] };
          },
        },
        "./job-planning-repository": { afterPlanningCommit: work => work() },
        "./sfs-mutation-authority-service": { lockSfsScope: async () => {} },
      });
      const outcome = await schedulerOutcome(() => service[method]({ ...scope, db: {} }));
      assert.equal(calls, 2, "both independent substeps execute");
      for (const [index, key] of ["discovery", "planning"].entries()) {
        if (failures[index]) assert.equal(readSchedulerFailureCause(outcome.result.decision[key]), failures[index]);
      }
      const allSql = failures.filter(Boolean).every(isTransientDatabaseError);
      assert.equal(outcome.policy.state, allSql ? "READY" : "RECONCILE_REQUIRED");
      assert.doesNotMatch(JSON.stringify(outcome.result.decision), /"stack"|controlled database outage/);
    }
  });

  test(`${name} resolver cannot upgrade text-only errors, malformed substeps or mixed refresh debt`, async () => {
    const service = require(`./${name}-service`);
    const resolve = service._test[name === "likes" ? "resolveAutomaticLikesResult" : "resolveAutomaticSfsResult"];
    const sql = attachSchedulerFailureCause({ ok: false, reason: "P2024" }, temporary());
    for (const unproven of [{ ok: false, reason: "P2024" }, { ok: false, reason: "invalid_contract" }, null, {}]) {
      const result = resolve({ discovery: sql, planning: unproven });
      assert.equal(result.ok, false);
      assert.equal(readSchedulerFailureCause(result), null);
    }
    const debt = await scheduleDurableFanDataRefreshDebt({ ...scope, fanIds: ["42"], scheduleFanRefresh: async () => { throw temporary(); } });
    const result = resolve({ discovery: { ok: false, reason: "bad_snapshot" }, planning: { ok: true, fanRefresh: debt } });
    assert.equal(result.reason, "fan_refresh_debt_not_durable");
    assert.equal(readSchedulerFailureCause(result), null, "refresh SQL does not override independent contract failure");
    const onlyDebt = resolve({ discovery: { ok: true }, planning: { ok: true, fanRefresh: debt } });
    assert.equal(readSchedulerFailureCause(onlyDebt), readSchedulerFailureCause(debt));
  });
}

test("actual fan refresh debt preserves thrown/returned Errors but never manufactures evidence from a reason", async () => {
  const error = temporary();
  for (const scheduleFanRefresh of [async () => { throw error; },
    async () => attachSchedulerFailureCause({ ok: false, created: false, reason: "P2024" }, error)]) {
    const result = await scheduleDurableFanDataRefreshDebt({ ...scope, fanIds: ["42"], scheduleFanRefresh });
    assert.equal(result.durable, false);
    assert.equal(readSchedulerFailureCause(result), error);
    assert.doesNotMatch(JSON.stringify(result), /"stack"|controlled database outage/);
  }
  for (const decision of [{ ok: false, created: false, reason: "P2024" },
    attachSchedulerFailureCause({ ok: false, reason: "P2024" }, { code: "P2024" }),
    { created: true }]) {
    const result = await scheduleDurableFanDataRefreshDebt({ ...scope, fanIds: ["42"], scheduleFanRefresh: async () => decision });
    assert.equal(result.durable, false);
    assert.equal(readSchedulerFailureCause(result), null);
  }
});

for (const [name, method] of [["follow-back", "ensureAutomaticFollowBack"], ["follow-automation", "ensureAutomaticFollowAutomation"], ["bump", "ensureAutomaticBumps"]]) {
  test(`actual ${name} wrapper carries fan refresh failures through to scheduler while preserving contract rejection`, async () => {
    const service = loadService(`./${name}-service`, {
      "./automation-control-service": controlAdapter,
      "./db-transaction-service": { withDbAdvisoryXactLock: async () => ({ ok: true, summary: { created: 0 }, planned: 0, refreshFanIds: ["42"] }) },
    });
    const db = { subscriberDirectoryState: { findFirst: async () => ({ currentRunId: "run" }) }, deviceCreatorBinding: { count: async () => 1 } };
    const error = temporary();
    for (const typed of [true, false]) {
      const outcome = await schedulerOutcome(() => service[method]({ ...scope, db,
        scheduleFanRefresh: async () => { if (typed) throw error; return { created: false, reason: "P2024" }; } }));
      assert.equal(outcome.result.decision.ok, false);
      assert.equal(readSchedulerFailureCause(outcome.result.decision), typed ? error : null);
      assert.equal(outcome.policy.state, typed ? "READY" : "RECONCILE_REQUIRED");
      assert.doesNotMatch(JSON.stringify(outcome.result.decision), /"stack"|controlled database outage/);
    }
  });
}

test("actual Bumps source aggregation retains every source cause, including a nontransient failure", async () => {
  const errors = [temporary(), new TypeError("invalid source contract")];
  let calls = 0;
  const service = loadService("./bump-service", {
    "./automation-control-service": controlAdapter,
    "./db-transaction-service": { withDbAdvisoryXactLock: async () => { throw errors[calls++]; } },
  });
  const outcome = await schedulerOutcome(() => service.ensureAutomaticBumps({ ...scope, db: { deviceCreatorBinding: { count: async () => 1 } } }));
  assert.equal(calls, 2);
  assert.deepEqual(readSchedulerFailureCause(outcome.result.decision).errors, errors);
  assert.equal(outcome.policy.state, "RECONCILE_REQUIRED");
});
