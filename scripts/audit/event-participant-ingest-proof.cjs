"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");

(async () => {
  const runtime = await createScaleSqlRuntime(), results = [];
  const pass = name => { results.push(name); console.log("PASS", name); };
  try {
    const { db } = runtime, s = await scope(db);
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const { projectFanIdentity, projectEventFanIdentities } = require("../../src/services/fan-data-authority-service");
    const financial = require("../../src/services/financial-transactions-service");
    const receipts = require("../../src/services/financial-receipt-authority");
    const { buildCollectionCommand, COLLECTOR_TYPES } = require("../../src/services/analytics-collector-control-service");
    const tx = work => runRootCommit(db, ({ tx }) => work(tx));
    const now = new Date(), old = new Date("2025-07-13T14:57:39Z");
    const fanInput = { ...s, onlyFansUserId: "159980430", observedAt: old, source: "FINANCIAL_TRANSACTION" };
    await tx(t => projectFanIdentity(t, { ...fanInput, avatarUrl: "https://images.test/avatar?token=old" }));
    // This is the exact production failure, before any source page is written.
    await assert.rejects(tx(t => projectFanIdentity(t, { ...fanInput, avatarUrl: "https://images.test/avatar?token=new" })),
      error => error.code === "FAN_DATA_SAME_GENERATION_CONFLICT");
    pass("reproduced legacy event-date/avatar contradiction against persisted SQL authority");
    const lease = require("../../src/services/job-lease-service"), publication = require("../../src/services/analytics-publication-service");
    const deviceId = "event-participant-device";
    await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(+now + 86400000) } });
    await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: new Date() } });
    await db.deviceCreatorBinding.create({ data: { deviceId, agencyId: s.agencyId, creatorId: s.creatorId, sessionReadReady: true, lastSeenAt: new Date() } });
    const command = buildCollectionCommand({ collectorType: COLLECTOR_TYPES.FINANCIAL, now });
    const created = await db.jobInstance.create({ data: { id: "financial-avatar-regression", agencyId: s.agencyId,
      creatorId: s.creatorId, jobKey: "financial_transactions_scan", scope: "creator", status: "SCHEDULED",
      params: { ...command, financialMode: "full", earningsLedgerVersion: 1, endDate: now.toISOString() } } });
    const claimed = await lease.claimJob({ userId: s.userId, deviceId, jobKeys: ["financial_transactions_scan"],
      capabilities: { creatorEventDrivenSyncV2: true, financialWindowReceiptsV1: true, financialMoneyResolutionV1: true, financialTraversalV2: true } });
    assert.equal(claimed.job?.id, created.id, JSON.stringify(claimed));
    const job = await db.jobInstance.findUnique({ where: { id: created.id } });
    assert.equal(job.params.financialTraversalVersion, 2); assert.equal(job.params.financialWindows[0].from, null);
    const credentials = { jobId: job.id, userId: s.userId, deviceId, leaseToken: claimed.job.leaseToken, leaseRevision: claimed.job.leaseRevision };
    let checkpoint = claimed.job.continuation ?? null;
    const progress = async chunkResult => {
      const result = await lease.progressJob({ ...credentials, expectedContinuation: checkpoint,
        continuation: checkpoint, chunkResult });
      assert(!result.sideEffect?.staleProgress); checkpoint = result.continuation; return result.sideEffect;
    };
    const row = (id, gross, fan = "159980430", avatar = null) => ({ externalTransactionId: id, transactionType: "tip",
      fanOnlyFansUserId: fan, fanUsername: "known-fan", fanAvatarUrl: avatar,
      occurredAt: old.toISOString(), amountCents: gross, netCents: gross * 0.8, feeCents: gross * 0.2,
      currency: "USD", transactionStatus: "done" });
    const page = { kind: "financial_transactions_page", scanRunId: command.collectionGeneration, collectorVersion: receipts.COLLECTOR,
      windowIndex: 0, pageNumber: 1, markerStart: job.params.financialWindows[0].initialMarker, markerEnd: "older-marker", sourceHasMore: true,
      rawReceived: 3, scannerRejected: 0, duplicateRows: 0,
      transactions: [row("one", 1000, "159980430", "avatar-A"), row("two", 2000, "159980430", "avatar-B"), row("deleted-fan", 500, null)] };
    const first = await progress(page);
    assert.equal(first.accepted, 3); assert.equal(first.storedOnly, 3); assert.equal(first.inserted, 0); assert.equal(first.rejected, 0);
    assert.equal(await db.financialObservedFact.count({ where: { runId: receipts.runId(job) } }), 3);
    assert.equal(await db.creatorFinancialTransaction.count({ where: { creatorId: s.creatorId } }), 0);
    assert.equal(await db.creatorTip.count({ where: { creatorId: s.creatorId } }), 0);
    let fan = await db.creatorFan.findUnique({ where: { creatorId_onlyFansUserId: { creatorId: s.creatorId, onlyFansUserId: "159980430" } } });
    assert.equal(fan.avatarUrl, "https://images.test/avatar?token=old"); assert.equal(fan.username, null);
    pass("source page persists immutable financial evidence without publishing money or profile hints before verification");
    const replay = chunk => tx(t => financial.ingestFinancialTransactionsChunk({ db: t, job, deviceId, chunk }));
    assert.equal((await replay(page)).replay, true);
    await assert.rejects(replay({ ...page, transactions: [{ ...page.transactions[0], amountCents: 999 }, ...page.transactions.slice(1)] }),
      error => error.code === "FINANCIAL_RECEIPT_PAYLOAD_CONFLICT");
    pass("receipt replay is idempotent; changed committed monetary page remains rejected");
    const second = await progress({ ...page, pageNumber: 2, markerStart: "older-marker", markerEnd: null, sourceHasMore: false,
      rawReceived: 1, transactions: [row("three", 100, "159980430", "avatar-current")] });
    assert.equal(second.storedOnly, 1); assert.equal(second.inserted, 0);
    const run = await db.financialReceiptRun.findFirst({ where: { creatorId: s.creatorId } });
    assert.equal(run.proof.windows[0].netCents, 2880); assert.equal(run.cursor.page, 2);
    const range = receipts.comparisonRange(run);
    for (const category of receipts.FULL_CHARTS) {
      const money = ["total", "tips"].includes(category);
      await progress({ kind: "financial_chart_total", collectorVersion: receipts.COLLECTOR, scanRunId: command.collectionGeneration,
        windowIndex: 0, category, rangeFrom: range.from, rangeTo: range.to, grossCents: money ? 3600 : 0,
        netCents: money ? 2880 : 0, transactionsCount: money ? 4 : 0 });
    }
    assert.equal((await receipts.completionProof(db, job)).complete, true);
    assert.equal(checkpoint.driverPhase, "complete");
    const queued = await lease.completeJob({ ...credentials, result: checkpoint.result }); assert(queued.publicationId);
    let published;
    for (let i = 0; i < 12; i++) {
      await db.analyticsPublication.update({ where: { id: queued.publicationId }, data: { availableAt: new Date(0) } });
      published = await publication.runAnalyticsPublicationUnit({ db, publicationId: queued.publicationId });
      if (!published.publicationPending) break;
    }
    assert.equal(published.job.status, "DONE", JSON.stringify(published));
    const stored = await db.creatorFinancialTransaction.findMany({ where: { creatorId: s.creatorId } });
    assert.equal(stored.length, 4); assert.equal(stored.reduce((n, r) => n + r.netCents, 0), 2880);
    assert.equal(stored.find(r => r.externalTransactionId === "deleted-fan").fanRecordId, null);
    assert.equal(await db.creatorTip.count({ where: { creatorId: s.creatorId } }), 4);
    fan = await db.creatorFan.findUnique({ where: { id: fan.id } });
    assert.equal(fan.avatarUrl, "https://images.test/avatar?token=old", "three conflicting historical hints cannot replace the saved canonical avatar");
    assert.equal(fan.username, "known-fan"); assert.equal(+fan.firstSeenAt, +old); assert.equal(+fan.lastActivityObservedAt, +old);
    assert(+fan.identityObservedAt >= +now);
    pass("real lease, six chart receipts and bounded publication commit all exact NET and tips while withholding ambiguous historical avatars");
    const hint = { ...s, onlyFansUserId: "159980430", source: "LIVE_NOTIFICATION", activityObservedAt: old,
      username: "notification-user", avatarUrl: "notification-avatar" };
    const hintAt = new Date(Date.now() + 1000);
    await tx(t => projectEventFanIdentities(t, [hint], hintAt));
    const conflict = await tx(t => projectEventFanIdentities(t, [{ ...hint, avatarUrl: "different", platformDisplayName: "available name" }], hintAt));
    assert.equal(conflict.ambiguousFields, 1);
    fan = await db.creatorFan.findUnique({ where: { id: fan.id } });
    assert.equal(fan.avatarUrl, "notification-avatar"); assert.equal(fan.displayName, "available name");
    await assert.rejects(tx(t => projectFanIdentity(t, { ...s, onlyFansUserId: "159980430", observedAt: hintAt,
      source: "LIVE_NOTIFICATION", avatarUrl: "strict-conflict" })), error => error.code === "FAN_DATA_SAME_GENERATION_CONFLICT");
    pass("notification hints withhold tied conflicting fields; strict canonical authority is unchanged");
    const notifications = require("../../src/services/notification-facts-service");
    const notificationJob = await db.jobInstance.create({ data: { id: "notification-avatar-regression", agencyId: s.agencyId,
      creatorId: s.creatorId, jobKey: "catchup_notifications_scan", scope: "creator", status: "RUNNING",
      params: { from: "2025-07-13T00:00:00Z", to: "2025-07-13T23:59:59.999Z", types: ["tips"] } } });
    const notificationPage = { collectorVersion: "notifications-catchup-v4", schemaVersion: 3, sourceTimezone: "UTC",
      scanRunId: "notification-avatar-run", batchKey: "run:notification-avatar-run:completion", finalizeCoverage: true,
      coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 2, rejected: 0 } },
      events: ["A", "B"].map(suffix => ({ eventType: "tip_received", notificationId: `notification-${suffix}`,
        fanId: "159980430", fanAvatarUrl: `variant-${suffix}`, fanName: "Profile",
        amountCents: 500, currency: "USD", occurredAt: old.toISOString() })) };
    const receive = result => tx(t => notifications.ingestNotificationFacts({ db: t, job: notificationJob, deviceId: null, result }));
    const notificationResult = await receive(notificationPage);
    assert.equal(notificationResult.status, "COMMITTED"); assert.equal(notificationResult.rejected, 0);
    assert.equal(notificationResult.inserted, 2); assert.equal(notificationResult.identityHintConflicts, 1);
    assert.equal((await receive(notificationPage)).replayed, true);
    assert.equal(await db.creatorTip.count({ where: { creatorId: s.creatorId } }), 6);
    pass("notification ingest commits both exact tips and coverage despite profile variants; replay preserves totals");
    const many = Array.from({ length: 2_000 }, () => ({ ...hint, onlyFansUserId: "large-page-fan" }));
    assert.equal((await tx(t => projectEventFanIdentities(t, many, hintAt))).fans.size, 1);
    await assert.rejects(tx(t => projectEventFanIdentities(t, [...many, hint], hintAt)), /Invalid event participant observation batch/);
    pass("full legacy notification batch stays bounded and merges repeated fans once");
    const before = await db.creatorFan.findUnique({ where: { id: fan.id } });
    await assert.rejects(tx(async t => {
      await projectEventFanIdentities(t, [{ ...hint, username: "must-rollback" }], new Date(+hintAt + 1000));
      throw new Error("FAIL_BEFORE_COMMIT");
    }), /FAIL_BEFORE_COMMIT/);
    assert.deepEqual(await db.creatorFan.findUnique({ where: { id: fan.id } }), before);
    pass("database failure rolls back metadata with transaction; no catch-and-continue write path");
    if (runtime.native) {
      const concurrentAt = new Date(+hintAt + 2000);
      const results = await Promise.all(['left', 'right'].map(username => tx(t => projectEventFanIdentities(t,
        [{ ...hint, onlyFansUserId: 'concurrent-fan', username }], concurrentAt))));
      assert.equal(results.reduce((n, value) => n + value.ambiguousFields, 0), 1);
      assert.equal(await db.creatorFan.count({ where: { creatorId: s.creatorId, onlyFansUserId: 'concurrent-fan' } }), 1);
      pass("native concurrent metadata tie serializes once without poisoning either transaction");
    }
    const report = { ok: true, engine: runtime.native ? "PostgreSQL" : "PGlite + Prisma, single connection", results };
    if (process.env.ONLINOD_EVENT_PARTICIPANT_REPORT) fs.writeFileSync(process.env.ONLINOD_EVENT_PARTICIPANT_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
