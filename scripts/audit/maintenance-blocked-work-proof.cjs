"use strict";
const assert = require("node:assert/strict");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");

async function main() {
  const f = await fixture();
  try {
    const identity = await scope(f.db);
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const { publishDomainWork } = require("../../src/services/domain-work-authority-service");
    const { withBlockedWorkHealth } = require("../../src/services/maintenance-blocked-work-service");
    const { createMaintenanceHealth } = require("../../src/services/maintenance-health-service");
    const classes = ["CREATOR_RECURRING_PLANNING", "ANALYTICS_PUBLICATION", "ANALYTICS_FACT_PUBLICATION", "ANALYTICS_FACT_ADOPTION"];
    await runRootCommit(f.db, async ({ tx }) => {
      for (const workClass of classes) await publishDomainWork({ db: tx, ...identity,
        workClass, objectType: "CreatorAccount", objectId: identity.creatorId, partitionKey: identity.creatorId });
      await tx.domainWorkItem.updateMany({ where: { agencyId: identity.agencyId, workClass: { in: classes } },
        data: { state: "RECONCILE_REQUIRED", errorClass: "CONTRACT", terminalCause: "INVALID_FIXTURE_INPUT" } });
    });
    const health = createMaintenanceHealth();
    for (const lane of ["creatorRecurringPlanning", "analyticsPublication", "analyticsFactPublication"]) {
      const result = await withBlockedWorkHealth({ db: f.db, lane, result: { ok: true, processed: 0 } });
      assert.equal(result.ok, false); assert.equal(result.reason, "DOMAIN_WORK_RECONCILE_REQUIRED");
      health.record({ ok: false, [lane]: result });
    }
    assert.equal(health.snapshot().status, "DEGRADED");
    await f.db.domainWorkItem.updateMany({ where: { agencyId: identity.agencyId, workClass: { in: classes } },
      data: { state: "DONE", isOutstanding: false, completedRevision: 1n } });
    for (const lane of ["creatorRecurringPlanning", "analyticsPublication", "analyticsFactPublication"]) {
      const result = await withBlockedWorkHealth({ db: f.db, lane, result: { ok: true, processed: 0 } });
      assert.equal(result.ok, true); health.record({ ok: true, [lane]: result });
    }
    assert.equal(health.snapshot().status, "HEALTHY");
    const queries = f.queries.filter(row => row.query.includes("CROSS JOIN LATERAL"));
    assert.equal(queries.length, 6);
    assert.ok(queries.every(row => /LIMIT 1/.test(row.query)));
    console.log("PASS actual SQL: quarantined planning/publication cannot become healthy on an empty poll; canonical completion clears it");
  } finally { await f.close(); }
}
const keep = setInterval(() => {}, 1000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keep));
