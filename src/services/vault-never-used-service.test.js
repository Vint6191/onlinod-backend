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
    { id: "row-used", mediaId: "used", mediaType: "video", status: "SORTED", thumbUrl: "used.jpg", folderIds: ["folder-a"], duration: 2, lastSeenAt: date(), updatedAt: date() },
    { id: "row-unused", mediaId: "unused", mediaType: "photo", status: "UNSORTED", thumbUrl: "unused.jpg", folderIds: [], duration: 0, lastSeenAt: date(), updatedAt: date() },
    { id: "row-sorted-unused", mediaId: "sorted-unused", mediaType: "photo", status: "SORTED", thumbUrl: "sorted.jpg", folderIds: ["folder-b"], duration: 0, lastSeenAt: date(), updatedAt: date() },
  ] : []);
  const visibleCatalog = catalogRows.filter((row) => row.status !== "HIDDEN");
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
  const used = new Set(usedIds);
  const sold = new Set(soldIds);

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
    return rows;
  }
  function evidenceRows(args, evidenceSet, field) {
    const ids = args.where?.[field]?.in || [];
    return ids.filter((id) => evidenceSet.has(id)).map((id) => ({ [field]: id, updatedAt: date() }));
  }

  return {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    vaultUnsortedSnapshot: {
      async findUnique() {
        if (!complete) return null;
        return {
          id: "messages", creatorId: "creator-1", itemsCount: visibleCatalog.length,
          unsortedCount: visibleCatalog.filter((row) => row.status === "UNSORTED").length,
          sortedCount: visibleCatalog.filter((row) => row.status === "SORTED").length,
          capturedAt: date(), updatedAt: date(),
          payload: {
            schema: 3, kind: "vault_unsorted_snapshot", messagesFolderId: "messages",
            lastFullScanAt: date().toISOString(), lastIncrementalScanAt: null,
            scan: { status: "COMPLETED", mode: "full", jobId: "messages-job", pages: 4, scanned: visibleCatalog.length, knownStreak: 0, startedAt: date().toISOString(), completedAt: date().toISOString(), lastError: null },
          },
        };
      },
    },
    vaultUnsortedItem: {
      async findMany(args) {
        const rows = filterCatalog(args);
        if (args.orderBy?.[0]?.lastSeenAt) {
          const sorted = [...rows].sort((a, b) => String(b.mediaId).localeCompare(String(a.mediaId)));
          return sorted.slice(Number(args.skip || 0), Number(args.skip || 0) + Number(args.take || sorted.length));
        }
        return matchesCursor(rows, args);
      },
      async count(args) { return filterCatalog(args).length; },
    },
    dialogMessageMedia: {
      async findMany(args) {
        if (args.where?.mediaId?.in) return evidenceRows(args, used, "mediaId");
        if (args.where?.assetId?.in) return evidenceRows(args, used, "assetId");
        return [];
      },
    },
    vaultAssetSalesAggregate: {
      async findMany(args) {
        if (args.where?.mediaId?.in) return evidenceRows(args, sold, "mediaId");
        if (args.where?.assetId?.in) return evidenceRows(args, sold, "assetId");
        return [];
      },
      async findFirst() { return sold.size ? { updatedAt: date() } : null; },
    },
    dialogScanState: {
      async findMany() { return dialogStates; },
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
    status: index % 2 ? "SORTED" : "UNSORTED",
    thumbUrl: "",
    folderIds: [],
    duration: 0,
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

test("projection queries evidence in bounded chunks", async () => {
  const count = PROJECTION_CHUNK_SIZE + 1;
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `row-${String(index).padStart(6, "0")}`, mediaId: `media-${index}`, mediaType: "photo", status: index % 2 ? "SORTED" : "UNSORTED", updatedAt: date(), lastSeenAt: date(), folderIds: [], duration: 0,
  }));
  const db = dbFixture({ complete: true, catalogRows: rows, usedIds: [] });
  const batchSizes = [];
  db.dialogMessageMedia.findMany = async (args) => {
    if (args.where?.mediaId?.in) batchSizes.push(args.where.mediaId.in.length);
    return [];
  };
  const result = await projectionCounts(db, "agency-1", "creator-1");
  assert.equal(result.catalogMedia, count);
  assert.equal(result.neverUsed, count);
  assert.deepEqual(batchSizes, [PROJECTION_CHUNK_SIZE, 1]);
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
