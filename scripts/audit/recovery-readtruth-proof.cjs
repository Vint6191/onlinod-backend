"use strict";
// Actual schema, job/activity triggers, publication worker and reader. Only
// synthetic facts are used; no live database or provider is contacted.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const keep = setInterval(() => {}, 1000), checks = [];
const deadline = setTimeout(() => { console.error("RECOVERY_READTRUTH_PROOF_DEADLINE"); process.exit(2); }, 180000);
const pass = name => { checks.push(name); console.log("PASS", name); };
async function main() {
  const f = await fixture(), { db, root } = f;
  const report = { ok: false, nativePostgres: false, productionAccessed: false, checks };
  try {
    const s = await scope(db), now = new Date(), day = now.toISOString().slice(0, 10), old = new Date(+now - 3 * 86400000);
    require.cache[require.resolve(path.join(root, "src/prisma"))] = { exports: db };
    const publication = require("../../src/services/analytics-fact-publication-service");
    const work = require("../../src/services/domain-work-authority-service");
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const overview = require("../../src/services/creator-overview-service");
    const { evaluateCollection } = require("../../src/services/financial-receipt-authority");
    const { stateVocabulary } = require("../../src/services/analytics-state-evaluator");
    const commit = fn => runRootCommit(db, ({ tx }) => fn(tx));
    const read = () => publication.readPublishedDays({ db, creatorId: s.creatorId, from: day, to: day });
    const collection = evaluateCollection({ status: "COMPLETE", baselineVerifiedAt: old, baselineObservedAt: old,
      receiptCoverageVersion: 1, recentRangeTo: old, coverageThrough: old, historyAuditObservedAt: old }, now, 86400000);
    assert.equal(collection.proven, true); assert.equal(stateVocabulary(collection), "STALE");
    await commit(async tx => {
      for (const [kind, row] of [["CreatorFinancialTransaction", { id: "truth-money", ...s, occurredAt: now.toISOString(), transactionType: "tip", transactionStatus: "settled", amountCents: 1000, netCents: 800 }],
        ["CreatorPostLike", { id: "truth-like", ...s, likedAt: now.toISOString(), fanId: "truth-fan" }]])
        await tx.$executeRawUnsafe('SELECT "analytics_stage_fact_v1"($1,$2::jsonb,FALSE,FALSE)', kind, JSON.stringify(row));
    });
    assert.equal((await read()).scopes.financial.state, "UPDATING"); assert.equal((await read()).scopes.activity.state, "UPDATING");
    await db.domainWorkClaimTopologyState.update({ where: { id: work.DOMAIN_WORK_CLAIM_TOPOLOGY_ID }, data: { activationState: "BUILDING" } });
    const blocked = await publication.runSweep({ db });
    assert.equal(blocked.ok, false); assert.equal(blocked.reason, "domain_work_claim_topology_building");
    assert.deepEqual(blocked.blockedWorkClasses, [publication.WORK_CLASS, publication.ADOPTION_CLASS]);
    assert.equal((await read()).scopes.financial.state, "UPDATING");
    pass("unavailable publication topology reports a blocked lane while dirty money remains unavailable");
    await db.domainWorkClaimTopologyState.update({ where: { id: work.DOMAIN_WORK_CLAIM_TOPOLOGY_ID }, data: { activationState: "ACTIVE" } });
    const sweep = await publication.runSweep({ db });
    assert.equal(sweep.ok, true); assert.equal((await read()).scopes.financial.ready, true); assert.equal((await read()).scopes.activity.ready, true);
    assert.equal((await read()).financialGroups[0]._sum.netCents, 800);
    assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId } }), 0);
    pass("actual publication clears UPDATING and exposes completed money without a new desktop collection job");

    // Recreate the old persisted activity omission using the actual previous
    // SQL trigger, then apply the current migration with unchanged source jobs.
    const baseline = fs.readFileSync(path.join(root, "prisma/migrations/20261009000000_current_baseline/migration.sql"), "utf8");
    const start = baseline.indexOf("CREATE OR REPLACE FUNCTION public.onlinod_sync_creator_task_activity()");
    const oldTrigger = baseline.slice(start, baseline.indexOf("$function$;", start) + "$function$;".length);
    await db.$disconnect(); await f.waitForIdle(); await f.engine.exec(oldTrigger);
    const job = await commit(tx => tx.jobInstance.create({ data: { id: "truth-subscriber", agencyId: s.agencyId, creatorId: s.creatorId,
      jobKey: "subscriber_directory_scan", scope: "CREATOR", status: "CLAIMED", startedAt: old, claimedAt: old, lastProgressAt: old,
      leaseUntil: new Date(+now + 60000), leaseTokenHash: "synthetic-lease", leaseRevision: 2, continuation: { page: 4 }, progress: { message: "Collecting subscribers" } } }));
    await commit(tx => tx.jobInstance.update({ where: { id: job.id }, data: { status: "PUBLISHING", lastProgressAt: old, updatedAt: old, progress: { message: "Publishing subscriber snapshot" } } }));
    await commit(tx => tx.jobInstance.create({ data: { id: "truth-done", agencyId: s.agencyId, creatorId: s.creatorId,
      jobKey: "subscriber_directory_scan", scope: "CREATOR", status: "DONE", startedAt: old, completedAt: old, updatedAt: old } }));
    await commit(tx => tx.jobInstance.create({ data: { id: "truth-no-progress", agencyId: s.agencyId, creatorId: s.creatorId,
      jobKey: "dialog_intelligence_scan", scope: "CREATOR", status: "CLAIMED", startedAt: old, claimedAt: old, lastProgressAt: null } }));
    assert.equal((await overview.readCreatorCurrentTask({ db, creatorId: s.creatorId })).id, job.id,
      "a nullable timestamp must not rank an old unobserved task ahead of real progress");
    pass("current task ranks actual progress before missing progress timestamps");
    const sourceBefore = await db.jobInstance.findUnique({ where: { id: job.id } });
    const doneBefore = await db.creatorTaskActivity.findUnique({ where: { jobId: "truth-done" } });
    assert.equal((await overview.readCreatorCurrentTask({ db, creatorId: s.creatorId })).rawStatus, "PUBLISHING");
    assert.equal((await db.creatorTaskActivity.findUnique({ where: { jobId: job.id } })).status, "CLAIMED");
    const migration = fs.readFileSync(path.join(root, "prisma/migrations/20261020000000_recovery_liveness/migration.sql"), "utf8");
    await db.$disconnect(); await f.waitForIdle(); await f.engine.exec(migration);
    const recovered = await db.creatorTaskActivity.findUnique({ where: { jobId: job.id } });
    assert.equal(recovered.status, "PUBLISHING"); assert.equal(recovered.detail, "Publishing subscriber snapshot");
    assert.equal(+recovered.updatedAt, +sourceBefore.updatedAt, "installation must not fabricate current progress");
    assert.deepEqual(await db.jobInstance.findUnique({ where: { id: job.id } }), sourceBefore, "leases, cursor and source status stay authoritative");
    assert.deepEqual(await db.creatorTaskActivity.findUnique({ where: { jobId: "truth-done" } }), doneBefore);
    await db.$disconnect(); await f.waitForIdle(); await f.engine.exec(migration);
    assert.deepEqual(await db.creatorTaskActivity.findUnique({ where: { jobId: job.id } }), recovered);
    pass("migration repairs only current PUBLISHING activity, preserves source timestamps/jobs and is idempotent");
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Tokyo'");
      await tx.jobInstance.update({ where: { id: job.id }, data: { progress: { message: "Publishing subscribers page 5" }, lastProgressAt: now } });
    });
    const progressed = await db.creatorTaskActivity.findUnique({ where: { jobId: job.id } });
    assert.equal(progressed.status, "PUBLISHING"); assert.equal(progressed.detail, "Publishing subscribers page 5");
    assert(Math.abs(+progressed.updatedAt - Date.now()) < 10000, "activity timestamp must be UTC even on a non-UTC connection");
    pass("ongoing PUBLISHING progress reaches task history with UTC timestamps");

    await commit(tx => tx.jobInstance.update({ where: { id: job.id }, data: { status: "DONE", completedAt: old, progress: { message: "Completed" } } }));
    const items = await overview.readCreatorTaskActivity({ db, creatorId: s.creatorId, now, day, authorityResolved: true });
    assert(items.length > 0); assert(items.every(row => row.day === day));
    assert.equal(items.find(row => row.jobId === job.id).completedAt, old.toISOString());
    const boundary = new Date(new Date(day).getTime() - 15 * 60000);
    await db.creatorTaskActivity.update({ where: { jobId: job.id }, data: { updatedAt: boundary } });
    const days = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Tokyo'");
      return overview.readCreatorTaskActivityDays({ db: tx, creatorId: s.creatorId, now, authorityResolved: true });
    });
    assert(days.includes(boundary.toISOString().slice(0, 10)));
    const selected = await overview.readCreatorTaskActivity({ db, creatorId: s.creatorId, now, day: boundary.toISOString().slice(0, 10), authorityResolved: true });
    assert(selected.some(row => row.jobId === job.id && row.day === boundary.toISOString().slice(0, 10)));
    pass("day selection, ordering and display use the same indexed UTC update timestamp while preserving completion time");
    const contract = await require("../../src/services/database-contract-service").readDatabaseContract(db);
    assert.equal(contract.ready, true, JSON.stringify(contract)); report.contract = contract;
    pass("current migration chain and function hashes satisfy the database contract");
    report.ok = true;
  } finally {
    await f.close(); const out = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || require("node:os").tmpdir(), "recovery-readtruth.json");
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keep); clearTimeout(deadline); });
