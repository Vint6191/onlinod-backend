"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const keep = setInterval(() => {}, 1000);

(async () => {
  const fixture = await createScaleSqlRuntime();
  try {
    const { db } = fixture;
    const tenant = await scope(db);
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const { runDbTransaction } = require(root + "/src/services/db-transaction-service");
    const diagnostics = require(root + "/src/services/subscriber-recovery-diagnostics");
    const { subscriberPublicationDebtWhere } = require(root + "/src/services/subscriber-directory-service");
    const now = new Date(), old = new Date(+now - 3 * 24 * 60 * 60_000);
    const report = [];
    function pass(name, details = {}) { report.push(name); console.log(JSON.stringify({ name, ok: true, ...details })); }
    await db.$executeRawUnsafe(`INSERT INTO "SubscriberScanRun" (
      "id","agencyId","creatorId","status","hasMore","fanProjectionStatus","publicationStatus",
      "publicationGeneration","publicationJobReconciledAt","createdAt","updatedAt"
    ) SELECT 'diagnostic-history-'||n::text,$1,$2,'SUPERSEDED',false,'COMPLETE','COMPLETE',n,$3,$3,$3
      FROM generate_series(1,5000) n`, tenant.agencyId, tenant.creatorId, old);
    await db.jobInstance.create({ data: { id: "diagnostic-job", agencyId: tenant.agencyId, creatorId: tenant.creatorId,
      jobKey: "subscriber_directory_scan", scope: "creator", status: "PUBLISHING", params: { scanRunId: "diagnostic-run", token: "SHOULD_NOT_LEAK" },
      progress: { stage: "PUBLICATION", rawPayload: "SHOULD_NOT_LEAK" }, lastProgressAt: old,
    } });
    await db.subscriberScanRun.create({ data: { id: "diagnostic-run", agencyId: tenant.agencyId, creatorId: tenant.creatorId,
      jobId: "diagnostic-job", status: "RUNNING", hasMore: false, fanProjectionStatus: "COMPLETE", scannedCount: 20,
      fanProjectionCount: 20, fanProjectionCursorOffset: 20, nextOffset: 20, publicationGeneration: 5001,
      publicationStatus: "CURRENT", publicationCursorId: "opaque-row-20", updatedAt: old,
    } });
    await db.subscriberDirectoryState.create({ data: { agencyId: tenant.agencyId, creatorId: tenant.creatorId,
      status: "SCANNING", publicationGeneration: 5001, publishedGeneration: 5000, lastJobId: "diagnostic-job" } });
    await db.subscriberDirectoryMaintenanceSignal.create({ data: { id: "diagnostic-signal", agencyId: tenant.agencyId,
      creatorId: tenant.creatorId, kind: "RECOVERY", reason: "PUBLICATION_DEBT", attempts: 100, dueAt: old,
      claimToken: "DO_NOT_EXPOSE_OWNER", claimUntil: old, lastError: "SUBSCRIBER_RECOLLECTION_BLOCKED" } });
    const inspect = () => runDbTransaction(db, async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return diagnostics.inspectSubscriberRecoveryDiagnostics(tx, { ...tenant, now });
    }, { maxWait: 3000, timeout: 12000, statementTimeoutMs: 2000, isolationLevel: "RepeatableRead" });
    const priorSignal = await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { id: "diagnostic-signal" } });
    const first = await inspect();
    assert.equal(first.debtRun.id, "diagnostic-run");
    assert.equal(first.debtRun.cursorId, "opaque-row-20");
    assert.equal(first.latestRun.id, "diagnostic-run");
    assert.ok(first.blockers.includes("RECOVERY_ATTEMPT_LIMIT_REACHED"));
    assert.ok(first.blockers.includes("RECOVERY_OWNER_EXPIRED"));
    assert.equal(first.jobs[0].status, "PUBLISHING");
    assert.doesNotMatch(JSON.stringify(first), /DO_NOT_EXPOSE_OWNER|SHOULD_NOT_LEAK/);
    assert.deepEqual(await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { id: "diagnostic-signal" } }), priorSignal);
    pass("real Prisma read-only transaction identifies run, poison, expired owner and job without mutations");

    for (const [name, data] of [
      ["RECOLLECTING", { status: "FAILED", publicationStatus: "RECOLLECTING" }],
      ["FINALIZE", { status: "RUNNING", publicationStatus: "FINALIZE" }],
      ["RECONCILE", { status: "PUBLISHED", publicationStatus: "COMPLETE", publicationJobReconciledAt: null }],
    ]) {
      await db.subscriberScanRun.update({ where: { id: "diagnostic-run" }, data });
      const canonical = await db.subscriberScanRun.findFirst({ where: subscriberPublicationDebtWhere(tenant) });
      const observed = await inspect();
      assert.equal(observed.debtRun.id, canonical.id);
      if (name === "RECONCILE") assert.ok(observed.blockers.includes("WAITING_FOR_JOB_RECONCILIATION"));
      pass("indexed diagnostic eligibility matches recovery: " + name);
    }

    const foreign = await scope(db, { agencyId: "foreign-agency", creatorId: "foreign-creator", userId: "foreign-user" });
    await db.$executeRawUnsafe(`INSERT INTO "SubscriberScanRun" (
      "id","agencyId","creatorId","status","hasMore","fanProjectionStatus","publicationStatus",
      "publicationGeneration","createdAt","updatedAt"
    ) SELECT 'foreign-debt-'||n::text,$1,$2,
      CASE n%3 WHEN 0 THEN 'FAILED' WHEN 1 THEN 'FAILED' ELSE 'PUBLISHED' END,false,'COMPLETE',
      CASE n%3 WHEN 0 THEN 'RECOLLECTING' WHEN 1 THEN 'CURRENT' ELSE 'COMPLETE' END,n,$3,$3
      FROM generate_series(1,6000) n`, foreign.agencyId, foreign.creatorId, old);
    await db.jobInstance.create({ data: { id: "foreign-job", agencyId: foreign.agencyId, creatorId: foreign.creatorId,
      scope: "creator", jobKey: "subscriber_directory_scan", status: "PUBLISHING", params: { scanRunId: "FOREIGN_PRIVATE" } } });
    await db.subscriberScanRun.update({ where: { id: "diagnostic-run" }, data: { jobId: "foreign-job" } });
    const isolated = await inspect();
    assert.ok(isolated.blockers.includes("SOURCE_JOB_MISSING_OR_OUT_OF_SCOPE"));
    assert.ok(!isolated.jobs.some(job => job.id === "foreign-job"));
    assert.doesNotMatch(JSON.stringify(isolated), /FOREIGN_PRIVATE/);
    pass("foreign linked source job does not escape tenant scope");

    await db.subscriberScanRun.update({ where: { id: "diagnostic-run" }, data: { publicationJobReconciledAt: now } });
    await db.$executeRawUnsafe('ANALYZE "SubscriberScanRun"');
    const none = await inspect();
    assert.equal(none.debtRun, null);
    const explained = await db.$queryRawUnsafe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + diagnostics._test.SUBSCRIBER_DEBT_DIAGNOSTIC_SQL,
      tenant.agencyId, tenant.creatorId, ["diagnostic-run"], ["diagnostic-job"]);
    const plan = explained[0]["QUERY PLAN"][0].Plan;
    const nodes = [];
    function visit(node) { nodes.push(node); for (const child of node.Plans || []) visit(child); }
    visit(plan);
    console.log(JSON.stringify({ name: "diagnostic probe physical plan", nodes: nodes.map(node => ({
      type: node["Node Type"], index: node["Index Name"], actualRows: node["Actual Rows"], removed: node["Rows Removed by Filter"],
      indexCond: node["Index Cond"], filter: node.Filter,
    })) }));
    assert.ok(!nodes.some(node => node["Relation Name"] === "SubscriberScanRun" && /Seq Scan/.test(node["Node Type"])));
    assert.ok(nodes.reduce((sum, node) => sum + Number(node["Rows Removed by Filter"] || 0), 0) < 20);
    const indexes = nodes.filter(node => node["Index Name"]).map(node => node["Index Name"]);
    for (const expected of ["SubscriberScanRun_recollection_creator_idx", "SubscriberScanRun_publication_debt_idx", "SubscriberScanRun_pkey", "SubscriberScanRun_jobId_key"]) {
      assert.ok(indexes.includes(expected), "diagnostic debt probes use bounded keys: " + expected);
    }
    assert.ok(indexes.every(index => ["SubscriberScanRun_recollection_creator_idx", "SubscriberScanRun_publication_debt_idx",
      "SubscriberScanRun_jobId_key", "SubscriberScanRun_pkey"].includes(index)));
    assert.equal(none.reconciliationSearch, "REFERENCED_RUNS_AND_JOBS_ONLY");
    pass("no-debt probe uses scoped partial and exact reference keys with 5001 settled history rows and 6000 foreign debts", { indexes });

    await assert.rejects(runDbTransaction(db, async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const broken = new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return sql => sql === diagnostics._test.SUBSCRIBER_DEBT_DIAGNOSTIC_SQL
          ? target.$queryRawUnsafe("SELECT missing_diagnostic_test_column") : target.$queryRawUnsafe(sql);
        return Reflect.get(target, key);
      } });
      return diagnostics.inspectSubscriberRecoveryDiagnostics(broken, { ...tenant, now });
    }, { maxWait: 3000, timeout: 12000, statementTimeoutMs: 2000, isolationLevel: "RepeatableRead" }), error => {
      assert.equal(error.code, "P2010");
      assert.equal(error.meta.code, "42703");
      assert.equal(error.diagnosticRead, "publicationDebt");
      return true;
    });
    pass("real SQL diagnostic failure preserves first cause instead of aborted-transaction noise");
    console.log(JSON.stringify({ ok: true, proofs: report.length, nativePostgres: fixture.native === true }));
  } finally { await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keep));
