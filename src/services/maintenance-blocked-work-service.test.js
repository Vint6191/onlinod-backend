"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
require.cache[require.resolve("../prisma")] = { exports: {} };
const { withBlockedWorkHealth } = require("./maintenance-blocked-work-service");
const { createMaintenanceHealth } = require("./maintenance-health-service");

test("empty claims cannot hide canonical publication quarantine, including after process restart", async () => {
  const health = createMaintenanceHealth();
  const db = { async $queryRawUnsafe(sql, classes) {
    assert.match(sql, /CROSS JOIN LATERAL/);
    assert.match(sql, /LIMIT 1/);
    assert.deepEqual(classes, ["ANALYTICS_FACT_PUBLICATION", "ANALYTICS_FACT_ADOPTION"]);
    return [{ workClass: "ANALYTICS_FACT_PUBLICATION", id: "private-work-id" }];
  } };
  const result = await withBlockedWorkHealth({ db, lane: "analyticsFactPublication", result: { ok: true, processed: 0 } });
  health.record({ ok: false, analyticsFactPublication: result });
  assert.equal(health.snapshot().status, "DEGRADED");
  assert.match(health.snapshot().lastReason, /DOMAIN_WORK_RECONCILE_REQUIRED/);
  assert.doesNotMatch(JSON.stringify(result), /private-work-id/);
  const repaired = await withBlockedWorkHealth({ db: { $queryRawUnsafe: async () => [] }, lane: "analyticsFactPublication", result: { ok: true, processed: 0 } });
  health.record({ ok: true, analyticsFactPublication: repaired });
  assert.equal(health.snapshot().status, "HEALTHY");
});

test("blocked work preserves actual execution failures and unrelated lanes do not probe", async () => {
  const result = await withBlockedWorkHealth({ db: { $queryRawUnsafe: async () => [{ workClass: "CREATOR_RECURRING_PLANNING" }] },
    lane: "creatorRecurringPlanning", result: { ok: false, reason: "SQL_TIMEOUT", errors: 1 } });
  assert.equal(result.reason, "SQL_TIMEOUT");
  assert.equal(result.errors, 1);
  assert.deepEqual(result.blockedWorkClasses, ["CREATOR_RECURRING_PLANNING"]);
  const other = { ok: true, processed: 0 };
  assert.equal(await withBlockedWorkHealth({ db: { $queryRawUnsafe: () => { throw Error("unexpected probe"); } }, lane: "messageLibraryTrash", result: other }), other);
});
