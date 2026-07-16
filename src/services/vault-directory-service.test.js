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

function fakeDb() {
  const catalog = [
    { id: "c1", mediaId: "m1", mediaType: "video", status: "SORTED", updatedAt: date(), lastSeenAt: date() },
    { id: "c3", mediaId: "m3", mediaType: "photo", status: "UNSORTED", updatedAt: date(), lastSeenAt: date() },
  ];
  const used = new Set(["m1"]);
  function evidence(args, field) {
    const ids = args.where?.[field]?.in || [];
    return ids.filter((id) => used.has(id)).map((id) => ({ [field]: id, updatedAt: date() }));
  }
  return {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    dialogMessageMedia: {
      async findMany(args) {
        if (args.where?.mediaId?.in) return evidence(args, "mediaId");
        if (args.where?.assetId?.in) return evidence(args, "assetId");
        return [{ mediaId: "m1" }];
      },
      async groupBy(args) {
        const field = args.by[0];
        const ids = args.where?.[field]?.in || [];
        return ids.filter((id) => used.has(id)).map((id) => ({ [field]: id, _count: { _all: 3 } }));
      },
      async findFirst() { return { updatedAt: date() }; },
    },
    vaultUnsortedSnapshot: {
      async findUnique() {
        return {
          id: "messages", creatorId: "creator-1", itemsCount: catalog.length, unsortedCount: 1, sortedCount: 1,
          capturedAt: date(), updatedAt: date(),
          payload: {
            schema: 3, kind: "vault_unsorted_snapshot", messagesFolderId: "messages",
            lastFullScanAt: date().toISOString(), lastIncrementalScanAt: null,
            scan: { status: "COMPLETED", mode: "full", jobId: "messages-job", pages: 4, scanned: 120, knownStreak: 0, startedAt: date().toISOString(), completedAt: date().toISOString(), lastError: null },
          },
        };
      },
    },
    vaultUnsortedItem: {
      async findMany(args) {
        let rows = catalog;
        const ids = args.where?.mediaId?.in;
        if (ids) rows = rows.filter((row) => ids.includes(row.mediaId));
        const cursor = args.cursor?.id;
        const start = cursor ? rows.findIndex((row) => row.id === cursor) + Number(args.skip || 0) : Number(args.skip || 0);
        return rows.slice(Math.max(0, start), Math.max(0, start) + Number(args.take || rows.length));
      },
      async count() { return catalog.length; },
    },
    vaultAssetSalesAggregate: {
      async aggregate() { return { _sum: { totalRevenueCents: 5000, soldCount: 2 }, _max: { lastSoldAt: date() } }; },
      async count() { return 1; },
      async findMany(args) {
        if (args.take === 100) return [{ assetId: "m1", mediaId: "m1", mediaType: "video", soldCount: 2, totalRevenueCents: 5000, averagePriceCents: 2500, uniqueBuyers: 2, notOpenedCount: 1, freeCount: 0, preview: { thumbUrl: "https://cdn/x.jpg" }, lastSoldAt: date(), updatedAt: date() }];
        if (args.where?.mediaId?.in) return evidence(args, "mediaId");
        if (args.where?.assetId?.in) return evidence(args, "assetId");
        return [];
      },
      async findFirst() { return { updatedAt: date() }; },
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

test("Messages catalog is candidate inventory, but catalog membership itself is not usage", async () => {
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
  assert.equal(byId.get("m2").neverUsed, false);
});

test("catalog media stays pending until initial Messages and dialog scans are authoritative", async () => {
  const result = await getVaultDirectoryIntelligence({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m3"], includePipeline: false, db: fakeDb(),
  });
  assert.equal(result.pipeline, null);
  assert.equal(result.analytics[0].usageState, "PENDING");
  assert.equal(result.analytics[0].neverUsed, false);
});

test("protection check returns only creator-owned dialog media", async () => {
  const result = await checkProtectedVaultMedia({ agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m1", "m2"], db: fakeDb() });
  assert.deepEqual(result.protectedMediaIds, ["m1"]);
});
