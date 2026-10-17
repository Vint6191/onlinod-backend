"use strict";
// Current SQL + real scheduler timer/registry/admission path. Physical provider
// reads are deterministic fixture pages; no application database is used.
const assert = require("node:assert/strict");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const keep = setInterval(() => {}, 1000);
(async () => {
  const runtime = await createScaleSqlRuntime();
  let stop = null;
  try {
    const { db } = runtime, s = await scope(db);
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const subscribers = require("../../src/services/subscriber-directory-service");
    const signals = require("../../src/services/subscriber-directory-maintenance-signal-service");
    const job = await db.jobInstance.create({ data: { id: "subscriber-runtime-job", ...s, userId: undefined,
      jobKey: "subscriber_directory_scan", scope: "creator", status: "CLAIMED", leaseRevision: 1,
      params: { scanRunId: "subscriber-runtime-run", observationTokenVersion: 1, scanEveryDays: 7 } } });
    await db.subscriberDirectoryState.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, publicationGeneration: 1 } });
    await db.subscriberScanRun.create({ data: { id: job.params.scanRunId, agencyId: s.agencyId, creatorId: s.creatorId,
      jobId: job.id, status: "RUNNING", hasMore: true, publicationGeneration: 1 } });
    const total = 3001, observedAt = new Date();
    for (let offset = 0; offset < total; offset += 20) {
      const items = Array.from({ length: Math.min(20, total - offset) }, (_, index) => ({
        fanId: String(20000 + offset + index), username: `fan_${offset + index}`, name: `Fan ${offset + index}`,
        lastSeen: offset + index < 5 ? null : observedAt.toISOString(), subscribedOn: true, subscribedBy: false,
        subscribedOnData: { isActive: true, type: "FREE" }, canReceiveChatMessage: true,
      }));
      await runRootCommit(db, ({ tx }) => subscribers.applySubscriberScanChunk({ db: tx, job,
        chunkResult: { kind: "subscriber_directory_page", scanRunId: job.params.scanRunId, offset, items,
          hasMore: offset + 20 < total, observationToken: `fixture-${offset}`, pagination: { contract: "of_subscribers_offset_v2", limit: 20 } },
        consumeObservationToken: async () => ({ observedAt }),
      }), { profile: "JOB_CHUNK" });
    }
    assert.equal(await db.creatorFan.count({ where: { creatorId: s.creatorId } }), total);
    await assert.rejects(subscribers.applySubscriberScanCompletion({ db, job, result: {} }),
      error => error.code === "SUBSCRIBER_PUBLICATION_DEFERRED_TO_MAINTENANCE");
    await runRootCommit(db, async ({ tx }) => {
      await tx.jobInstance.update({ where: { id: job.id }, data: { status: "PUBLISHING", leaseUntil: null,
        progress: { percent: 99, stage: "PUBLICATION", message: "Subscribers collected · publishing snapshot" }, lastProgressAt: new Date(0) } });
      await signals.signalSubscriberDirectoryMaintenance({ db: tx, agencyId: s.agencyId, creatorId: s.creatorId,
        kind: "RECOVERY", reason: "COMPLETION_HANDOFF" });
    });
    const before = await db.subscriberScanRun.findUnique({ where: { id: job.params.scanRunId } });
    assert.notEqual(before.publicationStatus, "COMPLETE");
    assert.equal(before.publicationAddedCount, total, "collector has durably published the current cohort before handoff");
    console.log("PASS current V2 source pages commit 3001 FanData rows and bounded completion hands off partial publication");
    await require("../../src/services/maintenance-runtime-contract").verifyMaintenanceRuntime({ db });
    const scheduler = require("../../src/services/job-scheduler");
    stop = scheduler.startRecurringScheduler();
    const deadline = Date.now() + 100000;
    let final;
    do {
      await wait(250);
      final = await db.jobInstance.findUnique({ where: { id: job.id } });
      if (Date.now() > deadline) {
        const signal = await db.subscriberDirectoryMaintenanceSignal.findMany({ where: { creatorId: s.creatorId } });
        throw Error("SCHEDULER_PUBLICATION_STALLED:" + JSON.stringify({ status: final.status, signal,
          maintenance: require("../../src/services/maintenance-health-service").getMaintenanceHealth?.() }));
      }
    } while (final.status !== "DONE");
    const run = await db.subscriberScanRun.findUnique({ where: { id: job.params.scanRunId } });
    const state = await db.subscriberDirectoryState.findUnique({ where: { creatorId: s.creatorId } });
    assert.equal(run.publicationStatus, "COMPLETE"); assert(run.publicationJobReconciledAt);
    assert.equal(state.totalCount, total); assert.equal(state.currentRunId, run.id);
    assert.equal(await db.followBackCandidate.count({ where: { creatorId: s.creatorId } }), total);
    assert.equal(await db.followAutomationCandidate.count({ where: { creatorId: s.creatorId } }), total);
    const admission = await require("../../src/services/phase2-maintenance-admission-service").readMaintenanceAdmissionProgress({ db });
    assert(BigInt(admission.lanes.find(lane => lane.name === "subscriberDirectoryMaintenance").turn) > 0n);
    console.log("PASS real startup validation, scheduler timer, fair admission, registry and signal owner converge PUBLISHING→DONE with complete derived projections");
    await stop(); stop = null;
    assert.equal((await subscribers.recoverSubscriberPublicationDebt({ db, agencyId: s.agencyId, creatorId: s.creatorId })).reason, "none_due");
    console.log("PASS scheduler drain and durable replay leave no subscriber publication debt");
  } finally { if (stop) await stop(); await runtime.close(); clearInterval(keep); }
})().catch(error => { console.error(error); process.exitCode = 1; clearInterval(keep); });
