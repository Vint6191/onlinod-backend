"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
const schedulerModule = require.resolve("./job-scheduler");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
require.cache[schedulerModule] = { id: schedulerModule, filename: schedulerModule, loaded: true, exports: { scheduleJobNow: async () => { throw new Error("not used"); } } };
delete require.cache[require.resolve("./vault-unsorted-service")];
delete require.cache[require.resolve("./vault-never-used-service")];
const {
  getNeverUsedPipelineState,
  listVaultNeverUsedMedia,
  projectionCounts,
  PROJECTION_CHUNK_SIZE,
} = require("./vault-never-used-service");

function date(offsetMs = 0) { return new Date(1_752_667_200_000 + offsetMs); }

function dbFixture({
  complete = false,
  catalogRows: suppliedRows = null,
  usedIds = ["used"],
  soldIds = [],
  dialogActiveJobs = [],
  unsortedActiveJob = null,
  dialogStates: suppliedDialogStates = null,
  discoveryRuns: suppliedDiscoveryRuns = null,
  activeRuns: suppliedActiveRuns = null,
} = {}) {
  const catalogRows = suppliedRows || (complete ? [
    { id: "row-used", mediaId: "used", mediaType: "video", sortingStatus: "SORTED", thumbUrl: "used.jpg", folderIds: ["folder-a"], durationSec: 2, lastSeenAt: date(), updatedAt: date() },
    { id: "row-unused", mediaId: "unused", mediaType: "photo", sortingStatus: "UNSORTED", thumbUrl: "unused.jpg", folderIds: [], durationSec: 0, lastSeenAt: date(), updatedAt: date() },
    { id: "row-sorted-unused", mediaId: "sorted-unused", mediaType: "photo", sortingStatus: "SORTED", thumbUrl: "sorted.jpg", folderIds: ["folder-b"], durationSec: 0, lastSeenAt: date(), updatedAt: date() },
  ] : []);
  const used = new Set([...usedIds, ...soldIds]);
  const visibleCatalog = catalogRows.map((row) => ({
    ...row,
    catalogActive: row.catalogActive !== false,
    sentCount: used.has(row.mediaId) ? 1 : 0,
    usageUpdatedAt: date(),
  })).filter((row) => row.catalogActive);
  const defaultDialogStates = complete ? [{
    dialogId: "dialog-1", scanMode: "initial", initialScanComplete: true, status: "COMPLETED",
    activeRunId: null, activeJobId: null, pagesProcessed: 3, messagesProcessed: 90,
    lastError: null, lastFullScanAt: date(), lastIncrementalScanAt: null, updatedAt: date(),
  }] : [];
  const dialogStates = suppliedDialogStates || defaultDialogStates;
  const discoveryRuns = suppliedDiscoveryRuns || (complete ? [{
    id: "disc", jobId: "disc-job", dialogId: "__dialog_discovery__", mode: "discovery",
    status: "COMPLETED", progress: { pages: 1, dialogs: dialogStates.length }, pagesProcessed: 1,
    purchaseSignals: dialogStates.length, completedAt: date(), updatedAt: date(), lastError: null,
  }] : []);
  const activeRuns = suppliedActiveRuns || [];

  function matchesCursor(rows, args) {
    const cursor = args.cursor?.id;
    const start = cursor ? Math.max(0, rows.findIndex((row) => row.id === cursor) + Number(args.skip || 0)) : Number(args.skip || 0);
    return rows.slice(start, start + Number(args.take || rows.length));
  }
  function filterCatalog(args) {
    let rows = visibleCatalog;
    const ids = args.where?.mediaId?.in;
    if (ids) rows = rows.filter((row) => ids.includes(row.mediaId));
    const type = args.where?.mediaType;
    if (type) rows = rows.filter((row) => row.mediaType === type);
    if (args.where?.catalogActive !== undefined) rows = rows.filter((row) => row.catalogActive === args.where.catalogActive);
    if (args.where?.sentCount === 0) rows = rows.filter((row) => row.sentCount === 0);
    if (args.where?.sentCount?.gt !== undefined) rows = rows.filter((row) => row.sentCount > args.where.sentCount.gt);
    return rows;
  }

  return {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    vaultUnsortedSnapshot: {
      async findUnique() {
        if (!complete) return null;
        return {
          id: "messages", creatorId: "creator-1", itemsCount: visibleCatalog.length,
          unsortedCount: visibleCatalog.filter((row) => row.sortingStatus === "UNSORTED").length,
          sortedCount: visibleCatalog.filter((row) => row.sortingStatus === "SORTED").length,
          capturedAt: date(), updatedAt: date(),
          payload: {
            schema: 3, kind: "vault_unsorted_snapshot", messagesFolderId: "messages",
            lastFullScanAt: date().toISOString(), lastIncrementalScanAt: null,
            scan: { status: "COMPLETED", mode: "full", jobId: "messages-job", pages: 4, scanned: visibleCatalog.length, knownStreak: 0, startedAt: date().toISOString(), completedAt: date().toISOString(), lastError: null },
          },
        };
      },
    },
    creatorMediaAsset: {
      async findMany(args) {
        const rows = filterCatalog(args);
        if (args.orderBy?.[0]?.lastSeenAt) {
          const sorted = [...rows].sort((a, b) => String(b.mediaId).localeCompare(String(a.mediaId)));
          return sorted.slice(Number(args.skip || 0), Number(args.skip || 0) + Number(args.take || sorted.length));
        }
        return matchesCursor(rows, args);
      },
      async count(args) { return filterCatalog(args).length; },
      async findFirst() {
        const row = visibleCatalog.find((item) => item.usageUpdatedAt);
        return row ? { usageUpdatedAt: row.usageUpdatedAt } : null;
      },
    },
    dialogScanState: {
      async findMany(args = {}) {
        let rows = dialogStates;
        if (args.where?.status) rows = rows.filter((row) => row.status === args.where.status);
        if (args.where?.activeRunId === null) rows = rows.filter((row) => row.activeRunId == null);
        if (args.where?.activeJobId === null) rows = rows.filter((row) => row.activeJobId == null);
        return rows;
      },
      async updateMany(args = {}) {
        const ids = new Set(args.where?.dialogId?.in || []);
        let count = 0;
        for (const row of dialogStates) {
          if (args.where?.status && row.status !== args.where.status) continue;
          if (args.where?.activeRunId === null && row.activeRunId != null) continue;
          if (args.where?.activeJobId === null && row.activeJobId != null) continue;
          if (ids.size && !ids.has(row.dialogId)) continue;
          Object.assign(row, args.data || {});
          count += 1;
        }
        return { count };
      },
    },
    dialogScanRun: {
      async findMany(args) {
        if (args.where?.dialogId === "__dialog_discovery__") return discoveryRuns;
        if (args.where?.status?.in) return activeRuns;
        return [];
      },
      async findFirst() {
        const rows = [...activeRuns, ...discoveryRuns];
        const latest = rows.sort((a, b) => Number(new Date(b.updatedAt || 0)) - Number(new Date(a.updatedAt || 0)))[0];
        return latest ? { updatedAt: latest.updatedAt, completedAt: latest.completedAt || null, lastError: latest.lastError || null } : null;
      },
    },
    jobInstance: {
      async findMany(args) {
        if (args.where?.id?.in) return [{ id: "disc-job", params: { childMode: "initial" } }];
        if (args.where?.jobKey === "dialog_intelligence_scan") return dialogActiveJobs;
        return [];
      },
      async findFirst(args) {
        if (args.where?.jobKey === "vault_unsorted_scan") return unsortedActiveJob;
        return null;
      },
    },
  };
}

test("zero committed pages cannot be reported as ready", async () => {
  const result = await getNeverUsedPipelineState({ agencyId: "agency-1", creatorId: "creator-1", db: dbFixture(), now: date() });
  assert.equal(result.pipeline.authoritative, false);
  assert.equal(result.pipeline.stage, "NOT_SCANNED");
  assert.equal(result.pipeline.projection.complete, false);
  assert.match(result.pipeline.provisionalReason, /Messages catalog initial scan is incomplete/i);
});

test("Messages full catalog plus initial dialog history makes the result authoritative", async () => {
  const result = await getNeverUsedPipelineState({ agencyId: "agency-1", creatorId: "creator-1", db: dbFixture({ complete: true }), now: date(60_000) });
  assert.equal(result.pipeline.authoritative, true);
  assert.equal(result.pipeline.stage, "UP_TO_DATE");
  assert.equal(Object.hasOwn(result.pipeline, "inventory"), false);
  assert.equal(result.pipeline.messagesCatalog.itemsCount, 3);
  assert.equal(result.pipeline.projection.catalogMedia, 3);
  assert.equal(result.pipeline.projection.usedCreatorMedia, 1);
  assert.equal(result.pipeline.projection.neverUsed, 2);
});

test("inaccessible dialogs drain the queue and do not block the projection", async () => {
  const dialogStates = [
    {
      dialogId: "dialog-ready", scanMode: "initial", initialScanComplete: true, status: "READY",
      activeRunId: null, activeJobId: null, pagesProcessed: 2, messagesProcessed: 50,
      lastError: null, lastFullScanAt: date(), lastIncrementalScanAt: null, updatedAt: date(),
    },
    {
      dialogId: "dialog-blocked", scanMode: "initial", initialScanComplete: false, status: "UNAVAILABLE",
      activeRunId: null, activeJobId: null, pagesProcessed: 0, messagesProcessed: 0,
      lastError: "DIALOG_UNAVAILABLE: HTTP 403", lastFullScanAt: null, lastIncrementalScanAt: null, updatedAt: date(),
    },
  ];
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: dbFixture({ complete: true, dialogStates }),
    now: date(60_000),
  });
  assert.equal(result.pipeline.stage, "UP_TO_DATE");
  assert.equal(result.pipeline.authoritative, true);
  assert.equal(result.pipeline.dialogs.pending, 0);
  assert.equal(result.pipeline.dialogs.unavailable, 1);
  assert.equal(result.pipeline.dialogs.queue.unavailable, 1);
  assert.equal(result.pipeline.provisionalReason, null);
  assert.equal(result.pipeline.projection.complete, true);
});

test("legacy terminal phantom failures are normalized to unavailable and finish successfully", async () => {
  const dialogStates = [
    {
      dialogId: "dialog-ready", scanMode: "initial", initialScanComplete: true, status: "READY",
      activeRunId: null, activeJobId: null, pagesProcessed: 2, messagesProcessed: 50,
      lastError: null, lastFullScanAt: date(), lastIncrementalScanAt: null, updatedAt: date(),
    },
    {
      dialogId: "dialog-phantom", scanMode: "initial", initialScanComplete: false, status: "FAILED",
      activeRunId: null, activeJobId: null, pagesProcessed: 0, messagesProcessed: 0,
      lastError: "DIALOG_BATCH_ITEM_ID_MISSING: historical target not found",
      lastFullScanAt: null, lastIncrementalScanAt: null, updatedAt: date(),
    },
  ];
  const db = dbFixture({ complete: true, dialogStates });
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db,
    now: date(60_000),
  });

  assert.equal(dialogStates[1].status, "UNAVAILABLE");
  assert.equal(result.pipeline.stage, "UP_TO_DATE");
  assert.equal(result.pipeline.authoritative, true);
  assert.equal(result.pipeline.dialogs.failed, 0);
  assert.equal(result.pipeline.dialogs.unavailable, 1);
  assert.equal(result.pipeline.dialogs.pending, 0);
});


test("legacy OF User not found failure is normalized to unavailable", async () => {
  const dialogStates = [
    {
      dialogId: "dialog-ready", scanMode: "initial", initialScanComplete: true, status: "READY",
      activeRunId: null, activeJobId: null, pagesProcessed: 2, messagesProcessed: 50,
      lastError: null, lastFullScanAt: date(), lastIncrementalScanAt: null, updatedAt: date(),
    },
    {
      dialogId: "579800822", scanMode: "initial", initialScanComplete: false, status: "FAILED",
      activeRunId: "stale-batch", activeJobId: "stale-job", pagesProcessed: 0, messagesProcessed: 0,
      lastError: "OF_REQUEST_FAILED: User not found",
      lastFullScanAt: null, lastIncrementalScanAt: null, updatedAt: date(),
    },
  ];
  const db = dbFixture({ complete: true, dialogStates });
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db,
    now: date(60_000),
  });

  assert.equal(dialogStates[1].status, "UNAVAILABLE");
  assert.equal(dialogStates[1].activeRunId, null);
  assert.equal(dialogStates[1].activeJobId, null);
  assert.equal(result.pipeline.stage, "UP_TO_DATE");
  assert.equal(result.pipeline.authoritative, true);
  assert.equal(result.pipeline.dialogs.failed, 0);
  assert.equal(result.pipeline.dialogs.unavailable, 1);
});

test("legacy terminal phantom failure is repaired even with stale ownership pointers", async () => {
  const dialogStates = [
    {
      dialogId: "dialog-ready", scanMode: "initial", initialScanComplete: true, status: "READY",
      activeRunId: null, activeJobId: null, pagesProcessed: 2, messagesProcessed: 50,
      lastError: null, lastFullScanAt: date(), lastIncrementalScanAt: null, updatedAt: date(),
    },
    {
      dialogId: "dialog-phantom", scanMode: "initial", initialScanComplete: false, status: "FAILED",
      activeRunId: "stale-batch", activeJobId: "stale-job", pagesProcessed: 0, messagesProcessed: 0,
      lastError: "DIALOG_BATCH_ITEM_ID_MISSING",
      lastFullScanAt: null, lastIncrementalScanAt: null, updatedAt: date(),
    },
  ];
  const db = dbFixture({ complete: true, dialogStates });
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db,
    now: date(60_000),
  });

  assert.equal(dialogStates[1].status, "UNAVAILABLE");
  assert.equal(dialogStates[1].activeRunId, null);
  assert.equal(dialogStates[1].activeJobId, null);
  assert.equal(result.pipeline.stage, "UP_TO_DATE");
  assert.equal(result.pipeline.authoritative, true);
  assert.equal(result.pipeline.dialogs.failed, 0);
  assert.equal(result.pipeline.dialogs.unavailable, 1);
});

test("both SORTED and UNSORTED Messages items are creator candidates; membership is not usage", async () => {
  const result = await projectionCounts(dbFixture({ complete: true }), "agency-1", "creator-1");
  assert.equal(result.catalogMedia, 3);
  assert.equal(result.usedCreatorMedia, 1);
  assert.equal(result.neverUsed, 2);
  assert.equal(result.byType.photo, 2);
  assert.equal(result.byType.video, 0);
});

test("Posts/SFS IDs outside Messages catalog never enter Never Used", async () => {
  const db = dbFixture({ complete: true });
  const page = await listVaultNeverUsedMedia({ agencyId: "agency-1", creatorId: "creator-1", db, limit: 40 });
  assert.deepEqual(page.media.map((item) => item.id).sort(), ["sorted-unused", "unused"]);
  assert.equal(page.media.some((item) => item.id === "foreign-sfs-post"), false);
  assert.equal(page.total, 2);
});


test("Never Used pagination never skips candidates inside an over-fetched catalog batch", async () => {
  const rows = Array.from({ length: 75 }, (_, index) => ({
    id: `row-${String(index).padStart(3, "0")}`,
    mediaId: `media-${String(index).padStart(3, "0")}`,
    mediaType: "photo",
    sortingStatus: index % 2 ? "SORTED" : "UNSORTED",
    thumbUrl: "",
    folderIds: [],
    durationSec: 0,
    lastSeenAt: date(75 - index),
    updatedAt: date(),
  }));
  const db = dbFixture({ complete: true, catalogRows: rows, usedIds: [] });
  const first = await listVaultNeverUsedMedia({ agencyId: "agency-1", creatorId: "creator-1", db, limit: 40 });
  const second = await listVaultNeverUsedMedia({ agencyId: "agency-1", creatorId: "creator-1", db, offset: first.nextOffset, limit: 40 });
  assert.equal(first.media.length, 40);
  assert.equal(first.nextOffset, 40);
  assert.equal(second.media.length, 35);
  assert.equal(second.nextOffset, 75);
  assert.equal(new Set([...first.media, ...second.media].map((item) => item.id)).size, 75);
  assert.equal(second.hasMore, false);
});

test("dialog or sales evidence removes a catalog item from Never Used", async () => {
  const result = await projectionCounts(dbFixture({ complete: true, usedIds: ["used"], soldIds: ["unused"] }), "agency-1", "creator-1");
  assert.equal(result.usedCreatorMedia, 2);
  assert.equal(result.neverUsed, 1);
});

test("an authoritative result becomes STALE after the bounded freshness window", async () => {
  const result = await getNeverUsedPipelineState({ agencyId: "agency-1", creatorId: "creator-1", db: dbFixture({ complete: true }), now: date(4 * 60 * 60 * 1000), staleAfter: 3 * 60 * 60 * 1000 });
  assert.equal(result.pipeline.stage, "STALE");
  assert.match(result.pipeline.staleReason, /Messages catalog/i);
});

test("the default freshness window is one day and never triggers a three-hour renderer rescan", async () => {
  const fresh = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: dbFixture({ complete: true }),
    now: date(23 * 60 * 60 * 1000),
  });
  assert.equal(fresh.pipeline.stage, "UP_TO_DATE");
  assert.equal(fresh.pipeline.freshness.staleAfterMs, 24 * 60 * 60 * 1000);

  const stale = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: dbFixture({ complete: true }),
    now: date(25 * 60 * 60 * 1000),
  });
  assert.equal(stale.pipeline.stage, "STALE");
});

test("a recent non-destructive daily catalog merge refreshes freshness without erasing the verified baseline", async () => {
  const refreshedAt = date(25 * 60 * 60 * 1000);
  const db = dbFixture({
    complete: true,
    dialogStates: [{
      dialogId: "dialog-1", scanMode: "incremental", initialScanComplete: true, status: "COMPLETED",
      activeRunId: null, activeJobId: null, pagesProcessed: 1, messagesProcessed: 0,
      lastError: null, lastFullScanAt: date(), lastIncrementalScanAt: refreshedAt, updatedAt: refreshedAt,
    }],
    discoveryRuns: [{
      id: "disc-daily", jobId: "disc-job-daily", dialogId: "__dialog_discovery__", mode: "discovery",
      status: "COMPLETED", progress: { pages: 1, dialogs: 1 }, pagesProcessed: 1, purchaseSignals: 1,
      completedAt: refreshedAt, updatedAt: refreshedAt, lastError: null,
    }],
  });
  const originalFindUnique = db.vaultUnsortedSnapshot.findUnique;
  db.vaultUnsortedSnapshot.findUnique = async (...args) => {
    const row = await originalFindUnique(...args);
    row.payload.lastFullScanAt = date().toISOString();
    row.payload.lastMergeScanAt = refreshedAt.toISOString();
    row.payload.scan.completedAt = row.payload.lastMergeScanAt;
    row.updatedAt = date(25 * 60 * 60 * 1000);
    return row;
  };
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db,
    now: date(26 * 60 * 60 * 1000),
  });
  assert.equal(result.pipeline.stage, "UP_TO_DATE");
  assert.equal(result.pipeline.freshness.messagesAt, refreshedAt.toISOString());
});

test("a frozen PLANNED backlog is waiting for a batch worker, not a recovery failure", async () => {
  const plannedState = {
    dialogId: "dialog-planned", scanMode: "initial", initialScanComplete: false, status: "PLANNED",
    activeRunId: null, activeJobId: null, pagesProcessed: 0, messagesProcessed: 0,
    lastError: null, lastFullScanAt: null, lastIncrementalScanAt: null, updatedAt: date(),
  };
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: dbFixture({ complete: true, dialogStates: [plannedState] }),
    now: date(60_000),
  });
  assert.equal(result.pipeline.stage, "WAITING_FOR_WORKER");
  assert.equal(result.pipeline.dialogs.queue.planned, 1);
  assert.equal(result.pipeline.projection.deferred, true);
});

test("legacy IDLE rows are not rendered as phantom pending worker backlog", async () => {
  const idleState = {
    dialogId: "dialog-idle", scanMode: "initial", initialScanComplete: false, status: "IDLE",
    activeRunId: null, activeJobId: null, pagesProcessed: 0, messagesProcessed: 0,
    lastError: null, lastFullScanAt: null, lastIncrementalScanAt: null, updatedAt: date(),
  };
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: dbFixture({ complete: true, dialogStates: [idleState] }),
    now: date(60_000),
  });
  assert.equal(result.pipeline.dialogs.pending, 0);
  assert.equal(result.pipeline.dialogs.queue.planned, 0);
  assert.notEqual(result.pipeline.stage, "WAITING_FOR_WORKER");
});

test("an active daily discovery preserves published dialog and message counters", async () => {
  const oldAt = date();
  const activeAt = date(24 * 60 * 60 * 1000);
  const dialogStates = [
    {
      dialogId: "dialog-a", generation: 7, scanMode: "initial", initialScanComplete: true, status: "READY",
      activeRunId: null, activeJobId: null, pagesProcessed: 2, messagesProcessed: 50,
      lastError: null, lastFullScanAt: oldAt, lastIncrementalScanAt: null, createdAt: oldAt, updatedAt: oldAt,
    },
    {
      dialogId: "dialog-b", generation: 7, scanMode: "initial", initialScanComplete: true, status: "READY",
      activeRunId: null, activeJobId: null, pagesProcessed: 3, messagesProcessed: 70,
      lastError: null, lastFullScanAt: oldAt, lastIncrementalScanAt: null, createdAt: oldAt, updatedAt: oldAt,
    },
  ];
  const activeRun = {
    id: "disc-daily", jobId: "disc-daily-job", dialogId: "__dialog_discovery__", mode: "discovery",
    status: "RUNNING", generation: 8, continuation: {}, progress: { pages: 1, dialogs: 25 },
    pagesProcessed: 1, purchaseSignals: 25, createdAt: activeAt, updatedAt: activeAt, completedAt: null, lastError: null,
  };
  const previousRun = {
    id: "disc-old", jobId: "disc-old-job", dialogId: "__dialog_discovery__", mode: "discovery",
    status: "COMPLETED", generation: 7, continuation: {}, progress: { pages: 1, dialogs: 2, hasMore: false },
    pagesProcessed: 1, purchaseSignals: 2, createdAt: oldAt, updatedAt: oldAt, completedAt: oldAt, lastError: null,
  };
  const activeJob = {
    id: "disc-daily-job", status: "CLAIMED", params: { dialogId: "__dialog_discovery__", scanRunId: "disc-daily", childMode: "incremental" },
    progress: { pages: 1, dialogs: 25 }, claimedByDeviceId: "device-a", leaseUntil: date(24 * 60 * 60 * 1000 + 60_000),
    attempts: 0, lastError: null, createdAt: activeAt, updatedAt: activeAt,
  };
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: dbFixture({ complete: true, dialogStates, discoveryRuns: [activeRun, previousRun], dialogActiveJobs: [activeJob] }),
    now: activeAt,
  });
  assert.equal(result.pipeline.stage, "DISCOVERING_DIALOGS");
  assert.equal(result.pipeline.dialogs.discovered, 2);
  assert.equal(result.pipeline.dialogs.messagesCommitted, 120);
});

test("scheduled durable work is shown as WAITING_FOR_WORKER", async () => {
  const activeJobs = [{ id: "job-1", status: "SCHEDULED", params: { dialogId: "__dialog_discovery__" }, progress: {}, claimedByDeviceId: null, leaseUntil: null, attempts: 0, lastError: null, updatedAt: date() }];
  const result = await getNeverUsedPipelineState({ agencyId: "agency-1", creatorId: "creator-1", db: dbFixture({ complete: true, dialogActiveJobs: activeJobs }), now: date(60_000) });
  assert.equal(result.pipeline.stage, "WAITING_FOR_WORKER");
  assert.equal(result.pipeline.projection.deferred, true);
});

test("creator context wait is diagnostic, not RETRYING", async () => {
  const waitingJob = {
    id: "job-wait", status: "SCHEDULED", params: { dialogId: "dialog-2", mode: "initial", scanRunId: "run-wait" },
    progress: { waitKind: "creator_context", waitReason: "Creator execution context unavailable", retryAt: date(5_000).toISOString() },
    claimedByDeviceId: null, leaseUntil: null, nextRunAt: date(5_000), attempts: 0, lastError: null,
    lastProgressAt: date(), createdAt: date(), updatedAt: date(),
  };
  const state = {
    dialogId: "dialog-2", scanMode: "initial", initialScanComplete: false, status: "RUNNING",
    activeRunId: "run-wait", activeJobId: "job-wait", pagesProcessed: 2, messagesProcessed: 100,
    lastError: null, lastFullScanAt: null, lastIncrementalScanAt: null, updatedAt: date(),
  };
  const run = {
    id: "run-wait", jobId: "job-wait", dialogId: "dialog-2", mode: "initial", status: "RUNNING",
    progress: { pages: 2, rawMessages: 50, messages: 50, skippedMessages: 0, cursorType: "firstId" },
    pagesProcessed: 2, messagesProcessed: 100, lastError: null, updatedAt: date(),
  };
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1", creatorId: "creator-1",
    db: dbFixture({ complete: true, dialogActiveJobs: [waitingJob], dialogStates: [state], activeRuns: [run] }),
    now: date(1_000),
  });
  assert.equal(result.pipeline.stage, "WAITING_FOR_CREATOR_CONTEXT");
  assert.equal(result.pipeline.dialogs.queue.waitingContext, 1);
  assert.equal(result.pipeline.dialogs.queue.retrying, 0);
  assert.equal(result.pipeline.dialogs.current.waitKind, "creator_context");
  assert.equal(result.pipeline.dialogs.current.committedMessages, 50);
});

test("a real failed attempt is shown as RETRYING with queue diagnostics", async () => {
  const retryJob = {
    id: "job-retry", status: "SCHEDULED", params: { dialogId: "dialog-2", mode: "initial", scanRunId: "run-retry" },
    progress: { pages: 2 }, claimedByDeviceId: null, leaseUntil: null, nextRunAt: date(60_000),
    attempts: 1, lastError: "HTTP 500", lastProgressAt: date(), createdAt: date(), updatedAt: date(),
  };
  const state = {
    dialogId: "dialog-2", scanMode: "initial", initialScanComplete: false, status: "RUNNING",
    activeRunId: "run-retry", activeJobId: "job-retry", pagesProcessed: 2, messagesProcessed: 100,
    lastError: null, lastFullScanAt: null, lastIncrementalScanAt: null, updatedAt: date(),
  };
  const run = {
    id: "run-retry", jobId: "job-retry", dialogId: "dialog-2", mode: "initial", status: "RUNNING",
    progress: { pages: 2 }, pagesProcessed: 2, messagesProcessed: 100, lastError: null, updatedAt: date(),
  };
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1", creatorId: "creator-1",
    db: dbFixture({ complete: true, dialogActiveJobs: [retryJob], dialogStates: [state], activeRuns: [run] }),
    now: date(1_000),
  });
  assert.equal(result.pipeline.stage, "RETRYING");
  assert.equal(result.pipeline.dialogs.queue.retrying, 1);
  assert.equal(result.pipeline.dialogs.queue.waitingContext, 0);
  assert.equal(result.pipeline.dialogs.current.lastError, "HTTP 500");
});

test("projection reads canonical Media Library rows in bounded chunks", async () => {
  const count = PROJECTION_CHUNK_SIZE + 1;
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `row-${String(index).padStart(6, "0")}`, mediaId: `media-${index}`, mediaType: "photo", sortingStatus: index % 2 ? "SORTED" : "UNSORTED", updatedAt: date(), lastSeenAt: date(), folderIds: [], durationSec: 0,
  }));
  const db = dbFixture({ complete: true, catalogRows: rows, usedIds: [] });
  const batchSizes = [];
  const originalFindMany = db.creatorMediaAsset.findMany;
  db.creatorMediaAsset.findMany = async (args) => {
    if (args.orderBy?.id === "asc") batchSizes.push(args.take);
    return originalFindMany(args);
  };
  const result = await projectionCounts(db, "agency-1", "creator-1");
  assert.equal(result.catalogMedia, count);
  assert.equal(result.neverUsed, count);
  assert.deepEqual(batchSizes, [PROJECTION_CHUNK_SIZE, PROJECTION_CHUNK_SIZE]);
  assert.ok(batchSizes.every((size) => size <= PROJECTION_CHUNK_SIZE));
});


test("a user pause is a PAUSED control state, not a fake OnlyFans error", async () => {
  const pausedRun = {
    id: "disc-paused",
    jobId: "disc-job",
    dialogId: "__dialog_discovery__",
    mode: "discovery",
    status: "PAUSED",
    generation: 71,
    progress: { pages: 1, dialogsFound: 1, hasMore: true, nextOffset: 10 },
    pagesProcessed: 1,
    purchaseSignals: 1,
    createdAt: date(),
    updatedAt: date(1_000),
    completedAt: null,
    lastError: "paused from Vault Asset Sales",
  };
  const state = {
    dialogId: "dialog-1",
    generation: 71,
    scanMode: "initial",
    initialScanComplete: false,
    status: "PLANNED",
    activeRunId: null,
    activeJobId: null,
    pagesProcessed: 0,
    messagesProcessed: 0,
    lastError: null,
    lastFullScanAt: null,
    lastIncrementalScanAt: null,
    createdAt: date(),
    updatedAt: date(500),
  };
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: dbFixture({ discoveryRuns: [pausedRun], dialogStates: [state] }),
    now: date(2_000),
  });
  assert.equal(result.pipeline.stage, "PAUSED");
  assert.equal(result.pipeline.dialogs.discovery.paused, true);
  assert.equal(result.pipeline.dialogs.discovery.error, null);
  assert.equal(result.pipeline.dialogs.discovery.lastError, null);
  assert.equal(result.pipeline.dialogs.lastError, null);
});

test("completed discovery keeps a durable history pause control", async () => {
  const pausedHistory = {
    id: "disc-complete-paused-history",
    jobId: "disc-job",
    dialogId: "__dialog_discovery__",
    mode: "discovery",
    status: "COMPLETED",
    generation: 72,
    continuation: { historyControl: { state: "PAUSED", reason: "paused by user", at: date().toISOString() } },
    progress: { pages: 1, dialogsFound: 1, hasMore: false },
    pagesProcessed: 1,
    purchaseSignals: 1,
    createdAt: date(),
    updatedAt: date(1_000),
    completedAt: date(1_000),
    lastError: null,
  };
  const state = {
    dialogId: "dialog-1", generation: 72, scanMode: "initial", initialScanComplete: false, status: "PAUSED",
    activeRunId: null, activeJobId: null, pagesProcessed: 0, messagesProcessed: 0,
    lastError: null, lastFullScanAt: null, lastIncrementalScanAt: null, createdAt: date(), updatedAt: date(),
  };
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1", creatorId: "creator-1",
    db: dbFixture({ complete: true, discoveryRuns: [pausedHistory], dialogStates: [state] }),
    now: date(2_000),
  });
  assert.equal(result.pipeline.stage, "PAUSED");
  assert.equal(result.pipeline.dialogs.discovery.control.kind, "PAUSED");
  assert.equal(result.pipeline.dialogs.discovery.control.reason, "paused by user");
});

test("an untouched discovery run keeps hasMore unknown and excludes stale generation-zero states", async () => {
  const untouchedRun = {
    id: "disc-empty",
    jobId: "disc-job",
    dialogId: "__dialog_discovery__",
    mode: "discovery",
    status: "RUNNING",
    generation: 0,
    progress: {},
    pagesProcessed: 0,
    purchaseSignals: 0,
    createdAt: date(10_000),
    updatedAt: date(10_000),
    completedAt: null,
    lastError: null,
  };
  const staleState = {
    dialogId: "dialog-old",
    generation: 0,
    scanMode: "initial",
    initialScanComplete: true,
    status: "COMPLETED",
    activeRunId: null,
    activeJobId: null,
    pagesProcessed: 1485,
    messagesProcessed: 8176,
    lastError: null,
    lastFullScanAt: date(),
    lastIncrementalScanAt: null,
    createdAt: date(),
    updatedAt: date(),
  };
  const result = await getNeverUsedPipelineState({
    agencyId: "agency-1",
    creatorId: "creator-1",
    db: dbFixture({ discoveryRuns: [untouchedRun], dialogStates: [staleState] }),
    now: date(11_000),
  });
  assert.equal(result.pipeline.dialogs.discovery.hasMoreKnown, false);
  assert.equal(result.pipeline.dialogs.discovery.hasMore, null);
  assert.equal(result.pipeline.dialogs.discovery.dialogsFound, 0);
  assert.equal(result.pipeline.dialogs.messagesCommitted, 0);
  assert.equal(result.pipeline.dialogs.pagesCommitted, 0);
  assert.equal(result.pipeline.authoritative, false);
});
