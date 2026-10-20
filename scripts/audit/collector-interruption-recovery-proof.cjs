"use strict";
// Disposable, fully migrated PostgreSQL/PGlite and real Prisma/services. These
// fixtures recreate persisted pre-fix poison; no live database/provider access.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { createAdminSqlRuntime } = require("../test-support/admin-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const root = path.resolve(__dirname, "../..");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("DATABASE_RECOVERY_PROOF_DEADLINE"); process.exit(2); }, 240000);
const checks = [], pass = name => { checks.push(name); console.log("PASS", name); };

(async () => {
  const f = await createAdminSqlRuntime({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME });
  try {
    let db = f.db;
    const now = new Date(), old = new Date(+now - 3 * 86400000);
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
      const now = new Date();
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
      const seed = require(root+"/scripts/test-support/campaign-read-coverage-fixture.cjs").seedCoverage;
      await seed(tx, s, { kind: "FINANCIAL", now: old, state: { baselineGeneration: "fixture-FINANCIAL-" + s.creatorId, receiptCoverageVersion: 1 } });
      await seed(tx, s, { kind: "CAMPAIGNS", now: old, state: { baselineGeneration: "fixture-CAMPAIGNS-" + s.creatorId,
        membershipCoverageStatus: "COMPLETE", fanValueFreshnessStatus: "COMPLETE" } });
      await require(root + "/src/services/earnings-generation-service").lock(tx, s.creatorId);
      await tx.creatorEarningsLedgerProof.create({ data: { ...narrow, fromAt: new Date("2016-01-01T00:00:00Z"), throughAt: old, generation: "fixture-ledger-baseline" } });
    });

    let orchestrator = require(root + "/src/services/creator-analytics-sync-orchestrator");
    const results = require(root + "/src/services/job-result-service");
    const policy = require(root + "/src/services/collector-retry-policy");
    const control = require(root + "/src/services/analytics-collector-control-service");
    const models = { catchup_notifications_scan: "creatorNotificationSyncState", financial_transactions_scan: "creatorFinancialCollectionState", fetch_campaigns: "creatorCampaignCollectionState" };
    const plan = () => orchestrator.ensureRecurringCreatorAnalyticsCatchups({ db, ...narrow });
    const queued = () => db.jobInstance.findMany({ where: { ...narrow, jobKey: { in: Object.keys(models) }, status: "SCHEDULED" } });
    async function fail(job, error = "lease expired", failure = null) {
      await commit(async tx => {
        await tx.jobInstance.update({ where: { id: job.id }, data: { status: "FAILED", attempts: 5, lastError: error,
          result: failure ? { failure } : {}, completedAt: new Date() } });
        // The production lease transaction calls the writer with the pre-update
        // job object. The failure classifier must reread this exact attempt.
        await results.recordJobFailure({ db: tx, job, error, terminal: true });
      });
    }
    assert.equal((await plan()).created.length, 3);
    const originalJobs = await queued();
    const firstSweep = await scheduler.runRecurringCreatorWork({ db });
    assert.equal(firstSweep.totalDegraded, 0);
    const plannerRow = () => db.domainWorkItem.findFirst({ where: { ...narrow, workClass: "CREATOR_RECURRING_PLANNING" } });
    const yielded = await plannerRow();
    assert(+yielded.availableAt > Date.now() + 30 * 60_000);
    await assert.rejects(commit(async tx => {
      const job = originalJobs[0];
      await tx.jobInstance.update({ where: { id: job.id }, data: { status: "FAILED", attempts: 5, lastError: "lease expired", completedAt: new Date() } });
      await results.recordJobFailure({ db: tx, job, error: "lease expired", terminal: true });
      throw Error("INJECTED_ROLLBACK_AFTER_RETRY_SIGNAL");
    }), /INJECTED_ROLLBACK_AFTER_RETRY_SIGNAL/);
    assert.equal(await db.subscriberDirectoryMaintenanceSignal.count({ where: { ...narrow, kind: "DERIVED_PLANNING" } }), 0);
    assert.equal((await db.jobInstance.findUnique({ where: { id: originalJobs[0].id } })).status, "SCHEDULED");
    for (const job of originalJobs) await fail(job);
    for (const job of originalJobs) {
      const state = await db[models[job.jobKey]].findUnique({ where: { creatorId: s.creatorId } });
      assert.equal(state.status, "FAILED"); assert(+state.retryAfterAt > Date.now());
      assert(+state.retryAfterAt < Date.now() + policy.MAX_RETRY_MS + 1000);
    }
    for (let tick = 0; tick < 3; tick++) {
      const result = await plan();
      assert.equal(result.created.length, 0); assert.deepEqual(result.blocked, []);
      assert(result.skipped.every(value => value.endsWith(":deferred")));
      assert.equal(result.pendingRecoveryCount, 4); assert(result.nextRetryAt > new Date());
    }
    pass("five exhausted leases retain three recovery debts with bounded backoff, without new-job churn");
    const retrySignal = await db.subscriberDirectoryMaintenanceSignal.findFirst({ where: { ...narrow, kind: "DERIVED_PLANNING" } });
    assert.equal(retrySignal.reason, "COLLECTOR_RETRY"); assert(+retrySignal.dueAt > Date.now());
    assert.equal(+(await plannerRow()).availableAt, +yielded.availableAt);
    // Advance the disposable due-time fixture rather than waiting fifteen
    // minutes. Dispatch uses the actual claim token/revision and DWI authority.
    await db.subscriberDirectoryMaintenanceSignal.update({ where: { id: retrySignal.id }, data: { dueAt: new Date(0) } });
    const signalService = require(root + "/src/services/subscriber-directory-maintenance-signal-service");
    const claim = await signalService.claimSubscriberDirectoryMaintenanceSignal({ db });
    assert.equal(claim.kind, "DERIVED_PLANNING");
    await require(root + "/src/services/subscriber-directory-maintenance-service")._test.dispatchSubscriberDerivedPlanning({ db, signal: claim });
    assert(+(await plannerRow()).availableAt < +yielded.availableAt);
    assert(+(await plannerRow()).availableAt <= Date.now() + 1000);
    assert.equal(await db.subscriberDirectoryMaintenanceSignal.count({ where: { id: retrySignal.id } }), 0);
    pass("failure after hourly planner yield commits a durable due-time outbox wake; transaction rollback leaves neither failure nor signal");

    // Persist the exact old168 state: the current generation failed three days
    // ago and retryAfterAt is NULL. This is a data fixture, not an UPDATE-all
    // repair: the runtime joins each row to its exact historical source job.
    for (const job of originalJobs) await commit(async tx => {
      const requestedAt = new Date(+old + 60_000), failedAt = new Date(+old + 120_000);
      await tx.jobInstance.update({ where: { id: job.id }, data: { completedAt: failedAt, createdAt: requestedAt,
        params: { ...job.params, collectionRequestedAt: requestedAt.toISOString(), collectionAuthorityRequestedAt: requestedAt.toISOString() } } });
      await tx[models[job.jobKey]].update({ where: { creatorId: s.creatorId }, data: { retryAfterAt: null, activeRequestedAt: requestedAt } });
    });
    await db.$disconnect(); await db.$connect();
    delete require.cache[require.resolve(root + "/src/services/creator-analytics-sync-orchestrator")];
    orchestrator = require(root + "/src/services/creator-analytics-sync-orchestrator");
    const recovered = await plan();
    assert.equal(recovered.created.length, 3); assert.deepEqual(recovered.blocked, []);
    const nextJobs = await queued();
    for (const job of nextJobs) {
      const previous = originalJobs.find(oldJob => oldJob.jobKey === job.jobKey);
      assert.notEqual(job.id, previous.id); assert.notEqual(job.params.collectionGeneration, previous.params.collectionGeneration);
      assert.equal((await db.jobInstance.findUnique({ where: { id: previous.id } })).status, "FAILED");
      const intent = await db.creatorRecoveryIntent.findUnique({ where: { id: job.params.recoveryIntentId } });
      assert.equal(intent.status, "RUNNING"); assert.equal(intent.jobId, job.id);
    }
    for (let tick = 0; tick < 3; tick++) assert.equal((await plan()).created.length, 0);
    assert.equal((await queued()).length, 3); assert.equal(await db.creatorRecoveryIntent.count({ where: narrow }), 4);
    pass("restart recovers old terminal interruptions into exactly one fresh generation per stream and rebinds existing intents");

    const campaign = nextJobs.find(job => job.jobKey === "fetch_campaigns");
    const financial = nextJobs.find(job => job.jobKey === "financial_transactions_scan");
    const notification = nextJobs.find(job => job.jobKey === "catchup_notifications_scan");
    const transportError = "SESSION_FETCH_TIMEOUT: Request timed out [GET /api2/v2/users/me/notifications; status=0]";
    await fail(notification, transportError, { code: "SESSION_FETCH_TIMEOUT", method: "GET", status: 0, retryable: true, message: transportError });
    const authError = "OF_REQUEST_FAILED: Unauthorized [GET /api2/v2/earnings; status=401]";
    await fail(financial, authError, { code: "OF_REQUEST_FAILED", method: "GET", status: 401, retryable: false, message: authError });
    await fail(campaign, "CAMPAIGN_CURSOR_PROOF_INVALID", { code: "CAMPAIGN_CURSOR_PROOF_INVALID", method: "GET", status: 0, retryable: true, message: "CAMPAIGN_CURSOR_PROOF_INVALID" });
    await db.workerDevice.update({ where: { id: "recovery-device" }, data: { lastSeenAt: old } });
    await db.deviceCreatorBinding.updateMany({ where: narrow, data: { sessionReadReady: false, lastSeenAt: old, lastCapabilityAt: old } });
    const waiting = await plan();
    assert.deepEqual(waiting.blocked, [{ stream: "campaigns", reason: "failed_terminal", code: "CAMPAIGN_COLLECTION_FAILED" }]);
    assert(waiting.skipped.includes("financial:waiting_for_api_session")); assert.equal((await queued()).length, 0);
    for (let tick = 0; tick < 3; tick++) assert.equal((await plan()).created.length, 0);
    await receive(null); // stale access epoch cannot turn failed auth into READY
    assert.equal((await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: s.creatorId } })).retryAfterAt, null);
    await db.workerDevice.update({ where: { id: "recovery-device" }, data: { lastSeenAt: new Date() } });
    await receive();
    assert.equal((await plan()).created.length, 0); // fresh auth still respects backoff
    assert((await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: s.creatorId } })).retryAfterAt);
    await commit(async tx => {
      for (const model of ["creatorNotificationSyncState", "creatorFinancialCollectionState"])
        await tx[model].update({ where: { creatorId: s.creatorId }, data: { retryAfterAt: new Date(Date.now() - 1000) } });
    });
    const independent = await plan();
    assert.equal(independent.created.length, 2); assert.equal(independent.blocked.length, 1);
    assert(independent.created.includes("financial_offline_recovery")); assert(independent.created.includes("notifications_offline_recovery"));
    pass("GET transport recovers, 401 requires authorized fresh session plus backoff, and contract failure cannot block other streams");

    // Negative fences use real SQL rows. No stale generation or other scope can
    // acquire permission to retry merely by retaining the phrase lease expired.
    const currentCampaign = () => db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    const initialCampaign = await currentCampaign();
    await db.jobInstance.update({ where: { id: campaign.id }, data: { lastError: "lease expired", result: {},
      params: { ...campaign.params, collectionGeneration: "different-generation" } } });
    const attemptRecovery = (extra = {}) => policy.recoverTerminalCollector({ db, type: "CAMPAIGNS", state: initialCampaign, ...narrow, now: new Date(), ...extra });
    await attemptRecovery(); assert.equal((await currentCampaign()).retryAfterAt, null);
    await db.jobInstance.update({ where: { id: campaign.id }, data: { params: campaign.params } });
    await attemptRecovery({ agencyId: "different-agency" }); assert.equal((await currentCampaign()).retryAfterAt, null);
    await db.creatorCampaignCollectionState.update({ where: { creatorId: s.creatorId }, data: { sourceJobId: financial.id } });
    await policy.recoverTerminalCollector({ db, type: "CAMPAIGNS", state: await currentCampaign(), ...narrow, now: new Date() });
    assert.equal((await currentCampaign()).retryAfterAt, null);
    await db.creatorCampaignCollectionState.update({ where: { creatorId: s.creatorId }, data: { sourceJobId: campaign.id } });
    await db.jobInstance.update({ where: { id: campaign.id }, data: { lastError: "CAMPAIGN_CURSOR_PROOF_INVALID" } });
    const manual = await require(root + "/src/services/campaign-scan-control-service").startManualCampaignScan({
      db, creator: { id: s.creatorId, agencyId: s.agencyId }, requestedByUserId: s.userId, intent: "source" });
    assert.notEqual(manual.job.params.collectionGeneration, campaign.params.collectionGeneration);
    assert.equal(manual.job.status, "SCHEDULED"); assert.equal(manual.job.params.collectionMode, "full");
    const beforeAccept = await plan(); assert.deepEqual(beforeAccept.blocked, []);
    await control.acceptCampaignGeneration({ db, job: manual.job });
    await results.recordJobFailure({ db, job: campaign, error: "lease expired", terminal: true });
    assert.equal((await currentCampaign()).activeGeneration, manual.job.params.collectionGeneration);
    assert.equal((await currentCampaign()).status, "SCANNING");
    pass("source job, generation and agency fences reject stale repair; explicit source START creates a fresh command immune to old failure");
    console.log(JSON.stringify({ ok: true, checks: checks.length, names: checks }, null, 2));
  } finally { await f.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
.finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });
