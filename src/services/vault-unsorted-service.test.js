"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
const schedulerModule = require.resolve("./job-scheduler");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
require.cache[schedulerModule] = {
  id: schedulerModule,
  filename: schedulerModule,
  loaded: true,
  exports: { scheduleJobNow: async () => { throw new Error("not used in this test"); } },
};
delete require.cache[require.resolve("./vault-unsorted-service")];
const {
  applyVaultUnsortedChunk,
  applyVaultUnsortedCompletion,
  getVaultUnsortedState,
  snapshotPayload,
} = require("./vault-unsorted-service");

function fixture(existingIds = []) {
  const rows = new Map(existingIds.map((mediaId) => [mediaId, {
    mediaId,
    status: "UNSORTED",
    lastSeenJobId: "old-job",
  }]));
  let snapshot = null;
  const calls = { deleteMany: [], upserts: 0 };
  const db = {
    vaultUnsortedItem: {
      count: async ({ where }) => [...rows.values()].filter((row) => !where.status || row.status === where.status).length,
      findMany: async ({ where }) => [...rows.values()]
        .filter((row) => where.mediaId?.in?.includes(row.mediaId))
        .map((row) => ({ mediaId: row.mediaId })),
      upsert: async ({ where, create, update }) => {
        const id = where.agencyId_creatorId_mediaId.mediaId;
        rows.set(id, rows.has(id) ? { ...rows.get(id), ...update } : { ...create });
        calls.upserts += 1;
        return rows.get(id);
      },
      deleteMany: async ({ where }) => {
        calls.deleteMany.push(where);
        let count = 0;
        for (const [id, row] of rows) {
          if (where.NOT?.lastSeenJobId && row.lastSeenJobId !== where.NOT.lastSeenJobId) {
            rows.delete(id);
            count += 1;
          }
        }
        return { count };
      },
      updateMany: async () => ({ count: 0 }),
    },
    vaultUnsortedSnapshot: {
      findUnique: async () => snapshot,
      upsert: async ({ create, update }) => {
        snapshot = snapshot ? { ...snapshot, ...update, updatedAt: new Date() } : {
          id: "snapshot-1",
          creatorId: "creator-1",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        return snapshot;
      },
    },
  };
  return { db, rows, calls, getSnapshot: () => snapshot };
}

const job = {
  id: "job-1",
  agencyId: "agency-1",
  creatorId: "creator-1",
  params: { mode: "incremental", knownStreakLimit: 3, maxPages: 100 },
};

test("incremental Unsorted scan stops after the configured consecutive known-media threshold", async () => {
  const fx = fixture(["m1", "m2", "m3"]);
  const result = await applyVaultUnsortedChunk({
    db: fx.db,
    job,
    chunkResult: {
      kind: "vault_unsorted_media_page",
      continuation: {
        phase: "media", mode: "incremental", messagesFolderId: "messages",
        offset: 0, pages: 0, scanned: 0, knownStreak: 0,
      },
      items: ["m1", "m2", "m3"].map((mediaId) => ({ mediaId, status: "UNSORTED", folderIds: [] })),
      hasMore: true,
      nextOffset: 3,
    },
  });

  assert.equal(result.completeAfterCommit, true);
  assert.equal(result.completionResult.knownStreak, 3);
  assert.equal(result.completionResult.stoppedReason, "known_streak_3");
  assert.equal(fx.calls.upserts, 3);
  assert.equal(fx.getSnapshot().payload.scan.scanned, 3);
});

test("full scan keeps the last complete generation visible until fenced completion", async () => {
  const fx = fixture(["old-1", "old-2"]);
  const fullJob = { ...job, params: { ...job.params, mode: "full" } };

  await applyVaultUnsortedChunk({
    db: fx.db,
    job: fullJob,
    chunkResult: {
      kind: "vault_unsorted_begin",
      continuation: {
        phase: "media", mode: "full", messagesFolderId: "messages",
        customFolderIds: ["custom-1"], offset: 0, pages: 0, scanned: 0, knownStreak: 0,
      },
    },
  });

  assert.equal(fx.calls.deleteMany.length, 0);
  assert.equal(fx.rows.size, 2);
  assert.equal(fx.getSnapshot().payload.scan.status, "RUNNING");
});

test("full completion prunes rows not stamped by the completed job generation", async () => {
  const fx = fixture(["fresh", "stale"]);
  fx.rows.get("fresh").lastSeenJobId = "job-1";
  fx.rows.get("stale").lastSeenJobId = "old-job";
  const fullJob = { ...job, params: { ...job.params, mode: "full" } };

  const result = await applyVaultUnsortedCompletion({
    db: fx.db,
    job: fullJob,
    result: { mode: "full", pages: 2, scanned: 80, knownStreak: 0 },
  });

  assert.equal(fx.calls.deleteMany.length, 1);
  assert.deepEqual([...fx.rows.keys()], ["fresh"]);
  assert.equal(result.snapshot.itemsCount, 1);
  assert.equal(result.snapshot.scan.status, "COMPLETED");
});

test("snapshot payload is compact and does not embed thousands of media rows", () => {
  const payload = snapshotPayload(null, { scanStatus: "RUNNING", pages: 4, scanned: 160, knownStreak: 12 });
  assert.equal(payload.schema, 3);
  assert.equal(payload.scan.pages, 4);
  assert.equal(payload.scan.scanned, 160);
  assert.equal(Object.hasOwn(payload, "items"), false);
  assert.equal(Object.hasOwn(payload, "media"), false);
});

test("Messages catalog writes one parameterized PostgreSQL UPSERT per OF page", async () => {
  const fx = fixture([]);
  let rawCalls = 0;
  let rawSql = "";
  let rawParams = [];
  fx.db.$executeRawUnsafe = async (sql, ...params) => {
    rawCalls += 1;
    rawSql = sql;
    rawParams = params;
    return 3;
  };
  await applyVaultUnsortedChunk({
    db: fx.db,
    job: { ...job, params: { ...job.params, mode: "full" } },
    chunkResult: {
      kind: "vault_unsorted_media_page",
      continuation: {
        phase: "media", mode: "full", messagesFolderId: "messages",
        offset: 0, pages: 0, scanned: 0, knownStreak: 0,
      },
      items: ["m1", "m2", "m3"].map((mediaId) => ({ mediaId, status: "UNSORTED", mediaType: "photo", folderIds: [] })),
      hasMore: true,
      nextOffset: 3,
    },
  });
  assert.equal(rawCalls, 1);
  assert.equal(fx.calls.upserts, 0);
  assert.match(rawSql, /ON CONFLICT \("agencyId", "creatorId", "mediaId"\) DO UPDATE/);
  assert.equal(rawParams.length, 3 * 14);
});


test("orphaned RUNNING Messages snapshot is reconciled from its terminal job", async () => {
  const fx = fixture(["m1"]);
  const started = new Date("2026-07-18T10:00:00.000Z");
  let snapshot = {
    id: "snapshot-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    itemsCount: 1,
    unsortedCount: 1,
    sortedCount: 0,
    capturedAt: started,
    updatedAt: started,
    payload: {
      schema: 3,
      kind: "vault_unsorted_snapshot",
      messagesFolderId: "messages",
      lastFullScanAt: null,
      lastIncrementalScanAt: null,
      scan: {
        status: "RUNNING",
        mode: "full",
        jobId: "job-done",
        pages: 10,
        scanned: 400,
        knownStreak: 0,
        startedAt: started.toISOString(),
        completedAt: null,
        lastError: null,
      },
    },
  };
  fx.db.vaultUnsortedSnapshot.findUnique = async () => snapshot;
  fx.db.vaultUnsortedSnapshot.upsert = async ({ create, update }) => {
    snapshot = snapshot ? { ...snapshot, ...update, updatedAt: new Date() } : { ...create };
    return snapshot;
  };
  fx.db.jobInstance = {
    async findFirst() { return null; },
    async findUnique() {
      return {
        id: "job-done",
        status: "DONE",
        params: { mode: "full" },
        result: { mode: "full", pages: 12, scanned: 480, knownStreak: 0 },
        progress: { current: 480, pages: 12 },
        completedAt: new Date("2026-07-18T10:15:00.000Z"),
      };
    },
  };

  const state = await getVaultUnsortedState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: fx.db,
  });

  assert.equal(state.activeJob, null);
  assert.equal(state.snapshot.scan.status, "COMPLETED");
  assert.equal(state.snapshot.scan.pages, 12);
  assert.equal(state.snapshot.scan.scanned, 480);
  assert.equal(state.snapshot.lastFullScanAt, "2026-07-18T10:15:00.000Z");
});
