"use strict";
// Actual Prisma + PostgreSQL fixture. --slow additionally proves one CURRENT
// page at 1.6s/client SQL round trip; this is transport latency, not a load test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const keep = setInterval(() => {}, 1000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function configureA32DerivedPlanningModules(db, scope) {
  const { setAutomationControl } = require(root + "/src/services/automation-control-service");
  const moduleSettings = [
    ["follow_back", {
      enabled: true, automatic: true, activeSubscribers: true, expiredSubscribers: true,
      freeSubscribers: true, paidSubscribers: true, dailyLimit: 1000,
    }],
    ["follow", {
      enabled: true, automatic: true, refollowEnabled: true, dailyLimit: 1000, maxNudgesPerFan: 2,
    }],
    ["bumps", {
      enabled: true, automatic: true, hiddenOnlineEnabled: false, paidSubscribersEnabled: true,
      freeSubscribersEnabled: false, subscriptionEventsEnabled: false, onlineEnabled: false,
      dailyLimit: 1000, candidateBatchSize: 500,
    }],
  ];
  for (const [moduleKey, settings] of moduleSettings) {
    await setAutomationControl({
      agencyId: scope.agencyId, creatorId: scope.creatorId, userId: null,
      scope: "module", moduleKey, enabled: true, settings, db,
    });
  }
}

async function seedA32DerivedPlanningDebt(db, scope, { prefix = "unknown500", fanCount = 500, generation = 77 } = {}) {
  const runId = `${prefix}-run`;
  const jobId = `${prefix}-subscriber-job`;
  const now = (await db.$queryRawUnsafe('SELECT clock_timestamp() AS "now"'))[0].now;
  const fanIds = Array.from({ length: fanCount }, (_, index) => `${scope.creatorId}-a32-fan-${String(index).padStart(4, "0")}`);

  await db.jobInstance.create({
    data: {
      id: jobId, jobKey: "subscriber_directory_scan", scope: "creator", creatorId: scope.creatorId, agencyId: scope.agencyId,
      status: "FAILED", leaseRevision: 1, lastError: "a32 derived planning proof",
      params: { scanRunId: runId, scanEveryDays: 7 },
    },
  });
  await db.subscriberScanRun.create({
    data: {
      id: runId, agencyId: scope.agencyId, creatorId: scope.creatorId, jobId, status: "PUBLISHED",
      hasMore: false, scannedCount: fanCount, fanProjectionStatus: "COMPLETE", fanProjectionCount: fanCount,
      fanProjectionCompletedAt: now, publicationStatus: "COMPLETE", publicationGeneration: generation,
      publicationStartedAt: now, publicationCompletedAt: now, publishedAt: now, completedAt: now, summary: { fanCount },
    },
  });
  await db.subscriberDirectoryState.create({
    data: {
      agencyId: scope.agencyId, creatorId: scope.creatorId, currentRunId: runId, lastJobId: jobId, status: "READY",
      totalCount: fanCount, publicationGeneration: generation, publishedGeneration: generation, publishedAt: now,
    },
  });

  const subscriberItems = fanIds.map((fanId, index) => ({
    id: `${prefix}-scan-${String(index).padStart(4, "0")}`, runId, agencyId: scope.agencyId, creatorId: scope.creatorId,
    fanId, dialogId: `${fanId}-dialog`, username: `fan_${index}`, name: `Fan ${index}`,
    subscriptionType: "paid", isActive: true, valueAvailability: "NOT_FETCHED",
    contentHash: `${prefix}-hash-${index}`, metadata: {}, observedAt: now,
  }));
  const followBack = fanIds.map((fanId, index) => ({
    id: `${prefix}-fb-${String(index).padStart(4, "0")}`, agencyId: scope.agencyId, creatorId: scope.creatorId, fanId,
    dialogId: `${fanId}-dialog`, username: `fan_${index}`, displayName: `Fan ${index}`, snapshotRunId: runId,
    state: "CANDIDATE", generation: 1, ignored: false, blocked: false, discoveredAt: now,
  }));
  const followAutomation = fanIds.map((fanId, index) => ({
    id: `${prefix}-fa-${String(index).padStart(4, "0")}`, agencyId: scope.agencyId, creatorId: scope.creatorId, fanId,
    dialogId: `${fanId}-dialog`, username: `fan_${index}`, displayName: `Fan ${index}`, snapshotRunId: runId,
    state: "CANDIDATE", phase: "IDLE", generation: 0, ignored: false, blocked: false, discoveredAt: now,
  }));
  await db.subscriberScanItem.createMany({ data: subscriberItems });
  await db.followBackCandidate.createMany({ data: followBack });
  await db.followAutomationCandidate.createMany({ data: followAutomation });
  await db.automationTask.create({
    data: {
      id: `${prefix}-bump-template`, agencyId: scope.agencyId, creatorId: scope.creatorId, type: "bump_online",
      title: "A32 derived planning proof", enabled: true, status: "active",
      config: { messageText: "A32 proof bump" }, triggers: { subscriber: true }, rules: {}, schedule: {}, stats: {}, metadata: {},
    },
  });
  await configureA32DerivedPlanningModules(db, scope);
  return { runId, jobId, fanIds, generation, now };
}

(async () => {
  const fixture = await createScaleSqlRuntime();
  try {
    const { db } = fixture, tenant = await scope(db);
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const sub = require(root + "/src/services/subscriber-directory-service");
    const signals = require(root + "/src/services/subscriber-directory-maintenance-signal-service");
    const maintenance = require(root + "/src/services/subscriber-directory-maintenance-service");
    const { runRootCommit } = require(root + "/src/services/db-commit-kernel");
    const old = new Date("2026-10-17T18:04:00Z"), observedAt = new Date();
    const input = { db, agencyId: tenant.agencyId, creatorId: tenant.creatorId };
    let latency = 0, queries = 0;
    db.$use(async (params, next) => { if (latency) { queries++; await wait(latency); } return next(params); });
    const report = [];
    const record = (name, data = {}) => { const entry = { name, ok: true, ...data }; report.push(entry); console.log(JSON.stringify(entry)); };
    const job = await db.jobInstance.create({ data: { id: "latency-job", agencyId: tenant.agencyId, creatorId: tenant.creatorId,
      jobKey: "subscriber_directory_scan", scope: "creator", status: "CLAIMED",
      params: { scanRunId: "latency-run", observationTokenVersion: 1, scanEveryDays: 7 } } });
    await db.subscriberDirectoryState.create({ data: { agencyId: tenant.agencyId, creatorId: tenant.creatorId, publicationGeneration: 1 } });
    await db.subscriberScanRun.create({ data: { id: "latency-run", agencyId: tenant.agencyId, creatorId: tenant.creatorId, jobId: job.id,
      status: "RUNNING", hasMore: true, publicationGeneration: 1 } });
    for (let offset = 0; offset < 60; offset += 20) {
      const items = Array.from({ length: 20 }, (_, i) => ({ fanId: String(20000 + offset + i), username: "fan" + (offset + i),
        lastSeenAt: observedAt.toISOString(), fanSubscribesToCreator: true, fanSubscriptionActive: true,
        creatorFollowsFan: false, subscriptionType: "FREE", subscribePriceCents: 0, canReceiveChatMessage: true,
        blocked: false, restricted: false, performer: false }));
      await runRootCommit(db, ({ tx }) => sub.applySubscriberScanChunk({ db: tx, job,
        chunkResult: { kind: "subscriber_directory_page", scanRunId: "latency-run", offset, items, hasMore: offset + 20 < 60,
          observationToken: "fixture" + offset, pagination: { contract: "of_subscribers_offset_v2", limit: 20 } },
        consumeObservationToken: async () => ({ observedAt }) }), { profile: "JOB_CHUNK" });
    }
    await db.jobInstance.update({ where: { id: job.id }, data: { status: "PUBLISHING", leaseUntil: null,
      progress: { percent: 99, message: "Subscribers collected · publishing snapshot" }, lastProgressAt: old } });
    if (process.argv.includes("--slow")) {
      const pending = await db.subscriberScanRun.findUnique({ where: { id: "latency-run" } });
      await sub._test.publishRun(db, pending, { jobId: job.id, maxSteps: 1 });
      assert.equal((await db.subscriberScanRun.findUnique({ where: { id: pending.id } })).publicationStatus, "CURRENT");
      await signals.ensureSubscriberDirectoryMaintenance({ ...input, kind: "RECOVERY" });
      queries = 0; latency = 1600; const started = Date.now();
      const result = await maintenance.runSubscriberDirectoryMaintenance({ db, maxSignals: 1, concurrency: 1, maxRuntimeMs: 750 });
      latency = 0;
      const advanced = await db.subscriberScanRun.findUnique({ where: { id: pending.id } });
      assert.equal(result.errors, 0); assert.equal(result.advancedSteps, 1);
      assert.equal(advanced.publicationStatus, "PREVIOUS", "one owned CURRENT page survives a soft slice shorter than network setup");
      assert.equal(advanced.publicationAddedCount, 60);
      assert.ok((await db.jobInstance.findUnique({ where: { id: job.id } })).lastProgressAt > old);
      record("CURRENT page at 1600ms SQL latency", { ms: Date.now() - started, queries, processed: 60 });
    }
    const scan = await db.subscriberScanRun.findUnique({ where: { id: "latency-run" } });
    assert.equal((await sub._test.publishRun(db, scan, { jobId: job.id, maxSteps: 8 })).complete, true);
    await db.automationControlState.create({ data: { agencyId: tenant.agencyId, creatorId: tenant.creatorId,
      scopeKey: "creator:" + tenant.creatorId + ":module:follow_back", moduleKey: "follow_back", enabled: true,
      settings: { enabled: true, automatic: true, dailyLimit: 50 } } });
    // FINALIZE committed before Job DONE. Recreate service modules to exercise
    // only durable state, with real eligible fans and enabled follow automation.
    const before = await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { creatorId_kind: { creatorId: tenant.creatorId, kind: "DERIVED_PLANNING" } } });
    assert.ok(before, "source FINALIZE and derived wake commit together");
    await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: tenant.creatorId, kind: "DERIVED_PLANNING" }, data: { dueAt: new Date("2030-01-01") } });
    await signals.ensureSubscriberDirectoryMaintenance({ ...input, kind: "RECOVERY" });
    await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: tenant.creatorId, kind: "RECOVERY" }, data: { dueAt: new Date(0) } });
    queries = 0; latency = 75; const started = Date.now();
    const completion = await maintenance.runSubscriberDirectoryMaintenance({ db, maxSignals: 1, concurrency: 1, maxRuntimeMs: 750 });
    latency = 0;
    assert.equal(completion.errors, 0); assert.equal(completion.reconciledJobs, 1);
    assert.equal((await db.jobInstance.findUnique({ where: { id: job.id } })).status, "DONE");
    assert.equal(await db.automationDelivery.count({ where: { creatorId: tenant.creatorId } }), 0, "source completion does not run delivery planners");
    assert.ok(await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { creatorId_kind: { creatorId: tenant.creatorId, kind: "DERIVED_PLANNING" } } }));
    record("enabled automation cannot roll back source completion", { ms: Date.now() - started, queries });
    const { publishDomainWork } = require(root + "/src/services/domain-work-authority-service");
    const work = await publishDomainWork({ ...input, workClass: "CREATOR_RECURRING_PLANNING", objectType: "CreatorAccount",
      objectId: tenant.creatorId, partitionKey: tenant.creatorId });
    const fresh = new Date();
    await db.domainWorkItem.update({ where: { id: work.id }, data: { state: "READY", availableAt: new Date(+fresh + 3600000),
      progressCursor: { lastFullPlanningAt: fresh.toISOString(), lastSubscriberDerivedGeneration: 0 } } });
    await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: tenant.creatorId }, data: { dueAt: new Date("2030-01-01") } });
    await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: tenant.creatorId, kind: "DERIVED_PLANNING" }, data: { dueAt: new Date(0) } });
    delete require.cache[require.resolve(root + "/src/services/subscriber-directory-maintenance-service")];
    const restarted = require(root + "/src/services/subscriber-directory-maintenance-service");
    const promoted = await restarted.runSubscriberDirectoryMaintenance({ db, maxSignals: 1, concurrency: 1, maxRuntimeMs: 750 });
    assert.equal(promoted.errors, 0); assert.equal(promoted.derivedPlanningSignals, 1);
    assert.equal(await db.subscriberDirectoryMaintenanceSignal.count({ where: { creatorId: tenant.creatorId, kind: "DERIVED_PLANNING" } }), 0);
    const pending = await db.domainWorkItem.findUnique({ where: { id: work.id } });
    assert.equal(pending.progressCursor.lastSubscriberDerivedGeneration, 0);
    assert.equal(pending.progressCursor.lastFullPlanningAt, fresh.toISOString());
    assert.ok(pending.availableAt <= new Date());
    const { runRecurringCreatorWork } = require(root + "/src/services/job-scheduler");
    const planned = await runRecurringCreatorWork({ db, pageSize: 1, maxRuntimeMs: 1000, now: new Date() });
    const deliveries = await db.automationDelivery.count({ where: { creatorId: tenant.creatorId } });
    assert.ok(deliveries > 0, "new subscriber generation must plan enabled deliveries outside source publication despite fresh hourly cursor");
    const after = await db.domainWorkItem.findUnique({ where: { id: work.id } });
    assert.equal(after.progressCursor.lastSubscriberDerivedGeneration, 1);
    await publishDomainWork({ ...input, workClass: "CREATOR_RECURRING_PLANNING", objectType: "CreatorAccount", objectId: tenant.creatorId, partitionKey: tenant.creatorId });
    await runRecurringCreatorWork({ db, pageSize: 1, maxRuntimeMs: 1000, now: new Date() });
    assert.equal(await db.automationDelivery.count({ where: { creatorId: tenant.creatorId } }), deliveries);
    record("restart outbox -> derived planning -> same-generation replay", { deliveries, planned });
    // Stale outbox claim cannot leave a DWI revision behind.
    await signals.signalSubscriberDirectoryMaintenance({ ...input, kind: "DERIVED_PLANNING" });
    const owned = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    assert.equal(owned.kind, "DERIVED_PLANNING");
    await signals.signalSubscriberDirectoryMaintenance({ ...input, kind: "DERIVED_PLANNING" });
    const beforeRevision = (await db.domainWorkItem.findUnique({ where: { id: work.id } })).requestedRevision;
    await assert.rejects(restarted._test.dispatchSubscriberDerivedPlanning({ db, signal: owned }), { code: "SUBSCRIBER_MAINTENANCE_CLAIM_STALE" });
    assert.equal((await db.domainWorkItem.findUnique({ where: { id: work.id } })).requestedRevision, beforeRevision);
    record("stale outbox owner rolls back DWI and preserves newer signal");
    await db.subscriberDirectoryMaintenanceSignal.deleteMany({});
    async function seed(name, overrides = {}, state = {}) {
      await runRootCommit(db, async ({ tx }) => {
        await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
        await tx.creatorAccount.create({ data: { id: name, agencyId: tenant.agencyId, displayName: name, remoteId: name, status: "READY" } });
      });
      await db.jobInstance.create({ data: { id: name + "-job", agencyId: tenant.agencyId, creatorId: name,
        jobKey: "subscriber_directory_scan", scope: "creator", status: "PUBLISHING", lastProgressAt: old,
        params: { scanRunId: name + "-run" }, progress: { percent: 99, message: "Subscribers collected · publishing snapshot" } } });
      await db.subscriberDirectoryState.create({ data: { agencyId: tenant.agencyId, creatorId: name, publicationGeneration: 1, status: "SCANNING", ...state } });
      await db.subscriberScanRun.create({ data: { id: name + "-run", agencyId: tenant.agencyId, creatorId: name, jobId: name + "-job",
        status: "RUNNING", hasMore: false, fanProjectionStatus: "COMPLETE", publicationStatus: "CURRENT", publicationGeneration: 1, ...overrides } });
      return { db, agencyId: tenant.agencyId, creatorId: name };
    }
    await runRootCommit(db, async ({ tx }) => {
      await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
      await tx.creatorAccount.create({ data: { id: "unknown500", agencyId: tenant.agencyId, displayName: "unknown500", remoteId: "unknown500", status: "READY" } });
    });
    const unknownScope = { agencyId: tenant.agencyId, creatorId: "unknown500" };
    const unknown = await seedA32DerivedPlanningDebt(db, unknownScope, { generation: 77, fanCount: 500 });
    const sourceOnly = await sub.recoverSubscriberPublicationDebt({ db, ...unknownScope });
    assert.equal(sourceOnly.reconciledJobs, 1);
    assert.equal(await db.jobInstance.count({ where: { creatorId: "unknown500", jobKey: "fan_data_point_refresh" } }), 0);
    const unknownWork = await publishDomainWork({ db, ...unknownScope, workClass: "CREATOR_RECURRING_PLANNING", objectType: "CreatorAccount", objectId: "unknown500", partitionKey: "unknown500" });
    await db.domainWorkItem.update({ where: { id: unknownWork.id }, data: { availableAt: new Date("2030-01-01"),
      progressCursor: { lastFullPlanningAt: new Date().toISOString(), lastSubscriberDerivedGeneration: 0 } } });
    const dispatched = await restarted.runSubscriberDirectoryMaintenance({ db, maxSignals: 1, concurrency: 1 });
    assert.equal(dispatched.derivedPlanningSignals, 1);
    await runRecurringCreatorWork({ db, pageSize: 1, maxRuntimeMs: 1000 });
    const refreshes = await db.jobInstance.findMany({ where: { creatorId: "unknown500", jobKey: "fan_data_point_refresh" } });
    assert.equal(refreshes.length, 3);
    assert.deepEqual(new Set(refreshes.map(row => row.params.consumer)), new Set(["follow_back", "follow_automation", "bumps"]));
    for (const refresh of refreshes) {
      assert.equal(refresh.status, "SCHEDULED"); assert.equal(refresh.params.fanIds.length, 500);
      assert.equal(refresh.params.subscriberRunId, unknown.runId);
      assert.equal(refresh.params.subscriberPublicationGeneration, 77);
      assert.equal(refresh.params.causalBarrierKey, `subscriber-derived:${unknown.runId}:77`);
    }
    assert.equal(await db.automationDelivery.count({ where: { creatorId: "unknown500" } }), 0);
    record("500 unknown facts create three generation-scoped refresh debts", { jobs: 3, fansPerJob: 500 });
    await db.subscriberDirectoryMaintenanceSignal.deleteMany({});

    const migration = fs.readFileSync(root + "/prisma/migrations/20261020000000_recovery_liveness/migration.sql", "utf8");
    const adoption = migration.match(/WITH active_publishers AS \([\s\S]*?ON CONFLICT \("creatorId","kind"\) DO NOTHING;/)[0];
    for (const [name, overrides, state] of [
      ["upstream-projecting", { fanProjectionStatus: "PROJECTING" }, {}],
      ["null-terminal", { hasMore: null }, {}],
      ["split-terminal", { publicationStatus: "COMPLETE" }, {}],
      ["stale-generation", {}, { publicationGeneration: 2 }],
    ]) {
      const scoped = await seed(name, overrides, state);
      if (name === "stale-generation") await db.subscriberScanRun.create({ data: { id: "newer-failed", agencyId: tenant.agencyId, creatorId: name, status: "FAILED", publicationGeneration: 2 } });
      await db.$executeRawUnsafe(adoption);
      assert.ok(await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { creatorId_kind: { creatorId: name, kind: "RECOVERY" } } }));
      const result = await maintenance.runSubscriberDirectoryMaintenance({ db, maxSignals: 1, concurrency: 1, maxRuntimeMs: 750 });
      assert.equal(result.errors, 0);
      const failed = await db.jobInstance.findUnique({ where: { id: name + "-job" } });
      assert.equal(failed.status, "FAILED"); assert.match(failed.lastError, /^SUBSCRIBER_PUBLICATION_/);
      const abandoned = await db.subscriberScanRun.findUnique({ where: { id: name + "-run" } });
      assert.equal(abandoned.publicationStatus, "RECOLLECTING");
      const replacement = await db.subscriberScanRun.findFirst({ where: { creatorId: name, status: "QUEUED" } });
      assert.ok(replacement.publicationGeneration > (state.publicationGeneration || 1));
      assert.equal((await db.jobInstance.findUnique({ where: { id: replacement.jobId } })).status, "SCHEDULED");
      assert.equal((await require(root + "/src/services/subscriber-publication-fence-service").getSubscriberPublicationFence(scoped)).active, true);
      const second = await sub.scheduleSubscriberScan({ ...scoped, force: true });
      assert.equal(second.created, false);
      assert.equal(await db.subscriberScanRun.count({ where: { creatorId: name, status: "QUEUED" } }), 1);
      if (name === "upstream-projecting") {
        const replacementJob = await db.jobInstance.update({ where: { id: replacement.jobId }, data: { status: "CLAIMED" } });
        await runRootCommit(db, ({ tx }) => sub.applySubscriberScanChunk({ db: tx, job: replacementJob,
          chunkResult: { kind: "subscriber_directory_page", scanRunId: replacement.id, offset: 0, items: [], hasMore: false,
            observationToken: "replacement-page", pagination: { contract: "of_subscribers_offset_v2", limit: 20 } },
          consumeObservationToken: async () => ({ observedAt: new Date() }) }), { profile: "JOB_CHUNK" });
        await db.jobInstance.update({ where: { id: replacement.jobId }, data: { status: "PUBLISHING" } });
        for (let attempt = 0; attempt < 4 && await sub.hasSubscriberPublicationDebt(scoped); attempt++) {
          await sub.recoverSubscriberPublicationDebt({ ...scoped, maxRuns: 4, maxStepsPerRun: 4, maxRuntimeMs: 30000 });
        }
        const current = await db.subscriberDirectoryState.findUnique({ where: { creatorId: name } });
        assert.equal(current.currentRunId, replacement.id); assert.equal(current.publishedGeneration, 2);
        assert.equal((await db.subscriberScanRun.findUnique({ where: { id: name + "-run" } })).status, "SUPERSEDED");
        assert.equal((await require(root + "/src/services/subscriber-publication-fence-service").getSubscriberPublicationFence(scoped)).active, false);
        assert.equal(await sub.hasSubscriberPublicationDebt(scoped), false);
        record("fresh collection closes invalid predecessor fence after source publication");
      }
      await db.subscriberDirectoryMaintenanceSignal.deleteMany({ where: { creatorId: name } });
      record("unsupported publisher recollects once with fence: " + name, { cause: failed.lastError, generation: replacement.publicationGeneration });
    }
    const active = await seed("active-owner", { fanProjectionStatus: "PROJECTING" });
    await db.jobInstance.update({ where: { id: "active-owner-job" }, data: { status: "CLAIMED", leaseUntil: new Date(Date.now() + 120000) } });
    const protectedOwner = await sub.scheduleSubscriberScan({ ...active, force: true });
    assert.equal(protectedOwner.created, false); assert.equal(protectedOwner.reason, "already_in_flight");
    assert.equal((await db.jobInstance.findUnique({ where: { id: "active-owner-job" } })).status, "CLAIMED");
    record("live collector owner is not replaced");
    const staleScope = await seed("stale-owner", { hasMore: null });
    await signals.signalSubscriberDirectoryMaintenance({ ...staleScope, kind: "RECOVERY" });
    const staleOwner = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    await signals.signalSubscriberDirectoryMaintenance({ ...staleScope, kind: "RECOVERY" });
    await assert.rejects(sub.recoverSubscriberPublicationDebt({ ...staleScope, maintenanceSignal: staleOwner }), { code: "SUBSCRIBER_MAINTENANCE_CLAIM_STALE" });
    assert.equal((await db.jobInstance.findUnique({ where: { id: "stale-owner-job" } })).status, "PUBLISHING");
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: "stale-owner" } }), 1);
    await db.subscriberDirectoryMaintenanceSignal.deleteMany({ where: { creatorId: "stale-owner" } });
    record("stale maintenance owner cannot recollect or mutate the old job");
    const oldScope = await seed("old-terminal", { status: "PUBLISHED", publicationStatus: "COMPLETE" },
      { currentRunId: "old-terminal-run", publishedAt: observedAt, publishedGeneration: 1, publicationGeneration: 2, status: "READY" });
    await db.subscriberScanRun.create({ data: { id: "new-current", agencyId: tenant.agencyId, creatorId: oldScope.creatorId,
      status: "RUNNING", hasMore: false, fanProjectionStatus: "COMPLETE", publicationStatus: "CURRENT", publicationGeneration: 2 } });
    await db.automationControlState.create({ data: { agencyId: tenant.agencyId, creatorId: oldScope.creatorId,
      scopeKey: "creator:" + oldScope.creatorId + ":module:follow_back", moduleKey: "follow_back", enabled: true,
      settings: { enabled: true, automatic: true } } });
    const newFirst = await sub.recoverSubscriberPublicationDebt({ ...oldScope, maxRuns: 1, maxStepsPerRun: 1 });
    assert.equal(newFirst.advancedSteps, 1);
    assert.equal((await db.subscriberScanRun.findUnique({ where: { id: "new-current" } })).publicationStatus, "PREVIOUS");
    assert.equal((await db.jobInstance.findUnique({ where: { id: "old-terminal-job" } })).status, "PUBLISHING");
    record("new CURRENT advances before old terminal planning debt");
    await db.subscriberDirectoryMaintenanceSignal.deleteMany({});
    const quarantined = await seed("known-poison", {}, { publicationGeneration: 2 });
    await db.subscriberScanRun.create({ data: { id: "known-poison-newer-failed", agencyId: tenant.agencyId,
      creatorId: "known-poison", status: "FAILED", publicationGeneration: 2 } });
    await signals.signalSubscriberDirectoryMaintenance({ ...quarantined, kind: "RECOVERY" });
    const diagnostic = "Subscriber publication generation 1 is stale behind allocated generation 2";
    await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: "known-poison" }, data: {
      attempts: 100, lastError: diagnostic, claimToken: "live-old-owner", claimUntil: new Date(Date.now() + 120000) } });
    assert.equal(await signals.claimSubscriberDirectoryMaintenanceSignal({ db }), null);
    await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: "known-poison" }, data: {
      claimToken: null, claimUntil: null, lastError: "genuine domain contract failure" } });
    assert.equal(await signals.claimSubscriberDirectoryMaintenanceSignal({ db }), null);
    assert.equal((await db.subscriberDirectoryMaintenanceSignal.findFirst({ where: { creatorId: "known-poison" } })).attempts, 100);
    await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: "known-poison" }, data: { lastError: diagnostic } });
    const adopted = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    assert.equal(adopted.creatorId, "known-poison"); assert.equal(adopted.attempts, 0);
    const repairedPoison = await sub.recoverSubscriberPublicationDebt({ ...quarantined, maintenanceSignal: adopted });
    assert.equal(repairedPoison.recollectedRuns, 1);
    const poisonReplacement = await db.subscriberScanRun.findFirst({ where: { creatorId: "known-poison", status: "QUEUED" } });
    assert.equal(poisonReplacement.publicationGeneration, 3);
    await db.subscriberDirectoryMaintenanceSignal.deleteMany({});
    record("exact structural poison resumes; unknown poison and live owner remain untouched");
    const alreadyPublished = await seed("published-poison", {}, { publicationGeneration: 2,
      publishedGeneration: 2, currentRunId: "published-poison-current", publishedAt: observedAt, status: "READY" });
    await db.subscriberScanRun.create({ data: { id: "published-poison-current", agencyId: tenant.agencyId,
      creatorId: "published-poison", status: "PUBLISHED", publicationStatus: "COMPLETE", publicationGeneration: 2,
      hasMore: false, fanProjectionStatus: "COMPLETE", publishedAt: observedAt, publicationJobReconciledAt: observedAt } });
    await signals.signalSubscriberDirectoryMaintenance({ ...alreadyPublished, kind: "RECOVERY" });
    await db.subscriberDirectoryMaintenanceSignal.updateMany({ where: { creatorId: "published-poison", kind: "RECOVERY" },
      data: { attempts: 100, lastError: diagnostic } });
    const publishedOwner = await signals.claimSubscriberDirectoryMaintenanceSignal({ db });
    assert.equal(publishedOwner?.creatorId, "published-poison"); assert.equal(publishedOwner.attempts, 0);
    const reconciledOld = await sub.recoverSubscriberPublicationDebt({ ...alreadyPublished, maintenanceSignal: publishedOwner });
    assert.equal(reconciledOld.reconciledJobs, 1); assert.equal(reconciledOld.derivedPlanningWakes, 0);
    assert.equal((await db.jobInstance.findUnique({ where: { id: "published-poison-job" } })).status, "DONE");
    assert.equal((await db.subscriberScanRun.findUnique({ where: { id: "published-poison-run" } })).status, "SUPERSEDED");
    const preservedCurrent = await db.subscriberDirectoryState.findUnique({ where: { creatorId: "published-poison" } });
    assert.equal(preservedCurrent.currentRunId, "published-poison-current"); assert.equal(preservedCurrent.publishedGeneration, 2);
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: "published-poison" } }), 2, "newer published proof requires no replacement collection");
    assert.equal(await db.subscriberDirectoryMaintenanceSignal.count({ where: { creatorId: "published-poison", kind: "DERIVED_PLANNING" } }), 0);
    await db.subscriberDirectoryMaintenanceSignal.deleteMany({});
    record("newer published proof reconciles old exact poison without recollection or obsolete side effects");
    // Index eligibility on the actual hot claim SQL: the quarantined branch
    // must use its exact partial index, not enumerate unrelated dead letters.
    const claimSource = fs.readFileSync(root + "/src/services/subscriber-directory-maintenance-signal-service.js", "utf8");
    const claimSql = claimSource.match(/const rows = await tx\.\$queryRawUnsafe\(`([\s\S]*?WITH normal_candidate[\s\S]*?)`, authorityNow, claimToken, claimUntil/)[1]
      .replace(/\$\{SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS\}/g, "100");
    const plan = await runRootCommit(db, async ({ tx }) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe("EXPLAIN (FORMAT JSON) " + claimSql, new Date(), "explain-owner", new Date(Date.now() + 120000));
    });
    assert.match(JSON.stringify(plan), /SubscriberDirectoryMaintenanceSignal_structural_retry_idx/);
    record("structural quarantine branch has an exact partial-index plan");
    async function failedReplacement(name, failure, missingRun = false) {
      const scoped = await seed(name, { hasMore: null });
      if (missingRun) await db.subscriberScanRun.delete({ where: { id: name + "-run" } });
      const first = await sub.recoverSubscriberPublicationDebt(scoped);
      assert.equal(first.recollectedRuns, 1);
      const replacement = await db.subscriberScanRun.findFirst({ where: { creatorId: name, status: "QUEUED" } });
      const failed = await db.jobInstance.update({ where: { id: replacement.jobId }, data: { status: "FAILED", attempts: 3,
        completedAt: new Date(), lastError: failure.message, result: { failure } } });
      await sub.recordSubscriberScanFailure({ db, job: failed, error: failure.message, terminal: true });
      return { scoped, replacement, failed };
    }
    const transientFailure = { method: "GET", status: 503, code: "OF_REQUEST_FAILED", retryable: true, message: "503 service unavailable" };
    const transient = await failedReplacement("replacement-transient", transientFailure);
    const backoff = await sub.recoverSubscriberPublicationDebt(transient.scoped);
    assert.equal(backoff.reason, "recollection_retry_backoff"); assert.ok(backoff.retryAt > new Date());
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: "replacement-transient" } }), 2);
    await db.jobInstance.update({ where: { id: transient.failed.id }, data: { completedAt: new Date(Date.now() - 15 * 60000) } });
    const retried = await sub.recoverSubscriberPublicationDebt(transient.scoped);
    assert.equal(retried.recollectedRuns, 1);
    const retryRun = await db.subscriberScanRun.findFirst({ where: { creatorId: "replacement-transient", status: "QUEUED" } });
    assert.equal(retryRun.publicationGeneration, 3);
    assert.equal((await require(root + "/src/services/subscriber-publication-fence-service").getSubscriberPublicationFence(transient.scoped)).active, true);
    await db.subscriberDirectoryMaintenanceSignal.deleteMany({});
    record("failed replacement retries only known read failure after bounded backoff");
    const unknownFailure = { method: "GET", status: 200, code: "SUBSCRIBER_CONTRACT_MISMATCH", retryable: true, message: "subscriber contract mismatch" };
    const blocked = await failedReplacement("replacement-blocked", unknownFailure);
    await assert.rejects(sub.recoverSubscriberPublicationDebt(blocked.scoped), { code: "SUBSCRIBER_RECOLLECTION_BLOCKED" });
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: "replacement-blocked" } }), 2);
    const priorSignal = await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { creatorId_kind: { creatorId: "replacement-blocked", kind: "RECOVERY" } } });
    await db.subscriberDirectoryMaintenanceSignal.update({ where: { id: priorSignal.id }, data: { attempts: 100, lastError: "subscriber contract mismatch" } });
    const restartedByUser = await sub.scheduleSubscriberScan({ ...blocked.scoped, manual: true, force: false });
    assert.equal(restartedByUser.created, true); assert.equal(restartedByUser.run.publicationGeneration, 3);
    const newSignal = await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { creatorId_kind: { creatorId: "replacement-blocked", kind: "RECOVERY" } } });
    assert.equal(newSignal.attempts, 0); assert.ok(newSignal.revision > priorSignal.revision);
    const nextFailed = await db.jobInstance.update({ where: { id: restartedByUser.job.id }, data: { status: "FAILED", attempts: 3,
      completedAt: new Date(Date.now() - 15 * 60000), lastError: transientFailure.message, result: { failure: transientFailure } } });
    await sub.recordSubscriberScanFailure({ db, job: nextFailed, error: transientFailure.message });
    const retryAfterManual = await sub.recoverSubscriberPublicationDebt(blocked.scoped);
    assert.equal(retryAfterManual.recollectedRuns, 1);
    assert.equal((await db.subscriberScanRun.findFirst({ where: { creatorId: "replacement-blocked", status: "QUEUED" } })).publicationGeneration, 4);
    await db.subscriberDirectoryMaintenanceSignal.deleteMany({});
    record("unknown replacement failure is visible; ordinary manual START renews durable retry ownership");
    const auth = await failedReplacement("replacement-auth", { method: "GET", status: 401, code: "OF_REQUEST_FAILED", retryable: false, message: "401 sign in required" });
    await db.jobInstance.update({ where: { id: auth.failed.id }, data: { completedAt: new Date(Date.now() - 15 * 60000) } });
    const authWait = await sub.recoverSubscriberPublicationDebt(auth.scoped);
    assert.equal(authWait.reason, "provider_auth_required");
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: "replacement-auth" } }), 2);
    record("authentication interruption waits for fresh session readiness");
    const missing = await failedReplacement("missing-source-run", transientFailure, true);
    const guard = await db.subscriberScanRun.findUnique({ where: { id: "missing-source-run-run" } });
    assert.equal(guard.publicationStatus, "RECOLLECTING"); assert.equal(guard.fanProjectionStatus, "PENDING");
    assert.equal(guard.hasMore, null); assert.equal(guard.summary.missingSourceRun, true);
    await db.jobInstance.update({ where: { id: missing.failed.id }, data: { completedAt: new Date(Date.now() - 15 * 60000) } });
    const missingRetried = await sub.recoverSubscriberPublicationDebt(missing.scoped);
    assert.equal(missingRetried.recollectedRuns, 1);
    assert.equal((await db.subscriberScanRun.findFirst({ where: { creatorId: "missing-source-run", status: "QUEUED" } })).publicationGeneration, 3);
    record("missing source run has explicit unproved predecessor debt and retryable replacement");
    const retiredJob = await db.jobInstance.findUnique({ where: { id: transient.failed.id } });
    await assert.rejects(runRootCommit(db, ({ tx }) => sub.applySubscriberScanChunk({ db: tx, job: retiredJob,
      chunkResult: { kind: "subscriber_directory_page", scanRunId: transient.replacement.id, offset: 0, items: [], hasMore: false } }),
      { profile: "JOB_CHUNK" }), { code: "SUBSCRIBER_SCAN_RECOLLECTED" });
    assert.equal(await db.subscriberScanItem.count({ where: { runId: transient.replacement.id } }), 0);
    record("retired collection cannot ingest an old-generation page after retry");
    const foreignScope = await scope(db, { agencyId: "foreign-agency", creatorId: "foreign-creator", userId: "foreign-user" });
    const currentReplacement = await db.subscriberScanRun.findFirst({ where: { creatorId: "replacement-blocked", status: "QUEUED" } });
    const foreignJob = await db.jobInstance.create({ data: { id: "foreign-claimed", agencyId: foreignScope.agencyId, creatorId: foreignScope.creatorId,
      jobKey: "subscriber_directory_scan", scope: "creator", status: "CLAIMED", leaseUntil: new Date(Date.now() + 120000),
      params: { scanRunId: currentReplacement.id } } });
    await db.subscriberScanRun.update({ where: { id: currentReplacement.id }, data: { jobId: foreignJob.id } });
    await assert.rejects(sub.recoverSubscriberPublicationDebt(blocked.scoped), { code: "SUBSCRIBER_PUBLICATION_JOB_SCOPE_MISMATCH" });
    assert.equal((await db.jobInstance.findUnique({ where: { id: foreignJob.id } })).status, "CLAIMED");
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: "replacement-blocked" } }), 4);
    record("foreign live job is rejected before it can acquire same-creator waiting authority");

    console.log(JSON.stringify({ ok: true, cases: report.length }));
  } finally { await fixture.close(); clearInterval(keep); }
})().catch(error => { console.error(error); process.exitCode = 1; clearInterval(keep); });
