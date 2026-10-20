"use strict";
// Actual current schema/Prisma and public subscriber services. Only provider
// pages/observation-token verification are fixtures; no application DB is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const keep = setInterval(() => {}, 1000);

(async () => {
  const runtime = await createScaleSqlRuntime();
  const checks = [];
  const pass = name => { checks.push(name); console.log("PASS", name); };
  try {
    const { db } = runtime, s = await scope(db);
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const subscribers = require("../../src/services/subscriber-directory-service");
    const signals = require("../../src/services/subscriber-directory-maintenance-signal-service");
    const { runSubscriberDirectoryMaintenance } = require("../../src/services/subscriber-directory-maintenance-service");
    const { readCreatorCurrentTask } = require("../../src/services/creator-overview-service");
    const input = { db, agencyId: s.agencyId, creatorId: s.creatorId };
    const due = () => db.subscriberDirectoryMaintenanceSignal.updateMany({
      where: { creatorId: s.creatorId, kind: "RECOVERY" }, data: { dueAt: new Date(0) },
    });
    const row = () => db.subscriberDirectoryMaintenanceSignal.findUnique({
      where: { creatorId_kind: { creatorId: s.creatorId, kind: "RECOVERY" } },
    });
    let latency = 0, delayedQueries = 0;
    db.$use(async (params, next) => {
      if (latency) { delayedQueries++; await wait(latency); }
      return next(params);
    });
    // Deliberately use a pool/session timezone far from UTC. The commit kernel
    // changes it only inside owned transactions; release/ack run outside them.
    await db.$executeRawUnsafe("SET TIME ZONE 'Pacific/Auckland'");
    await signals.ensureSubscriberDirectoryMaintenance({ ...input, kind: "RECOVERY" });
    assert.ok(Math.abs(+(await row()).dueAt - Date.now()) < 10000);
    let timezoneClaim = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    assert.ok(timezoneClaim, "a new UTC wake must be due immediately in a non-UTC pool");
    assert.equal(await signals.subscriberMaintenanceClaimCurrent({ db, signal: timezoneClaim }), true);
    assert.equal(await signals.releaseSubscriberDirectoryMaintenanceSignal({ db, signal: timezoneClaim }), true);
    await due();
    timezoneClaim = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    assert.equal(await signals.ackSubscriberDirectoryMaintenanceSignal({ db, signal: timezoneClaim }), true);
    pass("UTC due/lease storage works with Pacific/Auckland pool sessions: immediate claim, current, release and ack");
    const job = await db.jobInstance.create({ data: {
      id: "stranded-job", agencyId: s.agencyId, creatorId: s.creatorId,
      jobKey: "subscriber_directory_scan", scope: "creator", status: "CLAIMED", leaseRevision: 1,
      params: { scanRunId: "stranded-run", observationTokenVersion: 1, scanEveryDays: 7 },
    } });
    await db.subscriberDirectoryState.create({ data: {
      agencyId: s.agencyId, creatorId: s.creatorId, publicationGeneration: 1,
      // An earlier successful publication must not hide later stranded debt.
      publishedAt: new Date(Date.now() - 86400000), publishedGeneration: 0,
    } });
    await db.subscriberScanRun.create({ data: {
      id: job.params.scanRunId, agencyId: s.agencyId, creatorId: s.creatorId,
      jobId: job.id, status: "RUNNING", hasMore: true, publicationGeneration: 1,
    } });
    const total = 4048, observedAt = new Date();
    for (let offset = 0; offset < total; offset += 20) {
      const items = Array.from({ length: Math.min(20, total - offset) }, (_, index) => ({
        fanId: String(20000 + offset + index), username: `fan_${offset + index}`, name: `Fan ${offset + index}`,
        lastSeen: observedAt.toISOString(), subscribedOn: true, subscribedBy: false,
        subscribedOnData: { isActive: true, type: "FREE" }, canReceiveChatMessage: true,
      }));
      await runRootCommit(db, ({ tx }) => subscribers.applySubscriberScanChunk({ db: tx, job,
        chunkResult: { kind: "subscriber_directory_page", scanRunId: job.params.scanRunId, offset, items,
          hasMore: offset + 20 < total, observationToken: `fixture-${offset}`,
          pagination: { contract: "of_subscribers_offset_v2", limit: 20 } },
        consumeObservationToken: async () => ({ observedAt }),
      }), { profile: "JOB_CHUNK" });
    }
    assert.equal(await db.creatorFan.count({ where: { creatorId: s.creatorId } }), total);
    await assert.rejects(subscribers.applySubscriberScanCompletion({ db, job, result: {} }),
      error => error.code === "SUBSCRIBER_PUBLICATION_DEFERRED_TO_MAINTENANCE");
    await db.jobInstance.update({ where: { id: job.id }, data: {
      status: "PUBLISHING", leaseUntil: null,
      progress: { percent: 99, stage: "PUBLICATION", message: "Subscribers collected · publishing snapshot" },
      lastProgressAt: new Date(0),
    } });
    const snapshot = await db.subscriberScanRun.findUnique({ where: { id: job.params.scanRunId } });
    assert.notEqual(snapshot.publicationStatus, "COMPLETE");
    pass("4048 current provider-page fixtures pass real collection/FanData/completion handoff");

    // Reproduce the persisted interrupted deployment state, not a simulated
    // boolean flag: SQL has the collected rows and job but lacks its wake.
    await db.subscriberDirectoryMaintenanceSignal.deleteMany({ where: { creatorId: s.creatorId } });
    assert.equal((await runSubscriberDirectoryMaintenance({ db, maxSignals: 1, concurrency: 1 })).processedSignals, 0);
    const planned = await subscribers.scheduleSubscriberScan({ ...input, manual: true, force: true });
    assert.equal(planned.reason, "publication_recovery_in_progress");
    assert.equal(planned.created, false);
    assert.ok(await row(), "re-observing publication debt must restore its missing wake");
    assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId } }), 1);
    pass("manual retry repairs the missing publication wake without creating a second scan");

    await db.subscriberDirectoryMaintenanceSignal.deleteMany({ where: { creatorId: s.creatorId } });
    const automatic = await subscribers.ensureSubscriberScanDue(input);
    assert.equal(automatic.reason, "publication_recovery_in_progress");
    assert.ok(await row(), "old publishedAt must not bypass a newer incomplete generation");
    pass("automatic creator planning repairs missing wake even with an older published snapshot and no recovery intent");

    await due();
    let claim = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    const activeBefore = await row();
    await subscribers.scheduleSubscriberScan(input);
    const activeAfter = await row();
    for (const field of ["revision", "claimToken", "attempts", "lastError"]) assert.equal(activeAfter[field], activeBefore[field]);
    assert.equal(+activeAfter.claimUntil, +activeBefore.claimUntil);
    assert.equal(+activeAfter.dueAt, +activeBefore.dueAt);
    pass("repeat planning preserves another publisher's active claim, revision and backoff");

    await db.subscriberDirectoryMaintenanceSignal.update({ where: { id: claim.id }, data: { attempts: 99 } });
    const timeoutMessage = "Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15100 ms passed since the start of the transaction.";
    assert.equal(await signals.releaseSubscriberDirectoryMaintenanceSignal({ db, signal: claim,
      error: Object.assign(new Error(timeoutMessage), { code: "P2028", meta: { error: timeoutMessage } }), retryMs: 1000 }), true);
    assert.equal((await row()).attempts, 99, "a temporary DB timeout must not spend the permanent failure budget");
    await due();
    claim = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    assert.ok(claim, JSON.stringify(await row()));
    await signals.releaseSubscriberDirectoryMaintenanceSignal({ db, signal: claim });
    pass("the hundredth temporary transaction timeout remains retryable and successful continuation resets failures");

    await db.subscriberDirectoryMaintenanceSignal.update({ where: { id: claim.id }, data: {
      attempts: 100, lastError: timeoutMessage, dueAt: new Date(0), claimToken: null, claimUntil: null,
    } });
    assert.equal(await signals.claimSubscriberDirectoryMaintenanceSignal({ db }), null);
    await subscribers.ensureSubscriberScanDue(input);
    const repaired = await row();
    assert.equal(repaired.attempts, 0);
    assert.equal(repaired.lastError, null);
    assert.ok(repaired.revision > claim.revision);
    pass("automatic planning repairs an old timeout-quarantined signal using exact transient diagnostics");

    await due(); claim = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    await db.subscriberDirectoryMaintenanceSignal.update({ where: { id: claim.id }, data: { attempts: 100, lastError: timeoutMessage } });
    await subscribers.ensureSubscriberScanDue(input);
    assert.equal((await row()).claimToken, claim.claimToken);
    assert.equal((await row()).attempts, 100);
    await db.subscriberDirectoryMaintenanceSignal.update({ where: { id: claim.id }, data: { claimUntil: new Date(0) } });
    await subscribers.ensureSubscriberScanDue(input);
    assert.equal(await signals.ackSubscriberDirectoryMaintenanceSignal({ db, signal: claim }), false);
    assert.equal(await signals.releaseSubscriberDirectoryMaintenanceSignal({ db, signal: claim, error: "late" }), false);
    pass("repair respects live ownership and fences a stale owner after expired-claim recovery");

    await db.subscriberDirectoryMaintenanceSignal.update({ where: { id: claim.id }, data: {
      attempts: 100, lastError: "GENUINE_DATA_CONTRADICTION", claimToken: null, claimUntil: null,
    } });
    await subscribers.scheduleSubscriberScan({ ...input, manual: true, force: true });
    assert.equal((await row()).attempts, 100);
    assert.equal(await signals.claimSubscriberDirectoryMaintenanceSignal({ db }), null);
    assert.equal(await signals.countPoisonedSubscriberMaintenanceSignals({ db }), 1);
    pass("genuine domain contradictions stay quarantined and visible instead of being silently reset");
    await signals.requeuePoisonedSubscriberMaintenanceSignal({ db, signalId: claim.id, reason: "PROOF_OPERATOR_REPAIR" });

    latency = Number(process.env.ONLINOD_SUBSCRIBER_QUERY_LATENCY_MS || 75);
    const started = Date.now();
    let rounds = 0;
    for (; rounds < 30; rounds++) {
      await due();
      const result = await runSubscriberDirectoryMaintenance({ db, maxSignals: 1, concurrency: 1,
        maxRuntimeMs: 750, recoveryStepsPerRun: 4 });
      assert.equal(result.ok, true, JSON.stringify(result));
      if ((await db.jobInstance.findUnique({ where: { id: job.id } })).status === "DONE") break;
    }
    latency = 0;
    const finalRun = await db.subscriberScanRun.findUnique({ where: { id: job.params.scanRunId } });
    const state = await db.subscriberDirectoryState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(finalRun.publicationStatus, "COMPLETE"); assert.ok(finalRun.publicationJobReconciledAt);
    assert.equal((await db.jobInstance.findUnique({ where: { id: job.id } })).status, "DONE");
    assert.equal(state.totalCount, total); assert.equal(state.currentRunId, finalRun.id);
    assert.equal(await db.followBackCandidate.count({ where: { creatorId: s.creatorId } }), total);
    assert.equal(await db.followAutomationCandidate.count({ where: { creatorId: s.creatorId } }), total);
    assert.equal((await readCreatorCurrentTask({ db, creatorId: s.creatorId })).active, false);
    assert.equal(await subscribers.hasSubscriberPublicationDebt(input), false);
    pass("4048-row publication converges with 75ms per-query latency despite a 750ms soft admission budget; UI task clears");
    const report = { ok: true, checks, nativePostgres: runtime.native, externalProviders: false,
      engine: runtime.native ? "PostgreSQL + Prisma" : "PGlite + Prisma (one physical SQL connection)",
      total, rounds: rounds + 1, delayedQueries, publicationMs: Date.now() - started };
    if (process.env.ONLINOD_SUBSCRIBER_RECOVERY_REPORT) fs.writeFileSync(process.env.ONLINOD_SUBSCRIBER_RECOVERY_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await runtime.close(); clearInterval(keep); }
})().catch(error => { console.error(error); process.exitCode = 1; clearInterval(keep); });
