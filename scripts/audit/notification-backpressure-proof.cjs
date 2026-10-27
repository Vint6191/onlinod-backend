"use strict";
// Actual Prisma, current SQL schema and production services. A disposable
// single-session PGlite fixture is not a multi-replica PostgreSQL load test.
const assert = require("node:assert/strict"), path = require("node:path");
const { spawn } = require("node:child_process");
const root = process.env.ONLINOD_NOTIFICATION_PROOF_BACKEND || path.resolve(__dirname, "../..");
const load = file => require(path.join(root, file));
const baseline = process.env.ONLINOD_NOTIFICATION_BASELINE === "1";
const migration = "20261027000000_notification_refresh_backpressure";
const code = "NOTIFICATION_BUMP_PROJECTION_FAILED:FAN_DATA_REFRESH_BACKLOG_FULL";
async function main() {
  const fixture = await load("scripts/test-support/admin-sql-runtime.cjs").createAdminSqlRuntime({
    runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME, beforeMigration: baseline ? null : migration,
  });
  const { db, queries } = fixture;
  require.cache[require.resolve(path.join(root, "src/prisma"))] = { exports: db };
  const checks = [];
  async function check(name, run) { await run(); checks.push(name); console.log("PASS", name); }
  const { runRootCommit } = load("src/services/db-commit-kernel");
  const work = load("src/services/domain-work-authority-service");
  const receipts = load("src/services/notification-fact-receipt-service");
  const service = load("src/services/notification-consequence-service");
  const { scheduleFanDataPointRefresh } = load("src/services/fan-data-authority-service");
  const commit = fn => runRootCommit(db, ({ tx }) => fn(tx), { profile: "JOB_CHUNK" });
  const now = async () => (await db.$queryRawUnsafe('SELECT clock_timestamp() AS "now"'))[0].now;
  const installer = async () => {
    await db.$disconnect(); await fixture.waitForIdle();
    let output = "";
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/database/install-current.js"], {
        cwd: root, env: { ...process.env, DATABASE_URL: fixture.url }, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
      child.once("error", reject); child.once("exit", status => status === 0 ? resolve() : reject(Error(output)));
    });
    await fixture.waitForIdle();
  };
  try {
    if (!baseline) await check("real installer upgrades a populated prior schema and is repeatable", async () => {
      await db.loginAdmissionBucket.create({ data: { id: "notification-183-preserved", windowStartedAt: new Date(), expiresAt: new Date(Date.now() + 86400000), attempts: 3 } });
      await installer();
      assert.equal((await db.loginAdmissionBucket.findUnique({ where: { id: "notification-183-preserved" } })).attempts, 3);
      assert.equal((await load("src/services/database-contract-service").assertDatabaseContract(db)).ready, true);
      await installer();
      const rows = await db.$queryRawUnsafe('SELECT * FROM "_prisma_migrations" WHERE migration_name=$1', migration);
      assert.equal(rows.length, 1); assert.ok(rows[0].finished_at);
      assert.equal((await load("scripts/database/background-maintenance-indexes").ensureIndexes(db)).ready, true);
    });
    const scope = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", "phase2_team_control_plane_v2_durable_access");
      const user = await tx.user.create({ data: { email: "notification-183@example.test", passwordHash: "fixture" } });
      const agency = await tx.agency.create({ data: { name: "notification 183" } });
      await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
      const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: "fixture", status: "READY" } });
      return { agencyId: agency.id, creatorId: creator.id };
    });
    assert.equal(await db.creatorAccount.count(), 1);
    for (let i = 0; i < 4; i++) {
      const decision = await scheduleFanDataPointRefresh({ db, ...scope, onlyFansUserIds: [String(100 + i)], now: await now() });
      assert.equal(decision.created, true);
    }
    let serial = 0;
    async function receipt(target = scope, historical = false) {
      const at = await now();
      const job = await db.jobInstance.create({ data: { ...target, jobKey: "catchup_notifications_scan", scope: "creator", status: "DONE", params: { notificationMode: historical ? "full" : "catchup" } } });
      const fact = await db.creatorSubscriptionEvent.create({ data: { ...target, fanOnlyFansUserIdAtEvent: "123", eventFingerprint: String(++serial).padStart(64, "0"), eventType: "SUBSCRIBED_FREE", occurredAt: at } });
      await commit(tx => receipts.capture({ db: tx, job, groups: [{ kind: "CreatorSubscriptionEvent", ids: [fact.id] }] }));
      const item = await db.domainWorkItem.findUnique({ where: { agencyId_workClass_objectType_objectId: { agencyId: target.agencyId, workClass: receipts.WORK_CLASS, objectType: "JobInstance", objectId: job.id } } });
      assert.ok(item); return { job, fact, item };
    }
    const source = await receipt();
    const stored = () => db.domainWorkItem.findUnique({ where: { id: source.item.id } });
    const makeDue = () => commit(tx => tx.domainWorkItem.update({ where: { id: source.item.id }, data: { availableAt: new Date(0), nextAttemptAt: new Date(0) } }));
    const run = () => service.runNotificationConsequenceSweep({ db, limit: 3, maxRuntimeMs: 5000 });
    if (baseline) {
      await check("old code reproduces the reported eight-failure capacity quarantine", async () => {
        for (let i = 0; i < 8; i++) { await makeDue(); assert.equal((await run()).failed, 1); }
        const row = await stored(); assert.equal(row.state, "RECONCILE_REQUIRED"); assert.equal(row.consecutiveFailures, 8);
        assert.equal(row.terminalCause, `RETRY_EXHAUSTED:${code}`);
        assert.equal(await db.notificationFactReceipt.count({ where: { jobId: source.job.id } }), 1);
        console.log(JSON.stringify({ state: row.state, consecutiveFailures: row.consecutiveFailures, lastError: row.lastError, terminalCause: row.terminalCause }));
      });
      return;
    }
    await commit(tx => tx.domainWorkItem.update({ where: { id: source.item.id }, data: {
      state: "RECONCILE_REQUIRED", errorClass: "RETRY_EXHAUSTED", consecutiveFailures: 8, failureRevision: 1n,
      terminalCause: `RETRY_EXHAUSTED:${code}`, lastError: `${code}: ${code}`, progressCursor: { processed: 6 },
    } }));
    await check("live maintenance recovers exact quarantine, then waits without acknowledging its receipt", async () => {
      const result = await run(); assert.equal(result.recovered, 1); assert.equal(result.backpressured, 1); assert.equal(result.failed, 0);
      const row = await stored(); assert.equal(row.state, "READY"); assert.equal(row.consecutiveFailures, 0);
      assert.equal(row.requestedRevision, 2n); assert.deepEqual(row.progressCursor, { processed: 6 });
      assert.equal(row.lastRepair.kind, "notification_refresh_capacity_recovery_v1");
      assert.ok(+row.availableAt >= Date.now() + 20000);
      assert.equal(await db.notificationFactReceipt.count({ where: { jobId: source.job.id } }), 1);
      assert.equal(await db.automationBumpFanState.count(), 0, "projection writes before admission must roll back");
    });
    await check("twelve full-queue waits preserve budget, source and cursor across module reload", async () => {
      for (let i = 0; i < 12; i++) {
        await makeDue();
        const modulePath = require.resolve(path.join(root, "src/services/notification-consequence-service"));
        delete require.cache[modulePath];
        const result = await require(modulePath).runNotificationConsequenceSweep({ db, limit: 3 });
        assert.equal(result.waiting, 1); assert.equal(result.failed, 0); assert.equal(result.recovered, 0);
        assert.equal((await stored()).consecutiveFailures, 0);
        assert.equal(await db.notificationFactReceipt.count({ where: { jobId: source.job.id } }), 1);
      }
      assert.equal(await db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: "fan_data_point_refresh", status: "SCHEDULED" } }), 4);
      assert.equal(await db.creatorSubscriptionEvent.count(), 1);
    });
    await check("one creator at capacity does not block another creator's historical reconciliation", async () => {
      const creator = await commit(tx => tx.creatorAccount.create({ data: { agencyId: scope.agencyId, displayName: "second fixture", status: "READY" } }));
      const other = await receipt({ agencyId: scope.agencyId, creatorId: creator.id }, true);
      assert.equal((await run()).completed, 1);
      assert.equal((await db.domainWorkItem.findUnique({ where: { id: other.item.id } })).state, "DONE");
      assert.equal(await db.automationBumpFanState.count({ where: { creatorId: creator.id } }), 0);
      assert.equal(await db.automationDelivery.count(), 0, "historical facts cannot replay sends");
    });
    await check("freeing one slot completes the original receipt once and preserves the queue limit", async () => {
      const job = await db.jobInstance.findFirst({ where: { creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" } });
      await db.jobInstance.update({ where: { id: job.id }, data: { status: "DONE", completedAt: await now() } });
      await makeDue(); const result = await run(); assert.equal(result.completed, 1); assert.equal(result.failed, 0);
      assert.equal((await stored()).state, "DONE");
      assert.equal(await db.notificationFactReceipt.count({ where: { jobId: source.job.id } }), 0);
      assert.equal(await db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: "fan_data_point_refresh", status: "SCHEDULED" } }), 4);
      await commit(tx => receipts.capture({ db: tx, job: source.job, groups: [{ kind: "CreatorSubscriptionEvent", ids: [source.fact.id] }] }));
      assert.equal((await run()).completed, 1);
      assert.equal(await db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: "fan_data_point_refresh", status: "SCHEDULED" } }), 4);
    });
    await check("a failed same-bucket refresh is not accepted as a durable reconciliation", async () => {
      const refresh = await db.jobInstance.findFirst({ where: { creatorId: scope.creatorId, jobKey: "fan_data_point_refresh", params: { path: ["consumer"], equals: "bumps_runtime" } } });
      assert.ok(refresh);
      await db.jobInstance.update({ where: { id: refresh.id }, data: { status: "FAILED" } });
      await commit(tx => receipts.capture({ db: tx, job: source.job, groups: [{ kind: "CreatorSubscriptionEvent", ids: [source.fact.id] }] }));
      const result = await run(); assert.equal(result.failed, 1); assert.equal(result.completed, 0);
      assert.match(result.reason, /FAN_REFRESH_INTENT_NOT_DURABLE/);
      assert.equal(await db.notificationFactReceipt.count({ where: { jobId: source.job.id } }), 1);
      await db.jobInstance.update({ where: { id: refresh.id }, data: { status: "SCHEDULED" } });
      await makeDue(); assert.equal((await run()).completed, 1);
    });
    const recovery = load("src/services/notification-refresh-recovery-service");
    await check("recovery is bounded, exact and uses a partial index behind 10000 historical rows", async () => {
      for (let start = 0; start < 10000; start += 500) await commit(tx => tx.domainWorkItem.createMany({ data: Array.from({ length: 500 }, (_, i) => ({
        id: `noise183:${start + i}`, ...scope, workClass: receipts.WORK_CLASS, objectType: "Noise", objectId: String(start + i), partitionKey: scope.creatorId, state: "DONE", isOutstanding: false,
      })) }));
      const ids = [];
      for (let i = 0; i < 6; i++) await commit(async tx => {
        const item = await work.publishDomainWork({ db: tx, ...scope, workClass: receipts.WORK_CLASS, objectType: "JobInstance", objectId: `quarantine183:${i}`, partitionKey: scope.creatorId });
        ids.push(item.id);
        await tx.domainWorkItem.update({ where: { id: item.id }, data: { state: "RECONCILE_REQUIRED", consecutiveFailures: 8, terminalCause: `RETRY_EXHAUSTED:${code}`, progressCursor: { processed: i } } });
      });
      const other = await commit(async tx => {
        const item = await work.publishDomainWork({ db: tx, ...scope, workClass: receipts.WORK_CLASS, objectType: "JobInstance", objectId: "unrelated183", partitionKey: scope.creatorId });
        return tx.domainWorkItem.update({ where: { id: item.id }, data: { state: "RECONCILE_REQUIRED", terminalCause: "RETRY_EXHAUSTED:UNKNOWN_ERROR" } });
      });
      await db.$executeRawUnsafe('ANALYZE "DomainWorkItem"');
      const plan = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT "id","agencyId","creatorId" FROM "DomainWorkItem" WHERE ${recovery.PREDICATE} ORDER BY "id" LIMIT 4`);
      assert.match(JSON.stringify(plan), /DomainWorkItem_notification_refresh_recovery_idx/); assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/);
      assert.equal((await recovery.recoverNotificationRefreshWork({ db })).resumed, 4);
      assert.equal((await recovery.recoverNotificationRefreshWork({ db })).resumed, 2);
      assert.equal((await recovery.recoverNotificationRefreshWork({ db })).selected, 0);
      assert.equal((await db.domainWorkItem.findUnique({ where: { id: other.id } })).state, "RECONCILE_REQUIRED");
      assert.equal((await db.domainWorkItem.findMany({ where: { id: { in: ids } } })).filter(row => row.state === "READY" && row.progressCursor != null).length, 6);
    });
    await check("a retired creator is retained for review instead of being resurrected", async () => {
      const retired = await commit(tx => tx.creatorAccount.create({ data: { agencyId: scope.agencyId, displayName: "retired fixture", status: "READY", deletedAt: new Date() } }));
      const item = await commit(async tx => {
        const item = await work.publishDomainWork({ db: tx, ...scope, workClass: receipts.WORK_CLASS, objectType: "JobInstance", objectId: "retired183", partitionKey: scope.creatorId });
        return tx.domainWorkItem.update({ where: { id: item.id }, data: { creatorId: retired.id, state: "RECONCILE_REQUIRED", terminalCause: `RETRY_EXHAUSTED:${code}` } });
      });
      const result = await recovery.recoverNotificationRefreshWork({ db }); assert.equal(result.retained, 1); assert.equal(result.resumed, 0);
      assert.equal((await db.domainWorkItem.findUnique({ where: { id: item.id } })).state, "RECONCILE_REQUIRED");
      assert.equal((await recovery.recoverNotificationRefreshWork({ db })).selected, 0);
    });
    console.log(JSON.stringify({ ok: true, cases: checks.length, nativePostgres: false, productionAccessed: false, queries: queries.length }));
  } finally { await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
