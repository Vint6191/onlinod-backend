"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
const db = createDb();
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: db };
delete require.cache[require.resolve("./dialog-intelligence-service")];
const {
  applyDialogIntelligenceChunk,
  completeDialogIntelligenceJob,
  recordDialogIntelligenceFailure,
  autoRecoverDialogHistoryTx,
  finalizeCommittedDialogDiscoveryTx,
  repairRegressedDialogDiscoveryTx,
} = require("./dialog-intelligence-service");

function createDb() {
  const runs = new Map();
  const states = new Map();
  const jobs = new Map();
  const commits = new Map();
  let runSeq = 0;
  let jobSeq = 0;
  let commitSeq = 0;

  const matchesActive = (run, where) => {
    if (!run) return false;
    if (where.id && run.id !== where.id) return false;
    if (where.agencyId && run.agencyId !== where.agencyId) return false;
    if (where.creatorId && run.creatorId !== where.creatorId) return false;
    if (typeof where.dialogId === "string" && run.dialogId !== where.dialogId) return false;
    if (where.dialogId?.not && run.dialogId === where.dialogId.not) return false;
    if (where.dialogId?.notIn && where.dialogId.notIn.includes(run.dialogId)) return false;
    if (where.generation !== undefined && run.generation !== where.generation) return false;
    if (where.status?.in && !where.status.in.includes(run.status)) return false;
    return true;
  };
  const applyData = (row, data) => {
    for (const [key, value] of Object.entries(data || {})) {
      if (value === undefined) continue;
      if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "increment")) {
        row[key] = Number(row[key] || 0) + Number(value.increment || 0);
      } else {
        row[key] = value;
      }
    }
    row.updatedAt = new Date();
    return row;
  };

  const api = {
    _runs: runs,
    _states: states,
    _jobs: jobs,
    _commits: commits,
    creatorAccount: { findFirst: async () => ({ id: "creator-1", agencyId: "agency-1", remoteId: "of-1", status: "READY" }) },
    moduleSetting: { findUnique: async () => ({ enabled: true, status: "active", config: {} }) },
    dialogReconciliationTarget: { upsert: async () => { throw new Error("not used"); } },
    dialogScanChunkCommit: {
      findUnique: async ({ where }) => commits.get(`${where.runId_chunkKey.runId}:${where.runId_chunkKey.chunkKey}`) || null,
      findFirst: async ({ where }) => [...commits.values()]
        .filter((row) => {
          if (where.runId && row.runId !== where.runId) return false;
          if (where.mode && row.mode !== where.mode) return false;
          if (where.hasMore !== undefined && row.hasMore !== where.hasMore) return false;
          return true;
        })
        .sort((a, b) => Number(b.committedAt || 0) - Number(a.committedAt || 0))[0] || null,
      findMany: async ({ where }) => [...commits.values()].filter((row) => {
        if (where.runId && row.runId !== where.runId) return false;
        if (where.mode && row.mode !== where.mode) return false;
        if (where.hasMore !== undefined && row.hasMore !== where.hasMore) return false;
        return true;
      }),
      create: async ({ data }) => {
        const row = { id: `commit-${++commitSeq}`, committedAt: new Date(), ...data };
        commits.set(`${data.runId}:${data.chunkKey}`, row);
        return row;
      },
    },
    dialogScanRun: {
      findFirst: async ({ where }) => [...runs.values()].find((run) => matchesActive(run, where)) || null,
      findUnique: async ({ where }) => runs.get(where.id) || null,
      create: async ({ data }) => {
        const row = {
          id: `run-${++runSeq}`,
          jobId: null,
          pagesProcessed: 0,
          messagesProcessed: 0,
          purchaseSignals: 0,
          continuation: {},
          progress: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        runs.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = runs.get(where.id);
        if (!row) throw new Error(`run ${where.id} missing`);
        return applyData(row, data);
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of runs.values()) {
          if (matchesActive(row, where)) {
            applyData(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    dialogScanState: {
      findUnique: async ({ where }) => states.get(`${where.creatorId_dialogId.creatorId}:${where.creatorId_dialogId.dialogId}`) || null,
      findMany: async ({ where, select }) => [...states.values()]
        .filter((row) => {
          if (where.creatorId && row.creatorId !== where.creatorId) return false;
          if (where.dialogId?.in && !where.dialogId.in.includes(row.dialogId)) return false;
          return true;
        })
        .map((row) => select
          ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]))
          : row),
      createMany: async ({ data, skipDuplicates }) => {
        let count = 0;
        for (const input of data) {
          const key = `${input.creatorId}:${input.dialogId}`;
          if (states.has(key)) {
            if (!skipDuplicates) throw new Error(`duplicate state ${key}`);
            continue;
          }
          states.set(key, {
            initialScanComplete: false, pagesProcessed: 0, messagesProcessed: 0,
            createdAt: new Date(), updatedAt: new Date(), ...input,
          });
          count += 1;
        }
        return { count };
      },
      findFirst: async ({ where }) => {
        return [...states.values()]
          .filter((row) => {
            if (row.agencyId !== where.agencyId || row.creatorId !== where.creatorId) return false;
            if (where.dialogId?.not && row.dialogId === where.dialogId.not) return false;
            if (where.generation !== undefined && row.generation !== where.generation) return false;
            if (where.status && row.status !== where.status) return false;
            if (where.initialScanComplete !== undefined && row.initialScanComplete !== where.initialScanComplete) return false;
            return true;
          })
          .sort((a, b) => String(a.dialogId).localeCompare(String(b.dialogId)))[0] || null;
      },
      upsert: async ({ where, create, update }) => {
        const key = `${where.creatorId_dialogId.creatorId}:${where.creatorId_dialogId.dialogId}`;
        const existing = states.get(key);
        if (existing) return applyData(existing, update);
        const row = {
          initialScanComplete: false,
          pagesProcessed: 0,
          messagesProcessed: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        states.set(key, row);
        return row;
      },
      update: async ({ where, data }) => {
        const key = `${where.creatorId_dialogId.creatorId}:${where.creatorId_dialogId.dialogId}`;
        const row = states.get(key);
        if (!row) throw new Error(`state ${key} missing`);
        return applyData(row, data);
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of states.values()) {
          if (where.agencyId && row.agencyId !== where.agencyId) continue;
          if (where.creatorId && row.creatorId !== where.creatorId) continue;
          if (typeof where.dialogId === "string" && row.dialogId !== where.dialogId) continue;
          if (where.dialogId?.in && !where.dialogId.in.includes(row.dialogId)) continue;
          if (where.dialogId?.notIn && where.dialogId.notIn.includes(row.dialogId)) continue;
          if (where.status && row.status !== where.status) continue;
          if (where.activeRunId && row.activeRunId !== where.activeRunId) continue;
          applyData(row, data);
          count += 1;
        }
        return { count };
      },
    },
    jobInstance: {
      findUnique: async ({ where }) => jobs.get(where.id) || null,
      create: async ({ data }) => {
        const row = { id: `job-${++jobSeq}`, attempts: 0, createdAt: new Date(), updatedAt: new Date(), ...data };
        jobs.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = jobs.get(where.id);
        if (!row) throw new Error(`job ${where.id} missing`);
        return applyData(row, data);
      },
      updateMany: async ({ where, data }) => {
        const row = jobs.get(where.id);
        if (!row) return { count: 0 };
        applyData(row, data);
        return { count: 1 };
      },
    },
    $transaction: async (fn) => fn(api),
  };
  return api;
}

function resetDb() {
  db._runs.clear();
  db._states.clear();
  db._jobs.clear();
  db._commits.clear();
}

function seedDiscovery(generation = 77, childMode = "initial") {
  const run = {
    id: "discovery-run",
    jobId: "discovery-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "__dialog_discovery__",
    mode: "discovery",
    source: "test",
    status: "RUNNING",
    generation,
    pagesProcessed: 0,
    messagesProcessed: 0,
    purchaseSignals: 0,
    continuation: {},
    progress: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  db._runs.set(run.id, run);
  db._jobs.set("discovery-job", {
    id: "discovery-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    params: {
      scanRunId: run.id,
      dialogId: "__dialog_discovery__",
      mode: "discovery",
      childMode,
      childPriority: 60,
      generation,
      pageLimit: 50,
      maxPages: 5000,
    },
  });
  db._states.set("creator-1:__dialog_discovery__", {
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "__dialog_discovery__",
    generation,
    status: "RUNNING",
    initialScanComplete: false,
    pagesProcessed: 0,
    messagesProcessed: 0,
  });
  return { run, job: db._jobs.get("discovery-job") };
}

test("discovery pages build only a PLANNED list and never schedule history early", async () => {
  resetDb();
  const { job } = seedDiscovery();
  const page = await applyDialogIntelligenceChunk({
    db,
    job,
    deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page",
      runId: "discovery-run",
      chunkKey: "page-0",
      page: 0,
      childMode: "initial",
      hasMore: true,
      cursorIn: "0",
      cursorOut: "2",
      continuation: { mode: "discovery", page: 1, offset: 2 },
      progress: { pages: 1, dialogsFound: 2, hasMore: true, nextOffset: 2 },
      dialogs: [
        { dialogId: "dialog-a", fanId: "fan-a" },
        { dialogId: "dialog-b", fanId: "fan-b" },
      ],
    },
  });
  assert.equal(page.scheduled, 0);
  assert.equal(db._jobs.size, 1, "only the discovery job exists");
  assert.equal(db._states.get("creator-1:dialog-a").status, "PLANNED");
  assert.equal(db._states.get("creator-1:dialog-b").status, "PLANNED");
  assert.equal([...db._runs.values()].filter((run) => run.dialogId !== "__dialog_discovery__").length, 0);
});

test("an asynchronous 100-dialog discovery batch advances durable page counters in one commit", async () => {
  resetDb();
  const { job } = seedDiscovery();
  const result = await applyDialogIntelligenceChunk({
    db, job, deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page", runId: "discovery-run", chunkKey: "batch-0",
      page: 0, pageStart: 0, pageEnd: 10, pagesInBatch: 10, childMode: "initial", hasMore: true,
      cursorIn: "0", cursorOut: "100",
      continuation: { mode: "discovery", page: 10, offset: 100, dialogsFound: 2 },
      progress: { pages: 10, pagesInBatch: 10, dialogsFound: 2, hasMore: true, nextOffset: 100 },
      dialogs: [{ dialogId: "dialog-a", fanId: "fan-a" }, { dialogId: "dialog-b", fanId: "fan-b" }],
    },
  });
  assert.equal(result.pagesInBatch, 10);
  assert.equal(result.pageEnd, 10);
  assert.equal(db._runs.get("discovery-run").pagesProcessed, 10);
});

test("hasMore=false freezes the full list for batch CRM claims without creating history jobs", async () => {
  resetDb();
  const { job } = seedDiscovery();
  for (const dialogId of ["dialog-a", "dialog-b", "dialog-c"]) {
    db._states.set(`creator-1:${dialogId}`, {
      agencyId: "agency-1",
      creatorId: "creator-1",
      dialogId,
      fanId: `fan-${dialogId.at(-1)}`,
      generation: 77,
      status: "PLANNED",
      scanMode: "initial",
      initialScanComplete: false,
      pagesProcessed: 0,
      messagesProcessed: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const completion = await completeDialogIntelligenceJob({
    db,
    job,
    deviceId: "device-1",
    result: { pages: 4, dialogsFound: 3, hasMore: false },
  });
  assert.equal(completion.next.created, false);
  assert.equal(completion.next.reason, "history_batch_ready");
  const historyRuns = [...db._runs.values()].filter((run) => run.dialogId !== "__dialog_discovery__");
  assert.equal(historyRuns.length, 0);
  assert.equal([...db._jobs.values()].filter((row) => row.id !== "discovery-job").length, 0);
  assert.deepEqual(
    [...db._states.values()].filter((row) => row.dialogId !== "__dialog_discovery__").map((row) => row.status),
    ["PLANNED", "PLANNED", "PLANNED"],
  );
});

test("a terminal legacy dialog failure never spawns another per-dialog worker", async () => {
  resetDb();
  const { job } = seedDiscovery();
  db._runs.set("legacy-run", {
    id: "legacy-run",
    jobId: "legacy-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "dialog-a",
    mode: "initial",
    status: "RUNNING",
    generation: 77,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  db._jobs.set("legacy-job", {
    id: "legacy-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    status: "CLAIMED",
    params: { scanRunId: "legacy-run", dialogId: "dialog-a" },
  });
  db._states.set("creator-1:dialog-a", {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-a",
    generation: 77, status: "RUNNING", scanMode: "initial", initialScanComplete: false,
    activeRunId: "legacy-run", activeJobId: "legacy-job", pagesProcessed: 0, messagesProcessed: 0,
    createdAt: new Date(), updatedAt: new Date(),
  });
  const beforeJobs = db._jobs.size;
  const failure = await recordDialogIntelligenceFailure({
    job: { ...db._jobs.get("legacy-job"), agencyId: "agency-1", creatorId: "creator-1" },
    error: "HTTP 422 invalid dialog",
    terminal: true,
  });
  assert.equal(db._states.get("creator-1:dialog-a").status, "FAILED");
  assert.equal(failure.next, null);
  assert.equal(db._jobs.size, beforeJobs);
  assert.equal(job.id, "discovery-job");
});

test("explicit full discovery replans completed dialogs and resets current-plan counters", async () => {
  resetDb();
  const { job } = seedDiscovery(88);
  job.params.forceChildFull = true;
  db._states.set("creator-1:dialog-a", {
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "dialog-a",
    fanId: "fan-old",
    generation: 12,
    status: "READY",
    scanMode: "initial",
    initialScanComplete: true,
    pagesProcessed: 99,
    messagesProcessed: 9999,
    mediaProcessed: 123,
    backwardCursor: "old-cursor",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  await applyDialogIntelligenceChunk({
    db,
    job,
    deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page",
      runId: "discovery-run",
      chunkKey: "page-0",
      page: 0,
      childMode: "initial",
      forceChildFull: true,
      hasMore: false,
      cursorIn: "0",
      cursorOut: "",
      continuation: { mode: "discovery", page: 1, offset: 1 },
      progress: { pages: 1, dialogsFound: 1, hasMore: false, nextOffset: 1 },
      dialogs: [{ dialogId: "dialog-a", fanId: "fan-new" }],
    },
  });

  const state = db._states.get("creator-1:dialog-a");
  assert.equal(state.status, "PLANNED");
  assert.equal(state.generation, 88);
  assert.equal(state.initialScanComplete, false);
  assert.equal(state.pagesProcessed, 0);
  assert.equal(state.messagesProcessed, 0);
  assert.equal(state.mediaProcessed, 0);
  assert.equal(state.backwardCursor, null);
});

test("status recovery retires an orphaned legacy attempt and leaves the dialog claimable by a batch", async () => {
  resetDb();
  seedDiscovery(99);
  db._runs.get("discovery-run").status = "COMPLETED";
  db._runs.set("orphan-run", {
    id: "orphan-run",
    jobId: "missing-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "dialog-a",
    mode: "initial",
    status: "RUNNING",
    generation: 99,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  db._states.set("creator-1:dialog-a", {
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "dialog-a",
    generation: 99,
    status: "RUNNING",
    scanMode: "initial",
    initialScanComplete: false,
    activeRunId: "orphan-run",
    activeJobId: "missing-job",
    pagesProcessed: 0,
    messagesProcessed: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  db._states.set("creator-1:dialog-b", {
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "dialog-b",
    generation: 99,
    status: "PLANNED",
    scanMode: "initial",
    initialScanComplete: false,
    pagesProcessed: 0,
    messagesProcessed: 0,
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });

  const recovery = await autoRecoverDialogHistoryTx(db, {
    agencyId: "agency-1",
    creatorId: "creator-1",
    source: "status_poll",
  });

  assert.equal(db._runs.get("orphan-run").status, "FAILED");
  assert.equal(db._states.get("creator-1:dialog-a").status, "PLANNED");
  assert.equal(db._states.get("creator-1:dialog-a").activeRunId, null);
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.reason, "history_batch_ready");
  assert.equal(recovery.cleanedLegacyRuns, 1);
  assert.equal([...db._jobs.values()].filter((row) => row.id !== "discovery-job").length, 0);
});



test("a committed hasMore=false discovery boundary finalizes a stranded scheduled job", async () => {
  resetDb();
  const { job, run } = seedDiscovery(101, "incremental");
  job.status = "SCHEDULED";
  job.leaseUntil = null;
  run.status = "QUEUED";

  await applyDialogIntelligenceChunk({
    db, job, deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page", runId: run.id, chunkKey: "terminal-daily",
      page: 0, pageStart: 0, pageEnd: 1, pagesInBatch: 1, childMode: "incremental", hasMore: false,
      cursorIn: "0", cursorOut: "1",
      continuation: { mode: "discovery", page: 1, offset: 1, dialogsFound: 1 },
      progress: { pages: 1, dialogsFound: 1, hasMore: false, nextOffset: 1 },
      dialogs: [{ dialogId: "dialog-new", fanId: "fan-new", latestMessageId: "m-1", latestMessageAt: "2026-07-22T00:00:00.000Z" }],
    },
  });

  // Reproduce the production gap: the final page is durable, but the separate
  // Desktop completion request never changed the run/job terminal states.
  run.status = "QUEUED";
  db._states.get("creator-1:__dialog_discovery__").status = "QUEUED";
  const result = await finalizeCommittedDialogDiscoveryTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", now: new Date("2026-07-22T01:00:00.000Z"),
  });

  assert.equal(result.finalized, true);
  assert.equal(job.status, "DONE");
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.progress.hasMore, false);
  assert.equal(db._states.get("creator-1:__dialog_discovery__").status, "READY");
  assert.equal(db._states.get("creator-1:dialog-new").status, "PLANNED");
});

test("a legacy commit with default hasMore=false but no explicit terminal result is ignored", async () => {
  resetDb();
  const { job, run } = seedDiscovery(104, "incremental");
  job.status = "SCHEDULED";
  run.status = "QUEUED";
  db._commits.set(`${run.id}:legacy-default-false`, {
    id: "legacy-default-false", runId: run.id, chunkKey: "legacy-default-false", mode: "discovery",
    hasMore: false, result: {}, committedAt: new Date(),
  });

  const result = await finalizeCommittedDialogDiscoveryTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", now: new Date("2026-07-22T01:00:00.000Z"),
  });
  assert.equal(result.finalized, false);
  assert.equal(result.reason, "terminal_boundary_not_committed");
  assert.equal(job.status, "SCHEDULED");
  assert.equal(run.status, "QUEUED");
});

test("terminal discovery recovery never steals a live claimed lease", async () => {
  resetDb();
  const { job, run } = seedDiscovery(102, "incremental");
  job.status = "CLAIMED";
  job.leaseUntil = new Date("2026-07-22T02:00:00.000Z");
  await applyDialogIntelligenceChunk({
    db, job, deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page", runId: run.id, chunkKey: "terminal-live",
      page: 0, pageStart: 0, pageEnd: 1, pagesInBatch: 1, childMode: "incremental", hasMore: false,
      cursorIn: "0", cursorOut: "1", continuation: { mode: "discovery", page: 1, offset: 1, dialogsFound: 0 },
      progress: { pages: 1, dialogsFound: 0, hasMore: false, nextOffset: 1 }, dialogs: [],
    },
  });
  run.status = "RUNNING";

  const result = await finalizeCommittedDialogDiscoveryTx(db, {
    agencyId: "agency-1", creatorId: "creator-1", now: new Date("2026-07-22T01:00:00.000Z"),
  });
  assert.equal(result.finalized, false);
  assert.equal(result.reason, "live_worker_finishing");
  assert.equal(job.status, "CLAIMED");
  assert.equal(run.status, "RUNNING");
});

test("cursor regression repair ignores a committed terminal discovery page", async () => {
  resetDb();
  const { job, run } = seedDiscovery(103, "incremental");
  job.status = "SCHEDULED";
  job.continuation = { driverPhase: "complete", result: { hasMore: false } };
  job.progress = { pages: 1, dialogsFound: 16021, hasMore: false, nextOffset: 0 };
  run.status = "QUEUED";
  run.progress = { pages: 1, dialogsFound: 16021, hasMore: false, nextOffset: 0 };
  db._commits.set(`${run.id}:terminal-regression`, {
    id: "commit-terminal-regression", runId: run.id, chunkKey: "terminal-regression", mode: "discovery",
    hasMore: false, cursorOut: "16021", page: 1, result: { hasMore: false, page: 1 }, committedAt: new Date(),
  });

  const result = await repairRegressedDialogDiscoveryTx(db, { agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(result.repaired, false);
  assert.equal(result.reason, "terminal_boundary_already_committed");
  assert.equal(job.status, "SCHEDULED");
  assert.equal(run.status, "QUEUED");
});

test("daily discovery keeps an unchanged completed dialog READY without resetting counters", async () => {
  resetDb();
  const { job } = seedDiscovery(120, "incremental");
  db._states.set("creator-1:dialog-a", {
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "dialog-a",
    fanId: "fan-a",
    generation: 119,
    status: "READY",
    scanMode: "incremental",
    initialScanComplete: true,
    confirmedWatermarkMessageId: "message-100",
    confirmedWatermarkAt: new Date("2026-07-22T09:00:00.000Z"),
    newestMessageId: "message-100",
    newestMessageAt: new Date("2026-07-22T09:00:00.000Z"),
    pagesProcessed: 33,
    messagesProcessed: 750,
    mediaProcessed: 42,
    incrementalGapOpen: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const result = await applyDialogIntelligenceChunk({
    db,
    job,
    deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page",
      runId: "discovery-run",
      chunkKey: "daily-unchanged",
      page: 0,
      childMode: "incremental",
      hasMore: false,
      dialogs: [{
        dialogId: "dialog-a",
        fanId: "fan-a",
        latestMessageId: "message-100",
        latestMessageAt: "2026-07-22T09:00:00.000Z",
      }],
    },
  });

  const state = db._states.get("creator-1:dialog-a");
  assert.equal(result.planned, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(state.status, "READY");
  assert.equal(state.generation, 120);
  assert.equal(state.pagesProcessed, 33);
  assert.equal(state.messagesProcessed, 750);
  assert.equal(state.mediaProcessed, 42);
  assert.equal(state.incrementalGapOpen, false);
});

test("daily discovery plans only a changed completed dialog for incremental history", async () => {
  resetDb();
  const { job } = seedDiscovery(121, "incremental");
  db._states.set("creator-1:dialog-a", {
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "dialog-a",
    fanId: "fan-a",
    generation: 120,
    status: "READY",
    scanMode: "incremental",
    initialScanComplete: true,
    confirmedWatermarkMessageId: "message-100",
    confirmedWatermarkAt: new Date("2026-07-22T09:00:00.000Z"),
    newestMessageId: "message-100",
    newestMessageAt: new Date("2026-07-22T09:00:00.000Z"),
    pagesProcessed: 33,
    messagesProcessed: 750,
    mediaProcessed: 42,
    incrementalGapOpen: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const result = await applyDialogIntelligenceChunk({
    db,
    job,
    deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page",
      runId: "discovery-run",
      chunkKey: "daily-changed",
      page: 0,
      childMode: "incremental",
      hasMore: false,
      dialogs: [{
        dialogId: "dialog-a",
        fanId: "fan-a",
        latestMessageId: "message-101",
        latestMessageAt: "2026-07-22T12:00:00.000Z",
      }],
    },
  });

  const state = db._states.get("creator-1:dialog-a");
  assert.equal(result.planned, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(state.status, "PLANNED");
  assert.equal(state.scanMode, "incremental");
  assert.equal(state.generation, 121);
  assert.equal(state.incrementalGapOpen, true);
  assert.equal(state.pagesProcessed, 33, "daily delta planning preserves historical counters");
  assert.equal(state.messagesProcessed, 750);
  assert.equal(state.mediaProcessed, 42);
});

test("legacy completed dialogs bootstrap from their full-scan timestamp instead of all being rescanned once", async () => {
  resetDb();
  const { job } = seedDiscovery(122, "incremental");
  db._states.set("creator-1:dialog-legacy", {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-legacy", fanId: "fan-legacy",
    generation: 121, status: "READY", scanMode: "initial", initialScanComplete: true,
    confirmedWatermarkMessageId: null, confirmedWatermarkAt: null, newestMessageId: null, newestMessageAt: null,
    lastFullScanAt: new Date("2026-07-22T10:00:00.000Z"), lastIncrementalScanAt: null,
    pagesProcessed: 10, messagesProcessed: 200, mediaProcessed: 5, incrementalGapOpen: false,
    createdAt: new Date(0), updatedAt: new Date(0),
  });
  const result = await applyDialogIntelligenceChunk({
    db, job, deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page", runId: "discovery-run", chunkKey: "legacy-watermark-old",
      page: 0, childMode: "incremental", hasMore: false,
      dialogs: [{ dialogId: "dialog-legacy", fanId: "fan-legacy", latestMessageId: "message-200", latestMessageAt: "2026-07-22T09:59:00.000Z" }],
    },
  });
  assert.equal(result.planned, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(db._states.get("creator-1:dialog-legacy").status, "READY");
});

test("legacy completed dialogs with a marker newer than their last scan are planned incrementally", async () => {
  resetDb();
  const { job } = seedDiscovery(123, "incremental");
  db._states.set("creator-1:dialog-legacy", {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-legacy", fanId: "fan-legacy",
    generation: 122, status: "READY", scanMode: "initial", initialScanComplete: true,
    confirmedWatermarkMessageId: null, confirmedWatermarkAt: null, newestMessageId: null, newestMessageAt: null,
    lastFullScanAt: new Date("2026-07-22T10:00:00.000Z"), lastIncrementalScanAt: null,
    pagesProcessed: 10, messagesProcessed: 200, mediaProcessed: 5, incrementalGapOpen: false,
    createdAt: new Date(0), updatedAt: new Date(0),
  });
  const result = await applyDialogIntelligenceChunk({
    db, job, deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page", runId: "discovery-run", chunkKey: "legacy-watermark-new",
      page: 0, childMode: "incremental", hasMore: false,
      dialogs: [{ dialogId: "dialog-legacy", fanId: "fan-legacy", latestMessageId: "message-201", latestMessageAt: "2026-07-22T10:01:00.000Z" }],
    },
  });
  assert.equal(result.planned, 1);
  assert.equal(db._states.get("creator-1:dialog-legacy").status, "PLANNED");
  assert.equal(db._states.get("creator-1:dialog-legacy").scanMode, "incremental");
});

test("a new dialog found by a daily list rebuild is planned as an initial scan", async () => {
  resetDb();
  const { job } = seedDiscovery(122, "incremental");
  const result = await applyDialogIntelligenceChunk({
    db,
    job,
    deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page",
      runId: "discovery-run",
      chunkKey: "daily-new-dialog",
      page: 0,
      childMode: "incremental",
      hasMore: false,
      dialogs: [{
        dialogId: "dialog-new",
        fanId: "fan-new",
        latestMessageId: "new-message-1",
        latestMessageAt: "2026-07-22T12:00:00.000Z",
      }],
    },
  });
  const state = db._states.get("creator-1:dialog-new");
  assert.equal(result.planned, 1);
  assert.equal(state.status, "PLANNED");
  assert.equal(state.scanMode, "initial");
  assert.equal(state.initialScanComplete, false);
  assert.equal(state.newestMessageId, "new-message-1");
});

test("an unchanged unavailable dialog stays terminal during daily maintenance", async () => {
  resetDb();
  const { job } = seedDiscovery(123, "incremental");
  db._states.set("creator-1:dialog-gone", {
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "dialog-gone",
    fanId: "fan-gone",
    generation: 122,
    status: "UNAVAILABLE",
    scanMode: "incremental",
    initialScanComplete: false,
    newestMessageId: "last-visible-message",
    newestMessageAt: new Date("2026-07-20T10:00:00.000Z"),
    pagesProcessed: 0,
    messagesProcessed: 0,
    mediaProcessed: 0,
    incrementalGapOpen: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const result = await applyDialogIntelligenceChunk({
    db,
    job,
    deviceId: "device-1",
    chunkResult: {
      kind: "dialog_discovery_page",
      runId: "discovery-run",
      chunkKey: "daily-unavailable",
      page: 0,
      childMode: "incremental",
      hasMore: false,
      dialogs: [{
        dialogId: "dialog-gone",
        fanId: "fan-gone",
        latestMessageId: "last-visible-message",
        latestMessageAt: "2026-07-20T10:00:00.000Z",
      }],
    },
  });
  const state = db._states.get("creator-1:dialog-gone");
  assert.equal(result.planned, 0);
  assert.equal(result.unavailableUnchanged, 1);
  assert.equal(state.status, "UNAVAILABLE");
  assert.equal(state.generation, 123);
});
