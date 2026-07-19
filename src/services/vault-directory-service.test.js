"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
delete require.cache[require.resolve("./vault-unsorted-service")];
delete require.cache[require.resolve("./vault-never-used-service")];
delete require.cache[require.resolve("./vault-directory-service")];

const {
  cleanMediaIds,
  getVaultDirectoryIntelligence,
  checkProtectedVaultMedia,
} = require("./vault-directory-service");

function date(value = "2026-07-16T12:00:00.000Z") { return new Date(value); }

function matchesWhere(row, where = {}) {
  if (where.catalogActive !== undefined && row.catalogActive !== where.catalogActive) return false;
  if (where.mediaId?.in && !where.mediaId.in.includes(row.mediaId)) return false;
  if (where.sentCount?.gt !== undefined && row.sentCount <= where.sentCount.gt) return false;
  if (where.soldCount?.gt !== undefined && row.soldCount <= where.soldCount.gt) return false;
  return true;
}

function fakeDb() {
  const catalog = [
    {
      id: "c1", mediaId: "m1", mediaType: "video", catalogActive: true,
      sortingStatus: "SORTED", sentCount: 3, soldCount: 2, notOpenedCount: 1,
      freeCount: 0, revenueCents: 5000, averagePriceCents: 2500,
      uniqueBuyers: 2, lastSoldAt: date(), thumbUrl: "https://cdn/x.jpg",
      previewUrl: "https://cdn/x-preview.jpg", fullUrl: "https://cdn/x-full.jpg",
      updatedAt: date(), usageUpdatedAt: date(), lastSeenAt: date(),
    },
    {
      id: "c3", mediaId: "m3", mediaType: "photo", catalogActive: true,
      sortingStatus: "UNSORTED", sentCount: 0, soldCount: 0, notOpenedCount: 0,
      freeCount: 0, revenueCents: 0, averagePriceCents: 0, uniqueBuyers: 0,
      lastSoldAt: null, thumbUrl: null, previewUrl: null, fullUrl: null,
      updatedAt: date(), usageUpdatedAt: date(), lastSeenAt: date(),
    },
  ];
  return {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    creatorMediaAsset: {
      async count({ where }) { return catalog.filter((row) => matchesWhere(row, where)).length; },
      async aggregate({ where }) {
        const rows = catalog.filter((row) => matchesWhere(row, where));
        return {
          _sum: {
            soldCount: rows.reduce((sum, row) => sum + row.soldCount, 0),
            revenueCents: rows.reduce((sum, row) => sum + row.revenueCents, 0),
          },
          _max: { lastSoldAt: rows.map((row) => row.lastSoldAt).filter(Boolean).sort().at(-1) || null },
        };
      },
      async findMany(args) {
        return catalog.filter((row) => matchesWhere(row, args.where)).slice(0, args.take || catalog.length);
      },
      async findFirst({ where }) {
        return catalog.filter((row) => matchesWhere(row, where))[0] || null;
      },
    },
    vaultUnsortedSnapshot: {
      async findUnique() {
        return {
          id: "messages", creatorId: "creator-1", itemsCount: catalog.length,
          unsortedCount: 1, sortedCount: 1, capturedAt: date(), updatedAt: date(),
          payload: {
            schema: 3, kind: "vault_unsorted_snapshot", messagesFolderId: "messages",
            lastFullScanAt: date().toISOString(), lastIncrementalScanAt: null,
            scan: { status: "COMPLETED", mode: "full", jobId: "messages-job", pages: 4, scanned: 120, knownStreak: 0, startedAt: date().toISOString(), completedAt: date().toISOString(), lastError: null },
          },
        };
      },
    },
    dialogScanState: {
      async findMany() { return [{ initialScanComplete: true, status: "COMPLETED", pagesProcessed: 3, messagesProcessed: 90, lastError: null, lastFullScanAt: date(), lastIncrementalScanAt: null, updatedAt: date() }]; },
    },
    dialogScanRun: {
      async findMany() { return [{ id: "discovery-run", jobId: "discovery-job", status: "COMPLETED", pagesProcessed: 1, purchaseSignals: 1, completedAt: date(), updatedAt: date() }]; },
      async findFirst() { return { updatedAt: date(), completedAt: date(), lastError: null }; },
    },
    jobInstance: {
      async findMany(args) {
        if (args.where?.id?.in) return [{ id: "discovery-job", params: { childMode: "initial" } }];
        return [];
      },
      async findFirst() { return null; },
    },
  };
}

test("cleanMediaIds deduplicates and bounds input", () => {
  assert.deepEqual(cleanMediaIds(["m1", "m1", "", "m2"], 2), ["m1", "m2"]);
});

test("Media Library membership is protection while usage stays independently aggregated", async () => {
  const result = await getVaultDirectoryIntelligence({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m1", "m2", "m3"], db: fakeDb(),
  });
  const byId = new Map(result.analytics.map((item) => [item.mediaId, item]));
  assert.equal(result.pipeline.authoritative, true);
  assert.equal(byId.get("m1").usageState, "USED");
  assert.equal(byId.get("m1").inMessagesCatalog, true);
  assert.equal(byId.get("m3").usageState, "NEVER_USED");
  assert.equal(byId.get("m3").inMessagesCatalog, true);
  assert.equal(byId.get("m2").usageState, "NOT_APPLICABLE");
  assert.equal(result.summary.protectedMediaCount, 2);
});

test("catalog media stays pending until initial Messages and dialog scans are authoritative", async () => {
  const result = await getVaultDirectoryIntelligence({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m3"], includePipeline: false, db: fakeDb(),
  });
  assert.equal(result.pipeline, null);
  assert.equal(result.analytics[0].usageState, "PENDING");
  assert.equal(result.analytics[0].neverUsed, false);
});

test("protection check returns every requested active Media Library id", async () => {
  const result = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m1", "m2", "m3"], db: fakeDb(),
  });
  assert.deepEqual(result.protectedMediaIds, ["m1", "m3"]);
});
