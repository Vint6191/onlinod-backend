"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const root = path.resolve(__dirname, "../.."), checks = [];
const pass = text => { checks.push(text); console.log("PASS", text); };
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("FINANCIAL_RESOLUTION_PROOF_DEADLINE"); process.exit(2); }, 240000);
(async () => {
  const runtime = await createScaleSqlRuntime();
  let desktop;
  try {
    const { db } = runtime;
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const { runRootCommit } = require(root + "/src/services/db-commit-kernel");
    const tx = fn => runRootCommit(db, async ({ tx }) => {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)"); return fn(tx);
    });
    const receipts = require(root + "/src/services/financial-receipt-authority"), gen = require(root + "/src/services/earnings-generation-service");
    const work = require(root + "/src/services/domain-work-authority-service"), resolver = require(root + "/src/services/money-resolution-service");
    const lease = require(root + "/src/services/job-lease-service"), publication = require(root + "/src/services/analytics-publication-service");
    const diagnostics = require(root + "/src/services/financial-verification-diagnostics").financialVerificationDiagnostics;
    if (process.env.ONLINOD_DESKTOP_SOURCE) desktop = await require("../test-support/desktop-financial-handler.cjs").loadDesktopFinancialHandler(process.env.ONLINOD_DESKTOP_SOURCE);
    const now = new Date(), eventAt = new Date(+now - 3 * 86400000), baselineAt = new Date(+now - 4 * 86400000), fromAt = new Date("2020-01-01");
    async function claimRequest(creatorId) {
      await tx(t => t.domainWorkItem.updateMany({ where: { creatorId, workClass: resolver.WORK_CLASS, state: "READY" }, data: { availableAt: new Date(0) } }));
      const batch = await work.claimDomainWorkBatch({ db, workClass: resolver.WORK_CLASS, limit: 10 });
      const item = batch.items.find(row => row.creatorId === creatorId); assert(item);
      for (const other of batch.items.filter(row => row.id !== item.id)) await work.yieldDomainWorkClaim({ db, item: other, ownerToken: batch.ownerToken, availableAt: new Date(+now + 3600000) });
      return { db, item, ownerToken: batch.ownerToken };
    }
    async function scenario(name, { mismatch = false, missingNet = false, runningDebt = false, emptySource = false } = {}) {
      const s = await scope(db, { agencyId: name + "-agency", creatorId: name + "-creator", userId: name + "-user" });
      const deviceId = name + "-device", transactionId = name + "-money", observationId = name + "-observation";
      await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(+now + 86400000) } });
      await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: new Date() } });
      await db.deviceCreatorBinding.create({ data: { deviceId, agencyId: s.agencyId, creatorId: s.creatorId, sessionReadReady: true, lastSeenAt: new Date() } });
      await tx(async t => {
        await gen.lock(t, s.creatorId);
        await t.creatorEarningsGeneration.create({ data: { id: name + "-base", agencyId: s.agencyId, creatorId: s.creatorId,
          runId: name + "-base", state: "ACTIVE", phase: "READY", fromAt, throughAt: baselineAt, snapshotAt: baselineAt, fullScan: true, publishedAt: baselineAt } });
        await t.creatorEarningsLedgerProof.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, generation: name + "-base",
          activeGeneration: name + "-base", fromAt, throughAt: baselineAt } });
        await t.creatorMoneyObservation.create({ data: { id: observationId, agencyId: s.agencyId, creatorId: s.creatorId,
          transactionId, occurredAt: eventAt, capturedAt: eventAt, status: "PENDING" } });
        await resolver.enqueue({ db: t, ...s, now: eventAt });
      });
      const planned = await resolver.processRequest(await claimRequest(s.creatorId)); assert(planned.created);
      const claimed = await lease.claimJob({ userId: s.userId, deviceId, jobKeys: ["financial_transactions_scan"],
        capabilities: { creatorEventDrivenSyncV2: true, financialWindowReceiptsV1: true, financialMoneyResolutionV1: true, financialTraversalV2: true } });
      assert.equal(claimed.job.id, planned.jobId);
      const job = await db.jobInstance.findUnique({ where: { id: planned.jobId } }), window = job.params.financialWindows[0];
      assert.equal(window.kind, "RESOLUTION"); assert.equal(Date.parse(window.to) - Date.parse(window.from), 3600000);
      assert.equal((await require(root + "/src/services/creator-overview-service").readCreatorCurrentTask({ db, creatorId: s.creatorId })).label, "Transaction verification");
      // Independent newer main collector authority must neither supersede the
      // bounded request nor be changed by its progress, failure or publication.
      const mainCommand = require(root + "/src/services/analytics-collector-control-service").buildCollectionCommand({
        collectorType: "FINANCIAL", collectionMode: "catchup", reason: "RECOVERY", now: new Date(Date.parse(job.params.collectionRequestedAt) + 1000) });
      const normal = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId,
        jobKey: "financial_transactions_scan", scope: "creator", status: "SCHEDULED", params: mainCommand, nextRunAt: new Date(+now + 3600000) } });
      await db.creatorFinancialCollectionState.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, status: "SCANNING", mode: "catchup",
        activeGeneration: mainCommand.collectionGeneration, activeRequestedAt: new Date(mainCommand.collectionRequestedAt), sourceJobId: normal.id,
        retryAfterAt: new Date(+now + 300000), lastErrorCode: "prior-main-state" } });
      const mainBefore = await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: s.creatorId } });
      await db.creatorRecoveryIntent.create({ data: { id: name + "-recovery", agencyId: s.agencyId, creatorId: s.creatorId, stream: "financial",
        reason: "OFFLINE_GAP", gapFrom: baselineAt, targetAt: now, policyVersion: 2, status: runningDebt ? "RUNNING" : "PENDING",
        ...(runningDebt ? { jobId: name + "-prior-failed-job" } : {}) } });
      await tx(t => work.publishDomainWork({ db: t, ...s, workClass: "CREATOR_RECURRING_PLANNING", objectType: "CreatorAccount",
        objectId: s.creatorId, partitionKey: s.creatorId, availableAt: new Date(+now + 3600000) }));
      const request = await db.creatorMoneyResolutionRequest.findUnique({ where: { creatorId: s.creatorId } });
      const providerRow = { id: transactionId, amount: 10, ...(missingNet ? {} : { net: 8 }), fee: 2, status: "done",
        createdAt: eventAt.toISOString(), descriptionDetails: { type: "tip" }, user: { id: "42" } };
      const chart = { total: { gross: emptySource ? 57 : mismatch ? 20 : 10, total: emptySource ? 45.6 : mismatch ? 16 : 8, count: emptySource ? 3 : mismatch ? 2 : 1 } };
      const providerCalls = [];
      let checkpoint = claimed.job.continuation ?? null;
      const credentials = { jobId: job.id, userId: s.userId, deviceId, leaseToken: claimed.job.leaseToken, leaseRevision: claimed.job.leaseRevision };
      for (let page = 0; page < 2; page++) {
        const step = desktop ? await desktop.handler.runChunk({ job, creatorId: s.creatorId,
          continuation: checkpoint?.jobContinuation ?? null, signal: new AbortController().signal,
          ofApi: { request: async request => { providerCalls.push(request); return { ok: true, data: page ? chart : { list: emptySource ? [] : [providerRow], hasMore: false } }; } } }) : {
          outcome: page ? "done" : "continue", progress: { percent: page ? 100 : 0 }, chunkResult: page ? {
            kind: "financial_chart_total", collectorVersion: receipts.COLLECTOR, scanRunId: job.params.collectionGeneration, windowIndex: 0,
            category: "total", rangeFrom: window.from, rangeTo: window.to, grossCents: chart.total.gross * 100,
            netCents: chart.total.total * 100, transactionsCount: chart.total.count,
          } : { kind: "financial_transactions_page", collectorVersion: receipts.COLLECTOR, scanRunId: job.params.collectionGeneration,
            windowIndex: 0, pageNumber: 1, markerStart: window.initialMarker, markerEnd: null, rawReceived: emptySource ? 0 : 1, scannerRejected: 0,
            duplicateRows: 0, sourceHasMore: false, transactions: emptySource ? [] : [{ externalTransactionId: transactionId, transactionType: "tip", amountCents: 1000,
              netCents: missingNet ? null : 800, feeCents: 200, currency: "USD", transactionStatus: "done", occurredAt: eventAt.toISOString(), fanOnlyFansUserId: "42" }] } };
        if (page === 0) {
          await db.creatorMoneyResolutionRequest.update({ where: { creatorId: s.creatorId }, data: { jobId: normal.id } });
          await assert.rejects(() => lease.progressJob({ ...credentials, expectedContinuation: checkpoint, chunkResult: step.chunkResult }), /FINANCIAL_RESOLUTION_AUTHORITY_STALE/);
          assert.equal(await db.financialReceiptRun.count({ where: { jobId: job.id } }), 0);
          await db.creatorMoneyResolutionRequest.update({ where: { creatorId: s.creatorId }, data: { jobId: request.jobId } });
        }
        const advanced = await lease.progressJob({ ...credentials, expectedContinuation: checkpoint, progress: step.progress,
          continuation: page ? { driverPhase: "complete", result: step.result || { scanRunId: job.params.collectionGeneration } }
            : { driverPhase: "execute", jobContinuation: step.continuation }, chunkResult: step.chunkResult });
        assert(!advanced.sideEffect?.staleProgress); checkpoint = advanced.continuation;
        assert.deepEqual(await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: s.creatorId } }), mainBefore);
      }
      assert.equal(checkpoint.driverPhase, "complete");
      if (desktop) { assert.equal(providerCalls.length, 2); assert(providerCalls.every(call => call.creatorId === s.creatorId)); }
      const accepted = await lease.completeJob({ ...credentials, result: checkpoint.result }); assert(accepted.publicationId);
      await db.creatorMoneyResolutionRequest.update({ where: { creatorId: s.creatorId }, data: { targetId: "unknown-observation" } });
      await assert.rejects(() => publication.runAnalyticsPublicationUnit({ db, publicationId: accepted.publicationId }), /FINANCIAL_RESOLUTION_AUTHORITY_STALE/);
      assert.equal((await db.jobInstance.findUnique({ where: { id: job.id } })).status, "PUBLISHING");
      await db.creatorMoneyResolutionRequest.update({ where: { creatorId: s.creatorId }, data: { targetId: request.targetId } });
      let result;
      for (let attempt = 0; attempt < 8; attempt++) {
        await db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { availableAt: new Date(0) } });
        result = await publication.runAnalyticsPublicationUnit({ db, publicationId: accepted.publicationId });
        if (!result.publicationPending) break;
      }
      assert.equal(result.job.status, mismatch || missingNet ? "FAILED" : "DONE");
      assert.deepEqual(await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: s.creatorId } }), mainBefore);
      const proof = await db.creatorEarningsLedgerProof.findUnique({ where: { creatorId: s.creatorId } });
      assert.equal(proof.activeGeneration, name + "-base"); assert.equal(+proof.fromAt, +fromAt); assert.equal(+proof.throughAt, +baselineAt);
      const observation = await db.creatorMoneyObservation.findUnique({ where: { id: observationId } });
      const detail = diagnostics((await db.jobInstance.findUnique({ where: { id: job.id } })).result.completionSideEffect);
      if (emptySource) { assert.deepEqual(detail.windows[0].observed, { count: 0, grossCents: 0, netCents: 0 }); assert.deepEqual(detail.windows[0].expected, { count: 3, grossCents: 5700, netCents: 4560 }); }
      if (mismatch || missingNet) {
        assert.equal(observation.status, "PENDING"); assert.equal(observation.coveredGeneration, null);
        assert.equal(await db.creatorEarningsGenerationEntry.count({ where: { generation: name + "-base", transactionId } }), 0);
        assert.equal(detail.outcome, "REJECTED");
        if (mismatch) assert.deepEqual(detail.reasons, ["FINANCIAL_CHART_COUNT_MISMATCH", "FINANCIAL_CHART_GROSS_MISMATCH", "FINANCIAL_CHART_NET_MISMATCH"]);
        if (missingNet) { assert(detail.reasons.includes("FINANCIAL_SOURCE_ROWS_REJECTED")); assert.equal(detail.windows[0].rejectionReasons.net_invalid, 1); }
      } else {
        assert(observation.coveredGeneration); assert((await db.creatorEarningsGeneration.findUnique({ where: { id: observation.coveredGeneration } })).publishedAt);
        assert.equal(detail.outcome, "VERIFIED");
        assert.equal(Number((await gen.activeEntry(db, s.creatorId, transactionId)).netCents), 800);
        assert.equal((await lease.completeJob({ ...credentials, result: checkpoint.result })).job.status, "DONE");
      }
      // Terminal resolution wakes existing debt but cannot mark that debt done.
      const debt = await db.creatorRecoveryIntent.findUnique({ where: { id: name + "-recovery" } });
      assert.equal(debt.status, runningDebt ? "RUNNING" : "PENDING");
      const signals = require(root + "/src/services/subscriber-directory-maintenance-signal-service");
      const signal = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
      assert.equal(signal.creatorId, s.creatorId); assert.equal(signal.kind, "DERIVED_PLANNING");
      await require(root + "/src/services/subscriber-directory-maintenance-service")._test.dispatchSubscriberDerivedPlanning({ db, signal });
      const recurring = await db.domainWorkItem.findFirst({ where: { creatorId: s.creatorId, workClass: "CREATOR_RECURRING_PLANNING" } });
      assert(+recurring.availableAt < +now + 60000, "wake must override the planner's future availability");
      await db.jobInstance.update({ where: { id: normal.id }, data: { status: "CANCELLED" } });
      if (mismatch || missingNet) {
        const retried = await resolver.processRequest(await claimRequest(s.creatorId)); assert(retried.created);
        const next = await db.jobInstance.findUnique({ where: { id: retried.jobId } });
        assert.notEqual(next.params.collectionGeneration, job.params.collectionGeneration); assert.equal(next.params.moneyResolutionObservationId, observationId);
        assert.equal(next.params.startDate, job.params.startDate); assert.equal(next.params.endDate, job.params.endDate);
        assert(+next.nextRunAt > Date.now()); assert.equal((await db.creatorMoneyResolutionRequest.findUnique({ where: { creatorId: s.creatorId } })).attempts, 2);
        await db.jobInstance.update({ where: { id: next.id }, data: { status: "CANCELLED" } });
      }
      pass(`${name}: scoped request/page/publication fences, newer main authority preserved, terminal wake and ${mismatch || missingNet ? "unresolved exact debt retries" : "exact money publishes once"}`);
    }
    await scenario("verified");
    await scenario("chart-mismatch", { mismatch: true });
    await scenario("missing-net", { missingNet: true, runningDebt: true });
    await scenario("observed-zero-vs-three", { mismatch: true, emptySource: true });
    pass(desktop ? "unchanged Desktop financial handler -> real fenced progress -> receipt/chart -> completion/publication bridge" : "backend progress/completion/publication path; Desktop bridge optional and not executed");
    const report = { ok: true, engine: runtime.native ? "native PostgreSQL" : "PGlite + Prisma; native concurrency not executed", desktopBridge: Boolean(desktop), checks };
    if (process.env.ONLINOD_FINANCIAL_RESOLUTION_REPORT) fs.writeFileSync(process.env.ONLINOD_FINANCIAL_RESOLUTION_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { desktop?.close(); await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });
