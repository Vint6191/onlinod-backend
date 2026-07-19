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
  const assets = new Map(existingIds.map((mediaId) => [mediaId, {
    id: `asset-${mediaId}`,
    mediaId,
    catalogActive: true,
    sortingStatus: "UNSORTED",
    mediaType: "unknown",
    folderIds: [],
    lastSeenJobId: "old-job",
  }]));
  const stage = new Map();
  let snapshot = null;
  const calls = { assetDeleteMany: [], stageDeleteMany: [], assetUpserts: 0, stageUpserts: 0 };

  function assetMatches(row, where = {}) {
    if (where.catalogActive !== undefined && row.catalogActive !== where.catalogActive) return false;
    if (where.sortingStatus && row.sortingStatus !== where.sortingStatus) return false;
    if (where.mediaId?.in && !where.mediaId.in.includes(row.mediaId)) return false;
    if (where.mediaId?.notIn && where.mediaId.notIn.includes(row.mediaId)) return false;
    return true;
  }

  const db = {
    creatorMediaAsset: {
      count: async ({ where }) => [...assets.values()].filter((row) => assetMatches(row, where)).length,
      findMany: async ({ where }) => [...assets.values()]
        .filter((row) => assetMatches(row, where))
        .map((row) => ({ ...row })),
      upsert: async ({ where, create, update }) => {
        const mediaId = where.creatorId_mediaId.mediaId;
        assets.set(mediaId, assets.has(mediaId) ? { ...assets.get(mediaId), ...update } : { id: `asset-${mediaId}`, ...create });
        calls.assetUpserts += 1;
        return assets.get(mediaId);
      },
      deleteMany: async ({ where }) => {
        calls.assetDeleteMany.push(where);
        let count = 0;
        for (const [mediaId, row] of assets) {
          if (!assetMatches(row, where)) continue;
          assets.delete(mediaId);
          count += 1;
        }
        return { count };
      },
      updateMany: async () => ({ count: 0 }),
    },
    mediaLibraryScanItem: {
      count: async ({ where }) => [...stage.values()].filter((row) => row.jobId === where.jobId).length,
      findMany: async ({ where }) => [...stage.values()].filter((row) => row.jobId === where.jobId).map((row) => ({ ...row })),
      upsert: async ({ where, create, update }) => {
        const mediaId = where.jobId_mediaId.mediaId;
        stage.set(mediaId, stage.has(mediaId) ? { ...stage.get(mediaId), ...update } : { id: `stage-${mediaId}`, ...create });
        calls.stageUpserts += 1;
        return stage.get(mediaId);
      },
      deleteMany: async ({ where }) => {
        calls.stageDeleteMany.push(where);
        let count = 0;
        for (const [mediaId, row] of stage) {
          if (where.jobId && row.jobId !== where.jobId) continue;
          stage.delete(mediaId);
          count += 1;
        }
        return { count };
      },
      updateMany: async () => ({ count: 0 }),
    },
    vaultUnsortedSnapshot: {
      findUnique: async () => snapshot,
      upsert: async ({ create, update }) => {
        snapshot = snapshot ? { ...snapshot, ...update, updatedAt: new Date() } : {
          id: "snapshot-1", creatorId: "creator-1", createdAt: new Date(), updatedAt: new Date(), ...create,
        };
        return snapshot;
      },
    },
  };
  return { db, assets, stage, calls, getSnapshot: () => snapshot };
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
      continuation: { phase: "media", mode: "incremental", messagesFolderId: "messages", offset: 0, pages: 0, scanned: 0, knownStreak: 0 },
      items: ["m1", "m2", "m3"].map((mediaId) => ({ mediaId, status: "UNSORTED", folderIds: [] })),
      hasMore: true,
      nextOffset: 3,
    },
  });
  assert.equal(result.completeAfterCommit, true);
  assert.equal(result.completionResult.knownStreak, 3);
  assert.equal(result.completionResult.stoppedReason, "known_streak_3");
  assert.equal(fx.calls.assetUpserts, 3);
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
      continuation: { phase: "media", mode: "full", messagesFolderId: "messages", customFolderIds: ["custom-1"], offset: 0, pages: 0, scanned: 0, knownStreak: 0 },
    },
  });
  assert.equal(fx.calls.assetDeleteMany.length, 0);
  assert.equal(fx.assets.size, 2);
  assert.equal(fx.calls.stageDeleteMany.length, 1);
  assert.equal(fx.getSnapshot().payload.scan.status, "RUNNING");
});

test("full completion atomically publishes staging and prunes every absent row", async () => {
  const fx = fixture(["fresh", "stale"]);
  fx.stage.set("fresh", {
    id: "stage-fresh", agencyId: "agency-1", creatorId: "creator-1", jobId: "job-1", mediaId: "fresh",
    sortingStatus: "SORTED", mediaType: "video", durationSec: 2, thumbUrl: null, previewUrl: null, fullUrl: null,
    folderIds: ["custom"], seenAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
  });
  const fullJob = { ...job, params: { ...job.params, mode: "full" } };
  const result = await applyVaultUnsortedCompletion({ db: fx.db, job: fullJob, result: { mode: "full", pages: 2, scanned: 1, expectedMediaCount: 1, knownStreak: 0 } });
  assert.equal(fx.calls.assetDeleteMany.length, 1);
  assert.deepEqual([...fx.assets.keys()], ["fresh"]);
  assert.equal(result.snapshot.itemsCount, 1);
  assert.equal(result.snapshot.scan.status, "COMPLETED");
});

test("incomplete full completion preserves the previous catalog instead of shrinking it", async () => {
  const fx = fixture(["fresh-1", "fresh-2", "previous-only"]);
  for (const mediaId of ["fresh-1", "fresh-2"]) {
    fx.stage.set(mediaId, { id: `stage-${mediaId}`, agencyId: "agency-1", creatorId: "creator-1", jobId: "job-1", mediaId });
  }
  const fullJob = { ...job, params: { ...job.params, mode: "full" } };
  const result = await applyVaultUnsortedCompletion({
    db: fx.db,
    job: fullJob,
    result: { mode: "full", pages: 45, scanned: 1777, expectedMediaCount: 2104, knownStreak: 0 },
  });
  assert.equal(fx.calls.assetDeleteMany.length, 0);
  assert.deepEqual([...fx.assets.keys()], ["fresh-1", "fresh-2", "previous-only"]);
  assert.equal(result.published, false);
  assert.equal(result.incomplete, true);
  assert.equal(result.seenByJob, 2);
  assert.match(result.snapshot.scan.lastError, /expected 2104, received 2/);
});

test("snapshot payload is compact and does not embed thousands of media rows", () => {
  const payload = snapshotPayload(null, { scanStatus: "RUNNING", pages: 4, scanned: 160, knownStreak: 12 });
  assert.equal(payload.schema, 3);
  assert.equal(payload.scan.pages, 4);
  assert.equal(payload.scan.scanned, 160);
  assert.equal(Object.hasOwn(payload, "items"), false);
  assert.equal(Object.hasOwn(payload, "media"), false);
});

test("Messages catalog writes one parameterized staging UPSERT per OF page", async () => {
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
      continuation: { phase: "media", mode: "full", messagesFolderId: "messages", offset: 0, pages: 0, scanned: 0, knownStreak: 0 },
      items: ["m1", "m2", "m3"].map((mediaId) => ({ mediaId, status: "UNSORTED", mediaType: "photo", folderIds: [] })),
      hasMore: true,
      nextOffset: 3,
    },
  });
  assert.equal(rawCalls, 1);
  assert.equal(fx.calls.stageUpserts, 0);
  assert.match(rawSql, /INSERT INTO "MediaLibraryScanItem"/);
  assert.match(rawSql, /ON CONFLICT \("jobId", "mediaId"\) DO UPDATE/);
  assert.equal(rawParams.length, 3 * 15);
});

test("orphaned RUNNING Messages snapshot is reconciled from its terminal job", async () => {
  const fx = fixture(["m1"]);
  const started = new Date("2026-07-18T10:00:00.000Z");
  let snapshot = {
    id: "snapshot-1", agencyId: "agency-1", creatorId: "creator-1", itemsCount: 1, unsortedCount: 1, sortedCount: 0,
    capturedAt: started, updatedAt: started,
    payload: {
      schema: 3, kind: "vault_unsorted_snapshot", messagesFolderId: "messages", lastFullScanAt: null, lastIncrementalScanAt: null,
      scan: { status: "RUNNING", mode: "full", jobId: "job-done", pages: 10, scanned: 400, knownStreak: 0, startedAt: started.toISOString(), completedAt: null, lastError: null },
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
      return { id: "job-done", status: "DONE", params: { mode: "full" }, result: { mode: "full", pages: 12, scanned: 480, knownStreak: 0 }, progress: { current: 480, pages: 12 }, completedAt: new Date("2026-07-18T10:15:00.000Z") };
    },
  };
  const state = await getVaultUnsortedState({ agencyId: "agency-1", creatorId: "creator-1", db: fx.db });
  assert.equal(state.activeJob, null);
  assert.equal(state.snapshot.scan.status, "COMPLETED");
  assert.equal(state.snapshot.scan.pages, 12);
  assert.equal(state.snapshot.scan.scanned, 480);
  assert.equal(state.snapshot.lastFullScanAt, "2026-07-18T10:15:00.000Z");
});
