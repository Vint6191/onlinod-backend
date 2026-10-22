"use strict";
// Disposable current-schema SQL: exact recovery/scheduling boundaries under a
// non-UTC pooled session. No provider calls or native PostgreSQL capacity claim.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const keep = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("SOURCE_BOUND_TIMEZONE_PROOF_TIMEOUT"); process.exit(2); }, 180000);

(async () => {
  const f = await fixture(), { db } = f, cases = [];
  try {
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const { dbAuthorityNow } = require("../../src/services/db-time-authority-service");
    const sync = require("../../src/services/creator-live-sync-service");
    const control = require("../../src/services/analytics-collector-control-service");
    const { scheduleJobNow } = require("../../src/services/job-scheduler");
    const subscribers = require("../../src/services/subscriber-directory-service");
    const { selectClaimCandidate } = require("../../src/services/job-claim-fairness-service");
    const commit = work => runRootCommit(db, ({ tx }) => work(tx), { profile: "JOB_CHUNK" });
    let index = 0;
    for (const [zone, shift] of [["UTC", 0], ["Etc/GMT-1", 3600000], ["America/New_York", -14400000]]) {
      const id = "tz171-" + index++, s = await scope(db, { agencyId: id, creatorId: id, userId: id });
      const narrow = { agencyId: s.agencyId, creatorId: s.creatorId };
      await db.$executeRawUnsafe("SELECT set_config('TimeZone',$1,false)", zone);
      const instant = new Date("2026-10-22T12:34:56.789Z");
      const cast = async tx => (await tx.$queryRawUnsafe(
        "SELECT $1::timestamp AS raw_date, $2::timestamp AS utc_string, current_setting('TimeZone') AS zone", instant, instant.toISOString()))[0];
      const outside = await cast(db);
      assert.equal(+outside.raw_date, +instant + shift, "raw Date cast reproduces session shift");
      assert.equal(+outside.utc_string, +instant, "UTC text timestamp cast is session independent");
      const inside = await commit(cast);
      assert.equal(inside.zone, "UTC"); assert.equal(+inside.raw_date, +instant);
      assert.equal((await db.$queryRawUnsafe("SHOW TimeZone"))[0].TimeZone, zone);
      await assert.rejects(commit(async tx => { assert.equal((await cast(tx)).zone, "UTC"); throw Error("rollback-proof"); }), /rollback-proof/);
      assert.equal((await db.$queryRawUnsafe("SHOW TimeZone"))[0].TimeZone, zone);
      const before = Date.now(), authority = await dbAuthorityNow({ db });
      assert(+authority >= before - 1000 && +authority <= Date.now() + 1000);
      cases.push(zone + ": raw-cast reproduction, existing root UTC pin, commit/rollback session restoration and timestamptz clock authority");

      // ORM timestamp input/output uses its own timestamp wire type. Fairness
      // intentionally selects on the root client before taking the claim lock.
      const fairAt = instant, base = { ...narrow, scope: "creator", status: "SCHEDULED", jobKey: "timezone_fairness", params: {} };
      const aged = await db.jobInstance.create({ data: { ...base, id: id + "-aged", nextRunAt: new Date(+fairAt - 60001), priority: 1 } });
      const fresh = await db.jobInstance.create({ data: { ...base, id: id + "-fresh", nextRunAt: new Date(+fairAt - 1), priority: 100 } });
      await db.jobInstance.create({ data: { ...base, id: id + "-future", nextRunAt: new Date(+fairAt + 1), priority: 1000 } });
      assert.equal(+aged.nextRunAt, +fairAt - 60001);
      const fairInput = { db, now: fairAt, where: { ...narrow, jobKey: base.jobKey, status: "SCHEDULED", nextRunAt: { lte: fairAt } } };
      assert.equal((await selectClaimCandidate(fairInput)).id, aged.id);
      await db.jobInstance.update({ where: { id: aged.id }, data: { nextRunAt: new Date(+fairAt - 59999) } });
      assert.equal((await selectClaimCandidate(fairInput)).id, fresh.id);
      cases.push(zone + ": ORM dates and 60-second fairness stay exact outside the root transaction, future work remains excluded");

      const now = new Date(), old = new Date(+now - 7200000), member = await db.agencyMember.findUnique({ where: { id: "member-" + s.agencyId } });
      await db.workerDevice.create({ data: { id, agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
      await db.creatorLiveSync.create({ data: { ...narrow, lastCapturedAt: old } });
      await commit(tx => sync.recordCaptureSamples({ db: tx, ...narrow, deviceId: id, memberId: member.id, accessEpoch: member.accessEpoch,
        now, bindings: [{ creatorId: s.creatorId, account: { sessionReadReady: true, realtimeHealthy: false } }] }));
      const intents = await db.creatorRecoveryIntent.findMany({ where: narrow });
      assert.equal(intents.length, 4);
      for (const intent of intents) { assert.equal(+intent.gapFrom, +old); assert.equal(+intent.targetAt, +now); }
      const intent = intents.find(row => row.stream === "financial");
      const frozen = { ...control.buildCollectionCommand({ collectorType: "FINANCIAL", collectionMode: "catchup", now }),
        ...sync.recoveryParams(intent), financialTraversalVersion: 2, endDate: new Date(Math.ceil(+now / 1000) * 1000).toISOString() };
      const planned = await commit(tx => control.withCollectorStateLock({ db: tx, type: "FINANCIAL", creatorId: s.creatorId, work: async locked => {
        const result = await scheduleJobNow({ db: locked, ...narrow, jobKey: "financial_transactions_scan", params: frozen, now,
          dedupeParams: { planningEpoch: id } });
        await sync.bindRecovery(locked, intent, result.job.id);
        return result;
      } }));
      const job = await db.jobInstance.findUnique({ where: { id: planned.job.id } });
      const end = require("../../src/services/financial-receipt-authority").date(job.params.endDate);
      assert.equal(+end, Math.ceil(+now / 1000) * 1000);
      assert.equal(+new Date(job.params.recoveryTargetAt), +now);
      assert.equal(+job.nextRunAt, Math.max(+job.scheduledAt, +end));
      assert.equal(await db.jobInstance.findFirst({ where: { id: job.id, nextRunAt: { lte: new Date(+end - 1) } } }), null);
      await assert.rejects(commit(tx => sync.completeRecovery(tx, job, true, { coveredThrough: new Date(+now - 1), deferPlanningWake: true })),
        { code: "LIVE_RECOVERY_COVERAGE_INCOMPLETE" });
      assert.equal((await db.creatorRecoveryIntent.findUnique({ where: { id: intent.id } })).status, "RUNNING");
      const stoppedAt = new Date(+now + 123);
      await commit(tx => sync.stopRecovery(tx, job, "timezone-proof", { attempts: 3, now: stoppedAt }));
      const stopped = await db.creatorRecoveryIntent.findUnique({ where: { id: intent.id } });
      assert.equal(+stopped.stoppedAt, +stoppedAt); assert.equal(+stopped.updatedAt, +stoppedAt);
      await commit(tx => sync.completeRecovery(tx, job, true, { coveredThrough: end, deferPlanningWake: true }));
      const completed = await db.creatorRecoveryIntent.findUnique({ where: { id: intent.id } });
      assert.equal(completed.status, "COMPLETE"); assert.equal(+completed.targetAt, +now);
      assert.equal(+(await db.creatorRecoveryWatermark.findUnique({ where: { creatorId_stream: { creatorId: s.creatorId, stream: "financial" } } })).throughAt, +now);
      cases.push(zone + ": exact API-ready intent, frozen ceil financial schedule, one-millisecond undercoverage rejection, stop and completion watermark");

      // The capture/ACK receipt still binds a JS Date in raw SQL. Exercise its
      // actual owner path to establish that the existing UTC root protects it.
      const sessionId = randomUUID(), capturedAt = new Date(+now + 1000);
      await commit(tx => sync.recordCaptureSamples({ db: tx, ...narrow, deviceId: id, memberId: member.id, accessEpoch: member.accessEpoch,
        now: capturedAt, bindings: [{ creatorId: s.creatorId, account: { sessionReadReady: true, realtimeHealthy: true,
          lastWsFrameAt: capturedAt.toISOString(), observation: { version: 1, moneyRevisionVersion: 1, sessionId,
            captureFromAt: now.toISOString(), capturedThroughAt: capturedAt.toISOString(), capturedThroughSeq: 1, lossRevision: 0 } } }] }));
      const delivery = await commit(tx => sync.acceptDelivery({ db: tx, ...narrow, deviceId: id, memberId: member.id, accessEpoch: member.accessEpoch,
        now: capturedAt, delivery: { version: 1, sessionId, entries: [{ seq: 1, capturedAt: capturedAt.toISOString() }] },
        events: [{ type: "timezone-proof" }], ingest: async () => [] }));
      assert.equal(delivery.deliveryAck.throughSeq, 1);
      const receipt = await db.creatorRealtimeReceipt.findFirst({ where: { session: { creatorId: s.creatorId } } });
      assert.equal(+receipt.capturedAt, +capturedAt);
      const state = await db.creatorLiveSync.findUnique({ where: { creatorId: s.creatorId } });
      assert.equal(+state.lastCapturedAt, +capturedAt); assert.equal(+state.lastDeliveredAt, +capturedAt);
      assert.equal((await db.$queryRawUnsafe("SHOW TimeZone"))[0].TimeZone, zone);
      cases.push(zone + ": raw capture receipt, ACK and live watermarks retain exact UTC instants inside their root owner");

      const sub = await scope(db, { agencyId: id + "-sub", creatorId: id + "-sub", userId: id + "-sub" });
      const subInput = { db, agencyId: sub.agencyId, creatorId: sub.creatorId };
      const subJob = (await subscribers.scheduleSubscriberScan(subInput)).job;
      await db.jobInstance.update({ where: { id: subJob.id }, data: { status: "FAILED", attempts: 5, lastError: "provider exhausted" } });
      await subscribers.recordSubscriberScanFailure({ db, job: subJob, error: "provider exhausted", terminal: true });
      const debt = await db.creatorRecoveryIntent.create({ data: { agencyId: sub.agencyId, creatorId: sub.creatorId,
        id: id + "-sub-debt", stream: "subscribers", reason: "OFFLINE_GAP", gapFrom: old, targetAt: now,
        status: "RUNNING", jobId: subJob.id, policyVersion: 2 } });
      const reconciliationStart = Date.now();
      assert.equal((await subscribers.ensureSubscriberScanDue(subInput)).reason, "failed_terminal");
      const reconciled = await db.creatorRecoveryIntent.findUnique({ where: { id: debt.id } });
      assert.equal(reconciled.status, "STOPPED"); assert.equal(+reconciled.targetAt, +now);
      assert(+reconciled.updatedAt >= reconciliationStart - 1 && +reconciled.updatedAt <= Date.now() + 1);
      assert(+reconciled.stoppedAt >= reconciliationStart - 1 && +reconciled.stoppedAt <= Date.now() + 1);
      assert.equal((await commit(tx => subscribers.ensureSubscriberScanDue({ ...subInput, db: tx }))).reason, "failed_terminal");
      assert.equal(await db.jobInstance.count({ where: { creatorId: sub.creatorId, jobKey: "subscriber_directory_scan" } }), 1);
      assert.equal((await db.$queryRawUnsafe("SHOW TimeZone"))[0].TimeZone, zone);
      cases.push(zone + ": direct subscriber preflight adopts terminal debt inside UTC transaction without resetting or rescheduling its exhausted episode");
    }
    console.log(JSON.stringify({ ok: true, nativePostgres: false, externalProviders: false, cases }, null, 2));
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keep); clearTimeout(deadline); });
