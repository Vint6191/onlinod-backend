"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanMediaIds,
  getVaultDirectoryIntelligence,
  checkProtectedVaultMedia,
} = require("./vault-directory-service");

function fakeDb() {
  return {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    dialogMessageMedia: {
      async findMany(args) {
        if (args.where?.mediaId?.in) return [{ mediaId: "m2" }];
        if (args.where?.OR) return [{ mediaId: "m2" }, { mediaId: "m3" }];
        return [{ mediaId: "m1" }, { mediaId: "m2" }, { mediaId: "m3" }];
      },
      async groupBy() { return [{ mediaId: "m1", _count: { _all: 3 } }]; },
      async findFirst() { return { updatedAt: new Date("2026-07-15T20:00:00.000Z") }; },
    },
    vaultAssetSalesAggregate: {
      async aggregate() { return { _sum: { totalRevenueCents: 5000, soldCount: 2 }, _max: { lastSoldAt: new Date("2026-07-15T19:00:00.000Z") } }; },
      async count() { return 1; },
      async findMany(args) {
        if (args.take === 100) return [{ assetId: "m1", mediaId: "m1", mediaType: "video", soldCount: 2, totalRevenueCents: 5000, averagePriceCents: 2500, uniqueBuyers: 2, notOpenedCount: 1, freeCount: 0, preview: { thumbUrl: "https://cdn/x.jpg" }, lastSoldAt: new Date("2026-07-15T19:00:00.000Z"), updatedAt: new Date("2026-07-15T19:00:00.000Z") }];
        return [{ assetId: "m1", mediaId: "m1", mediaType: "video", soldCount: 2, totalRevenueCents: 5000, averagePriceCents: 2500, uniqueBuyers: 2, notOpenedCount: 1, freeCount: 0, preview: {} }];
      },
    },
  };
}

test("cleanMediaIds deduplicates and bounds input", () => {
  assert.deepEqual(cleanMediaIds(["m1", "m1", "", "m2"], 2), ["m1", "m2"]);
});

test("directory intelligence combines ledger usage and sales projection", async () => {
  const result = await getVaultDirectoryIntelligence({ agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m1", "m9"], db: fakeDb() });
  assert.equal(result.summary.usedMediaCount, 2);
  assert.equal(result.summary.protectedMediaCount, 2);
  assert.equal(result.summary.revenueCents, 5000);
  assert.equal(result.topAssets[0].rank, 1);
  assert.equal(result.topAssets[0].sentCount, 3);
  assert.deepEqual(result.analytics.find((item) => item.mediaId === "m1"), {
    mediaId: "m1", sentCount: 3, soldCount: 2, notOpenedCount: 1, freeCount: 0,
    revenueCents: 5000, averagePriceCents: 2500, uniqueBuyers: 2, rank: 1, neverUsed: false,
  });
  assert.equal(result.analytics.find((item) => item.mediaId === "m9").neverUsed, true);
});

test("protection check returns only creator-owned dialog media", async () => {
  const result = await checkProtectedVaultMedia({ agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m1", "m2"], db: fakeDb() });
  assert.deepEqual(result.protectedMediaIds, ["m2"]);
});
