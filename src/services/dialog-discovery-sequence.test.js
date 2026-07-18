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
      create: async ({ data }) => {
        const row = { id: `commit-${++commitSeq}`, ...data };
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
          if (where.creatorId && row.creatorId !== where.creatorId) continue;
          if (typeof where.dialogId === "string" && row.dialogId !== where.dialogId) continue;
          if (where.dialogId?.in && !where.dialogId.in.includes(row.dialogId)) continue;
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

function seedDiscovery(generation = 77) {
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
      childMode: "initial",
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

test("hasMore=false freezes the full list and starts exactly one history dialog", async () => {
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
  assert.equal(completion.next.created, true);
  const historyRuns = [...db._runs.values()].filter((run) => run.dialogId !== "__dialog_discovery__");
  assert.equal(historyRuns.length, 1);
  assert.equal(historyRuns[0].dialogId, "dialog-a");
  assert.equal([...db._jobs.values()].filter((row) => row.id !== "discovery-job").length, 1);

  const firstJob = [...db._jobs.values()].find((row) => row.id !== "discovery-job");
  const firstRun = historyRuns[0];
  const next = await completeDialogIntelligenceJob({
    db,
    job: { ...firstJob, agencyId: "agency-1", creatorId: "creator-1" },
    deviceId: "device-1",
    result: { pages: 2, scanNewestMessageId: "m-9", scanNewestMessageAt: new Date().toISOString() },
  });
  assert.equal(next.next.created, true);
  const after = [...db._runs.values()].filter((run) => run.dialogId !== "__dialog_discovery__");
  assert.equal(after.length, 2);
  assert.deepEqual(after.map((run) => run.dialogId), ["dialog-a", "dialog-b"]);
  assert.equal(after.filter((run) => ["QUEUED", "RUNNING", "PAUSED"].includes(run.status)).length, 1);
});

test("a terminal failure marks one dialog failed and immediately advances to the next", async () => {
  resetDb();
  seedDiscovery();
  for (const dialogId of ["dialog-a", "dialog-b"]) {
    db._states.set(`creator-1:${dialogId}`, {
      agencyId: "agency-1",
      creatorId: "creator-1",
      dialogId,
      fanId: null,
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
  // Create the first history run through discovery completion.
  await completeDialogIntelligenceJob({
    db,
    job: db._jobs.get("discovery-job"),
    deviceId: "device-1",
    result: { hasMore: false },
  });
  const first = [...db._runs.values()].find((run) => run.dialogId === "dialog-a");
  const firstJob = db._jobs.get(first.jobId);
  const failure = await recordDialogIntelligenceFailure({
    job: { ...firstJob, agencyId: "agency-1", creatorId: "creator-1" },
    error: "HTTP 422 invalid dialog",
    terminal: true,
  });
  assert.equal(db._states.get("creator-1:dialog-a").status, "FAILED");
  assert.equal(failure.next.created, true);
  assert.equal([...db._runs.values()].some((run) => run.dialogId === "dialog-b" && run.status === "QUEUED"), true);
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

test("an orphaned active history run is failed and cannot block the next planned dialog", async () => {
  resetDb();
  const { job } = seedDiscovery(99);
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

  const completion = await completeDialogIntelligenceJob({
    db,
    job,
    deviceId: "device-1",
    result: { pages: 1, dialogsFound: 2, hasMore: false },
  });

  assert.equal(db._runs.get("orphan-run").status, "FAILED");
  assert.equal(db._states.get("creator-1:dialog-a").status, "FAILED");
  assert.equal(completion.next.created, true);
  assert.equal(completion.next.runId, [...db._runs.values()].find((run) => run.dialogId === "dialog-b")?.id);
});
