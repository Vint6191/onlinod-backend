"use strict";
// Disposable, fully migrated PostgreSQL/PGlite and real Prisma/services. These
// fixtures recreate persisted pre-fix poison; no live database/provider access.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { createAdminSqlRuntime } = require("../test-support/admin-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const root = path.resolve(__dirname, "../..");
const migrationPath = path.join(root, "prisma/migrations/20261018040000_domain_work_transient_recovery/migration.sql");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("DATABASE_RECOVERY_PROOF_DEADLINE"); process.exit(2); }, 240000);
const checks = [], pass = name => { checks.push(name); console.log("PASS", name); };

(async () => {
  const f = await createAdminSqlRuntime({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME });
  try {
    const { db } = f, now = new Date(), old = new Date(+now - 3 * 86400000);
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const { runRootCommit } = require(root + "/src/services/db-commit-kernel");
    const commit = work => runRootCommit(db, ({ tx }) => work(tx));
    let authority = require(root + "/src/services/domain-work-authority-service");
    let sync = require(root + "/src/services/creator-live-sync-service");
    let scheduler = require(root + "/src/services/job-scheduler");
    const heartbeat = require(root + "/src/services/device-heartbeat-batch-service");
    const s = await scope(db, { agencyId: "recovery-agency", creatorId: "recovery-creator", userId: "recovery-owner" });
    const narrow = { agencyId: s.agencyId, creatorId: s.creatorId };
    const member = await db.agencyMember.findUnique({ where: { id: "member-" + s.agencyId } });
    await db.workerDevice.create({ data: { id: "recovery-device", agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
    await db.creatorLiveSync.create({ data: { ...narrow, lastCapturedAt: old, lastDeliveredAt: old } });
    async function receive(accessEpoch = member.accessEpoch) {
      return commit(async tx => {
        const normalized = await heartbeat.syncBindings({ db: tx, agencyId: s.agencyId, deviceId: "recovery-device",
          accounts: [{ creatorId: s.creatorId, accessEpoch, sessionReadReady: true, realtimeHealthy: false }],
          allowedCreatorIds: new Set([s.creatorId]), currentAccessEpoch: member.accessEpoch, now });
        return sync.recordCaptureSamples({ db: tx, agencyId: s.agencyId, deviceId: "recovery-device", memberId: member.id,
          accessEpoch: member.accessEpoch, bindings: normalized.resolvedAccounts, now });
      });
    }
    await receive(null);
    assert.equal(await db.creatorRecoveryIntent.count({ where: narrow }), 0);
    await receive();
    const intents = await db.creatorRecoveryIntent.findMany({ where: narrow, orderBy: { stream: "asc" } });
    assert.equal(intents.length, 4); assert(intents.every(row => row.status === "PENDING"));
    assert.equal(await db.creatorRealtimeSession.count({ where: narrow }), 0);
    pass("only an authorized API-ready heartbeat creates four offline debts, without requiring a websocket");

    // Genuine committed read-side baseline receipts, with all database writer
    // guards enabled. The catchup itself is planned by the production scheduler.
    await commit(async tx => {
      const jobId = "notification-baseline", generation = "notification-baseline";
      await tx.jobInstance.create({ data: { id: jobId, ...narrow, scope: "CREATOR", jobKey: "catchup_notifications_scan", status: "PUBLISHING", params: { collectionGeneration: generation } } });
      await tx.analyticsPublication.create({ data: { id: jobId + ":1", jobId, ...narrow, userId: s.userId, deviceId: "recovery-device",
        leaseRevision: 1, leaseTokenHash: "fixture", payloadHash: "fixture", payload: { scanRunId: generation }, stage: "FINALIZE" } });
      await tx.creatorNotificationSyncState.create({ data: { ...narrow, status: "COMPLETE", normalizerVersion: "notification-source-v2",
        fullBackfillVerifiedAt: old, fullBackfillObservedAt: old, sourceJobId: jobId } });
      await tx.analyticsPublication.update({ where: { id: jobId + ":1" }, data: { state: "COMMITTED", completedAt: old } });
      await tx.jobInstance.update({ where: { id: jobId }, data: { status: "DONE" } });
      const seed = require("../test-support/campaign-read-coverage-fixture.cjs").seedCoverage;
      await seed(tx, s, { kind: "FINANCIAL", now: old, state: { baselineGeneration: "fixture-FINANCIAL-" + s.creatorId, receiptCoverageVersion: 1 } });
      await seed(tx, s, { kind: "CAMPAIGNS", now: old, state: { baselineGeneration: "fixture-CAMPAIGNS-" + s.creatorId,
        membershipCoverageStatus: "COMPLETE", fanValueFreshnessStatus: "COMPLETE" } });
      await require(root + "/src/services/earnings-generation-service").lock(tx, s.creatorId);
      await tx.creatorEarningsLedgerProof.create({ data: { ...narrow, fromAt: new Date("2016-01-01T00:00:00Z"), throughAt: old, generation: "fixture-ledger-baseline" } });
    });
    const planner = await db.domainWorkItem.findFirst({ where: { ...narrow, workClass: "CREATOR_RECURRING_PLANNING" } });
    assert(planner);
    const cursor = { lastFullPlanningAt: now.toISOString(), lastPlanningCycleAt: old.toISOString() };
    // Persisted state produced by the old eight-error policy. Pending recovery
    // intents already exist, so subsequent healthy heartbeats do not republish.
    await db.domainWorkItem.update({ where: { id: planner.id }, data: { state: "RECONCILE_REQUIRED", isOutstanding: true,
      ownerToken: null, leaseUntil: old, nextAttemptAt: null, consecutiveFailures: 8, failureRevision: planner.requestedRevision,
      errorClass: "RETRY_EXHAUSTED", terminalCause: "RETRY_EXHAUSTED:CREATOR_RECURRING_PLANNING_DEGRADED",
      lastError: "CREATOR_RECURRING_PLANNING_DEGRADED: analytics_planning:P2024", progressCursor: cursor } });
    await receive();
    assert.equal((await db.domainWorkItem.findUnique({ where: { id: planner.id } })).state, "RECONCILE_REQUIRED");
    delete require.cache[require.resolve(root + "/src/services/job-scheduler")]; scheduler = require(root + "/src/services/job-scheduler");
    const before = await scheduler.runRecurringCreatorWork({ db, now, ownerToken: "restart-before-repair" });
    assert.equal(before.creatorsScanned, 0); assert.equal(before.totalCreated, 0);
    assert.equal(await db.jobInstance.count({ where: { ...narrow, status: "SCHEDULED" } }), 0);
    pass("reproduced old failure: durable pending recovery plus quarantined planner survives restart and healthy heartbeat with zero catchup jobs");

    const expired = "P2028: Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15500 ms passed since the start of the transaction.";
    async function poisoned(id, overrides = {}) {
      const row = await authority.publishDomainWork({ db, ...narrow, workClass: "ANALYTICS_FACT_PUBLICATION", objectType: "ProofFixture",
        objectId: id, partitionKey: s.creatorId, availableAt: old });
      return db.domainWorkItem.update({ where: { id: row.id }, data: { state: "RECONCILE_REQUIRED", isOutstanding: true,
        ownerToken: null, leaseUntil: old, consecutiveFailures: 8, failureRevision: row.requestedRevision,
        errorClass: "RETRY_EXHAUSTED", terminalCause: "RETRY_EXHAUSTED:P2024", lastError: "P2024: pool timeout",
        progressCursor: { afterFactId: id }, ...overrides } });
    }
    const liveRow = await authority.publishDomainWork({ db, ...narrow, workClass: "ANALYTICS_FACT_PUBLICATION", objectType: "ProofFixture", objectId: "live", partitionKey: s.creatorId });
    const live = (await authority.claimDomainWorkBatch({ db, workClass: "ANALYTICS_FACT_PUBLICATION", ownerToken: "live-worker", limit: 1 })).items[0];
    assert.equal(live.id, liveRow.id);
    await db.domainWorkItem.update({ where: { id: live.id }, data: { errorClass: "RETRY_EXHAUSTED", terminalCause: "RETRY_EXHAUSTED:P2024", lastError: "P2024: historical pool timeout" } });
    const positives = [await poisoned("direct"), await poisoned("expired", { terminalCause: "RETRY_EXHAUSTED:P2028", lastError: expired }),
      await poisoned("serialization", { terminalCause: "RETRY_EXHAUSTED:P2010", lastError: "P2010: Raw query failed. Code: `40001`. Message: `serialization failure`" }),
      await poisoned("publication", { workClass: "ANALYTICS_PUBLICATION" })];
    const nestedPlanner = await poisoned("nested-planner", { workClass: "CREATOR_RECURRING_PLANNING",
      terminalCause: "RETRY_EXHAUSTED:CREATOR_RECURRING_PLANNING_DEGRADED",
      lastError: "CREATOR_RECURRING_PLANNING_DEGRADED: creator_analytics:P2024; subscriber_directory_scan:P2034; follow_back_plan:P2024" });
    positives.push(nestedPlanner);
    await scope(db, { agencyId: "other-agency", creatorId: "other-creator", userId: "other-owner" });
    await db.domainWorkItem.updateMany({ where: { agencyId: "other-agency", workClass: "CREATOR_RECURRING_PLANNING" },
      data: { availableAt: new Date(+now + 86400000) } });
    const negatives = [await poisoned("contract", { errorClass: "CONTRACT", terminalCause: "P2024" }),
      await poisoned("ambiguous", { terminalCause: "RETRY_EXHAUSTED:P2028", lastError: "P2028: Transaction not found" }),
      await poisoned("bad-sql", { terminalCause: "RETRY_EXHAUSTED:P2010", lastError: "P2010: Raw query failed. Code: `23503`. Message: `mentions 40001`" }),
      await poisoned("old-generation", { activeGeneration: "retired-generation" }),
      await poisoned("external", { workClass: "CUSTOM_COMMUNICATION" }),
      await poisoned("no-creator", { agencyId: "other-agency", creatorId: null }),
      await poisoned("mixed-planner", { workClass: "CREATOR_RECURRING_PLANNING",
        terminalCause: "RETRY_EXHAUSTED:CREATOR_RECURRING_PLANNING_DEGRADED",
        lastError: "CREATOR_RECURRING_PLANNING_DEGRADED: analytics_planning:P2024; creator_planning:malformed_creator_planning_result" }),
      await poisoned("unknown-label", { workClass: "CREATOR_RECURRING_PLANNING",
        terminalCause: "RETRY_EXHAUSTED:CREATOR_RECURRING_PLANNING_DEGRADED",
        lastError: "CREATOR_RECURRING_PLANNING_DEGRADED: external_send:P2024" })];
    await assert.rejects(() => db.domainWorkItem.update({ where: { id: negatives[5].id }, data: { creatorId: s.creatorId } }),
      error => error.code === "P2003", "database composite scope guard must reject cross-agency creator work");

    await db.$disconnect(); await f.waitForIdle();
    await f.engine.exec("SET TIME ZONE 'Etc/GMT-1'");
    await f.engine.exec(fs.readFileSync(migrationPath, "utf8"));
    const repaired = await db.domainWorkItem.findUnique({ where: { id: planner.id } });
    assert.equal(repaired.state, "READY"); assert.equal(repaired.requestedRevision, planner.requestedRevision);
    assert.equal(repaired.completedRevision, planner.completedRevision); assert.deepEqual(repaired.progressCursor, cursor);
    assert.equal(repaired.consecutiveFailures, 0); assert.equal(repaired.lastRepair.kind, "database_outage_recovery_v1");
    assert(Math.abs(+repaired.availableAt - Date.now()) < 20000, "repair availability must remain UTC on a non-UTC database pool");
    for (const row of positives) {
      const current = await db.domainWorkItem.findUnique({ where: { id: row.id } });
      assert.equal(current.state, "READY", row.objectId); assert.deepEqual(current.progressCursor, row.progressCursor);
      assert.equal(current.requestedRevision, row.requestedRevision);
    }
    // Fixture-only second planner identity proves the historical nested cause
    // shape; retire it before exercising the canonical one-per-creator planner.
    await db.domainWorkItem.update({ where: { id: nestedPlanner.id }, data: { state: "DONE", isOutstanding: false } });
    for (const row of negatives) assert.deepEqual(await db.domainWorkItem.findUnique({ where: { id: row.id } }), row, row.objectId);
    const liveAfter = await db.domainWorkItem.findUnique({ where: { id: live.id } });
    assert.equal(liveAfter.state, "CLAIMED"); assert.equal(liveAfter.ownerToken, "live-worker"); assert.equal(liveAfter.claimFence, live.claimFence);
    pass("one-time SQL repair revives only proven database outages, preserves cursors/revisions/live leases and respects tenant/generation/error fences under non-UTC pool time");

    delete require.cache[require.resolve(root + "/src/services/creator-live-sync-service")]; sync = require(root + "/src/services/creator-live-sync-service");
    delete require.cache[require.resolve(root + "/src/services/job-scheduler")]; scheduler = require(root + "/src/services/job-scheduler");
    const after = await scheduler.runRecurringCreatorWork({ db, now, ownerToken: "restart-after-repair" });
    assert.equal(after.creatorsScanned, 1, JSON.stringify(after)); assert.equal(after.totalDegraded, 0, JSON.stringify(after));
    const jobs = await db.jobInstance.findMany({ where: { ...narrow, status: "SCHEDULED" } });
    for (const key of ["financial_transactions_scan", "catchup_notifications_scan", "fetch_campaigns", "subscriber_directory_scan"]) {
      assert(jobs.some(job => job.jobKey === key && job.params.recoveryIntentId), "missing exact recovery job: " + key);
    }
    assert.deepEqual((await db.creatorRecoveryIntent.findMany({ where: narrow, orderBy: { stream: "asc" } })).map(row => row.id), intents.map(row => row.id));
    await receive(); const again = await scheduler.runRecurringCreatorWork({ db, now, ownerToken: "next-empty-tick" });
    assert.equal(again.creatorsScanned, 0);
    assert.equal(await db.jobInstance.count({ where: { ...narrow, status: "SCHEDULED" } }), jobs.length);
    pass("restarted production scheduler consumes existing debts into financial, notification, campaign and subscriber catchups exactly once");

    // Real row locks/CAS/leases for >8 failures. Accelerate only the persisted
    // retry deadline after checking its bound; no production clock is mocked.
    const retryWork = await authority.publishDomainWork({ db, ...narrow, workClass: "ANALYTICS_FACT_ADOPTION", objectType: "ProofFixture", objectId: "retry", partitionKey: s.creatorId });
    const retryCursor = { afterFactId: "durably-committed" };
    await db.domainWorkItem.update({ where: { id: retryWork.id }, data: { progressCursor: retryCursor } });
    let previousClaim;
    for (let attempt = 1; attempt <= 12; attempt++) {
      delete require.cache[require.resolve(root + "/src/services/domain-work-authority-service")]; authority = require(root + "/src/services/domain-work-authority-service");
      const claimed = await authority.claimDomainWorkBatch({ db, workClass: "ANALYTICS_FACT_ADOPTION", ownerToken: "process-" + attempt, limit: 1 });
      assert.equal(claimed.items.length, 1); const item = claimed.items[0]; assert.equal(item.id, retryWork.id);
      if (previousClaim) assert.equal((await authority.ackDomainWorkClaim({ db, item: previousClaim })).acknowledged, false);
      const error = Object.assign(new Error("Timed out fetching a new connection from the connection pool."), { code: "P2024" });
      const result = await authority.failDomainWorkClaim({ db, item, error });
      assert.equal(result.state, "READY"); assert.equal(result.consecutiveFailures, attempt);
      const saved = await db.domainWorkItem.findUnique({ where: { id: item.id } });
      assert.deepEqual(saved.progressCursor, retryCursor);
      assert(+saved.nextAttemptAt - +saved.lastFailureAt > 0 && +saved.nextAttemptAt - +saved.lastFailureAt <= 900000);
      assert.match(saved.lastError, /^\[TRANSIENT_DB:P2024\]/);
      await db.domainWorkItem.update({ where: { id: item.id }, data: { availableAt: old, nextAttemptAt: old } });
      previousClaim = item;
    }
    const finalClaim = (await authority.claimDomainWorkBatch({ db, workClass: "ANALYTICS_FACT_ADOPTION", ownerToken: "database-restored", limit: 1 })).items[0];
    assert.deepEqual(finalClaim.progressCursor, retryCursor);
    assert.equal((await authority.ackDomainWorkClaim({ db, item: finalClaim })).acknowledged, true);
    pass("twelve temporary SQL failures retain bounded backoff and durable progress across new process owners; stale fences cannot acknowledge the restarted work");
    console.log(JSON.stringify({ ok: true, checks: checks.length, fixture: "disposable PGlite + actual Prisma/services; no provider/capacity claim" }));
  } finally { await f.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });
