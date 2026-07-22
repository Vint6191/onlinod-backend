"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
delete require.cache[require.resolve("./dialog-history-batch-service")];
const {
  DIALOG_HISTORY_BATCH_DIALOG_ID,
  claimDialogHistoryBatchTx,
  progressDialogHistoryBatchTx,
  completeDialogHistoryBatchTx,
  releaseDialogHistoryBatchTx,
  recoverExpiredDialogHistoryBatchesTx,
  normalizeOrphanedDialogHistoryBatchesTx,
  reclaimOwnedDialogHistoryBatchTx,
} = require("./dialog-history-batch-service");

function applyData(row, data) {
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
}

function matches(row, where = {}) {
  if (!row) return false;
  for (const key of ["id", "agencyId", "creatorId", "dialogId", "activeRunId", "status", "generation"]) {
    if (typeof where[key] === "string" || typeof where[key] === "number") {
      if (row[key] !== where[key]) return false;
    }
  }
  if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
  if (where.dialogId?.in && !where.dialogId.in.includes(row.dialogId)) return false;
  if (where.dialogId?.notIn && where.dialogId.notIn.includes(row.dialogId)) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  if (where.initialScanComplete !== undefined && row.initialScanComplete !== where.initialScanComplete) return false;
  return true;
}

function createDb() {
  const states = new Map();
  const runs = new Map();
  const jobs = new Map();
  const commits = new Map();
  const locks = [];
  let runSeq = 0;
  const api = {
    _states: states,
    _runs: runs,
    _jobs: jobs,
    _commits: commits,
    _locks: locks,
    $queryRawUnsafe: async (...args) => {
      locks.push(args);
      return [{ pg_advisory_xact_lock: null }];
    },
    creatorAccount: {
      findMany: async ({ where }) => where.id.in.map((id) => ({ id })),
    },
    moduleSetting: {
      findUnique: async () => ({ enabled: true }),
    },
    dialogScanChunkCommit: {
      findFirst: async ({ where }) => [...commits.values()].find((row) => {
        if (where.runId && row.runId !== where.runId) return false;
        if (where.mode && row.mode !== where.mode) return false;
        if (where.hasMore !== undefined && row.hasMore !== where.hasMore) return false;
        return true;
      }) || null,
    },
    jobInstance: {
      findUnique: async ({ where }) => jobs.get(where.id) || null,
      updateMany: async ({ where, data }) => {
        const row = jobs.get(where.id);
        if (!row) return { count: 0 };
        if (typeof where.status === "string" && row.status !== where.status) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(row.status)) return { count: 0 };
        if (row.status === "CLAIMED" && where.OR) {
          const now = where.OR.find((item) => item.leaseUntil?.lte)?.leaseUntil?.lte || null;
          if (row.leaseUntil && now && row.leaseUntil > now) return { count: 0 };
        }
        applyData(row, data);
        return { count: 1 };
      },
    },
    dialogScanState: {
      findFirst: async ({ where }) => [...states.values()].filter((row) => matches(row, where))[0] || null,
      findMany: async ({ where, take }) => [...states.values()].filter((row) => matches(row, where)).slice(0, take),
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of states.values()) {
          if (!matches(row, where)) continue;
          applyData(row, data);
          count += 1;
        }
        return { count };
      },
    },
    dialogScanRun: {
      findMany: async ({ where, take }) => [...runs.values()].filter((row) => matches(row, where)).slice(0, take),
      findFirst: async ({ where }) => [...runs.values()].find((row) => matches(row, where)) || null,
      create: async ({ data }) => {
        const row = {
          id: `batch-${++runSeq}`,
          pagesProcessed: 0,
          messagesProcessed: 0,
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
      delete: async ({ where }) => {
        const row = runs.get(where.id) || null;
        runs.delete(where.id);
        return row;
      },
    },
  };
  return api;
}


function seedCompletedDiscovery(db, generation = 7, status = "COMPLETED") {
  db._runs.set(`discovery-${generation}`, {
    id: `discovery-${generation}`,
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "__dialog_discovery__",
    mode: "discovery",
    status,
    generation,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
}

function seedPlanned(db, count, generation = 7) {
  for (let index = 1; index <= count; index += 1) {
    const dialogId = `dialog-${String(index).padStart(2, "0")}`;
    db._states.set(dialogId, {
      id: `state-${index}`,
      agencyId: "agency-1",
      creatorId: "creator-1",
      dialogId,
      fanId: `fan-${index}`,
      generation,
      scanMode: "initial",
      initialScanComplete: false,
      status: "PLANNED",
      pagesProcessed: 0,
      messagesProcessed: 0,
      createdAt: new Date(index),
      updatedAt: new Date(index),
    });
  }
}

test("PLANNED rows stay unavailable until the newest discovery generation is frozen", async () => {
  const db = createDb();
  seedPlanned(db, 2);
  seedCompletedDiscovery(db, 7, "RUNNING");
  const result = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 2,
  });
  assert.equal(result.batch, null);
  assert.equal(result.reason, "no_frozen_dialog_batch_ready");
  assert.equal([...db._states.values()].every((row) => row.status === "PLANNED"), true);
});

test("batch claim finalizes a committed terminal discovery boundary before looking for PLANNED rows", async () => {
  const db = createDb();
  seedPlanned(db, 2, 17);
  seedCompletedDiscovery(db, 17, "QUEUED");
  const run = db._runs.get("discovery-17");
  run.jobId = "discovery-job-17";
  run.progress = { pages: 321, dialogsFound: 16021, hasMore: false, nextOffset: 16021 };
  db._jobs.set("discovery-job-17", {
    id: "discovery-job-17", status: "SCHEDULED", leaseUntil: null,
    agencyId: "agency-1", creatorId: "creator-1",
  });
  db._commits.set("terminal-17", {
    id: "terminal-17", runId: run.id, mode: "discovery", hasMore: false,
    page: 321, result: { page: 321, hasMore: false, discovered: 21 },
  });

  const result = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 2,
  });

  assert.equal(db._jobs.get("discovery-job-17").status, "DONE");
  assert.equal(run.status, "COMPLETED");
  assert.equal(result.reason, "claimed");
  assert.deepEqual(result.batch.dialogs.map((item) => item.dialogId), ["dialog-01", "dialog-02"]);
});

test("stranded IDLE rows in the completed generation are repaired and claimed", async () => {
  const db = createDb();
  seedPlanned(db, 3);
  seedCompletedDiscovery(db);
  for (const state of db._states.values()) state.status = "IDLE";

  const result = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    creatorIds: ["creator-1"],
    batchSize: 3,
  });

  assert.equal(result.reason, "claimed");
  assert.deepEqual(result.batch.dialogs.map((item) => item.dialogId), ["dialog-01", "dialog-02", "dialog-03"]);
  assert.equal([...db._states.values()].every((row) => row.status === "RUNNING"), true);
});

test("durably cancelled history plan does not resurrect IDLE rows", async () => {
  const db = createDb();
  seedPlanned(db, 1);
  seedCompletedDiscovery(db);
  db._states.get("dialog-01").status = "IDLE";
  db._runs.get("discovery-7").continuation = {
    historyControl: { state: "CANCELLED", reason: "cancelled by user" },
  };

  const result = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    creatorIds: ["creator-1"],
    batchSize: 1,
  });

  assert.equal(result.batch, null);
  assert.equal(result.reason, "dialog_history_cancelled");
  assert.equal(db._states.get("dialog-01").status, "IDLE");
});

test("one claim reserves one compact batch and creates no JobInstance", async () => {
  const db = createDb();
  seedPlanned(db, 5);
  seedCompletedDiscovery(db);

  const result = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    creatorIds: ["creator-1"],
    batchSize: 3,
    leaseMs: 600_000,
  });

  assert.equal(result.reason, "claimed");
  assert.equal(result.batch.dialogs.length, 3);
  assert.deepEqual(result.batch.dialogs.map((item) => item.dialogId), ["dialog-01", "dialog-02", "dialog-03"]);
  assert.equal([...db._runs.values()].filter((row) => row.dialogId === DIALOG_HISTORY_BATCH_DIALOG_ID).length, 1);
  const run = db._runs.get(result.batch.id);
  assert.equal(run.dialogId, DIALOG_HISTORY_BATCH_DIALOG_ID);
  assert.equal(run.status, "RUNNING");
  assert.equal([...db._states.values()].filter((row) => row.status === "RUNNING").length, 3);
  assert.equal([...db._states.values()].filter((row) => row.status === "PLANNED").length, 2);
  assert.equal(db._locks.length, 1);
  assert.match(db._locks[0][0], /pg_advisory_xact_lock[\s\S]*::text/);
  assert.equal(db._locks[0][1], "dialog_history_batch_claim:agency-1");
});

test("the same stable device reattaches to its live batch after a Desktop restart", async () => {
  const db = createDb();
  seedPlanned(db, 3);
  seedCompletedDiscovery(db);

  const first = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    creatorIds: ["creator-1"],
    batchSize: 3,
    leaseMs: 600_000,
  });
  const oldToken = first.batch.leaseToken;

  const reclaimed = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    creatorIds: ["creator-1"],
    batchSize: 3,
    leaseMs: 600_000,
  });

  assert.equal(reclaimed.reason, "reclaimed");
  assert.equal(reclaimed.batch.id, first.batch.id);
  assert.notEqual(reclaimed.batch.leaseToken, oldToken);
  assert.deepEqual(reclaimed.batch.dialogs.map((item) => item.dialogId), ["dialog-01", "dialog-02", "dialog-03"]);
  assert.equal([...db._states.values()].every((row) => row.status === "RUNNING"), true);

  const otherDevice = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-b",
    creatorIds: ["creator-1"],
    batchSize: 3,
  });
  assert.equal(otherDevice.batch, null);
  assert.equal(otherDevice.reason, "creator_batch_already_active");
});

test("a contradictory PLANNED initial tail is claimed per item instead of draining forever", async () => {
  const db = createDb();
  seedPlanned(db, 2);
  seedCompletedDiscovery(db);
  const alreadyInitial = db._states.get("dialog-01");
  alreadyInitial.initialScanComplete = true;
  alreadyInitial.scanMode = "initial";

  const claim = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    creatorIds: ["creator-1"],
    batchSize: 2,
  });

  assert.equal(claim.reason, "claimed");
  assert.deepEqual(claim.batch.dialogs.map((item) => [item.dialogId, item.mode]), [
    ["dialog-01", "incremental"],
    ["dialog-02", "initial"],
  ]);

  await completeDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    batchId: claim.batch.id,
    leaseToken: claim.batch.leaseToken,
    results: [
      { dialogId: "dialog-01", ok: true, pages: 1, messages: 2 },
      { dialogId: "dialog-02", ok: true, pages: 2, messages: 10 },
    ],
  });

  assert.ok(db._states.get("dialog-01").lastIncrementalScanAt instanceof Date);
  assert.equal(db._states.get("dialog-01").initialScanComplete, true);
  assert.ok(db._states.get("dialog-02").lastFullScanAt instanceof Date);
  assert.equal(db._states.get("dialog-02").initialScanComplete, true);
});

test("an active or paused creator batch that still owns dialogs blocks a second claim", async () => {
  for (const status of ["RUNNING", "PAUSED"]) {
    const db = createDb();
    seedPlanned(db, 2);
    seedCompletedDiscovery(db);
    const runId = `existing-${status}`;
    db._runs.set(runId, {
      id: runId,
      agencyId: "agency-1",
      creatorId: "creator-1",
      dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID,
      status,
      generation: 7,
      continuation: {
        leaseUntil: new Date(Date.now() + 600_000).toISOString(),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const owned = db._states.get("dialog-01");
    owned.status = status;
    owned.activeRunId = runId;

    const result = await claimDialogHistoryBatchTx(db, {
      agencyId: "agency-1",
      deviceId: "device-b",
      creatorIds: ["creator-1"],
      batchSize: 2,
    });

    assert.equal(result.batch, null);
    assert.equal(result.reason, "creator_batch_already_active");
    assert.equal(db._runs.get(runId).status, status);
    assert.equal(db._states.get("dialog-01").activeRunId, runId);
  }
});

test("a stale synthetic batch from an older generation is cancelled before claiming current PLANNED rows", async () => {
  const db = createDb();
  seedPlanned(db, 2, 8);
  seedCompletedDiscovery(db, 8);
  db._runs.set("stale-batch", {
    id: "stale-batch",
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID,
    status: "RUNNING",
    generation: 7,
    continuation: { leaseUntil: new Date(Date.now() + 600_000).toISOString() },
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });

  const result = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-b",
    creatorIds: ["creator-1"],
    batchSize: 2,
  });

  assert.equal(result.reason, "claimed");
  assert.equal(result.batch.dialogs.length, 2);
  assert.equal(db._runs.get("stale-batch").status, "CANCELLED");
  assert.equal(db._runs.get("stale-batch").lastError, "DIALOG_HISTORY_BATCH_SUPERSEDED");
});

test("an orphaned paused batch with no owned PAUSED dialogs cannot block forever", async () => {
  const db = createDb();
  seedPlanned(db, 1);
  seedCompletedDiscovery(db);
  db._runs.set("paused-orphan", {
    id: "paused-orphan",
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID,
    status: "PAUSED",
    generation: 7,
    continuation: { leaseUntil: new Date(Date.now() + 600_000).toISOString() },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const normalized = await normalizeOrphanedDialogHistoryBatchesTx(db, {
    agencyId: "agency-1",
    creatorIds: ["creator-1"],
  });
  assert.equal(normalized.normalized, 1);
  assert.equal(db._runs.get("paused-orphan").status, "CANCELLED");

  const result = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 1,
  });
  assert.equal(result.reason, "claimed");
});


test("live batch progress exposes the real dialog and renews the lease", async () => {
  const db = createDb();
  seedPlanned(db, 2);
  seedCompletedDiscovery(db);
  const claim = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 2, leaseMs: 60_000,
  });
  const beforeLease = new Date(claim.batch.leaseUntil).getTime();
  const progress = await progressDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    batchId: claim.batch.id,
    leaseToken: claim.batch.leaseToken,
    leaseMs: 120_000,
    progress: {
      current: 0, total: 2, completed: 0, failed: 0, replanned: 0,
      dialogId: "dialog-01", fanId: "fan-1", stage: "scanning",
      pages: 3, messages: 147, media: 12, message: "Dialog 1/2 · 147 messages",
    },
  });

  assert.equal(progress.ok, true);
  assert.equal(progress.progress.dialogId, "dialog-01");
  assert.equal(progress.progress.fanId, "fan-1");
  assert.equal(progress.progress.stage, "scanning");
  assert.equal(progress.progress.pages, 3);
  assert.equal(progress.progress.messages, 147);
  assert.equal(progress.progress.media, 12);
  assert.ok(new Date(progress.leaseUntil).getTime() > beforeLease);
  assert.deepEqual(db._runs.get(claim.batch.id).progress, progress.progress);
});

test("one completion report closes the whole batch and is idempotent", async () => {
  const db = createDb();
  seedPlanned(db, 4);
  seedCompletedDiscovery(db);
  const claim = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 4,
  });
  const input = {
    agencyId: "agency-1",
    deviceId: "device-a",
    batchId: claim.batch.id,
    leaseToken: claim.batch.leaseToken,
    results: [
      { dialogId: "dialog-01", ok: true, pages: 4, messages: 120, inserted: 120, newestMessageId: "message-120", newestMessageAt: "2026-07-22T12:00:00.000Z" },
      { dialogId: "dialog-02", ok: false, retryable: true, error: "HTTP_429" },
      { dialogId: "dialog-03", ok: false, retryable: false, unavailable: true, code: "DIALOG_UNAVAILABLE", status: 403, error: "geo blocked" },
      { dialogId: "dialog-04", ok: false, retryable: false, code: "INVALID_SCAN_WORK", error: "bad payload" },
    ],
  };

  const completed = await completeDialogHistoryBatchTx(db, input);
  assert.deepEqual(
    { completed: completed.completed, replanned: completed.replanned, unavailable: completed.unavailable, failed: completed.failed },
    { completed: 1, replanned: 1, unavailable: 1, failed: 1 },
  );
  assert.equal(db._states.get("dialog-01").status, "READY");
  assert.equal(db._states.get("dialog-01").initialScanComplete, true);
  assert.equal(db._states.get("dialog-01").newestMessageId, "message-120");
  assert.equal(db._states.get("dialog-01").confirmedWatermarkMessageId, "message-120");
  assert.equal(db._states.get("dialog-01").newestMessageAt.toISOString(), "2026-07-22T12:00:00.000Z");
  assert.equal(db._states.get("dialog-01").confirmedWatermarkAt.toISOString(), "2026-07-22T12:00:00.000Z");
  assert.equal(db._states.get("dialog-02").status, "PLANNED");
  assert.equal(db._states.get("dialog-03").status, "UNAVAILABLE");
  assert.match(db._states.get("dialog-03").lastError, /DIALOG_UNAVAILABLE.*HTTP 403.*geo blocked/);
  assert.equal(db._states.get("dialog-04").status, "FAILED");
  assert.equal(db._runs.get(claim.batch.id).status, "COMPLETED");
  assert.equal(db._runs.get(claim.batch.id).progress.skipped, 1);

  const replay = await completeDialogHistoryBatchTx(db, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.completed, 1);
  assert.equal(replay.unavailable, 1);
  assert.equal(db._states.get("dialog-01").messagesProcessed, 120);
});

test("terminal phantom dialog results are resolved as unavailable instead of failing the creator scan", async () => {
  const db = createDb();
  seedPlanned(db, 1);
  seedCompletedDiscovery(db);
  const claim = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 1,
  });

  const completed = await completeDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    batchId: claim.batch.id,
    leaseToken: claim.batch.leaseToken,
    results: [{
      dialogId: "dialog-01",
      ok: false,
      retryable: false,
      code: "DIALOG_BATCH_ITEM_ID_MISSING",
      error: "Historical dialog no longer has an addressable target",
    }],
  });

  assert.equal(completed.failed, 0);
  assert.equal(completed.unavailable, 1);
  assert.equal(db._states.get("dialog-01").status, "UNAVAILABLE");
  assert.equal(db._runs.get(claim.batch.id).lastError, null);
});


test("OnlyFans User not found result is resolved as unavailable", async () => {
  const db = createDb();
  seedPlanned(db, 1);
  seedCompletedDiscovery(db);
  const claim = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 1,
  });

  const completed = await completeDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    batchId: claim.batch.id,
    leaseToken: claim.batch.leaseToken,
    results: [{
      dialogId: "dialog-01",
      ok: false,
      retryable: false,
      code: "OF_REQUEST_FAILED",
      error: "User not found",
    }],
  });

  assert.equal(completed.failed, 0);
  assert.equal(completed.unavailable, 1);
  assert.equal(db._states.get("dialog-01").status, "UNAVAILABLE");
  assert.equal(db._runs.get(claim.batch.id).lastError, null);
});

test("terminal phantom machine code in error text is also resolved as unavailable", async () => {
  const db = createDb();
  seedPlanned(db, 1);
  seedCompletedDiscovery(db);
  const claim = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 1,
  });

  const completed = await completeDialogHistoryBatchTx(db, {
    agencyId: "agency-1",
    deviceId: "device-a",
    batchId: claim.batch.id,
    leaseToken: claim.batch.leaseToken,
    results: [{
      dialogId: "dialog-01",
      ok: false,
      retryable: false,
      error: "DIALOG_BATCH_ITEM_ID_MISSING",
    }],
  });

  assert.equal(completed.failed, 0);
  assert.equal(completed.unavailable, 1);
  assert.equal(db._states.get("dialog-01").status, "UNAVAILABLE");
  assert.equal(db._runs.get(claim.batch.id).lastError, null);
});

test("expired or explicitly released batches return their dialogs to PLANNED", async () => {
  const db = createDb();
  seedPlanned(db, 4);
  seedCompletedDiscovery(db);
  const claim = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 2,
  });
  const released = await releaseDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", batchId: claim.batch.id,
    leaseToken: claim.batch.leaseToken, reason: "desktop_shutdown",
  });
  assert.equal(released.released, 2);
  assert.equal(db._runs.get(claim.batch.id).status, "CANCELLED");
  assert.equal([...db._states.values()].filter((row) => row.status === "PLANNED").length, 4);

  const second = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-b", creatorIds: ["creator-1"], batchSize: 2,
  });
  const run = db._runs.get(second.batch.id);
  run.continuation = { ...run.continuation, leaseUntil: new Date(Date.now() - 1_000).toISOString() };
  const recovered = await recoverExpiredDialogHistoryBatchesTx(db, {
    agencyId: "agency-1", creatorIds: ["creator-1"], now: new Date(),
  });
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.dialogCount, 2);
  assert.equal(run.status, "FAILED");
  assert.equal([...db._states.values()].filter((row) => row.status === "PLANNED").length, 4);

  const third = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-c", creatorIds: ["creator-1"], batchSize: 1,
  });
  const missingLeaseRun = db._runs.get(third.batch.id);
  missingLeaseRun.continuation = { ...missingLeaseRun.continuation, leaseUntil: null };
  const missingLease = await recoverExpiredDialogHistoryBatchesTx(db, {
    agencyId: "agency-1", creatorIds: ["creator-1"], now: new Date(),
  });
  assert.equal(missingLease.recovered, 1);
  assert.equal(missingLeaseRun.status, "FAILED");
  assert.equal(missingLeaseRun.lastError, "DIALOG_HISTORY_BATCH_LEASE_MISSING");
});
