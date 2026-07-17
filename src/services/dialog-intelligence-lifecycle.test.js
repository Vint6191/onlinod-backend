"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
const { scheduleDialogScanTx, autoRecoverDialogDiscoveryTx, repairRegressedDialogDiscoveryTx } = require("./dialog-intelligence-service");

function fakeDb(options = {}) {
  const calls = { runsCreated: [], runsUpdated: [], jobsCreated: [], jobsUpdated: [], statesUpserted: [], statesUpdated: [], targetsUpserted: [] };
  let runCounter = 0;
  let jobCounter = 0;
  const active = options.active || null;
  const failed = options.failed || null;
  const activeJob = options.activeJob || null;
  const failedJob = options.failedJob || null;
  const state = options.state || null;
  const latest = options.latest || active || failed || null;
  return {
    calls,
    creatorAccount: { findFirst: async () => ({ id: "creator-1", agencyId: "agency-1", remoteId: "of-1", status: "READY" }) },
    moduleSetting: { findUnique: async () => ({ enabled: true, status: "active", config: {} }) },
    dialogReconciliationTarget: {
      upsert: async ({ where, create, update }) => {
        const key = where.creatorId_dialogId_messageId;
        const existing = calls.targetsUpserted.find((item) => item.creatorId === key.creatorId && item.dialogId === key.dialogId && item.messageId === key.messageId);
        if (existing) Object.assign(existing, update);
        else calls.targetsUpserted.push({ id: `target-${calls.targetsUpserted.length + 1}`, ...create });
        return existing || calls.targetsUpserted.at(-1);
      },
    },
    dialogScanState: {
      findUnique: async () => state,
      count: async () => Number(options.stateCount || 0),
      upsert: async (value) => { calls.statesUpserted.push(value); return value; },
      updateMany: async (value) => { calls.statesUpdated.push(value); return { count: 1 }; },
    },
    dialogScanChunkCommit: {
      findMany: async () => options.commits || [],
    },
    dialogScanRun: {
      findFirst: async ({ where } = {}) => where?.status === "FAILED" ? failed : (where?.dialogId === "__dialog_discovery__" ? latest : active),
      create: async ({ data }) => {
        const row = { id: `run-${++runCounter}`, jobId: null, pagesProcessed: 0, continuation: {}, ...data };
        calls.runsCreated.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...(active || calls.runsCreated.find((item) => item.id === where.id) || { id: where.id }), ...data };
        calls.runsUpdated.push({ where, data, row });
        return row;
      },
    },
    jobInstance: {
      findUnique: async ({ where } = {}) => {
        if (failedJob && where?.id === failedJob.id) return failedJob;
        return activeJob;
      },
      create: async ({ data }) => {
        const row = { id: `job-${++jobCounter}`, priority: 0, params: {}, continuation: null, ...data };
        calls.jobsCreated.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...(activeJob || calls.jobsCreated.find((item) => item.id === where.id) || { id: where.id }), ...data };
        calls.jobsUpdated.push({ where, data, row });
        return row;
      },
    },
  };
}

test("dialog open on a new dialog creates one initial durable run", async () => {
  const db = fakeDb();
  const result = await scheduleDialogScanTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1",
    source: "dialog_open", priority: 180,
  });
  assert.equal(result.created, true);
  assert.equal(db.calls.runsCreated.length, 1);
  assert.equal(db.calls.runsCreated[0].mode, "initial");
  assert.equal(db.calls.jobsCreated[0].params.mode, "initial");
  assert.equal(db.calls.jobsCreated[0].priority, 180);
});



test("opening a fully scanned dialog creates an incremental run", async () => {
  const db = fakeDb({ state: { initialScanComplete: true, newestMessageId: "message-900" } });
  const result = await scheduleDialogScanTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1",
    source: "dialog_open", priority: 180,
  });
  assert.equal(result.created, true);
  assert.equal(db.calls.runsCreated[0].mode, "incremental");
  assert.equal(db.calls.jobsCreated[0].params.mode, "incremental");
  assert.equal(db.calls.jobsCreated[0].continuation.watermark, "message-900");
});

test("reopening an active dialog reprioritizes instead of creating a second run", async () => {
  const active = { id: "run-active", jobId: "job-active", status: "RUNNING", mode: "initial", pagesProcessed: 4, continuation: { cursor: "old" } };
  const activeJob = { id: "job-active", status: "CLAIMED", priority: 70, params: { dialogId: "dialog-1", priorityTargets: [] } };
  const db = fakeDb({ active, activeJob });
  const result = await scheduleDialogScanTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1",
    source: "dialog_open", priority: 180,
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "active_run_reprioritized");
  assert.equal(db.calls.runsCreated.length, 0);
  assert.equal(db.calls.jobsUpdated.at(-1).data.priority, 180);
});

test("partially scanned paused dialog resumes the same run and continuation", async () => {
  const active = { id: "run-paused", jobId: "job-old", status: "PAUSED", mode: "initial", pagesProcessed: 12, continuation: { mode: "initial", cursor: "cursor-12", page: 12 } };
  const activeJob = { id: "job-old", status: "CANCELLED", priority: 70, params: { dialogId: "dialog-1", mode: "initial" } };
  const db = fakeDb({ active, activeJob, state: { initialScanComplete: false, generation: 2, backwardCursor: "cursor-12" } });
  const result = await scheduleDialogScanTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1",
    source: "automatic_startup_resume_scan", priority: 90,
  });
  assert.equal(result.resumed, true);
  assert.equal(result.run.id, "run-paused");
  assert.deepEqual(db.calls.jobsCreated[0].continuation, active.continuation);
  assert.equal(db.calls.runsCreated.length, 0);
});

test("recoverable failed discovery resumes the same checkpoint instead of rebuilding the dialog list", async () => {
  const failed = {
    id: "run-failed", jobId: "job-failed", status: "FAILED", mode: "discovery",
    dialogId: "__dialog_discovery__", pagesProcessed: 1151, generation: 7,
    continuation: {
      stage: "DIALOG_DISCOVERY", mode: "discovery", dialogId: "__dialog_discovery__",
      offset: 21590, page: 1151, dialogsFound: 15243, childMode: "initial", maxPages: 5000,
    },
    progress: { pages: 1151, nextOffset: 21590, dialogsFound: 15243 },
  };
  const failedJob = {
    id: "job-failed", status: "FAILED", priority: 90,
    params: { dialogId: "__dialog_discovery__", mode: "discovery", childMode: "initial", pageLimit: 50 },
    continuation: failed.continuation,
    result: { failure: { code: "DIALOG_DISCOVERY_EMPTY_PAGE_WITH_HAS_MORE", retryable: false } },
  };
  const db = fakeDb({ failed, failedJob, state: { generation: 7 } });
  const result = await scheduleDialogScanTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "__dialog_discovery__",
    mode: "discovery", childMode: "initial", source: "never_used_pipeline", priority: 90,
  });
  assert.equal(result.resumed, true);
  assert.equal(result.run.id, "run-failed");
  assert.equal(db.calls.runsCreated.length, 0);
  assert.equal(db.calls.jobsCreated.length, 1);
  assert.deepEqual(db.calls.jobsCreated[0].continuation, failed.continuation);
  assert.equal(db.calls.jobsCreated[0].params.scanRunId, "run-failed");
});



test("status polling automatically revives the contradictory empty discovery tail", async () => {
  const failed = {
    id: "run-failed", jobId: "job-failed", status: "FAILED", mode: "discovery",
    dialogId: "__dialog_discovery__", pagesProcessed: 1151, generation: 7,
    continuation: {
      stage: "DIALOG_DISCOVERY", mode: "discovery", dialogId: "__dialog_discovery__",
      offset: 21590, page: 1151, dialogsFound: 15243, childMode: "initial", maxPages: 5000,
    },
    progress: { pages: 1151, nextOffset: 21590, dialogsFound: 15243 },
  };
  const failedJob = {
    id: "job-failed", status: "FAILED", priority: 90,
    params: { dialogId: "__dialog_discovery__", mode: "discovery", childMode: "initial", pageLimit: 50, maxPages: 5000, generation: 7 },
    continuation: failed.continuation,
    result: { failure: { code: "DIALOG_DISCOVERY_EMPTY_PAGE_WITH_HAS_MORE", retryable: false } },
  };
  const db = fakeDb({ failed, latest: failed, failedJob, state: { generation: 7 } });
  const result = await autoRecoverDialogDiscoveryTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", source: "status_poll", priority: 90,
  });
  assert.equal(result.recovered, true);
  assert.equal(db.calls.jobsCreated.length, 1);
  assert.deepEqual(db.calls.jobsCreated[0].continuation, failed.continuation);
  assert.equal(db.calls.jobsCreated[0].params.scanRunId, "run-failed");
  assert.equal(db.calls.runsUpdated.at(-1).data.status, "QUEUED");
});



test("active discovery whose continuation restarted at zero is fenced and restored from committed chunks", async () => {
  const active = {
    id: "run-regressed", jobId: "job-regressed", status: "RUNNING", mode: "discovery",
    dialogId: "__dialog_discovery__", pagesProcessed: 1200, generation: 7,
    continuation: {
      stage: "DIALOG_DISCOVERY", mode: "discovery", dialogId: "__dialog_discovery__",
      offset: 600, page: 1200, dialogsFound: 15242, childMode: "initial", maxPages: 5000,
    },
    progress: { pages: 1200, nextOffset: 600, dialogsFound: 15242 },
  };
  const activeJob = {
    id: "job-regressed", status: "CLAIMED", priority: 90, leaseRevision: 4,
    params: { dialogId: "__dialog_discovery__", mode: "discovery", childMode: "initial", pageLimit: 50, maxPages: 5000, generation: 7 },
    continuation: active.continuation,
    progress: active.progress,
  };
  const db = fakeDb({
    active,
    latest: active,
    activeJob,
    stateCount: 15242,
    commits: [
      { cursorOut: "21540", page: 1149 },
      { cursorOut: "21590", page: 1150 },
      { cursorOut: "600", page: 1199 },
    ],
  });
  const result = await repairRegressedDialogDiscoveryTx(db, {
    agencyId: "agency-1", creatorId: "creator-1",
  });
  assert.equal(result.repaired, true);
  assert.equal(result.fromOffset, 600);
  assert.equal(result.toOffset, 21590);
  assert.equal(db.calls.jobsUpdated.at(-1).data.status, "SCHEDULED");
  assert.deepEqual(db.calls.jobsUpdated.at(-1).data.leaseRevision, { increment: 1 });
  assert.equal(db.calls.jobsUpdated.at(-1).data.continuation.offset, 21590);
  assert.equal(db.calls.jobsUpdated.at(-1).data.continuation.page, 1151);
  assert.equal(db.calls.runsUpdated.at(-1).data.pagesProcessed, 1151);
  assert.equal(db.calls.runsUpdated.at(-1).data.progress.nextOffset, 21590);
});

test("purchase target is queued inside an active initial run without damaging continuation", async () => {
  const active = { id: "run-active", jobId: "job-active", status: "RUNNING", mode: "initial", pagesProcessed: 5, continuation: { mode: "initial", cursor: "cursor-5", page: 5 } };
  const activeJob = { id: "job-active", status: "CLAIMED", priority: 90, params: { dialogId: "dialog-1", mode: "initial", priorityTargets: [] } };
  const db = fakeDb({ active, activeJob });
  const result = await scheduleDialogScanTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1",
    mode: "targeted", targetMessageId: "message-ppv", source: "purchase_notification", priority: 190,
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "targeted_reconciliation_queued");
  assert.equal(db.calls.targetsUpserted.length, 1);
  assert.equal(db.calls.targetsUpserted[0].messageId, "message-ppv");
  assert.deepEqual(active.continuation, { mode: "initial", cursor: "cursor-5", page: 5 });
  assert.equal(db.calls.runsCreated.length, 0);
});
