"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
delete require.cache[require.resolve("./dialog-history-batch-service")];
const {
  DIALOG_HISTORY_BATCH_DIALOG_ID,
  claimDialogHistoryBatchTx,
  completeDialogHistoryBatchTx,
  releaseDialogHistoryBatchTx,
  recoverExpiredDialogHistoryBatchesTx,
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
  const locks = [];
  let runSeq = 0;
  const api = {
    _states: states,
    _runs: runs,
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

test("an active or paused creator batch blocks a second claim without touching the plan", async () => {
  for (const status of ["RUNNING", "PAUSED"]) {
    const db = createDb();
    seedPlanned(db, 2);
    seedCompletedDiscovery(db);
    db._runs.set(`existing-${status}`, {
      id: `existing-${status}`,
      agencyId: "agency-1",
      creatorId: "creator-1",
      dialogId: DIALOG_HISTORY_BATCH_DIALOG_ID,
      status,
      continuation: {
        leaseUntil: new Date(Date.now() + 600_000).toISOString(),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await claimDialogHistoryBatchTx(db, {
      agencyId: "agency-1",
      deviceId: "device-b",
      creatorIds: ["creator-1"],
      batchSize: 2,
    });

    assert.equal(result.batch, null);
    assert.equal(result.reason, "creator_batch_already_active");
    assert.equal([...db._runs.values()].filter((row) => row.dialogId === DIALOG_HISTORY_BATCH_DIALOG_ID).length, 1);
    assert.equal([...db._states.values()].every((row) => row.status === "PLANNED"), true);
  }
});

test("one completion report closes the whole batch and is idempotent", async () => {
  const db = createDb();
  seedPlanned(db, 3);
  seedCompletedDiscovery(db);
  const claim = await claimDialogHistoryBatchTx(db, {
    agencyId: "agency-1", deviceId: "device-a", creatorIds: ["creator-1"], batchSize: 3,
  });
  const input = {
    agencyId: "agency-1",
    deviceId: "device-a",
    batchId: claim.batch.id,
    leaseToken: claim.batch.leaseToken,
    results: [
      { dialogId: "dialog-01", ok: true, pages: 4, messages: 120, inserted: 120 },
      { dialogId: "dialog-02", ok: false, retryable: true, error: "HTTP_429" },
      { dialogId: "dialog-03", ok: false, retryable: false, error: "DIALOG_NOT_FOUND" },
    ],
  };

  const completed = await completeDialogHistoryBatchTx(db, input);
  assert.deepEqual(
    { completed: completed.completed, replanned: completed.replanned, failed: completed.failed },
    { completed: 1, replanned: 1, failed: 1 },
  );
  assert.equal(db._states.get("dialog-01").status, "READY");
  assert.equal(db._states.get("dialog-01").initialScanComplete, true);
  assert.equal(db._states.get("dialog-02").status, "PLANNED");
  assert.equal(db._states.get("dialog-03").status, "FAILED");
  assert.equal(db._runs.get(claim.batch.id).status, "COMPLETED");

  const replay = await completeDialogHistoryBatchTx(db, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.completed, 1);
  assert.equal(db._states.get("dialog-01").messagesProcessed, 120);
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
});
