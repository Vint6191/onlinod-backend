"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const keep = setInterval(() => {}, 1000), deadline = setTimeout(() => { console.error("COLLECTOR_PROOF_DEADLINE"); process.exit(2); }, 240000);
const checks = [], pass = text => { checks.push(text); console.log("PASS", text); };
(async () => {
  const runtime = await createScaleSqlRuntime(); let desktop;
  try {
    const { db } = runtime;
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    desktop = await require("../test-support/desktop-collector-handlers.cjs").loadDesktopCollectorHandlers(process.env.ONLINOD_DESKTOP_SOURCE || path.resolve(__dirname, "../../../desktop169"));
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const tx = fn => runRootCommit(db, ({ tx }) => fn(tx), { profile: "JOB_CHUNK" });
    const lease = require("../../src/services/job-lease-service"), control = require("../../src/services/analytics-collector-control-service");
    const notification = require("../../src/services/notification-sync-state-service"), dialog = require("../../src/services/dialog-intelligence-service");
    const subscribers = require("../../src/services/subscriber-directory-service"), now = new Date();
    const capabilities = { creatorEventDrivenSyncV2: true };
    async function account(prefix) {
      const s = await scope(db, { agencyId: prefix + "-agency", creatorId: prefix + "-creator", userId: prefix + "-user" });
      s.deviceId = prefix + "-device";
      await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(+now + 86400000) } });
      await db.workerDevice.create({ data: { id: s.deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
      await db.deviceCreatorBinding.create({ data: { deviceId: s.deviceId, agencyId: s.agencyId, creatorId: s.creatorId, sessionReadReady: true, lastSeenAt: now } });
      return s;
    }
    async function releaseStages(s) {
      for (const model of ["creatorFinancialCollectionState", "creatorCampaignCollectionState"])
        await db[model].upsert({ where: { creatorId: s.creatorId }, create: { agencyId: s.agencyId, creatorId: s.creatorId, status: "FAILED" }, update: { status: "FAILED" } });
    }
    async function notificationJob(s) {
      return db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, scope: "creator", jobKey: "catchup_notifications_scan", status: "SCHEDULED",
        params: control.stampCollectionAuthorityParams({ ...notification.buildNotificationScanParams({ now }),
          ...control.buildCollectionCommand({ collectorType: "NOTIFICATIONS", collectionMode: "full", reason: "INITIAL_PROOF", now }) }, now) } });
    }
    async function claim(s, job) {
      const claimed = await lease.claimJob({ userId: s.userId, deviceId: s.deviceId, jobKeys: [job.jobKey], capabilities });
      assert.equal(claimed.job?.id, job.id, JSON.stringify(claimed));
      return { s, job: await db.jobInstance.findUnique({ where: { id: job.id } }), checkpoint: claimed.job.continuation ?? null,
        credentials: { jobId: job.id, userId: s.userId, deviceId: s.deviceId, leaseToken: claimed.job.leaseToken, leaseRevision: claimed.job.leaseRevision } };
    }
    async function nstep(run, data) {
      const result = await desktop.notificationsCatchupHandler.runChunk({ job: run.job, creatorId: run.s.creatorId,
        continuation: run.checkpoint?.jobContinuation ?? null, signal: new AbortController().signal, ofApi: { request: async () => ({ ok: true, data }) } });
      const advanced = await lease.progressJob({ ...run.credentials, expectedContinuation: run.checkpoint, progress: result.progress,
        continuation: result.outcome === "done" ? { driverPhase: "complete", result: result.result } : { driverPhase: "execute", jobContinuation: result.continuation }, chunkResult: result.chunkResult });
      assert(!advanced.sideEffect?.staleProgress); run.checkpoint = advanced.continuation; return advanced;
    }
    const n = await account("partial"), nj = await notificationJob(n);
    let blocked = await lease.claimJob({ userId: n.userId, deviceId: n.deviceId, jobKeys: [nj.jobKey], capabilities });
    assert.equal(blocked.reason, "initial-stage-wait"); assert.equal(blocked.job, null);
    await db.creatorFinancialCollectionState.create({ data: { agencyId: n.agencyId, creatorId: n.creatorId, status: "FAILED" } });
    blocked = await lease.claimJob({ userId: n.userId, deviceId: n.deviceId, jobKeys: [nj.jobKey], capabilities });
    assert.equal(blocked.reason, "initial-stage-wait");
    await releaseStages(n); const partial = await claim(n, nj);
    pass("actual initial claim waits for finance then campaign finite outcomes; failed independent sources release later collection without inventing readiness");
    const bad = { id: "rejected-subscription", type: "subscribed", amount: -5, user: { id: 42 }, createdAt: new Date(+now - 1000).toISOString() };
    for (let phase = 0; phase < 6; phase++) await nstep(partial, { list: phase === 0 || phase === 5 ? [bad] : [], hasMore: false });
    await nstep(partial, { list: [], hasMore: false });
    assert.equal(partial.checkpoint.driverPhase, "complete");
    const ended = await lease.completeJob({ ...partial.credentials, result: partial.checkpoint.result });
    assert.equal(ended.job.status, "FAILED");
    const final = await db.jobInstance.findUnique({ where: { id: nj.id } });
    assert.equal(final.params.collectionGeneration, partial.job.params.collectionGeneration); assert.equal(final.attempts, 1);
    assert.equal(final.result.completionSideEffect.sourceTraversalComplete, true);
    const state = await db.creatorNotificationSyncState.findUnique({ where: { creatorId: n.creatorId } });
    assert.equal(state.status, "FAILED"); assert.equal(state.fullBackfillVerifiedAt, null); assert(state.fullBackfillCompletedAt);
    for (let i = 0; i < 3; i++) await require("../../src/services/creator-analytics-sync-orchestrator").ensureInitialCreatorAnalyticsSync({ db, agencyId: n.agencyId, creatorId: n.creatorId });
    assert.equal(await db.jobInstance.count({ where: { creatorId: n.creatorId, jobKey: nj.jobKey } }), 1);
    assert.equal(await db.creatorNotificationFrontierPage.count({ where: { creatorId: n.creatorId } }), 6);
    pass("exact Desktop FULL with rejected source facts ends once, keeps traversal proof and facts, and repeated planner wake cannot reset the retry budget by rereading history");

    const c = await account("cycle"); await releaseStages(c); const cyclic = await claim(c, await notificationJob(c));
    const notice = id => ({ id, type: "price_changed", createdAt: new Date(+now - 1000).toISOString(), user: { id: 42 } });
    await nstep(cyclic, { list: [notice("A")], hasMore: true });
    cyclic.checkpoint = (await db.jobInstance.findUnique({ where: { id: cyclic.job.id } })).continuation;
    await nstep(cyclic, { list: [notice("B")], hasMore: true });
    await assert.rejects(nstep(cyclic, { list: [notice("A")], hasMore: true }), { code: "NOTIFICATION_FRONTIER_CURSOR_CYCLE" });
    assert.equal(await db.creatorNotificationFrontierPage.count({ where: { creatorId: c.creatorId } }), 2);
    assert.equal((await db.jobInstance.findUnique({ where: { id: cyclic.job.id } })).continuation.jobContinuation.page, 2);
    await lease.failJob({ ...cyclic.credentials, retryable: false, error: "NOTIFICATION_FRONTIER_CURSOR_CYCLE" });
    assert.equal((await db.jobInstance.findUnique({ where: { id: cyclic.job.id } })).status, "FAILED");
    pass("FULL A-to-B-to-A cycle is rejected by indexed SQL receipts after restart; rejected page cannot advance source checkpoint or replenish attempts");

    const r = await account("receipts"); await releaseStages(r); const original = await notificationJob(r);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const repair = await claim(r, original);
      await nstep(repair, { list: [notice(`safe-${attempt}`)], hasMore: true });
      assert.equal((await db.jobInstance.findUnique({ where: { id: original.id } })).attempts, 0);
      const scopeHash = crypto.createHash("sha256").update(JSON.stringify([r.agencyId, r.creatorId, original.id])).digest("hex");
      await db.analyticsIngestBatch.create({ data: { agencyId: r.agencyId, creatorId: r.creatorId, sourceJobId: original.id, dataType: "NOTIFICATIONS",
        idempotencyKey: `notification-source-page:${scopeHash}:run:${repair.job.params.collectionGeneration}:source-page:2:v1`,
        status: "COMMITTED", completedAt: now, payloadChecksum: "f".repeat(64), sourceTimezone: "UTC", schemaVersion: 6,
        collectorVersion: "notifications-history-v9-source-ledger", rangeFrom: new Date(repair.job.params.from), rangeTo: new Date(repair.job.params.to) } });
      await assert.rejects(nstep(repair, { list: [notice(`conflict-${attempt}`)], hasMore: true }), { code: "JOB_LEASE_STALE" });
      const row = await db.jobInstance.findUnique({ where: { id: original.id } });
      assert.equal(row.params.notificationReceiptRepairAttempts, attempt); assert.equal(row.attempts, attempt);
      assert.equal(row.status, attempt === 5 ? "FAILED" : "SCHEDULED");
    }
    pass("immutable receipt repair has one durable five-attempt budget even when every replacement first commits a successful page");

    const good = await account("good"); await releaseStages(good); const success = await claim(good, await notificationJob(good));
    const historical = { id: "pre-epoch-tip", type: "tip", amount: 2, createdAt: "1965-01-01T00:00:00.000Z", user: { id: 42 } };
    const future = { ...historical, id: "after-frozen-target", createdAt: new Date(+now + 86400000).toISOString() };
    for (let phase = 0; phase < 6; phase++) await nstep(success, { list: [notice("same-source-id"), ...(phase === 2 || phase === 5 ? [historical, future] : [])], hasMore: false });
    await nstep(success, { list: [], hasMore: false });
    assert.equal((await lease.completeJob({ ...success.credentials, result: success.checkpoint.result })).job.status, "DONE");
    assert((await db.creatorNotificationSyncState.findUnique({ where: { creatorId: good.creatorId } })).fullBackfillVerifiedAt);
    const oldSource = await db.creatorNotificationEvent.findFirst({ where: { creatorId: good.creatorId, notificationId: historical.id } });
    assert.equal(oldSource.persistenceStatus, "FACT_COMMITTED"); assert(oldSource.canonicalFactId);
    assert.equal((await db.creatorNotificationEvent.findFirst({ where: { creatorId: good.creatorId, notificationId: future.id } })).persistenceStatus, "IGNORED_STORED");
    pass("six ordered FULL phases share source IDs, retain valid facts older than receipt epoch, exclude facts beyond frozen target and publish historical baseline");

    const d = await account("dialog");
    const scheduled = await tx(tx => dialog.scheduleDialogScanTx(tx, { agencyId: d.agencyId, creatorId: d.creatorId,
      dialogId: "__dialog_discovery__", mode: "discovery", childMode: "initial", source: "manual", allowTerminalRetry: true }));
    const dlease = await claim(d, scheduled.job), dj = dlease.job;
    dj.params.discoveryBatchMaxApiPages = 1; let dc = null;
    const dstep = async id => {
      const result = await desktop.dialogIntelligenceHandler.runChunk({ job: dj, creatorId: d.creatorId, continuation: dc,
        signal: new AbortController().signal, ofApi: { request: async () => ({ ok: true, data: { list: [{ withUser: { id } }], hasMore: true } }) } });
      const advanced = await lease.progressJob({ ...dlease.credentials, expectedContinuation: dlease.checkpoint, progress: result.progress,
        continuation: { driverPhase: "execute", jobContinuation: result.continuation }, chunkResult: result.chunkResult });
      dlease.checkpoint = advanced.continuation;
      dc = JSON.parse(JSON.stringify(result.continuation)); return result;
    };
    await db.jobInstance.update({ where: { id: dj.id }, data: { attempts: 4 } });
    const firstDiscovery = await dstep("101"); await dstep("102");
    assert.equal((await db.jobInstance.findUnique({ where: { id: dj.id } })).attempts, 0);
    await db.jobInstance.update({ where: { id: dj.id }, data: { attempts: 3 } });
    const replay = await lease.progressJob({ ...dlease.credentials, expectedContinuation: dlease.checkpoint, progress: firstDiscovery.progress,
      continuation: { driverPhase: "execute", jobContinuation: firstDiscovery.continuation }, chunkResult: firstDiscovery.chunkResult });
    assert.equal(replay.sideEffect.replayedCommit, true); assert.deepEqual(replay.continuation, dlease.checkpoint);
    assert.equal((await db.jobInstance.findUnique({ where: { id: dj.id } })).attempts, 3);
    await assert.rejects(lease.completeJob({ ...dlease.credentials, result: { runId: scheduled.run.id, mode: "discovery", hasMore: false } }),
      { code: "DIALOG_DISCOVERY_SOURCE_NOT_EXHAUSTED" });
    assert.equal((await db.jobInstance.findUnique({ where: { id: dj.id } })).status, "CLAIMED");
    await assert.rejects(dstep("101"), { code: "DIALOG_DISCOVERY_PAGE_CYCLE" });
    assert.equal((await db.dialogScanRun.findUnique({ where: { id: scheduled.run.id } })).pagesProcessed, 2);
    assert.equal(await db.dialogScanChunkCommit.count({ where: { runId: scheduled.run.id, mode: "discovery_source_page" } }), 2);
    await assert.rejects(desktop.dialogIntelligenceHandler.runChunk({ job: dj, creatorId: d.creatorId, continuation: dc,
      signal: new AbortController().signal, ofApi: { request: async () => ({ ok: true, data: { list: [], hasMore: true } }) } }), { code: "DIALOG_DISCOVERY_EMPTY_PAGE_WITH_HAS_MORE" });
    const large = await desktop.dialogIntelligenceHandler.runChunk({ job: dj, creatorId: d.creatorId, continuation: { ...dc, page: 10001 },
      signal: new AbortController().signal, ofApi: { request: async () => ({ ok: true, data: { list: [{ withUser: { id: "103" } }], hasMore: true } }) } });
    assert.equal(large.outcome, "continue"); assert.equal(large.continuation.page, 10002);
    pass("dialog SQL page receipts reject cycles and false empty tails; committed advance renews only segment retry budget, old batch replay never rewinds progress, and history beyond ten thousand pages is not truncated");

    await db.dialogScanRun.update({ where: { id: scheduled.run.id }, data: { status: "FAILED", source: "offline_gap_recovery", lastError: "DIALOG_DISCOVERY_EMPTY_PAGE_WITH_HAS_MORE" } });
    await db.jobInstance.update({ where: { id: dj.id }, data: { status: "FAILED", attempts: 5, lastError: "DIALOG_DISCOVERY_EMPTY_PAGE_WITH_HAS_MORE",
      continuation: dc, result: { failure: { code: "DIALOG_DISCOVERY_EMPTY_PAGE_WITH_HAS_MORE", retryable: true } } } });
    await db.dialogScanRun.create({ data: { agencyId: d.agencyId, creatorId: d.creatorId, dialogId: "__dialog_discovery__", mode: "discovery", source: "manual", status: "COMPLETED",
      createdAt: new Date(+now - 172800000), completedAt: new Date(+now - 86400000) } });
    for (let i = 0; i < 4; i++) {
      const offline = await require("../../src/services/dialog-offline-recovery-service").scheduleOfflineDialogRecovery({ db, agencyId: d.agencyId, creatorId: d.creatorId, lastCoveredAt: new Date(+now - 86400000), now });
      assert.equal(offline.reason, "recovery_stopped");
      const poll = await tx(tx => dialog.autoRecoverDialogDiscoveryTx(tx, { agencyId: d.agencyId, creatorId: d.creatorId }));
      assert.equal(poll.reason, "recovery_stopped");
    }
    assert.equal(await db.jobInstance.count({ where: { creatorId: d.creatorId } }), 1);
    const manual = await tx(tx => dialog.scheduleDialogScanTx(tx, { agencyId: d.agencyId, creatorId: d.creatorId, dialogId: "__dialog_discovery__", mode: "discovery", source: "manual", allowTerminalRetry: true }));
    assert.equal(manual.resumed, true); assert.equal(manual.run.id, scheduled.run.id); assert.equal(manual.job.continuation.offset, dc.offset);
    pass("exhausted offline dialog episode survives repeated reconnect/status polls; explicit manual retry alone resumes its durable checkpoint");

    const e = await account("independent-dialog"), oldTarget = new Date(+now - 4 * 3600000), resumeAt = new Date(+now - 3 * 3600000);
    const episodeOwner = require("../../src/services/dialog-recovery-episode-authority");
    const firstEpisode = episodeOwner.episode({ ...e, gapFrom: new Date(+oldTarget - 3600000), targetAt: oldTarget });
    const oldRun = await tx(tx => dialog.scheduleDialogScanTx(tx, { agencyId: e.agencyId, creatorId: e.creatorId,
      dialogId: "__dialog_discovery__", mode: "discovery", childMode: "incremental", source: "offline_gap_recovery", dialogRecoveryEpisode: firstEpisode }));
    await db.dialogScanRun.update({ where: { id: oldRun.run.id }, data: { status: "FAILED", completedAt: oldTarget, createdAt: oldTarget } });
    await db.jobInstance.update({ where: { id: oldRun.job.id }, data: { status: "FAILED", attempts: 5, completedAt: oldTarget, createdAt: oldTarget } });
    await db.dialogScanRun.create({ data: { agencyId: e.agencyId, creatorId: e.creatorId, dialogId: "__dialog_discovery__", mode: "discovery", status: "COMPLETED",
      source: "manual", createdAt: new Date(+oldTarget - 86400000), completedAt: new Date(+oldTarget - 86400000) } });
    const recover = () => require("../../src/services/dialog-offline-recovery-service").scheduleOfflineDialogRecovery({ db,
      agencyId: e.agencyId, creatorId: e.creatorId, lastCoveredAt: new Date(firstEpisode.gapFrom), now,
      schedule: input => tx(tx => dialog.restartCreatorDialogPlanTx(tx, input)) });
    assert.equal((await recover()).reason, "recovery_stopped");
    await db.creatorLiveSync.create({ data: { agencyId: e.agencyId, creatorId: e.creatorId, lastCapturedAt: new Date(firstEpisode.gapFrom) } });
    const member = await db.agencyMember.findUnique({ where: { id: "member-" + e.agencyId } });
    const capture = (incarnation, from, at) => tx(tx => require("../../src/services/creator-live-sync-service").recordCaptureSamples({ db: tx,
      agencyId: e.agencyId, memberId: member.id, accessEpoch: member.accessEpoch, deviceId: e.deviceId, now: at,
      bindings: [{ creatorId: e.creatorId, account: { sessionReadReady: true, realtimeHealthy: true, lastWsFrameAt: at.toISOString(),
        observation: { version: 1, moneyRevisionVersion: 1, sessionId: incarnation, captureFromAt: from.toISOString(), capturedThroughAt: at.toISOString(), capturedThroughSeq: 0, lossRevision: 0 } } }] }));
    const session = crypto.randomUUID();
    await capture(session, resumeAt, resumeAt);
    assert.equal((await recover()).reason, "recovery_stopped", "reconnect at end of old gap cannot reset exhausted dialog budget");
    const capturedThrough = new Date(+resumeAt + 60000);
    await capture(session, resumeAt, capturedThrough);
    assert.equal(+(await db.creatorLiveSync.findUnique({ where: { creatorId: e.creatorId } })).lastCapturedAt, +capturedThrough);
    const nextTarget = new Date(+now - 300000);
    await capture(crypto.randomUUID(), nextTarget, nextTarget);
    const laterLoss = await db.creatorRecoveryIntent.findFirst({ where: { creatorId: e.creatorId, gapFrom: capturedThrough }, orderBy: { targetAt: "desc" } });
    assert(laterLoss); assert.equal(+laterLoss.targetAt, +nextTarget);
    const nextEpisode = await episodeOwner.independentEpisode(db, { ...e, failedRun: await db.dialogScanRun.findUnique({ where: { id: oldRun.run.id } }), now });
    assert(nextEpisode, JSON.stringify({ laterLoss, run: await db.dialogScanRun.findUnique({ where: { id: oldRun.run.id } }), prior: await db.jobInstance.findUnique({ where: { id: oldRun.job.id } }), live: await db.creatorLiveSync.findUnique({ where: { creatorId: e.creatorId } }) }));
    const owners = await Promise.all([recover(), recover()]);
    assert.equal(owners.filter(result => result.created).length, 1, JSON.stringify(owners));
    const newJob = await db.jobInstance.findFirst({ where: { creatorId: e.creatorId, jobKey: "dialog_intelligence_scan", status: "SCHEDULED" } });
    assert(newJob); assert.equal(newJob.params.dialogRecoveryEpisode.gapFrom, capturedThrough.toISOString());
    assert.equal(newJob.params.dialogRecoveryEpisode.targetAt, nextTarget.toISOString()); assert(newJob.params.dialogRecoveryEpisode.sourceIntentId);
    assert.equal((await db.jobInstance.findUnique({ where: { id: oldRun.job.id } })).attempts, 5);
    assert.equal((await db.jobInstance.findUnique({ where: { id: oldRun.job.id } })).status, "FAILED");
    assert.equal(await db.jobInstance.count({ where: { creatorId: e.creatorId, jobKey: "dialog_intelligence_scan" } }), 2);
    pass("real successful capture followed by a later durable loss creates exactly one independent dialog recovery under concurrent planning; old FAILED budget remains unchanged");

    await db.dialogScanRun.update({ where: { id: newJob.params.scanRunId }, data: { status: "COMPLETED", completedAt: now } });
    await db.jobInstance.update({ where: { id: newJob.id }, data: { status: "DONE", completedAt: now } });
    const nextNormal = await tx(tx => dialog.scheduleDialogScanTx(tx, { agencyId: e.agencyId, creatorId: e.creatorId,
      dialogId: "__dialog_discovery__", mode: "discovery", source: "automatic_startup_resume_scan" }));
    assert.equal(nextNormal.created, true); assert.notEqual(nextNormal.run.id, oldRun.run.id);
    assert.equal((await db.jobInstance.findUnique({ where: { id: oldRun.job.id } })).attempts, 5);
    await db.dialogScanRun.update({ where: { id: nextNormal.run.id }, data: { status: "FAILED", lastError: "DIALOG_DISCOVERY_CURSOR_STALLED" } });
    await db.jobInstance.update({ where: { id: nextNormal.job.id }, data: { status: "FAILED", attempts: 5,
      result: { failure: { code: "DIALOG_DISCOVERY_CURSOR_STALLED", retryable: true } } } });
    const operations = require("../../src/services/operational-command-service");
    const command = { family: "dialog", operation: "start", input: { mode: "incremental" } };
    command.expectedRevision = await operations.snapshot(db, e.agencyId, e.creatorId, command);
    const explicit = await tx(tx => operations.apply(tx, e.agencyId, e.creatorId, e.userId, member, command));
    assert.equal(explicit.humanReference.outcome.resumed, true);
    assert.equal(explicit.humanReference.outcome.run.id, nextNormal.run.id);
    assert.equal((await db.jobInstance.findUnique({ where: { id: oldRun.job.id } })).attempts, 5);
    pass("a successful newer dialog run supersedes the old FAILED barrier; canonical explicit operational start can resume the current failed checkpoint");

    const terminalDialog = await account("dialog-terminal");
    const terminalPlan = await tx(tx => dialog.scheduleDialogScanTx(tx, { agencyId: terminalDialog.agencyId, creatorId: terminalDialog.creatorId,
      dialogId: "__dialog_discovery__", mode: "discovery", source: "manual" }));
    const terminalLease = await claim(terminalDialog, terminalPlan.job);
    const terminalPage = await desktop.dialogIntelligenceHandler.runChunk({ job: terminalLease.job, creatorId: terminalDialog.creatorId,
      continuation: null, signal: new AbortController().signal, ofApi: { request: async () => ({ ok: true, data: { list: [], hasMore: false } }) } });
    const terminalCommit = await lease.progressJob({ ...terminalLease.credentials, expectedContinuation: terminalLease.checkpoint,
      progress: terminalPage.progress, chunkResult: terminalPage.chunkResult,
      continuation: { driverPhase: "execute", jobContinuation: terminalPage.chunkResult.continuation } });
    assert.equal(terminalCommit.continuation.driverPhase, "complete"); assert.equal(terminalCommit.continuation.result.hasMore, false);
    const terminalReplay = await lease.progressJob({ ...terminalLease.credentials, expectedContinuation: terminalCommit.continuation,
      progress: terminalPage.progress, chunkResult: terminalPage.chunkResult,
      continuation: { driverPhase: "execute", jobContinuation: terminalPage.chunkResult.continuation } });
    assert.deepEqual(terminalReplay.continuation, terminalCommit.continuation);
    const terminalDone = await lease.completeJob({ ...terminalLease.credentials, result: terminalReplay.continuation.result });
    assert.equal(terminalDone.job.status, "DONE");
    assert.equal((await db.dialogScanRun.findUnique({ where: { id: terminalPlan.run.id } })).status, "COMPLETED");
    pass("final discovery source receipt atomically saves complete continuation; lost-ACK replay completes the exact run without reading provider tail again");

    const sub = await account("subscribers"), subInput = { db, agencyId: sub.agencyId, creatorId: sub.creatorId };
    let current = (await subscribers.scheduleSubscriberScan(subInput)).job;
    for (let generation = 0; generation <= 3; generation++) {
      await db.jobInstance.update({ where: { id: current.id }, data: { status: "PUBLISHING" } });
      // A fresh collector repeatedly hands off an internally contradictory final
      // proof. It must not allocate a new baseline generation without a limit.
      await db.subscriberScanRun.update({ where: { id: current.params.scanRunId }, data: { hasMore: false, fanProjectionStatus: "PENDING" } });
      const recovered = await subscribers.recoverSubscriberPublicationDebt(subInput);
      if (generation < 3) {
        assert.equal(recovered.reason, "publication_recollection_scheduled");
        current = await db.jobInstance.findUnique({ where: { id: recovered.replacementJobId } });
        assert.equal(current.params.subscriberRecollectionAttempts, generation + 1);
      } else assert.equal(recovered.reason, "failed_terminal");
    }
    for (let i = 0; i < 3; i++) assert.equal((await subscribers.ensureSubscriberScanDue(subInput)).reason, "failed_terminal");
    assert.equal(await db.jobInstance.count({ where: { creatorId: sub.creatorId, jobKey: "subscriber_directory_scan" } }), 4);
    assert.match((await db.jobInstance.findUnique({ where: { id: current.id } })).lastError, /SUBSCRIBER_RECOLLECTION_EXHAUSTED/);
    assert.equal((await subscribers.scheduleSubscriberScan({ ...subInput, manual: true, force: true })).created, true);
    pass("subscriber invalid-publication chain stops after three replacements, remains terminal on scheduler wake, and supports explicit retry");
    console.log(JSON.stringify({ ok: true, native: runtime.native, checks: checks.length }));
  } finally { desktop?.close(); await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keep); clearTimeout(deadline); });
