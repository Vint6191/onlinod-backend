"use strict";
// Real schema, Prisma transactions and publication code. The soft admission
// clock is advanced deterministically; SQL/client deadlines remain real.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");

(async () => {
  const runtime = await createScaleSqlRuntime(), checks = [];
  const pass = name => { checks.push(name); console.log("PASS", name); };
  const realNow = Date.now;
  const before = process.env.ONLINOD_EXPECT_SUBSCRIBER_STALL === "1";
  const keepAlive = setInterval(() => {}, 1000);
  let offset = 0, slowPreparation = false, slowClaim = false;
  const monotonicNow = () => realNow() + offset;
  if (before) Date.now = monotonicNow;
  try {
    const { db } = runtime, s = await scope(db);
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const subscribers = require("../../src/services/subscriber-directory-service");
    const signals = require("../../src/services/subscriber-directory-maintenance-signal-service");
    const { runSubscriberDirectoryMaintenance } = require("../../src/services/subscriber-directory-maintenance-service");
    const { readCreatorCurrentTask } = require("../../src/services/creator-overview-service");
    const creators = [s.creatorId, "qa-creator-second"];
    const tx = work => runRootCommit(db, ({ tx }) => work(tx));
    await tx(async t => {
      await t.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
      await t.creatorAccount.create({ data: { id: creators[1], agencyId: s.agencyId, displayName: "Second", remoteId: "second", status: "READY" } });
    });
    db.$use(async (params, next) => {
      if (params.model === "SubscriberScanItem" && params.action === "findMany" && params.args?.take) {
        assert(params.args.take <= 500, "publication page must stay bounded");
      }
      const value = await next(params);
      if (slowPreparation && params.model === "SubscriberDirectoryState" && params.action === "findUnique") offset += 2000;
      if (slowClaim && params.action === "queryRaw" && JSON.stringify(params.args).includes('RETURNING s.')) offset += 2000;
      return value;
    });
    const recover = (creatorId, options = {}) => subscribers.recoverSubscriberPublicationDebt({
      db, agencyId: s.agencyId, creatorId, maxRuns: 1, maxStepsPerRun: 1, maxRuntimeMs: 500, monotonicNow, ...options,
    });
    const wake = creatorId => signals.signalSubscriberDirectoryMaintenance({ db, agencyId: s.agencyId, creatorId,
      kind: "RECOVERY", dueAt: new Date(0), reason: "LIVENESS_PROOF" });
    const due = creatorId => db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId }, data: { dueAt: new Date(0) } });
    for (const creatorId of creators) {
      const runId = `run-${creatorId}`, jobId = `job-${creatorId}`, recoveryIntentId = `intent-${creatorId}`;
      await db.jobInstance.create({ data: { id: jobId, agencyId: s.agencyId, creatorId, jobKey: "subscriber_directory_scan", scope: "creator",
        status: "PUBLISHING", params: { scanRunId: runId, scanEveryDays: 7, recoveryIntentId }, lastProgressAt: new Date(0) } });
      await db.creatorRecoveryIntent.create({ data: { id: recoveryIntentId, agencyId: s.agencyId, creatorId, jobId,
        stream: "subscribers", policyVersion: 2, reason: "OFFLINE_GAP", status: "RUNNING", gapFrom: new Date(0), targetAt: new Date() } });
      await db.subscriberDirectoryState.create({ data: { agencyId: s.agencyId, creatorId, publicationGeneration: 1 } });
      await db.subscriberScanRun.create({ data: { id: runId, agencyId: s.agencyId, creatorId, jobId, status: "RUNNING",
        hasMore: false, nextOffset: 1020, scannedCount: 1001, fanProjectionCursorOffset: 1020, fanProjectionCount: 1001,
        fanProjectionStatus: "COMPLETE", publicationGeneration: 1, publicationStatus: "PENDING" } });
      await db.subscriberScanItem.createMany({ data: Array.from({ length: 1001 }, (_, i) => ({
        id: `${creatorId}-item-${String(i).padStart(5, "0")}`, runId, agencyId: s.agencyId, creatorId,
        fanId: String(i + 100000), contentHash: `hash-${i}`, lastSeenIsNull: false,
      })) });
      await wake(creatorId);
    }
    if (!before) {
      // Exercise the actual deployment path over populated V8 state, then repeat
      // it. The new release must not reset receipts, cursors or collected rows.
      await db.$executeRawUnsafe('DROP INDEX "SubscriberDirectoryMaintenanceSignal_legacy_yield_idx"');
      await db.$executeRawUnsafe('DELETE FROM "_prisma_migrations" WHERE migration_name=$1', "20261017010000_subscriber_publication_liveness");
      await db.$disconnect();
      const install = () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["scripts/database/install-current.js"], {
          cwd: path.resolve(__dirname, "../.."), stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, DATABASE_URL: runtime.url || process.env.ONLINOD_NATIVE_TEST_DATABASE_URL },
        });
        let output = "";
        child.stdout.on("data", x => { output += x; }); child.stderr.on("data", x => { output += x; });
        const timer = setTimeout(() => child.kill(), 60000);
        child.once("error", e => { clearTimeout(timer); reject(e); });
        child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(output)); });
      });
      await install(); await install();
      assert.equal(await db.subscriberScanItem.count(), 2002);
      assert.equal(await db.jobInstance.count({ where: { status: "PUBLISHING" } }), 2);
      assert.equal((await require("../../src/services/database-contract-service").readDatabaseContract(db)).ready, true);
      pass("actual V8-to-V9 installer and repeated install preserve both collected snapshots and pass schema readiness");
    }
    if (runtime.native && !before) {
      let enter, release;
      const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
      const blocker = subscribers._test.publicationTransaction(db, s.agencyId, creators[0], async () => { enter(); await held; });
      await entered;
      let timer;
      try {
        const result = await Promise.race([recover(creators[1]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("OTHER_CREATOR_BLOCKED")), 10000);
        })]);
        assert(result.advancedSteps > 0);
      } finally { clearTimeout(timer); release(); await blocker; }
      pass("native PostgreSQL: held publication lock for one creator does not block the other in the same agency");
    }
    slowPreparation = true;
    for (const creatorId of creators) {
      const result = await recover(creatorId);
      assert.equal(result.advancedSteps > 0, !before);
      if (!before) {
        const task = await readCreatorCurrentTask({ db, creatorId });
        assert.equal(task.rawStatus, "PUBLISHING");
        assert.match(task.progress.message, /publishing snapshot/);
        assert(+new Date(task.lastProgressAt) > 0);
      }
    }
    pass(before ? "reproduced zero progress on both creators when preparation consumes soft slice" : "both creators advance and report current phase despite preparation exceeding soft slice");
    slowPreparation = false;
    let signal = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    await db.subscriberDirectoryMaintenanceSignal.update({ where: { id: signal.id }, data: { attempts: 99 } });
    await signals.releaseSubscriberDirectoryMaintenanceSignal({ db, signal, error: null, retryMs: 1000 });
    assert.equal((await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { id: signal.id } })).attempts, before ? 100 : 0);
    pass(before ? "reproduced healthy continuation becoming poisoned at attempt 100" : "healthy continuation resets consecutive error budget instead of becoming poison");
    for (const creatorId of creators) await wake(creatorId);
    slowClaim = true;
    const maintenance = await runSubscriberDirectoryMaintenance({ db, maxSignals: 1, concurrency: 1, maxRuntimeMs: 750, recoveryStepsPerRun: 1, monotonicNow });
    slowClaim = false;
    const owned = await db.subscriberDirectoryMaintenanceSignal.count({ where: { claimToken: { not: null } } });
    assert.equal(owned > 0, before);
    if (!before) { assert.equal(maintenance.processedSignals, 1); assert(maintenance.advancedSteps > 0); }
    pass(before ? "reproduced slow claim abandoned until lease expiry" : "slow claim still executes one bounded unit and releases ownership");
    if (!before) {
      // Resetting/reloading the service loses no progress; cursors are SQL state.
      slowPreparation = true;
      for (let iteration = 0; iteration < 20; iteration++) {
        for (const creatorId of creators) await recover(creatorId);
        if (await db.jobInstance.count({ where: { status: "DONE" } }) === 2) break;
      }
      slowPreparation = false;
      for (const creatorId of creators) {
        const run = await db.subscriberScanRun.findUnique({ where: { id: `run-${creatorId}` } });
        assert.equal(run.publicationStatus, "COMPLETE"); assert(run.publicationJobReconciledAt);
        assert.equal((await db.jobInstance.findUnique({ where: { id: run.jobId } })).status, "DONE");
        assert.equal((await db.subscriberDirectoryState.findUnique({ where: { creatorId } })).totalCount, 1001);
        assert.equal((await db.creatorRecoveryIntent.findUnique({ where: { id: `intent-${creatorId}` } })).status, "COMPLETE");
        assert.equal((await readCreatorCurrentTask({ db, creatorId })).active, false);
        assert.equal((await recover(creatorId)).reason, "none_due");
      }
      pass("both 1001-row snapshots, job DONE and offline recovery converge; current-task clears and replay is idle");
      // Known pre-v25 yields are repairable. Real domain failures stay quarantined.
      for (let i = 0; i < creators.length; i++) {
        await wake(creators[i]);
        await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: creators[i] },
          data: { attempts: 100, lastError: i ? "GENUINE_DATA_CONTRADICTION" : "subscriber_recovery_budget_exhausted" } });
      }
      signal = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
      assert.equal(signal.creatorId, creators[0]); assert.equal(signal.attempts, 0);
      await signals.ackSubscriberDirectoryMaintenanceSignal({ db, signal });
      assert.equal(await signals.claimSubscriberDirectoryMaintenanceSignal({ db }), null);
      assert.equal(await signals.countPoisonedSubscriberMaintenanceSignals({ db }), 1);
      pass("legacy false poison resumes automatically; genuine poison stays quarantined");
      for (const legacyError of [null, "maintenance_budget_exhausted", "publication_debt"]) {
        await wake(creators[0]);
        await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: creators[0] },
          data: { attempts: 150, lastError: legacyError } });
        signal = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
        assert.equal(signal.creatorId, creators[0]); assert.equal(signal.attempts, 0);
        await signals.ackSubscriberDirectoryMaintenanceSignal({ db, signal });
      }
      await wake(creators[0]); signal = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
      await db.subscriberDirectoryMaintenanceSignal.update({ where: { id: signal.id }, data: { attempts: 99 } });
      await signals.releaseSubscriberDirectoryMaintenanceSignal({ db, signal, error: "GENUINE_DATA_CONTRADICTION" });
      await due(creators[0]);
      assert.equal((await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { id: signal.id } })).attempts, 100);
      assert.equal(await signals.claimSubscriberDirectoryMaintenanceSignal({ db }), null);
      pass("all legacy yield variants recover; a real hundredth failure remains quarantined");
      const claimQuery = runtime.queries.find(x => x.query.includes("WITH normal_candidate"))?.query;
      assert(claimQuery);
      const plan = await tx(async t => {
        await t.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        return t.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) ${claimQuery}`, new Date(), "explain-only", new Date(realNow() + 120000));
      });
      assert.match(JSON.stringify(plan), /SubscriberDirectoryMaintenanceSignal_due_claim_idx/);
      assert.match(JSON.stringify(plan), /SubscriberDirectoryMaintenanceSignal_legacy_yield_idx/);
      pass("both ordinary and legacy claim branches have usable ordered partial indexes");
      await wake(creators[0]); signal = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
      await wake(creators[0]);
      assert.equal(await signals.releaseSubscriberDirectoryMaintenanceSignal({ db, signal, error: "stale" }), false);
      await assert.rejects(recover(creators[0], { maintenanceSignal: signal }), e => e.code === "SUBSCRIBER_MAINTENANCE_CLAIM_STALE");
      assert.equal(await signals.ackSubscriberDirectoryMaintenanceSignal({ db, signal }), false);
      pass("superseded worker cannot publish, release or acknowledge a newer signal revision");
      // Final job+coverage commit must roll back as a unit when identity is wrong.
      const creatorId = creators[0], jobId = `job-${creatorId}`, runId = `run-${creatorId}`;
      await db.jobInstance.update({ where: { id: jobId }, data: { status: "PUBLISHING", params: { scanRunId: runId, recoveryIntentId: "missing" } } });
      await db.subscriberScanRun.update({ where: { id: runId }, data: { publicationJobReconciledAt: null } });
      await assert.rejects(recover(creatorId), e => e.code === "LIVE_RECOVERY_COMPLETION_SCOPE_MISMATCH");
      assert.equal((await db.jobInstance.findUnique({ where: { id: jobId } })).status, "PUBLISHING");
      assert.equal((await db.subscriberScanRun.findUnique({ where: { id: runId } })).publicationJobReconciledAt, null);
      await db.jobInstance.update({ where: { id: jobId }, data: { params: { scanRunId: runId, recoveryIntentId: `intent-${creatorId}` } } });
      await recover(creatorId);
      pass("failed coverage finalization rolls back job DONE and reconciliation marker together, then retries successfully");
      await db.jobInstance.update({ where: { id: jobId }, data: { status: "CLAIMED", leaseUntil: new Date(realNow() + 60000) } });
      await db.subscriberScanRun.update({ where: { id: runId }, data: { publicationJobReconciledAt: null } });
      assert.equal((await recover(creatorId)).reconciledJobs, 0);
      assert.equal((await db.jobInstance.findUnique({ where: { id: jobId } })).status, "CLAIMED");
      await db.jobInstance.update({ where: { id: jobId }, data: { leaseUntil: new Date(0) } });
      assert.equal((await recover(creatorId)).reconciledJobs, 1);
      pass("unexpired collector lease is respected; expired ownership converges without another scan");
      await db.jobInstance.update({ where: { id: jobId }, data: { status: "CANCELLED" } });
      await db.subscriberScanRun.update({ where: { id: runId }, data: { publicationJobReconciledAt: null } });
      await recover(creatorId);
      assert.equal((await db.jobInstance.findUnique({ where: { id: jobId } })).status, "CANCELLED");
      assert.equal((await recover(creatorId)).reason, "none_due");
      pass("reconciliation never resurrects a cancelled job");
    }
    const report = { ok: true, engine: runtime.native ? "PostgreSQL" : "PGlite + Prisma (single SQL connection)", checks };
    if (process.env.ONLINOD_SUBSCRIBER_LIVENESS_REPORT) fs.writeFileSync(process.env.ONLINOD_SUBSCRIBER_LIVENESS_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { Date.now = realNow; await runtime.close(); clearInterval(keepAlive); }
})().catch(error => { console.error(error); process.exitCode = 1; });
