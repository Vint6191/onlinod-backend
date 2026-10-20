"use strict";
// Current Desktop collector + actual Prisma/SQL, isolated from any application
// database. Provider responses and failure injection are deliberate fixtures.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("ANALYTICS_RECOVERY_PROOF_TIMEOUT"); process.exit(2); }, 180000);
const result = { ok: false, nativePostgres: false, productionAccessed: false, externalProviders: false, cases: [] };
const pass = (name, details = {}) => { result.cases.push({ name, ...details }); console.log("PASS", name); };
async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nod-queue-recovery-"));
  const desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT);
  const desktopLoad = createRequire(path.join(desktop, "package.json"));
  const bundle = path.join(temporary, "earnings.cjs");
  await desktopLoad("esbuild").build({ entryPoints: [path.join(desktop, "apps/desktop/electron/main/services/backend-jobs/handlers/earnings-handler.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
  const { earningsHandler } = require(bundle);
  const f = await fixture(), { db, root } = f;
  try {
    const s = await scope(db);
    require.cache[require.resolve(path.join(root, "src/prisma"))] = { exports: db };
    const kernel = require(path.join(root, "src/services/db-commit-kernel"));
    const lease = require(path.join(root, "src/services/job-lease-service"));
    const authority = require(path.join(root, "src/services/domain-work-authority-service"));
    const publisherPath = path.join(root, "src/services/analytics-publication-service");
    let publisher = require(publisherPath);
    const plannerPath = path.join(root, "src/services/analytics-collection-planner");
    let planner = require(plannerPath);
    const hot = require(path.join(root, "src/services/analytics-hot-executor"));
    await db.workerDevice.create({ data: { id: "recovery-device", agencyId: s.agencyId, userId: s.userId, lastSeenAt: new Date() } });
    let providerReads = 0, dateOffset = 10;
    async function accept(id) {
      const at = new Date(), run = "run-" + id, token = "lease-" + id;
      const from = new Date(+at - dateOffset++ * 86400000).toISOString().slice(0, 10);
      const job = await kernel.runRootCommit(db, ({ tx }) => tx.jobInstance.create({ data: {
        id, agencyId: s.agencyId, creatorId: s.creatorId, jobKey: "fetch_earnings", scope: "creator", status: "CLAIMED",
        claimedByDeviceId: "recovery-device", leaseTokenHash: crypto.createHash("sha256").update(token).digest("hex"), leaseRevision: 1,
        leaseMemberId: "member-" + s.agencyId, leaseAccessEpoch: 1, leaseUntil: new Date(+at + 600000),
        params: { analyticsContractVersion: 1, scanFrom: from, scanTo: from, sourceTimezone: "UTC", requestedAt: at.toISOString(),
          analyticsObservationStartedAt: at.toISOString(), scanGeneration: run, collectionReason: "LOCAL_RECOVERY_PROOF" },
      } }));
      const identity = { jobId: id, userId: s.userId, deviceId: "recovery-device", leaseToken: token, leaseRevision: 1 }, reports = [];
      const collected = await earningsHandler.runChunk({ creatorId: s.creatorId, job, signal: new AbortController().signal,
        ofApi: { request: async () => { providerReads++; return { ok: true, status: 200, data: { total: { total: 1, chartAmount: [{ date: from, count: 1 }] } } }; } },
        reportAsync: report => reports.push(report), flushAsyncReports: async () => {},
      });
      assert.equal(collected.result.dailyComplete, true);
      for (const report of reports) await lease.progressJob({ ...identity, ...report });
      const accepted = await lease.completeJob({ ...identity, result: collected.result });
      assert.equal(accepted.publicationPending, true);
      return { id: accepted.publicationId, jobId: id, from };
    }
    async function publicationWork(id) { return db.domainWorkItem.findFirst({ where: { workClass: "ANALYTICS_PUBLICATION", objectId: id } }); }
    async function makePublicationDue(id) {
      await kernel.runRootCommit(db, async ({ tx }) => {
        const at = new Date(Date.now() - 1000);
        await tx.analyticsPublication.update({ where: { id }, data: { availableAt: at } });
        await tx.domainWorkItem.updateMany({ where: { workClass: "ANALYTICS_PUBLICATION", objectId: id }, data: { availableAt: at, nextAttemptAt: null } });
      });
    }
    async function finishPublication(id) {
      for (let turn = 0; turn < 8; turn++) {
        const row = await db.analyticsPublication.findUnique({ where: { id } });
        if (row.state !== "PENDING") { assert.equal(row.state, "COMMITTED", JSON.stringify({ state: row.state, lastError: row.lastError, stage: row.stage })); return row; }
        await makePublicationDue(id);
        const next = await publisher.runAnalyticsPublicationSweep({ db });
        assert.equal(next.ok, true, JSON.stringify(next));
      }
      throw Error("publication did not complete within bounded test turns");
    }
    let injectedJob = null, injectedCode = "P2024";
    db.$use(async (params, next) => {
      if (injectedJob && params.model === "AnalyticsIngestBatch" && params.action === "findMany" && params.args.where.sourceJobId === injectedJob) {
        throw Object.assign(new Error("Injected database failure for recovery proof"), { code: injectedCode });
      }
      return next(params);
    });
    const live = await accept("recovery-live"), readsAfterAcceptance = providerReads;
    injectedJob = live.jobId;
    for (let attempt = 1; attempt <= 10; attempt++) {
      await makePublicationDue(live.id);
      const sweep = await publisher.runAnalyticsPublicationSweep({ db, limit: 1 });
      assert.equal(sweep.ok, false);
      const row = await db.analyticsPublication.findUnique({ where: { id: live.id } }), work = await publicationWork(live.id);
      assert.equal(row.state, "PENDING"); assert.equal(row.stage, "EARNINGS_BATCHES");
      assert.equal(row.attempts, attempt); assert.equal(work.state, "READY"); assert.equal(work.consecutiveFailures, attempt);
      assert.match(row.lastError, /^\[TRANSIENT_DB:P2024\]/);
      assert(row.availableAt > new Date()); assert(row.availableAt - new Date() <= 300000);
    }
    injectedJob = null;
    await db.$disconnect(); await f.waitForIdle();
    delete require.cache[require.resolve(publisherPath)]; publisher = require(publisherPath);
    await finishPublication(live.id);
    assert.equal((await db.jobInstance.findUnique({ where: { id: live.jobId } })).status, "DONE");
    assert.equal(providerReads, readsAfterAcceptance);
    pass("Ten transient publication failures survive restart and publish accepted facts without another provider read");

    const demand = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId: s.agencyId, creatorIds: [s.creatorId],
      rangeKey: "7d", includePrevious: false, requestedByMemberId: "member-" + s.agencyId, requestedAccessEpoch: 1 });
    for (let attempt = 1; attempt <= 10; attempt++) {
      await db.analyticsCollectionDemand.update({ where: { key: demand.key }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      const owned = await planner.claimNextAnalyticsDemand({ db }); assert.equal(owned.key, demand.key);
      owned.cursorCreatorId = "qa-000";
      const settled = await planner.settleAnalyticsDemand({ db, demand: owned, error: Object.assign(new Error("pool unavailable"), { code: "P2024" }) });
      assert.equal(settled.retry, true); assert.equal(settled.quarantined, false); assert.equal(settled.attempts, attempt);
    }
    await db.$disconnect(); await f.waitForIdle();
    delete require.cache[require.resolve(plannerPath)]; planner = require(plannerPath);
    await db.analyticsCollectionDemand.update({ where: { key: demand.key }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const resumed = await planner.claimNextAnalyticsDemand({ db }); assert.equal(resumed.cursorCreatorId, "qa-000");
    const planned = await planner.processAnalyticsDemand({ db, demand: resumed });
    assert.equal(planned.ok, true); assert.equal(planned.creators, 1); assert(planned.created > 0, JSON.stringify(planned));
    pass("Ten transient Home demand failures preserve the cursor and produce real catch-up jobs after restart", { jobsCreated: planned.created });

    // Seed the exact old terminal shape, including the earnings detail suffix.
    // Keep unknown/ambiguous failures, live owners and newer executions closed.
    // Recreate the prior terminal policy through the real sweep/settle path.
    // This also executes recordJobFailure, collector updates and DWI ack; no
    // handcrafted FAILED/REJECTED shape can hide those downstream effects.
    const retryPolicy = require(path.join(root, "src/services/db-retry-policy"));
    const classifyCurrent = retryPolicy.isTransientDatabaseError;
    delete require.cache[require.resolve(publisherPath)];
    retryPolicy.isTransientDatabaseError = () => false;
    const previousPublisher = require(publisherPath);
    retryPolicy.isTransientDatabaseError = classifyCurrent;
    delete require.cache[require.resolve(publisherPath)]; publisher = require(publisherPath);
    async function oldTerminal(id, code, options = {}) {
      const item = await accept(id);
      await db.analyticsPublication.update({ where: { id: item.id }, data: { attempts: 7 } });
      injectedJob = item.jobId; injectedCode = code;
      try {
        assert.equal((await previousPublisher.runAnalyticsPublicationSweep({ db, limit: 1 })).ok, false);
      } finally { injectedJob = null; }
      const terminal = await db.analyticsPublication.findUnique({ where: { id: item.id } });
      assert.equal(terminal.state, "REJECTED");
      assert.match(terminal.lastError, new RegExp("^" + code + "; EARNINGS_DAILY_INCOMPLETE:"));
      await kernel.runRootCommit(db, async ({ tx }) => {
        if (options.newer) await tx.jobInstance.update({ where: { id: item.jobId }, data: { leaseRevision: 2 } });
      });
      if (options.owned) {
        await authority.publishDomainWork({ db, agencyId: s.agencyId, creatorId: s.creatorId, workClass: "ANALYTICS_PUBLICATION",
          objectType: "ANALYTICS_PUBLICATION", objectId: item.id, partitionKey: s.creatorId });
        const currentClaim = await authority.claimDomainWorkBatch({ db, workClass: "ANALYTICS_PUBLICATION", limit: 1 });
        assert.equal(currentClaim.items[0].objectId, item.id);
      }
      return item;
    }
    const old = await oldTerminal("recovery-old", "P2024"), unknown = await oldTerminal("recovery-contract", "P2022"),
      ambiguous = await oldTerminal("recovery-ambiguous", "P2028"), newer = await oldTerminal("recovery-newer-execution", "P2024", { newer: true }),
      owned = await oldTerminal("recovery-live-owner", "P2024", { owned: true });
    // A historically quarantined request retains its actor and cursor; repair
    // does not manufacture authority and the ordinary executor checks it again.
    await db.analyticsCollectionDemand.update({ where: { key: demand.key }, data: { completedAt: null, completedRevision: 0,
      quarantinedAt: new Date(), attempts: 8, cursorCreatorId: "qa-000", lastErrorClass: "TRANSIENT", lastErrorCode: "P2024", lastError: "old pool outage" } });
    const seed = await db.analyticsCollectionDemand.findUnique({ where: { key: demand.key } });
    for (const [suffix, errorClass, errorCode] of [["unknown", "INTERNAL", "UNEXPECTED"], ["contract", "CONTRACT", "P2022"]]) {
      await db.analyticsCollectionDemand.create({ data: { ...seed, key: demand.key + ":" + suffix, lastErrorClass: errorClass, lastErrorCode: errorCode } });
    }
    // The fixture already installs the current chain. Drop only its new index
    // and apply the exact migration again to prove the populated overlay.
    await db.$disconnect(); await f.waitForIdle();
    await f.engine.exec('DROP INDEX "AnalyticsCollectionDemand_quarantine_pending_idx"');
    await f.engine.exec(fs.readFileSync(path.join(root, "prisma/migrations/20261018030000_analytics_recovery_retry/migration.sql"), "utf8"));
    assert.equal((await db.analyticsPublication.findUnique({ where: { id: old.id } })).state, "PENDING");
    assert.equal((await publicationWork(old.id)).state, "READY");
    for (const item of [unknown, ambiguous, newer, owned]) assert.equal((await db.analyticsPublication.findUnique({ where: { id: item.id } })).state, "REJECTED");
    const recoveredDemand = await db.analyticsCollectionDemand.findUnique({ where: { key: demand.key } });
    assert.equal(recoveredDemand.quarantinedAt, null); assert.equal(recoveredDemand.cursorCreatorId, "qa-000");
    assert.equal(recoveredDemand.requestRevision, seed.requestRevision); assert.equal(recoveredDemand.requestedByMemberId, seed.requestedByMemberId);
    const readsBeforeRepair = providerReads;
    await finishPublication(old.id);
    assert.equal(providerReads, readsBeforeRepair);
    pass("Exact old transient terminal rows recover through normal publication; ambiguous errors, newer leases and live owners stay fenced");

    // Finish only the repaired demand; unknown/contract quarantine remains
    // visible even after an entirely empty subsequent sweep.
    const repaired = await planner.claimNextAnalyticsDemand({ db }); assert.equal(repaired.key, demand.key);
    assert.equal((await planner.processAnalyticsDemand({ db, demand: repaired })).ok, true);
    const health = await planner.runAnalyticsCollectionDemandSweep({ db });
    assert.equal(health.demands, 0); assert.equal(health.quarantinedRemaining, true); assert.equal(health.ok, false);
    await db.$executeRawUnsafe("SET enable_seqscan=off");
    const healthPlan = await db.$queryRawUnsafe('EXPLAIN (FORMAT JSON) SELECT EXISTS (SELECT 1 FROM "AnalyticsCollectionDemand" WHERE "completedAt" IS NULL AND "quarantinedAt" IS NOT NULL)');
    assert.match(JSON.stringify(healthPlan), /AnalyticsCollectionDemand_quarantine_pending_idx/);
    await db.$executeRawUnsafe("SET enable_seqscan=on");
    pass("An empty demand sweep still reports genuine quarantine through its bounded partial index");

    const timeWork = await authority.publishDomainWork({ db, agencyId: s.agencyId, creatorId: s.creatorId,
      workClass: "ANALYTICS_PUBLICATION", objectType: "ANALYTICS_PUBLICATION", objectId: "timezone-probe", partitionKey: s.creatorId });
    const timeId = timeWork.id || timeWork.item?.id || (await publicationWork("timezone-probe")).id;
    await db.domainWorkItem.updateMany({ where: { workClass: "ANALYTICS_PUBLICATION", id: { not: timeId } }, data: { isOutstanding: false } });
    for (const zone of ["UTC", "Etc/GMT-3", "America/New_York"]) {
      await db.$executeRawUnsafe("SELECT set_config('TimeZone',$1,false)", zone);
      for (const state of ["READY", "CLAIMED"]) {
        for (const delta of [-60000, 60000]) {
          await kernel.runRootCommit(db, async ({ tx }) => {
            await require(path.join(root, "src/services/database-write-contract-service")).authorizeDomainWorkExecutor(tx);
            await tx.domainWorkItem.update({ where: { id: timeId }, data: { state, availableAt: new Date(Date.now() + delta), leaseUntil: new Date(Date.now() + delta) } });
          });
          assert.equal((await hot.due(db)).has("ANALYTICS_PUBLICATION"), delta < 0, `${zone} ${state} ${delta}`);
        }
      }
    }
    pass("Hot executor sees due work and expired claims consistently across positive and negative pool timezones");
    result.ok = true;
  } finally {
    await f.close(); fs.rmSync(temporary, { recursive: true, force: true });
    const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || temporary + "-output", "evidence/analytics-queue-recovery.json");
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });
