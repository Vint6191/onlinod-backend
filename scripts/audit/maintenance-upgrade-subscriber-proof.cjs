"use strict";
// Isolated authentic-schema upgrade + real scheduler/publisher integration.
// Provider observations are fixture inputs; all current maintenance callbacks, SQL
// ownership, publication phases and process restarts execute production code.
process.env.TZ = "UTC";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const { migrations, validMigrationPrefix } = require("../../src/services/database-migration-chain");
const root = path.resolve(__dirname, "../..");
const migrationName = "20261020010000_maintenance_admission_sequence";
const generation = "onlinod_maintenance_v1";
const keep = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("MAINTENANCE_UPGRADE_SUBSCRIBER_PROOF_DEADLINE"); process.exit(2); }, 240000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function childProcess(args, url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root,
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      code === 0 && !signal ? resolve(output) : reject(new Error(output || `PROOF_CHILD_FAILED:${code}:${signal}`));
    });
  });
}

// Separate OS processes cannot retain admission cursors, pending promises or
// publisher state from the setup process or a preceding maintenance worker.
const workerSource = `
  const db = require('./src/prisma');
  (async () => {
    const { verifyMaintenanceRuntime } = require('./src/services/maintenance-runtime-contract');
    const { runPhase2MaintenancePump } = require('./src/services/job-scheduler');
    const ready = await verifyMaintenanceRuntime({ db });
    const ticks = [];
    for (let i = 0; i < Number(process.argv[1]); i++) {
      const result = await runPhase2MaintenancePump({ db });
      ticks.push({ selected: result.admission?.selected || [],
        policy: result.admission?.policy, subscriber: result.subscriberDirectoryMaintenance || null,
        failures: Object.entries(result).filter(([name, value]) => name !== 'admission' && value?.ok === false)
          .map(([name, value]) => ({ name, ...value })), ok: result.ok });
    }
    console.log('MAINTENANCE_PROOF_RESULT=' + JSON.stringify({ ready, ticks }));
  })().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => db.$disconnect());
`;

(async () => {
  const fixture = await createScaleSqlRuntime({ beforeMigration: migrationName });
  const checks = [], ticks = [];
  const pass = (name, details = {}) => { checks.push(name); console.log("PASS", name, JSON.stringify(details)); };
  try {
    const { db } = fixture;
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    // This setup deliberately runs against the pre-admission schema. The new
    // reverse feed did not exist in that version: model that one old boundary
    // explicitly while constructing historical stranded subscriber state.
    // Every post-upgrade pump runs unmodified production modules in a fresh
    // child process, including the real transactional reverse publication.
    const entityChanges = require(root + "/src/services/creator-entity-change-service");
    const publishEntityChanges = entityChanges.publishEntityChanges;
    let constructingOldSchemaFixture = true;
    entityChanges.publishEntityChanges = async input => {
      if (!constructingOldSchemaFixture) return publishEntityChanges(input);
      assert.equal(require(root + "/src/services/db-commit-kernel").currentCommitContext()?.tx, input.db);
      assert.ok(input.changes.length <= 5000);
      return { staged: false, count: 0, historicalFixtureWithoutReverseFeed: true };
    };
    const sub = require(root + "/src/services/subscriber-directory-service");
    const { runRootCommit } = require(root + "/src/services/db-commit-kernel");
    const { MAINTENANCE_LANE_NAMES } = require(root + "/src/services/maintenance-lane-registry");
    const first = await scope(db, { agencyId: "upgrade-agency-a", creatorId: "upgrade-creator-a", userId: "upgrade-user-a" });
    const second = await scope(db, { agencyId: "upgrade-agency-b", creatorId: "upgrade-creator-b", userId: "upgrade-user-b" });
    const old = new Date("2026-10-17T15:08:03Z");

    async function collect(tenant, { generation: publicationGeneration, count, fanStart, label }) {
      const observedAt = (await db.$queryRawUnsafe('SELECT clock_timestamp() AS "now"'))[0].now;
      const runId = `${tenant.creatorId}-${label}-run`, jobId = `${tenant.creatorId}-${label}-job`;
      const job = await db.jobInstance.create({ data: {
        id: jobId, agencyId: tenant.agencyId, creatorId: tenant.creatorId, jobKey: "subscriber_directory_scan",
        scope: "creator", status: "CLAIMED", params: { scanRunId: runId, observationTokenVersion: 1, scanEveryDays: 7 },
      } });
      await db.subscriberDirectoryState.upsert({ where: { creatorId: tenant.creatorId },
        create: { agencyId: tenant.agencyId, creatorId: tenant.creatorId, publicationGeneration, status: "SCANNING", lastJobId: jobId },
        update: { publicationGeneration, status: "SCANNING", lastJobId: jobId } });
      await db.subscriberScanRun.create({ data: {
        id: runId, agencyId: tenant.agencyId, creatorId: tenant.creatorId, jobId,
        status: "RUNNING", hasMore: true, publicationGeneration,
      } });
      for (let offset = 0; offset < count; offset += 20) {
        const items = Array.from({ length: Math.min(20, count - offset) }, (_, i) => ({
          fanId: String(fanStart + offset + i), username: `${label}_fan_${offset + i}`,
          lastSeenAt: observedAt.toISOString(), fanSubscribesToCreator: true, fanSubscriptionActive: true,
          creatorFollowsFan: false, subscriptionType: "FREE", subscribePriceCents: 0,
          canReceiveChatMessage: true, blocked: false, restricted: false, performer: false,
        }));
        await runRootCommit(db, ({ tx }) => sub.applySubscriberScanChunk({ db: tx, job,
          chunkResult: { kind: "subscriber_directory_page", scanRunId: runId, offset, items,
            hasMore: offset + items.length < count, observationToken: `${runId}:${offset}`,
            pagination: { contract: "of_subscribers_offset_v2", limit: 20 } },
          consumeObservationToken: async () => ({ observedAt }),
        }), { profile: "JOB_CHUNK" });
      }
      await db.jobInstance.update({ where: { id: jobId }, data: {
        status: "PUBLISHING", leaseUntil: null, lastProgressAt: old,
        progress: { percent: 99, stage: "PUBLICATION", waitKind: "PUBLICATION",
          message: "Subscribers collected · publishing snapshot" },
      } });
      return { ...tenant, runId, jobId, count, generation: publicationGeneration, fanStart };
    }

    async function stranded(tenant, count, previousCount, fanStart) {
      const previous = await collect(tenant, { generation: 3, count: previousCount, fanStart, label: "previous" });
      const completed = await sub.recoverSubscriberPublicationDebt({ db, ...tenant, maxStepsPerRun: 8, maxRuntimeMs: 30000 });
      assert.equal(completed.reconciledJobs, 1);
      const current = await collect(tenant, { generation: 4, count, fanStart: fanStart + 10, label: "current" });
      const pending = await db.subscriberScanRun.findUnique({ where: { id: current.runId } });
      const partial = await sub._test.publishRun(db, pending, { jobId: current.jobId, maxSteps: 2 });
      assert.equal(partial.complete, false); assert.equal(partial.run.publicationStatus, "CURRENT");
      assert.ok(partial.run.publicationCursorId, "fixture requires a committed CURRENT prefix");
      assert.equal(partial.run.publicationAddedCount + partial.run.publicationChangedCount, 500);
      await db.subscriberScanRun.update({ where: { id: current.runId }, data: { publicationStartedAt: old, updatedAt: old } });
      await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: tenant.creatorId }, data: { dueAt: old } });
      const recovery = await db.subscriberDirectoryMaintenanceSignal.findUnique({
        where: { creatorId_kind: { creatorId: tenant.creatorId, kind: "RECOVERY" } },
      });
      assert.ok(recovery); assert.equal(recovery.attempts, 0); assert.equal(recovery.claimToken, null);
      assert.equal(recovery.lastError, null);
      return { ...current, previous, previousCount, cursor: partial.run.publicationCursorId,
        expectedChanged: previousCount - 10, expectedAdded: count - previousCount + 10, expectedDisappeared: 10 };
    }

    const targets = [await stranded(first, 600, 20, 10000), await stranded(second, 620, 40, 20000)];
    await db.$executeRawUnsafe(`UPDATE "MaintenanceAdmissionClassState" SET
      "turnCount"=CASE WHEN ordinal<28 THEN 3582 ELSE 0 END,
      "lastAdmittedAt"=CASE WHEN ordinal<28 THEN $2 ELSE NULL END WHERE generation=$1`, generation, old);
    const before = await db.$queryRawUnsafe('SELECT "laneName","ordinal","turnCount","lastAdmittedAt" FROM "MaintenanceAdmissionClassState" WHERE generation=$1 ORDER BY ordinal', generation);
    assert.equal(before.length, 38);
    assert.equal(before.filter(row => row.turnCount === 3582n).length, 28);
    assert.equal(before.filter(row => row.turnCount === 0n).length, 10);
    const runsBefore = await db.subscriberScanRun.findMany({ where: { id: { in: targets.map(row => row.runId) } }, orderBy: { id: "asc" } });
    pass("two tenant-scoped CURRENT snapshots reproduce committed 500-row prefixes and unclaimed due recovery", { creators: 2, fans: [600, 620], oldLanes: 28, newLanes: 10 });

    const prefix = await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
    assert.equal(validMigrationPrefix(prefix), true); assert.equal(validMigrationPrefix(prefix, true), false);
    assert.deepEqual(prefix.map(row => ({ migration: row.migration_name, checksum: row.checksum })),
      migrations.slice(0, migrations.findIndex(row => row.migration === migrationName)));
    assert.equal((await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='MaintenanceAdmissionClassState' AND column_name='admissionSequence'`))[0].n, 0);
    pass("authentic previous schema and migration receipts contain no admissionSequence");

    async function releaseConnection() { await db.$disconnect(); if (fixture.waitForIdle) await fixture.waitForIdle(); }
    async function install() { await releaseConnection(); return childProcess(["scripts/database/install-current.js"], fixture.url); }
    constructingOldSchemaFixture = false;
    await install();
    const upgraded = await db.$queryRawUnsafe('SELECT "laneName","ordinal","turnCount","lastAdmittedAt","admissionSequence" FROM "MaintenanceAdmissionClassState" WHERE generation=$1 ORDER BY ordinal', generation);
    assert.deepEqual(upgraded.filter(row => before.some(oldRow => oldRow.laneName === row.laneName)).map(({ admissionSequence, ...row }) => row), before);
    assert.equal(upgraded.length, MAINTENANCE_LANE_NAMES.length);
    assert.ok(upgraded.every(row => row.admissionSequence === 0n));
    assert.deepEqual(await db.subscriberScanRun.findMany({ where: { id: { in: targets.map(row => row.runId) } }, orderBy: { id: "asc" } }), runsBefore);
    assert.equal((await require("../../src/services/database-contract-service").readDatabaseContract(db)).ready, true);
    pass("actual installer adds fair sequence while preserving lifetime counts and publication checkpoints");

    async function pumpProcess(count) {
      await releaseConnection();
      const output = await childProcess(["-e", workerSource, String(count)], fixture.url, 90000);
      const line = output.split(/\r?\n/).find(value => value.startsWith("MAINTENANCE_PROOF_RESULT="));
      assert.ok(line, output);
      const result = JSON.parse(line.slice("MAINTENANCE_PROOF_RESULT=".length));
      assert.equal(result.ready.ready, true); assert.equal(result.ready.handlers, MAINTENANCE_LANE_NAMES.length);
      for (const tick of result.ticks) {
        assert.equal(tick.policy, "bounded_fair_sequence"); assert.equal(tick.selected.length, 5);
        assert.deepEqual(tick.failures, [], JSON.stringify(tick)); assert.equal(tick.ok, true, JSON.stringify(tick));
        if (tick.subscriber) assert.equal(tick.subscriber.errors, 0, JSON.stringify(tick.subscriber));
      }
      ticks.push(...result.ticks);
      return result;
    }

    await pumpProcess(1);
    assert.equal(ticks[0].selected.includes("subscriberDirectoryMaintenance"), false);
    for (const target of targets) {
      const row = await db.subscriberScanRun.findUnique({ where: { id: target.runId } });
      assert.equal(row.publicationStatus, "CURRENT"); assert.equal(row.publicationCursorId, target.cursor);
      assert.equal((await db.jobInstance.findUnique({ where: { id: target.jobId } })).status, "PUBLISHING");
    }
    pass("first real pump preserves pending subscriber work before its offer, then worker process exits");

    await pumpProcess(7);
    assert.deepEqual(new Set(ticks.slice(0, 8).flatMap(tick => tick.selected)), new Set(MAINTENANCE_LANE_NAMES));
    const firstOffer = ticks.findIndex(tick => tick.selected.includes("subscriberDirectoryMaintenance")) + 1;
    assert.ok(firstOffer > 0 && firstOffer <= 8);
    assert.ok(ticks.some(tick => Number(tick.subscriber?.advancedSteps || 0) > 0));
    pass("fresh process dispatches every actual handler within eight ticks despite 3582-count history", { firstSubscriberOffer: firstOffer, ticks: 8 });

    // Recovery deliberately yields after bounded work. If local SQL exceeds the
    // soft slice, honor its real 2s continuation delay before a fresh process.
    let complete = false;
    for (let round = 0; round <= 3; round++) {
      const rows = await db.jobInstance.findMany({ where: { id: { in: targets.map(row => row.jobId) } }, select: { status: true } });
      if (rows.every(row => row.status === "DONE")) { complete = true; break; }
      if (round === 3) break;
      await wait(2100); await pumpProcess(8);
    }
    assert.equal(complete, true, "bounded actual pump continuations must close both publications");
    async function assertPublished() {
      for (const target of targets) {
        const run = await db.subscriberScanRun.findUnique({ where: { id: target.runId } });
        const state = await db.subscriberDirectoryState.findUnique({ where: { creatorId: target.creatorId } });
        const job = await db.jobInstance.findUnique({ where: { id: target.jobId } });
        assert.equal(run.status, "PUBLISHED"); assert.equal(run.publicationStatus, "COMPLETE");
        assert.equal(run.publicationCursorId, null); assert.equal(run.publicationLastError, null);
        assert.ok(run.publicationJobReconciledAt); assert.ok(run.publicationCompletedAt > old);
        assert.equal(run.publicationAddedCount, target.expectedAdded);
        assert.equal(run.publicationChangedCount, target.expectedChanged);
        assert.equal(run.publicationDisappearedCount, target.expectedDisappeared);
        assert.equal(state.status, "READY"); assert.equal(state.currentRunId, target.runId);
        assert.equal(state.previousRunId, target.previous.runId); assert.equal(state.totalCount, target.count);
        assert.equal(state.publicationGeneration, 4); assert.equal(state.publishedGeneration, 4);
        assert.equal(job.status, "DONE"); assert.equal(job.leaseUntil, null); assert.equal(job.lastError, null);
        assert.ok(job.lastProgressAt > old);
        assert.equal(await sub.hasSubscriberPublicationDebt({ db, ...target }), false);
        assert.equal(await db.subscriberScanItem.count({ where: { runId: target.runId } }), target.count);
        assert.equal(await db.followBackCandidate.count({ where: { creatorId: target.creatorId, snapshotRunId: target.runId } }), target.count);
        assert.equal(await db.followAutomationCandidate.count({ where: { creatorId: target.creatorId, snapshotRunId: target.runId } }), target.count);
        assert.equal(await db.subscriberDirectoryMaintenanceSignal.count({ where: { creatorId: target.creatorId, kind: "RECOVERY" } }), 0);
        assert.equal(await db.jobInstance.count({ where: { creatorId: target.creatorId, jobKey: "subscriber_directory_scan" } }), 2);
      }
    }
    await assertPublished();
    pass("actual subscriber lane completes CURRENT/PREVIOUS/FINALIZE, exact projection counts and job DONE for both tenants");

    const finalRuns = await db.subscriberScanRun.findMany({ where: { id: { in: targets.map(row => row.runId) } }, orderBy: { id: "asc" } });
    await install();
    await pumpProcess(8);
    await assertPublished();
    assert.deepEqual(await db.subscriberScanRun.findMany({ where: { id: { in: targets.map(row => row.runId) } }, orderBy: { id: "asc" } }), finalRuns);
    const after = await db.$queryRawUnsafe('SELECT "laneName","turnCount","admissionSequence" FROM "MaintenanceAdmissionClassState" WHERE generation=$1 ORDER BY ordinal', generation);
    for (const row of after) {
      const offers = ticks.filter(tick => tick.selected.includes(row.laneName)).length;
      assert.equal(row.turnCount, (before.find(prior => prior.laneName === row.laneName)?.turnCount || 0n) + BigInt(offers));
      assert.ok(row.admissionSequence > 0n);
    }
    pass("repeated install and a third process preserve closure, checkpoints and exact lifetime dispatch counts");
    console.log(JSON.stringify({ ok: true, checks, ticks: ticks.length, firstSubscriberOffer: firstOffer,
      engine: fixture.native ? "PostgreSQL + Prisma" : "PGlite + Prisma, one physical SQL connection",
      limitations: "local SQL fixture with deterministic source observations; no provider calls or fleet concurrency claim" }));
  } finally { await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { clearInterval(keep); clearTimeout(deadline); });
