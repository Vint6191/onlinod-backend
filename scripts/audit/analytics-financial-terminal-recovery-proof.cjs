"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const keepAlive = setInterval(() => {}, 1000), deadline = setTimeout(() => { console.error("FINANCIAL_RECOVERY_PROOF_TIMEOUT"); process.exit(2); }, 180000);
const report = { ok: false, nativePostgres: false, productionAccessed: false, externalProviders: false, cases: [] };
async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nod-financial-recovery-"));
  const desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT), desktopLoad = createRequire(path.join(desktop, "package.json")), bundle = path.join(temporary, "financial.cjs");
  await desktopLoad("esbuild").build({ entryPoints: [path.join(desktop, "apps/desktop/electron/main/services/backend-jobs/handlers/financial-transactions-handler.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
  const { financialTransactionsHandler } = require(bundle);
  const f = await fixture(), { db, root } = f;
  try {
    require.cache[require.resolve(path.join(root, "src/prisma"))] = { exports: db };
    const kernel = require(path.join(root, "src/services/db-commit-kernel"));
    const collection = require(path.join(root, "src/services/analytics-collector-control-service"));
    const receipts = require(path.join(root, "src/services/financial-receipt-authority"));
    const lease = require(path.join(root, "src/services/job-lease-service"));
    const publisherPath = path.join(root, "src/services/analytics-publication-service");
    const policy = require(path.join(root, "src/services/db-retry-policy")), classifier = policy.isTransientDatabaseError;
    delete require.cache[require.resolve(publisherPath)]; policy.isTransientDatabaseError = () => false;
    const previousPublisher = require(publisherPath);
    policy.isTransientDatabaseError = classifier; delete require.cache[require.resolve(publisherPath)];
    const publisher = require(publisherPath);
    const write = fn => kernel.runRootCommit(db, async ({ tx }) => { await receipts.enter(tx); return fn(tx); });
    let injectRun = null, providerReads = 0;
    db.$use(async (params, next) => {
      if (injectRun && params.model === "FinancialReceiptRun" && params.action === "findUnique" && params.args.where.id === injectRun) {
        throw Object.assign(new Error("Injected pool timeout"), { code: "P2024" });
      }
      return next(params);
    });
    async function terminal(label) {
      const s = await scope(db, { agencyId: "finance-" + label, creatorId: "finance-" + label, userId: "finance-" + label });
      const deviceId = "device-" + label, id = "finance-job-" + label, token = "token-" + label, now = new Date(Math.floor(Date.now() / 1000) * 1000);
      await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
      let job = { id, agencyId: s.agencyId, creatorId: s.creatorId, jobKey: "financial_transactions_scan", scope: "CREATOR",
        params: collection.stampCollectionAuthorityParams({ ...collection.buildCollectionCommand({ collectorType: "FINANCIAL", collectionMode: "full", now }), startDate: "2016-01-01 00:00:00" }, now) };
      job.params = await receipts.claimParams(db, job);
      job = await write(tx => tx.jobInstance.create({ data: { ...job, status: "CLAIMED", startedAt: now, claimedAt: now,
        claimedByDeviceId: deviceId, leaseUntil: new Date(+now + 600000), leaseRevision: 1,
        leaseTokenHash: crypto.createHash("sha256").update(token).digest("hex"), leaseMemberId: "member-" + s.agencyId, leaseAccessEpoch: 1,
        continuation: receipts.envelope(job, receipts.initialCursor(job)) } }));
      const identity = { jobId: id, userId: s.userId, deviceId, leaseToken: token, leaseRevision: 1 };
      const source = [{ id: "payment-" + label, createdAt: new Date(+now - 86400000).toISOString(), amount: 25, net: 20, fee: 5,
        type: "message", status: "done", currency: "USD", user: { id: "42", username: "fixture_fan" } }];
      let accepted;
      for (let turn = 0; turn < 12; turn++) {
        const expected = structuredClone(job.continuation), cursor = expected.jobContinuation;
        const chunk = await financialTransactionsHandler.runChunk({ job, creatorId: s.creatorId, continuation: structuredClone(cursor), signal: new AbortController().signal,
          ofApi: { request: async request => {
            providerReads++;
            if (request.source.endsWith(".payouts")) return { ok: true, status: 200, data: { list: source, hasMore: false } };
            const category = request.source.split(".").at(-1), key = category === "messages" ? "chat_messages" : category;
            const selected = category === "total" || category === "messages" ? source : [];
            return { ok: true, status: 200, data: { [key]: { gross: selected.reduce((n, row) => n + row.amount, 0),
              total: selected.reduce((n, row) => n + row.net, 0), count: selected.length } } };
          } } });
        await lease.progressJob({ ...identity, expectedContinuation: expected, chunkResult: chunk.chunkResult, continuation: chunk.continuation, progress: chunk.progress });
        job = await db.jobInstance.findUnique({ where: { id } });
        if (chunk.outcome === "done") { accepted = await lease.completeJob({ ...identity, result: chunk.result, progress: chunk.progress }); break; }
      }
      assert(accepted?.publicationId);
      const runId = receipts.runId(job), run = await db.financialReceiptRun.findUnique({ where: { id: runId } });
      assert.equal(run.proof.complete, true); assert.equal(await db.financialObservedFact.count({ where: { runId } }), 1);
      await db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { attempts: 7 } });
      injectRun = runId;
      try { assert.equal((await previousPublisher.runAnalyticsPublicationSweep({ db, limit: 1 })).ok, false); }
      finally { injectRun = null; }
      const failed = await db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } });
      assert.equal(failed.state, "REJECTED"); assert.equal(failed.lastError, "P2024");
      assert.equal((await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: s.creatorId } })).status, "FAILED");
      return { ...s, job, runId, publicationId: accepted.publicationId };
    }
    const intact = await terminal("intact"), retired = await terminal("retired"), missing = await terminal("missing");
    // Real retention takes its Run lock, marks details retired before deletion,
    // and retains the old complete header. Such a header is not reusable input.
    await write(async tx => {
      await tx.financialReceiptRun.update({ where: { id: retired.runId }, data: { createdAt: new Date(Date.now() - 31 * 86400000) } });
      await tx.domainWorkItem.updateMany({ where: { workClass: "FINANCIAL_RECEIPT_RETENTION", creatorId: retired.creatorId }, data: { availableAt: new Date(0) } });
    });
    const retention = await require(path.join(root, "src/services/financial-receipt-retention-service")).runSweep({ db, limit: 1 });
    assert.equal(retention.ok, true); assert.equal(retention.deleted, 1);
    const retiredHeader = await db.financialReceiptRun.findUnique({ where: { id: retired.runId } });
    assert(retiredHeader.detailsRetiredAt); assert.equal(retiredHeader.proof.complete, true);
    await db.financialReceiptRun.delete({ where: { id: missing.runId } });
    const readsBeforeRepair = providerReads;
    await db.$disconnect(); await f.waitForIdle();
    await f.engine.exec('DROP INDEX "AnalyticsCollectionDemand_quarantine_pending_idx"');
    await f.engine.exec(fs.readFileSync(path.join(root, "prisma/migrations/20261018030000_analytics_recovery_retry/migration.sql"), "utf8"));
    assert.equal((await db.analyticsPublication.findUnique({ where: { id: intact.publicationId } })).state, "PENDING");
    for (const item of [retired, missing]) {
      assert.equal((await db.analyticsPublication.findUnique({ where: { id: item.publicationId } })).state, "REJECTED");
      assert.equal((await db.jobInstance.findUnique({ where: { id: item.job.id } })).status, "FAILED");
    }
    report.cases.push("Migration preserves real retired receipt quarantine and missing receipt rejection");
    for (let turn = 0; turn < 12; turn++) {
      const row = await db.analyticsPublication.findUnique({ where: { id: intact.publicationId } });
      if (row.state !== "PENDING") { assert.equal(row.state, "COMMITTED", JSON.stringify({ state: row.state, error: row.lastError })); break; }
      await db.analyticsPublication.update({ where: { id: row.id }, data: { availableAt: new Date(0) } });
      await db.domainWorkItem.updateMany({ where: { workClass: "ANALYTICS_PUBLICATION", objectId: row.id }, data: { availableAt: new Date(0), nextAttemptAt: null } });
      assert.equal((await publisher.runAnalyticsPublicationSweep({ db, limit: 1 })).ok, true);
    }
    assert.equal((await db.analyticsPublication.findUnique({ where: { id: intact.publicationId } })).state, "COMMITTED");
    const state = await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: intact.creatorId } });
    assert.equal(state.status, "COMPLETE"); assert.equal(state.activeGeneration, intact.job.params.collectionGeneration);
    assert.equal(providerReads, readsBeforeRepair);
    report.cases.push("Actual Financial terminal failure resumes accepted receipt to COMPLETE without another provider traversal");
    report.ok = true;
  } finally {
    await f.close(); fs.rmSync(temporary, { recursive: true, force: true });
    const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || temporary + "-output", "evidence/analytics-financial-terminal-recovery.json");
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });
