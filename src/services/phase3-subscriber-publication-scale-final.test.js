"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function cacheModule(relative, exportsValue) {
  const resolved = require.resolve(relative, { paths: [__dirname] });
  const previous = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
  return () => {
    delete require.cache[resolved];
    if (previous) require.cache[resolved] = previous;
  };
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}

function applyData(target, data) {
  for (const [key, value] of Object.entries(data || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "increment")) {
      target[key] = Number(target[key] || 0) + Number(value.increment || 0);
    } else {
      target[key] = clone(value);
    }
  }
  return target;
}

function matchesFanFilter(item, filter) {
  if (!filter) return true;
  if (Array.isArray(filter.in)) return filter.in.includes(item.fanId);
  return true;
}

function buildFixture({ failTransactionAttempt = null } = {}) {
  const overlap = 1000;
  const current = [];
  const previous = [];
  for (let i = 0; i < overlap; i += 1) {
    const fanId = `fan-${String(i).padStart(4, "0")}`;
    const changed = i % 10 === 0;
    previous.push({ id: `prev-${String(i).padStart(4, "0")}`, runId: "run-prev", fanId, contentHash: `hash-${i}`, lastSeenIsNull: false });
    current.push({ id: `cur-${String(i).padStart(4, "0")}`, runId: "run-current", fanId, contentHash: changed ? `hash-${i}-changed` : `hash-${i}`, lastSeenIsNull: i % 3 === 0 });
  }
  for (let i = 0; i < 200; i += 1) {
    current.push({ id: `cur-new-${String(i).padStart(4, "0")}`, runId: "run-current", fanId: `fan-new-${String(i).padStart(4, "0")}`, contentHash: `new-${i}`, lastSeenIsNull: i % 2 === 0 });
  }
  for (let i = 0; i < 100; i += 1) {
    previous.push({ id: `prev-old-${String(i).padStart(4, "0")}`, runId: "run-prev", fanId: `fan-old-${String(i).padStart(4, "0")}`, contentHash: `old-${i}`, lastSeenIsNull: true });
  }
  current.sort((a, b) => a.id.localeCompare(b.id));
  previous.sort((a, b) => a.id.localeCompare(b.id));

  const run = {
    id: "run-current", agencyId: "agency-1", creatorId: "creator-1", jobId: "job-1",
    status: "RUNNING", hasMore: false, nextOffset: 1200, scannedCount: 1200, pageCount: 12, hiddenCount: 434,
    fanProjectionStatus: "COMPLETE", fanProjectionCursorOffset: 1200, fanProjectionCount: 1200,
    publicationStatus: "PENDING", publicationGeneration: 2, publicationCursorId: null, publicationPreviousRunId: null,
    publicationAddedCount: 0, publicationChangedCount: 0, publicationDisappearedCount: 0,
    publicationStartedAt: null, publicationCompletedAt: null, publicationJobReconciledAt: null, publicationLastError: null,
    summary: null, updatedAt: new Date("2026-09-20T18:00:00.000Z"),
  };
  const previousRun = { id: "run-prev", agencyId: "agency-1", creatorId: "creator-1", status: "PUBLISHED", publicationGeneration: 1, publicationStatus: "COMPLETE" };
  const state = { creatorId: "creator-1", agencyId: "agency-1", currentRunId: "run-prev", status: "READY", scanEveryDays: 7, publicationGeneration: 2, publishedGeneration: 1 };
  const job = { id: "job-1", status: "SCHEDULED", leaseUntil: null, leaseRevision: 0, params: { scanRunId: "run-current", scanEveryDays: 7 } };
  let txAttempts = 0;
  const projectedChunkSizes = [];
  const staleChunkSizes = [];
  const lockCalls = [];
  let failAt = failTransactionAttempt;

  const model = {
    subscriberScanRun: {
      findUnique: async ({ where }) => where.id === run.id ? clone(run) : (where.id === previousRun.id ? clone(previousRun) : null),
      findFirst: async ({ where }) => {
        const incomplete = run.hasMore === false && run.fanProjectionStatus === "COMPLETE" && run.publicationStatus !== "COMPLETE";
        const reconcileDebt = ["PUBLISHED", "SUPERSEDED"].includes(run.status) && run.publicationStatus === "COMPLETE" && run.publicationJobReconciledAt == null;
        if (where?.agencyId && where.agencyId !== run.agencyId) return null;
        if (where?.creatorId && where.creatorId !== run.creatorId) return null;
        if (Array.isArray(where?.OR)) return (incomplete || reconcileDebt) ? clone(run) : null;
        if (where?.publicationJobReconciledAt === null) return reconcileDebt ? clone(run) : null;
        return incomplete ? clone(run) : null;
      },
      findMany: async () => {
        const incomplete = run.hasMore === false && run.fanProjectionStatus === "COMPLETE" && run.publicationStatus !== "COMPLETE";
        const reconcileDebt = ["PUBLISHED", "SUPERSEDED"].includes(run.status) && run.publicationStatus === "COMPLETE" && run.publicationJobReconciledAt == null;
        return incomplete || reconcileDebt ? [clone(run)] : [];
      },
      update: async ({ where, data }) => {
        const target = where.id === run.id ? run : previousRun;
        applyData(target, data);
        target.updatedAt = new Date("2026-09-20T18:00:00.000Z");
        return clone(target);
      },
      updateMany: async ({ where, data }) => {
        if (where.id === previousRun.id && previousRun.status === "PUBLISHED") {
          applyData(previousRun, data);
          return { count: 1 };
        }
        if (where.id === run.id) { applyData(run, data); return { count: 1 }; }
        return { count: 0 };
      },
    },
    subscriberDirectoryState: {
      findUnique: async () => clone(state),
      updateMany: async ({ where, data }) => {
        if (where.creatorId && where.creatorId !== state.creatorId) return { count: 0 };
        if (where.publicationGeneration !== undefined && Number(where.publicationGeneration) !== Number(state.publicationGeneration)) return { count: 0 };
        if (where.publishedGeneration?.lt !== undefined && !(Number(state.publishedGeneration) < Number(where.publishedGeneration.lt))) return { count: 0 };
        applyData(state, data);
        return { count: 1 };
      },
      upsert: async ({ create, update }) => {
        if (state.currentRunId) applyData(state, update);
        else applyData(state, create);
        return clone(state);
      },
    },
    subscriberScanItem: {
      findMany: async ({ where, orderBy, take, select }) => {
        let rows = where.runId === "run-current" ? current : previous;
        if (where.id?.gt) rows = rows.filter((item) => item.id > where.id.gt);
        if (where.fanId) rows = rows.filter((item) => matchesFanFilter(item, where.fanId));
        rows = rows.slice().sort((a, b) => a.id.localeCompare(b.id));
        if (Number.isFinite(take)) rows = rows.slice(0, take);
        return rows.map((item) => {
          if (!select) return clone(item);
          const out = {};
          for (const key of Object.keys(select)) if (select[key]) out[key] = item[key];
          return out;
        });
      },
    },
    jobInstance: {
      findUnique: async ({ where }) => where.id === job.id ? clone(job) : null,
      updateMany: async ({ where, data }) => {
        if (where.id !== job.id) return { count: 0 };
        const allowed = Array.isArray(where.OR) ? where.OR.some((branch) => {
          if (branch.status?.in) return branch.status.in.includes(job.status);
          if (branch.status === "CLAIMED") return job.status === "CLAIMED";
          return false;
        }) : true;
        if (!allowed) return { count: 0 };
        applyData(job, data);
        return { count: 1 };
      },
    },
    fanObservationReadLease: { deleteMany: async () => ({ count: 0 }) },
    followBackCandidate: { updateMany: async ({ where }) => { staleChunkSizes.push(where.fanId?.in?.length || 0); return { count: 0 }; } },
    followAutomationCandidate: { updateMany: async ({ where }) => { staleChunkSizes.push(where.fanId?.in?.length || 0); return { count: 0 }; } },
  };

  function txClient() {
    return {
      ...model,
      $queryRawUnsafe: async (sql, id) => {
        const text = String(sql);
        if (text.includes('MAX(r."publicationGeneration")')) {
          return [{ maxGeneration: run.publicationGeneration, maxPublishedGeneration: state.publishedGeneration }];
        }
        if (text.includes('FROM "SubscriberScanRun"')) return id === run.id ? [clone(run)] : [];
        return [];
      },
      $executeRawUnsafe: async (sql, ...args) => {
        if (String(sql).includes("pg_advisory_xact_lock")) lockCalls.push(args);
        return 0;
      },
    };
  }

  const db = {
    ...model,
    $transaction: async (work) => {
      txAttempts += 1;
      if (failAt && txAttempts === failAt) throw Object.assign(new Error("simulated process boundary"), { code: "SIMULATED_RESTART" });
      return work(txClient());
    },
  };

  return {
    db, run, state, previousRun, job, current, previous, projectedChunkSizes, staleChunkSizes, lockCalls,
    get txAttempts() { return txAttempts; },
    clearFailure() { failAt = null; },
  };
}

test("final Subscriber publication is bounded at 500, durable across restart, and does not double-count", async () => {
  const restores = [];
  restores.push(cacheModule("../prisma", {}));
  const projectedChunkSizes = [];
  const staleChunkSizes = [];
  restores.push(cacheModule("./follow-back-service", {
    projectFollowBackProjectionChunk: async ({ itemIds }) => { projectedChunkSizes.push(itemIds.length); return { ok: true, count: itemIds.length }; },
    staleFollowBackProjectionFans: async ({ fanIds }) => { staleChunkSizes.push(fanIds.length); return { ok: true, count: fanIds.length }; },
    ensureAutomaticFollowBack: async () => ({ ok: true, created: false }),
  }));
  restores.push(cacheModule("./follow-automation-service", {
    projectFollowAutomationProjectionChunk: async ({ itemIds }) => { projectedChunkSizes.push(itemIds.length); return { ok: true, count: itemIds.length }; },
    staleFollowAutomationProjectionFans: async ({ fanIds }) => { staleChunkSizes.push(fanIds.length); return { ok: true, count: fanIds.length }; },
    ensureAutomaticFollowAutomation: async () => ({ ok: true, created: false }),
  }));
  restores.push(cacheModule("./bump-service", { ensureAutomaticBumps: async () => ({ ok: true, created: false, sources: [] }) }));
  restores.push(cacheModule("./fan-data-authority-service", { projectSubscriberDirectoryItems: async () => ({ projected: 0 }), readFanCurrent: async () => null }));
  restores.push(cacheModule("./job-planning-repository", { createPlannedJob: async () => null, publishPlannedJobAvailable: async () => null }));
  restores.push(cacheModule("./fan-observation-token-service", { consumeFanObservationToken: async () => null }));
  restores.push(cacheModule("./db-time-authority-service", { dbAuthorityNow: async () => new Date("2026-09-20T18:00:00.000Z") }));
  restores.push(cacheModule("./automation-write-commit-fence-service", {
    lockAutomationWriteCommitFence: async ({ db, agencyId }) => db.$executeRawUnsafe("SELECT pg_advisory_xact_lock($1)", agencyId),
  }));
  const servicePath = require.resolve("./subscriber-directory-service", { paths: [__dirname] });
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    const fx = buildFixture({ failTransactionAttempt: 3 });
    await assert.rejects(
      () => service._test.publishRun(fx.db, fx.run, { jobId: "job-1", scanEveryDays: 7 }),
      (error) => error?.code === "SIMULATED_RESTART",
    );
    assert.equal(fx.run.publicationStatus, "CURRENT");
    assert.ok(fx.run.publicationCursorId, "first 500-row CURRENT chunk must commit a durable cursor before restart");
    const addedAfterFirstChunk = fx.run.publicationAddedCount;
    const changedAfterFirstChunk = fx.run.publicationChangedCount;
    assert.ok(addedAfterFirstChunk >= 0);
    assert.ok(changedAfterFirstChunk >= 0);

    fx.clearFailure();
    const publication = await service._test.publishRun(fx.db, fx.run, { jobId: "job-1", scanEveryDays: 7 });
    assert.equal(publication.complete, true);
    const summary = publication.summary;
    assert.equal(fx.run.status, "PUBLISHED");
    assert.equal(fx.run.publicationStatus, "COMPLETE");
    assert.equal(summary.totalCount, 1200);
    assert.equal(summary.addedCount, 200);
    assert.equal(summary.changedCount, 100);
    assert.equal(summary.disappearedCount, 100);
    assert.equal(fx.state.currentRunId, "run-current");
    assert.equal(fx.previousRun.status, "SUPERSEDED");
    assert.ok(projectedChunkSizes.length >= 6, "both projection families must run across multiple bounded chunks");
    assert.ok(projectedChunkSizes.every((size) => size > 0 && size <= 500));
    assert.ok(staleChunkSizes.every((size) => size >= 0 && size <= 500));
    assert.ok(fx.lockCalls.length >= 1, "every durable transaction must cross the automation write commit fence");
    assert.ok(fx.txAttempts >= 8, "large publication must be split across multiple transactions, never one completion transaction");
  } finally {
    delete require.cache[servicePath];
    for (const restore of restores.reverse()) restore();
  }
});


test("durable Subscriber publication recovery lane resumes a crashed run and reconciles an unowned scheduled job", async () => {
  const restores = [];
  restores.push(cacheModule("../prisma", {}));
  restores.push(cacheModule("./follow-back-service", {
    projectFollowBackProjectionChunk: async () => ({ ok: true }), staleFollowBackProjectionFans: async () => ({ ok: true }), ensureAutomaticFollowBack: async () => ({ ok: true, created: false }),
  }));
  restores.push(cacheModule("./follow-automation-service", {
    projectFollowAutomationProjectionChunk: async () => ({ ok: true }), staleFollowAutomationProjectionFans: async () => ({ ok: true }), ensureAutomaticFollowAutomation: async () => ({ ok: true, created: false }),
  }));
  restores.push(cacheModule("./bump-service", { ensureAutomaticBumps: async () => ({ ok: true, created: false, sources: [] }) }));
  restores.push(cacheModule("./fan-data-authority-service", { projectSubscriberDirectoryItems: async () => ({ projected: 0 }), readFanCurrent: async () => null }));
  restores.push(cacheModule("./job-planning-repository", { createPlannedJob: async () => null, publishPlannedJobAvailable: async () => null }));
  restores.push(cacheModule("./fan-observation-token-service", { consumeFanObservationToken: async () => null }));
  restores.push(cacheModule("./db-time-authority-service", { dbAuthorityNow: async () => new Date("2026-09-20T18:00:00.000Z") }));
  restores.push(cacheModule("./automation-write-commit-fence-service", { lockAutomationWriteCommitFence: async () => null }));
  const servicePath = require.resolve("./subscriber-directory-service", { paths: [__dirname] });
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    const fx = buildFixture({ failTransactionAttempt: 3 });
    await assert.rejects(
      () => service._test.publishRun(fx.db, fx.run, { jobId: "job-1", scanEveryDays: 7 }),
      (error) => error?.code === "SIMULATED_RESTART",
    );
    assert.equal(fx.run.publicationStatus, "CURRENT");
    assert.equal(fx.job.status, "SCHEDULED");
    fx.clearFailure();
    let result = null;
    for (let i = 0; i < 8 && fx.run.status !== "PUBLISHED"; i += 1) {
      result = await service.recoverSubscriberPublicationDebt({ db: fx.db, agencyId: fx.run.agencyId, creatorId: fx.run.creatorId, maxRuns: 1, maxStepsPerRun: 2, maxRuntimeMs: 30_000 });
    }
    assert.equal(fx.run.status, "PUBLISHED");
    assert.equal(fx.run.publicationStatus, "COMPLETE");
    assert.equal(fx.job.status, "DONE");
    assert.equal(fx.job.result?.recoveredPublication, true);
    assert.ok(Number(result?.recoveredRuns || 0) >= 1);
  } finally {
    delete require.cache[servicePath];
    for (const restore of restores.reverse()) restore();
  }
});


test("PUBLISHED Subscriber snapshot survives crash-before-job-DONE and recovery converges planning + job ledger exactly once", async () => {
  const restores = [];
  let followBackPlans = 0;
  let followAutomationPlans = 0;
  let bumpPlans = 0;
  restores.push(cacheModule("../prisma", {}));
  restores.push(cacheModule("./follow-back-service", {
    projectFollowBackProjectionChunk: async () => ({ ok: true }), staleFollowBackProjectionFans: async () => ({ ok: true }),
    ensureAutomaticFollowBack: async () => { followBackPlans += 1; return { ok: true, created: true }; },
  }));
  restores.push(cacheModule("./follow-automation-service", {
    projectFollowAutomationProjectionChunk: async () => ({ ok: true }), staleFollowAutomationProjectionFans: async () => ({ ok: true }),
    ensureAutomaticFollowAutomation: async () => { followAutomationPlans += 1; return { ok: true, created: true }; },
  }));
  restores.push(cacheModule("./bump-service", {
    ensureAutomaticBumps: async () => { bumpPlans += 1; return { ok: true, created: true, sources: [] }; },
  }));
  restores.push(cacheModule("./fan-data-authority-service", { projectSubscriberDirectoryItems: async () => ({ projected: 0 }), readFanCurrent: async () => null }));
  restores.push(cacheModule("./job-planning-repository", { createPlannedJob: async () => null, publishPlannedJobAvailable: async () => null }));
  restores.push(cacheModule("./fan-observation-token-service", { consumeFanObservationToken: async () => null }));
  restores.push(cacheModule("./db-time-authority-service", { dbAuthorityNow: async () => new Date("2026-09-20T18:00:00.000Z") }));
  restores.push(cacheModule("./automation-write-commit-fence-service", { lockAutomationWriteCommitFence: async () => null }));
  const servicePath = require.resolve("./subscriber-directory-service", { paths: [__dirname] });
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    const fx = buildFixture();
    await service._test.publishRun(fx.db, fx.run, { jobId: "job-1", scanEveryDays: 7 });
    assert.equal(fx.run.status, "PUBLISHED");
    assert.equal(fx.run.publicationStatus, "COMPLETE");
    assert.equal(fx.run.publicationJobReconciledAt, null, "FINALIZE must not lie that JobInstance DONE was committed");
    assert.equal(fx.job.status, "SCHEDULED", "simulates process death after FINALIZE but before generic job completion");

    const first = await service.recoverSubscriberPublicationDebt({ db: fx.db, agencyId: fx.run.agencyId, creatorId: fx.run.creatorId, maxRuns: 1, maxStepsPerRun: 1, maxRuntimeMs: 30_000 });
    assert.equal(first.reconciledJobs, 1);
    assert.equal(first.planningRuns, 1);
    assert.equal(fx.job.status, "DONE");
    assert.equal(fx.job.result?.recoveredPublication, true);
    assert.ok(fx.run.publicationJobReconciledAt instanceof Date);
    assert.equal(followBackPlans, 1);
    assert.equal(followAutomationPlans, 1);
    assert.equal(bumpPlans, 1);

    const second = await service.recoverSubscriberPublicationDebt({ db: fx.db, agencyId: fx.run.agencyId, creatorId: fx.run.creatorId, maxRuns: 1, maxStepsPerRun: 1, maxRuntimeMs: 30_000 });
    assert.equal(second.reason, "none_due", "durable reconciliation marker must remove the published run from recovery debt");
    assert.equal(second.reconciledJobs, 0);
    assert.equal(followBackPlans, 1, "planning must not replay after marker commit");
    assert.equal(followAutomationPlans, 1);
    assert.equal(bumpPlans, 1);
  } finally {
    delete require.cache[servicePath];
    for (const restore of restores.reverse()) restore();
  }
});

test("A21 terminal failed Subscriber job cannot open a second generation while durable publication debt exists", async () => {
  const restores = [];
  const debtRun = {
    id: "run-debt", agencyId: "agency-1", creatorId: "creator-1", jobId: "job-debt",
    status: "FAILED", hasMore: false, fanProjectionStatus: "COMPLETE",
    publicationStatus: "CURRENT", publicationGeneration: 7, updatedAt: new Date("2026-09-20T18:00:00.000Z"),
  };
  const failedJob = { id: "job-debt", status: "FAILED" };
  let createdRuns = 0;
  let plannedJobs = 0;
  const tx = {
    $executeRawUnsafe: async () => 0,
    subscriberScanRun: {
      findFirst: async ({ where }) => {
        if (Array.isArray(where?.OR) || where?.publicationStatus?.in) return clone(debtRun);
        return null;
      },
      create: async () => { createdRuns += 1; throw new Error("must not create a second generation"); },
    },
    subscriberDirectoryState: { findUnique: async () => ({ publicationGeneration: 7, publishedGeneration: 6 }) },
    jobInstance: { findUnique: async () => clone(failedJob) },
  };
  const prismaMock = {
    $transaction: async (work) => work(tx),
    subscriberScanRun: { findFirst: async () => clone(debtRun) },
    jobInstance: { findUnique: async () => clone(failedJob) },
  };
  restores.push(cacheModule("../prisma", prismaMock));
  restores.push(cacheModule("./follow-back-service", {
    projectFollowBackProjectionChunk: async () => ({}), staleFollowBackProjectionFans: async () => ({}), ensureAutomaticFollowBack: async () => ({}),
  }));
  restores.push(cacheModule("./follow-automation-service", {
    projectFollowAutomationProjectionChunk: async () => ({}), staleFollowAutomationProjectionFans: async () => ({}), ensureAutomaticFollowAutomation: async () => ({}),
  }));
  restores.push(cacheModule("./bump-service", { ensureAutomaticBumps: async () => ({}) }));
  restores.push(cacheModule("./fan-data-authority-service", { projectSubscriberDirectoryItems: async () => ({}), readFanCurrent: async () => null }));
  restores.push(cacheModule("./job-planning-repository", {
    createPlannedJob: async () => { plannedJobs += 1; throw new Error("must not plan a second generation"); },
    publishPlannedJobAvailable: () => { throw new Error("must not publish a second generation"); },
  }));
  restores.push(cacheModule("./fan-observation-token-service", { consumeFanObservationToken: async () => null }));
  restores.push(cacheModule("./db-time-authority-service", { dbAuthorityNow: async () => new Date("2026-09-20T18:00:00.000Z") }));
  restores.push(cacheModule("./automation-write-commit-fence-service", { lockAutomationWriteCommitFence: async () => null }));
  const servicePath = require.resolve("./subscriber-directory-service", { paths: [__dirname] });
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    const result = await service.scheduleSubscriberScan({ agencyId: "agency-1", creatorId: "creator-1", manual: true, force: true });
    assert.equal(result.created, false);
    assert.equal(result.reason, "publication_recovery_in_progress");
    assert.equal(result.run.id, "run-debt");
    assert.equal(result.run.publicationGeneration, 7);
    assert.equal(createdRuns, 0);
    assert.equal(plannedJobs, 0);
  } finally {
    delete require.cache[servicePath];
    for (const restore of restores.reverse()) restore();
  }
});

test("A21 reverse FINALIZE ordering cannot let an older Subscriber generation replace a newer published generation", async () => {
  const restores = [];
  restores.push(cacheModule("../prisma", {}));
  restores.push(cacheModule("./follow-back-service", {
    projectFollowBackProjectionChunk: async () => ({}), staleFollowBackProjectionFans: async () => ({}), ensureAutomaticFollowBack: async () => ({}),
  }));
  restores.push(cacheModule("./follow-automation-service", {
    projectFollowAutomationProjectionChunk: async () => ({}), staleFollowAutomationProjectionFans: async () => ({}), ensureAutomaticFollowAutomation: async () => ({}),
  }));
  restores.push(cacheModule("./bump-service", { ensureAutomaticBumps: async () => ({}) }));
  restores.push(cacheModule("./fan-data-authority-service", { projectSubscriberDirectoryItems: async () => ({}), readFanCurrent: async () => null }));
  restores.push(cacheModule("./job-planning-repository", { createPlannedJob: async () => null, publishPlannedJobAvailable: async () => null }));
  restores.push(cacheModule("./fan-observation-token-service", { consumeFanObservationToken: async () => null }));
  restores.push(cacheModule("./db-time-authority-service", { dbAuthorityNow: async () => new Date("2026-09-20T18:00:00.000Z") }));
  restores.push(cacheModule("./automation-write-commit-fence-service", { lockAutomationWriteCommitFence: async () => null }));
  const servicePath = require.resolve("./subscriber-directory-service", { paths: [__dirname] });
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    const runs = new Map([
      ["run-old", {
        id: "run-old", agencyId: "agency-1", creatorId: "creator-1", status: "FAILED", hasMore: false,
        scannedCount: 0, hiddenCount: 0, fanProjectionStatus: "COMPLETE", fanProjectionCursorOffset: 0, fanProjectionCount: 0,
        publicationStatus: "FINALIZE", publicationGeneration: 1, publicationPreviousRunId: null,
        publicationAddedCount: 0, publicationChangedCount: 0, publicationDisappearedCount: 0, summary: {},
      }],
      ["run-new", {
        id: "run-new", agencyId: "agency-1", creatorId: "creator-1", status: "RUNNING", hasMore: false,
        scannedCount: 0, hiddenCount: 0, fanProjectionStatus: "COMPLETE", fanProjectionCursorOffset: 0, fanProjectionCount: 0,
        publicationStatus: "FINALIZE", publicationGeneration: 2, publicationPreviousRunId: null,
        publicationAddedCount: 0, publicationChangedCount: 0, publicationDisappearedCount: 0, summary: {},
      }],
    ]);
    const state = { creatorId: "creator-1", currentRunId: null, publicationGeneration: 2, publishedGeneration: 0 };
    const db = {
      subscriberScanRun: {
        findUnique: async ({ where }) => clone(runs.get(where.id) || null),
        update: async ({ where, data }) => { const row = runs.get(where.id); applyData(row, data); return clone(row); },
        updateMany: async ({ where, data }) => {
          const row = runs.get(where.id);
          if (!row) return { count: 0 };
          if (where.publicationGeneration !== undefined && Number(row.publicationGeneration) !== Number(where.publicationGeneration)) return { count: 0 };
          if (where.publicationStatus && row.publicationStatus !== where.publicationStatus) return { count: 0 };
          if (where.status && typeof where.status === "string" && row.status !== where.status) return { count: 0 };
          if (where.publicationGeneration?.lt !== undefined && !(Number(row.publicationGeneration) < Number(where.publicationGeneration.lt))) return { count: 0 };
          applyData(row, data); return { count: 1 };
        },
      },
      subscriberDirectoryState: {
        findUnique: async () => clone(state),
        updateMany: async ({ where, data }) => {
          if (Number(where.publicationGeneration) !== Number(state.publicationGeneration)) return { count: 0 };
          if (!(Number(state.publishedGeneration) < Number(where.publishedGeneration.lt))) return { count: 0 };
          applyData(state, data); return { count: 1 };
        },
      },
    };
    const newer = await service._test.advanceSubscriberPublication(db, { runId: "run-new", jobId: "job-new", scanEveryDays: 7 });
    assert.equal(newer.complete, true);
    assert.equal(state.currentRunId, "run-new");
    assert.equal(state.publishedGeneration, 2);
    assert.equal(runs.get("run-new").status, "PUBLISHED");

    const older = await service._test.advanceSubscriberPublication(db, { runId: "run-old", jobId: "job-old", scanEveryDays: 7 });
    assert.equal(older.complete, true);
    assert.equal(runs.get("run-old").status, "SUPERSEDED");
    assert.equal(runs.get("run-old").publicationStatus, "COMPLETE");
    assert.equal(state.currentRunId, "run-new");
    assert.equal(state.publishedGeneration, 2);
  } finally {
    delete require.cache[servicePath];
    for (const restore of restores.reverse()) restore();
  }
});

test("A21 Subscriber publication resumes cleanly after a process boundary at every durable phase transaction", async () => {
  const restores = [];
  restores.push(cacheModule("../prisma", {}));
  restores.push(cacheModule("./follow-back-service", {
    projectFollowBackProjectionChunk: async () => ({ ok: true }), staleFollowBackProjectionFans: async () => ({ ok: true }), ensureAutomaticFollowBack: async () => ({ ok: true, created: false }),
  }));
  restores.push(cacheModule("./follow-automation-service", {
    projectFollowAutomationProjectionChunk: async () => ({ ok: true }), staleFollowAutomationProjectionFans: async () => ({ ok: true }), ensureAutomaticFollowAutomation: async () => ({ ok: true, created: false }),
  }));
  restores.push(cacheModule("./bump-service", { ensureAutomaticBumps: async () => ({ ok: true, created: false, sources: [] }) }));
  restores.push(cacheModule("./fan-data-authority-service", { projectSubscriberDirectoryItems: async () => ({ projected: 0 }), readFanCurrent: async () => null }));
  restores.push(cacheModule("./job-planning-repository", { createPlannedJob: async () => null, publishPlannedJobAvailable: async () => null }));
  restores.push(cacheModule("./fan-observation-token-service", { consumeFanObservationToken: async () => null }));
  restores.push(cacheModule("./db-time-authority-service", { dbAuthorityNow: async () => new Date("2026-09-20T18:00:00.000Z") }));
  restores.push(cacheModule("./automation-write-commit-fence-service", { lockAutomationWriteCommitFence: async () => null }));
  const servicePath = require.resolve("./subscriber-directory-service", { paths: [__dirname] });
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    for (const failAt of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const fx = buildFixture({ failTransactionAttempt: failAt });
      await assert.rejects(
        () => service._test.publishRun(fx.db, fx.run, { jobId: "job-1", scanEveryDays: 7 }),
        (error) => error?.code === "SIMULATED_RESTART",
        `expected process boundary at publication transaction ${failAt}`,
      );
      fx.clearFailure();
      const publication = await service._test.publishRun(fx.db, fx.run, { jobId: "job-1", scanEveryDays: 7 });
      assert.equal(publication.complete, true, `failAt=${failAt}`);
      const summary = publication.summary;
      assert.equal(fx.run.status, "PUBLISHED", `failAt=${failAt}`);
      assert.equal(fx.run.publicationStatus, "COMPLETE", `failAt=${failAt}`);
      assert.equal(fx.state.currentRunId, "run-current", `failAt=${failAt}`);
      assert.equal(fx.state.publishedGeneration, 2, `failAt=${failAt}`);
      assert.equal(summary.addedCount, 200, `failAt=${failAt}`);
      assert.equal(summary.changedCount, 100, `failAt=${failAt}`);
      assert.equal(summary.disappearedCount, 100, `failAt=${failAt}`);
    }
  } finally {
    delete require.cache[servicePath];
    for (const restore of restores.reverse()) restore();
  }
});
