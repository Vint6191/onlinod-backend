"use strict";
// Disposable current-schema database only. This proof exercises the actual
// resolver -> worker claim boundary, which direct receipt fixtures bypassed.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const root = path.resolve(__dirname, "../..");
const checks = [], pass = message => { checks.push(message); console.log("PASS", message); };
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("FINANCIAL_CLAIM_PROOF_DEADLINE"); process.exit(2); }, 240000);

(async () => {
  const runtime = await createScaleSqlRuntime();
  try {
    const { db } = runtime;
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const { runRootCommit } = require(root + "/src/services/db-commit-kernel");
    const tx = fn => runRootCommit(db, async ({ tx }) => {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
      return fn(tx);
    });
    const receipts = require(root + "/src/services/financial-receipt-authority");
    const gen = require(root + "/src/services/earnings-generation-service");
    const work = require(root + "/src/services/domain-work-authority-service");
    const resolver = require(root + "/src/services/money-resolution-service");
    const lease = require(root + "/src/services/job-lease-service");
    const s = await scope(db, { agencyId: "claim-agency", creatorId: "claim-creator", userId: "claim-user" });
    const now = new Date(), eventAt = new Date(+now - 3 * 86400000), baselineAt = new Date(+now - 4 * 86400000);
    await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(+now + 86400000) } });
    await db.workerDevice.create({ data: { id: "claim-device", agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
    await db.deviceCreatorBinding.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
      deviceId: "claim-device", sessionReadReady: true, lastSeenAt: now } });
    await tx(async t => {
      await gen.lock(t, s.creatorId);
      await t.creatorEarningsGeneration.create({ data: { id: "claim-base", agencyId: s.agencyId, creatorId: s.creatorId,
        runId: "claim-base", state: "ACTIVE", phase: "READY", fromAt: new Date("2020-01-01"),
        throughAt: baselineAt, snapshotAt: baselineAt, fullScan: true, publishedAt: baselineAt } });
      await t.creatorEarningsLedgerProof.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
        generation: "claim-base", activeGeneration: "claim-base", fromAt: new Date("2020-01-01"), throughAt: baselineAt } });
      await t.creatorMoneyObservation.create({ data: { id: "historical-money", agencyId: s.agencyId, creatorId: s.creatorId,
        occurredAt: eventAt, capturedAt: eventAt, status: "PENDING" } });
      await resolver.enqueue({ db: t, ...s, now: eventAt });
    });
    async function resolutionClaim() {
      await tx(t => t.domainWorkItem.updateMany({ where: { workClass: resolver.WORK_CLASS, state: "READY" }, data: { availableAt: new Date(0) } }));
      const batch = await work.claimDomainWorkBatch({ db, workClass: resolver.WORK_CLASS, limit: 1 });
      assert.equal(batch.items.length, 1);
      return { db, item: batch.items[0], ownerToken: batch.ownerToken };
    }
    const input = { userId: s.userId, deviceId: "claim-device", jobKeys: ["financial_transactions_scan", "catchup_notifications_scan"],
      capabilities: { creatorEventDrivenSyncV2: true, financialWindowReceiptsV1: true, financialTraversalV2: true, financialMoneyResolutionV1: true } };
    const planned = await resolver.processRequest(await resolutionClaim());
    assert(planned.created);
    const queued = await db.jobInstance.findUnique({ where: { id: planned.jobId } });
    const originalTo = receipts.date(queued.params.endDate).toISOString();
    assert(+receipts.date(originalTo) < +now - 2 * 86400000);
    const claimed = await lease.claimJob(input);
    assert.equal(claimed.job.id, queued.id);
    assert.equal(claimed.job.params.financialWindows[0].to, originalTo);
    assert.equal(claimed.job.params.financialWindows[0].kind, "RESOLUTION");
    assert.equal(claimed.job.params.collectionGeneration, queued.params.collectionGeneration);
    assert(+receipts.date(claimed.job.params.analyticsObservationStartedAt) >= +now);
    assert.equal(await db.creatorEarningsGenerationEntry.count(), 0);
    assert.equal((await db.creatorMoneyObservation.findUnique({ where: { id: "historical-money" } })).status, "PENDING");
    pass("actual resolver -> worker claim preserves the historical hour after three offline days, without publishing unverified money");

    let owned = await db.jobInstance.findUnique({ where: { id: queued.id } });
    const window = receipts.windowsFor(owned)[0];
    const page = { collectorVersion: receipts.COLLECTOR, scanRunId: owned.params.collectionGeneration, windowIndex: 0,
      pageNumber: 1, markerStart: window.initialMarker, markerEnd: null, rawReceived: 0, scannerRejected: 0,
      duplicateRows: 0, sourceHasMore: false, transactions: [] };
    const continuation = await tx(async t => {
      const prepared = await receipts.beforePage(t, owned, page);
      return receipts.commitPage(t, owned, page, prepared, [], 0);
    });
    // Crash after the receipt commit and before JobInstance.continuation update.
    const beforeRun = await db.financialReceiptRun.findUnique({ where: { id: receipts.runId(owned) } });
    await lease.releaseJob({ ...input, jobId: owned.id, leaseToken: claimed.job.leaseToken, leaseRevision: claimed.job.leaseRevision });
    await db.jobInstance.update({ where: { id: owned.id }, data: { nextRunAt: new Date(0) } });
    await db.$disconnect(); await db.$connect();
    const resumed = await lease.claimJob(input);
    assert.equal(resumed.job.id, owned.id);
    assert.deepEqual(resumed.job.params.financialWindows, owned.params.financialWindows);
    assert.deepEqual(resumed.job.continuation, continuation);
    assert.deepEqual(await db.financialReceiptRun.findUnique({ where: { id: beforeRun.id } }), beforeRun);
    assert.equal(await db.financialPageReceipt.count({ where: { runId: beforeRun.id } }), 1);
    pass("restart claim restores the committed receipt cursor and exact interval without replaying or widening the window");
    await tx(async t => { await receipts.enter(t); await t.jobInstance.update({ where: { id: owned.id }, data: { status: "PAUSED" } }); });

    await tx(async t => {
      await require(root + "/src/services/database-write-contract-service").authorizeCreatorAccountWrite(t);
      await t.creatorAccount.create({ data: { id: "healthy-creator", agencyId: s.agencyId, displayName: "Healthy", status: "READY" } });
      await t.deviceCreatorBinding.create({ data: { agencyId: s.agencyId, creatorId: "healthy-creator",
        deviceId: "claim-device", sessionReadReady: true, lastSeenAt: new Date() } });
    });
    const healthy = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: "healthy-creator", jobKey: "catchup_notifications_scan",
      scope: "creator", priority: 1, nextRunAt: new Date(0), params: { notificationMode: "catchup", notificationNormalizerVersion: "notification-source-v2" } } });
    const invalidParams = { ...queued.params, endDate: now.toISOString(), financialWindowGeneration: queued.params.collectionGeneration,
      financialWindows: [{ kind: "RESOLUTION", from: receipts.date(queued.params.startDate).toISOString(),
        to: now.toISOString(), initialMarker: String(Math.floor(+now / 1000)) }] };
    const invalid = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, jobKey: "financial_transactions_scan",
      scope: "creator", priority: 100, params: invalidParams, nextRunAt: new Date(0), startedAt: eventAt,
      result: { retainedDiagnostic: "fixture" } } });
    const other = await scope(db, { agencyId: "other-agency", creatorId: "other-creator", userId: "other-user" });
    const foreign = await db.jobInstance.create({ data: { agencyId: other.agencyId, creatorId: other.creatorId,
      jobKey: "financial_transactions_scan", scope: "creator", priority: 200, params: invalidParams, nextRunAt: new Date(0), startedAt: eventAt } });
    const foreignBefore = await db.jobInstance.findUnique({ where: { id: foreign.id } });
    // Database failure while retiring the exact invalid job must abort, rather
    // than be swallowed as another candidate validation failure.
    await db.$executeRawUnsafe('CREATE TABLE "FinancialClaimProofFault" (id text PRIMARY KEY)');
    await db.$executeRawUnsafe('INSERT INTO "FinancialClaimProofFault"(id) VALUES($1)', invalid.id);
    await db.$executeRawUnsafe(`CREATE FUNCTION financial_claim_proof_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='FAILED' AND EXISTS(SELECT 1 FROM "FinancialClaimProofFault" f WHERE f.id=NEW.id) THEN
        RAISE EXCEPTION 'FINANCIAL_CLAIM_PROOF_ROLLBACK';
      END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER financial_claim_proof_fault BEFORE UPDATE ON "JobInstance"
      FOR EACH ROW EXECUTE FUNCTION financial_claim_proof_fault()`);
    await assert.rejects(() => lease.claimJob(input), /FINANCIAL_CLAIM_PROOF_ROLLBACK/);
    assert.equal((await db.jobInstance.findUnique({ where: { id: invalid.id } })).status, "SCHEDULED");
    assert.equal((await db.jobInstance.findUnique({ where: { id: healthy.id } })).status, "SCHEDULED");
    await db.$executeRawUnsafe('DELETE FROM "FinancialClaimProofFault"');
    pass("a real database failure rolls back invalid-job retirement and is not swallowed by claim isolation");
    const next = await lease.claimJob(input);
    assert.equal(next.job.id, healthy.id);
    const rejected = await db.jobInstance.findUnique({ where: { id: invalid.id } });
    assert.equal(rejected.status, "FAILED");
    assert.equal(rejected.lastError, "FINANCIAL_RESOLUTION_BINDING_INVALID");
    assert.deepEqual(rejected.params, invalidParams);
    assert.equal(rejected.result.retainedDiagnostic, "fixture");
    assert.equal(rejected.result.failure.phase, "CLAIM_ADMISSION");
    assert.deepEqual(await db.financialReceiptRun.findUnique({ where: { id: beforeRun.id } }), beforeRun);
    assert.equal(await db.creatorEarningsGenerationEntry.count(), 0);
    assert.deepEqual(await db.jobInstance.findUnique({ where: { id: foreign.id } }), foreignBefore);
    pass("one frozen invalid financial candidate becomes FAILED and healthy other-creator work is claimed in the same request");
    pass("higher-priority foreign-agency work is neither claimed nor failed by another agency's worker");
    const localHealthy = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
      jobKey: "catchup_notifications_scan", scope: "creator", priority: 1, nextRunAt: new Date(0),
      params: { notificationMode: "catchup", notificationNormalizerVersion: "notification-source-v2" } } });
    const anotherInvalid = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
      jobKey: "financial_transactions_scan", scope: "creator", priority: 100, params: invalidParams,
      nextRunAt: new Date(0), startedAt: eventAt } });
    assert.equal((await lease.claimJob(input)).job.id, localHealthy.id);
    assert.equal((await db.jobInstance.findUnique({ where: { id: anotherInvalid.id } })).status, "FAILED");
    pass("invalid financial work also cannot starve an independent notification lane on the same creator");

    // Resolve the real request's invalid source attempt, preserving its target
    // and bounded backoff. This is not a generic UPDATE-all repair.
    await tx(async t => {
      await receipts.enter(t);
      await t.jobInstance.update({ where: { id: owned.id }, data: { status: "FAILED", lastError: "FINANCIAL_RESOLUTION_BINDING_INVALID" } });
    });
    const replacement = await resolver.processRequest(await resolutionClaim());
    assert(replacement.created);
    const request = await db.creatorMoneyResolutionRequest.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(request.targetId, "historical-money");
    assert.equal(request.jobId, replacement.jobId);
    assert.equal(request.attempts, 2);
    assert.equal(request.queued, true);
    const fresh = await db.jobInstance.findUnique({ where: { id: replacement.jobId } });
    assert.equal(receipts.date(fresh.params.endDate).toISOString(), originalTo);
    assert.notEqual(fresh.params.collectionGeneration, queued.params.collectionGeneration);
    assert(+fresh.nextRunAt > Date.now());
    await db.jobInstance.update({ where: { id: fresh.id }, data: { nextRunAt: new Date(0) } });
    assert.equal((await lease.claimJob(input)).job.id, fresh.id);
    assert.equal((await db.creatorMoneyObservation.findUnique({ where: { id: "historical-money" } })).status, "PENDING");
    pass("resolution retry keeps the unresolved observation, creates one bounded fresh generation with backoff, and claims it normally");

    await tx(t => t.domainWorkItem.updateMany({ where: { workClass: resolver.WORK_CLASS, state: "READY" }, data: { availableAt: new Date(0) } }));
    const softSlice = await resolver.runSweep({ db, limit: 1, maxRuntimeMs: 0 });
    assert.equal(softSlice.processed, 1);
    pass("an exhausted soft time slice still executes the first owned money-resolution unit instead of yielding forever");
    const report = { ok: true, engine: runtime.native ? "native PostgreSQL" : "PGlite + Prisma (single connection)", checks };
    if (process.env.ONLINOD_FINANCIAL_CLAIM_REPORT) fs.writeFileSync(process.env.ONLINOD_FINANCIAL_CLAIM_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });
