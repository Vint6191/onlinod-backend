"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
delete require.cache[require.resolve("./media-library-service")];
const {
  getMediaMetadata,
  searchMediaLibrary,
  upsertMediaMetadata,
  replaceUsageSources,
} = require("./media-library-service");

const AGENCY_ID = "agency-1";
const CREATOR_ID = "creator-1";

test("Media Library migration merges legacy data before dropping redundant tables", () => {
  const root = path.resolve(__dirname, "../..");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(
    path.join(root, "prisma/migrations/20260719170000_media_library_v1/migration.sql"),
    "utf8",
  );
  const cleanup = fs.readFileSync(path.join(root, "DELETE_LEGACY_FILES.bat"), "utf8");
  assert.match(schema, /catalogActive\s+Boolean\s+@default\(false\)/);
  assert.match(migration, /INSERT INTO "CreatorMediaAsset"[\s\S]*FROM "VaultUnsortedItem"/);
  assert.match(migration, /CREATE TABLE "CreatorMediaUsageContribution"/);
  assert.match(migration, /CREATE TABLE "MediaLibraryScanItem"/);
  const mergePosition = migration.indexOf('FROM "VaultUnsortedItem"');
  const dropPosition = migration.indexOf('DROP TABLE "VaultUnsortedItem"');
  assert.ok(mergePosition >= 0 && dropPosition > mergePosition);
  for (const file of [
    "src\\routes\\vault-intelligence.js",
    "src\\routes\\vault-unsorted.js",
    "src\\services\\vault-intelligence-service.js",
  ]) assert.match(cleanup, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

function metadataDb(seed = []) {
  const assets = new Map(seed.map((asset) => [asset.mediaId, { ...asset }]));
  const db = {
    creatorAccount: {
      async findFirst() { return { id: CREATOR_ID }; },
    },
    creatorMediaAsset: {
      async findMany({ where }) {
        return [...assets.values()].filter((asset) => (
          asset.agencyId === where.agencyId
          && asset.creatorId === where.creatorId
          && (!where.mediaId?.in || where.mediaId.in.includes(asset.mediaId))
        ));
      },
      async upsert({ where, create, update }) {
        const key = where.creatorId_mediaId.mediaId;
        const previous = assets.get(key);
        const next = previous
          ? { ...previous, ...update, updatedAt: new Date() }
          : { ...create, createdAt: new Date(), updatedAt: new Date() };
        assets.set(key, next);
        return next;
      },
    },
    async $transaction(callback) { return callback(db); },
  };
  return { db, assets };
}

test("legacy JSON metadata import endpoint is removed from the server runtime", () => {
  const route = fs.readFileSync(path.resolve(__dirname, "../routes/media-library.js"), "utf8");
  const service = fs.readFileSync(path.resolve(__dirname, "media-library-service.js"), "utf8");
  assert.doesNotMatch(route, /metadata\/import/);
  assert.doesNotMatch(route, /importMediaMetadata/);
  assert.doesNotMatch(service, /importMediaMetadata/);
});

test("server metadata edits preserve existing active catalog membership", async () => {
  const { db, assets } = metadataDb([{
    id: "asset-active",
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaId: "active-media",
    catalogActive: true,
    sortingStatus: "UNSORTED",
    mediaType: "photo",
    manualTags: [],
    visibleBodyParts: [],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }]);
  const saved = await upsertMediaMetadata({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaId: "active-media",
    db,
    input: {
      mediaType: "photo",
      description: "manager note",
      manualTags: [" My Tag ", "my tag"],
      visibleBodyParts: [],
      accessType: "paid",
      minPrice: 0,
      idealPrice: 0,
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(assets.get("active-media").catalogActive, true);
  assert.equal(assets.get("active-media").description, "manager note");
  assert.deepEqual(assets.get("active-media").manualTags, ["my_tag"]);

  const queried = await getMediaMetadata({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaIds: ["active-media"],
    db,
  });
  assert.deepEqual(queried.items.map((item) => item.onlyfansMediaId), ["active-media"]);
});

test("metadata editing creates only an inactive placeholder when catalog discovery has not seen media yet", async () => {
  const { db, assets } = metadataDb([]);
  const saved = await upsertMediaMetadata({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaId: "metadata-only",
    db,
    input: {
      mediaType: "photo",
      description: "manager note before catalog discovery",
      manualTags: ["Teaser"],
      visibleBodyParts: [],
      accessType: "paid",
      minPrice: 10,
      idealPrice: 20,
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.item.onlyfansMediaId, "metadata-only");
  assert.equal(assets.get("metadata-only").catalogActive, false);
  assert.equal(assets.get("metadata-only").description, "manager note before catalog discovery");
  assert.deepEqual(assets.get("metadata-only").manualTags, ["teaser"]);

  const queried = await getMediaMetadata({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaIds: ["metadata-only"],
    db,
  });
  assert.equal(queried.items.length, 1);
  assert.equal(queried.items[0].description, "manager note before catalog discovery");
});

test("Media Library search is paged and keeps folder-scoped queries catalog-active", async () => {
  const calls = [];
  const asset = {
    id: "asset-search", agencyId: AGENCY_ID, creatorId: CREATOR_ID, mediaId: "m-search",
    catalogActive: true, sortingStatus: "SORTED", mediaType: "video", durationSec: 42,
    thumbUrl: "thumb.jpg", previewUrl: "preview.jpg", fullUrl: "full.mp4", folderIds: ["folder-2"],
    description: "Purple couch scene", manualTags: ["purple_light", "cowgirl"], visibleBodyParts: [],
    accessType: "paid", minPriceCents: 2000, idealPriceCents: 3500, metadata: {},
    createdAt: new Date(), updatedAt: new Date(), lastSeenAt: new Date(),
  };
  const db = {
    creatorAccount: { async findFirst() { return { id: CREATOR_ID }; } },
    creatorMediaAsset: {
      async findMany(input) { calls.push({ kind: "findMany", input }); return [asset]; },
      async count(input) { calls.push({ kind: "count", input }); return 1; },
    },
  };
  const result = await searchMediaLibrary({
    agencyId: AGENCY_ID, creatorId: CREATOR_ID, query: "purple couch", scope: "everything",
    folderId: "folder-2", folderMatchIds: ["folder-3"], mediaType: "video", offset: 0, limit: 40, db,
  });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.items[0].mediaId, "m-search");
  assert.equal(result.items[0].previewUrl, "preview.jpg");
  assert.equal(result.items[0].metadata.idealPrice, 35);
  const where = calls.find((row) => row.kind === "findMany").input.where;
  assert.ok(where.AND.some((row) => row.catalogActive === true));
  assert.deepEqual(where.AND.find((row) => row.mediaType)?.mediaType, "video");
  assert.deepEqual(where.AND.find((row) => row.folderIds)?.folderIds, { array_contains: ["folder-2"] });
  const searchClause = where.AND.find((row) => Array.isArray(row.OR));
  assert.ok(searchClause.OR.some((row) => row.description?.contains === "purple couch"));
  assert.ok(searchClause.OR.some((row) => row.manualTags?.array_contains?.includes("purple_couch")));
  assert.ok(searchClause.OR.some((row) => row.folderIds?.array_contains?.includes("folder-3") || row.AND?.some((entry) => entry.OR?.some((clause) => clause.folderIds?.array_contains?.includes("folder-3")))));
});

test("Media Library text search includes metadata-only placeholders before catalog activation", async () => {
  const calls = [];
  const asset = {
    id: "asset-meta-only", agencyId: AGENCY_ID, creatorId: CREATOR_ID, mediaId: "m-meta-only",
    catalogActive: false, sortingStatus: "UNSORTED", mediaType: "photo", durationSec: 0,
    thumbUrl: null, previewUrl: null, fullUrl: null, folderIds: [],
    description: "тест", manualTags: ["тест"], visibleBodyParts: [],
    accessType: "paid", minPriceCents: 0, idealPriceCents: 1500, metadata: {},
    metadataUpdatedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), lastSeenAt: new Date(),
  };
  const db = {
    creatorAccount: { async findFirst() { return { id: CREATOR_ID }; } },
    creatorMediaAsset: {
      async findMany(input) { calls.push({ kind: "findMany", input }); return [asset]; },
      async count(input) { calls.push({ kind: "count", input }); return 1; },
    },
  };

  const result = await searchMediaLibrary({
    agencyId: AGENCY_ID, creatorId: CREATOR_ID, query: "тест", scope: "everything",
    mediaType: "all", offset: 0, limit: 40, db,
  });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].mediaId, "m-meta-only");
  assert.equal(result.items[0].metadata.description, "тест");
  assert.deepEqual(result.items[0].metadata.manualTags, ["тест"]);

  const where = calls.find((row) => row.kind === "findMany").input.where;
  const presence = where.AND.find((row) => Array.isArray(row.OR) && row.OR.some((entry) => entry.metadataUpdatedAt));
  assert.ok(presence, "text search must admit active catalog rows or human metadata placeholders");
  assert.deepEqual(presence.OR, [{ catalogActive: true }, { metadataUpdatedAt: { not: null } }]);
  assert.ok(!where.AND.some((row) => row.catalogActive === true), "text-only search must not globally exclude metadata placeholders");
  const searchClause = where.AND.find((row) => Array.isArray(row.OR) && row !== presence);
  assert.ok(searchClause.OR.some((row) => row.description?.contains === "тест"));
  assert.ok(searchClause.OR.some((row) => row.manualTags?.array_contains?.includes("тест")));
});

test("metadata editing updates an inactive placeholder without reactivating catalog membership", async () => {
  const { db, assets } = metadataDb([{
    id: "asset-inactive",
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaId: "inactive-media",
    catalogActive: false,
    sortingStatus: "UNSORTED",
    mediaType: "video",
    manualTags: [],
    visibleBodyParts: [],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }]);
  const saved = await upsertMediaMetadata({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaId: "inactive-media",
    db,
    input: {
      mediaType: "video",
      description: "kept while inactive",
      manualTags: [],
      visibleBodyParts: [],
      accessType: "paid",
      minPrice: 0,
      idealPrice: 0,
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(assets.get("inactive-media").catalogActive, false);
  assert.equal(assets.get("inactive-media").description, "kept while inactive");
});

function usageDb({ rawSql = false } = {}) {
  const assets = new Map([
    ["m1", {
      id: "asset-m1",
      agencyId: AGENCY_ID,
      creatorId: CREATOR_ID,
      mediaId: "m1",
      catalogActive: true,
      sentCount: 0,
      soldCount: 0,
      notOpenedCount: 0,
      freeCount: 0,
      revenueCents: 0,
      averagePriceCents: 0,
      uniqueBuyers: 0,
      lastSoldAt: null,
    }],
  ]);
  const contributions = [];
  const sourceStates = new Map();
  const transactionCalls = [];
  const usageLocks = [];
  const bulkUsageUpdates = [];

  const matchesMedia = (where, mediaId) => {
    if (where.mediaId?.in && !where.mediaId.in.includes(mediaId)) return false;
    if (typeof where.mediaId === "string" && where.mediaId !== mediaId) return false;
    return true;
  };
  const db = {
    creatorAccount: {
      async findFirst() { return { id: CREATOR_ID }; },
    },
    creatorMediaAsset: {
      async findMany({ where }) {
        return [...assets.values()].filter((asset) => (
          asset.agencyId === where.agencyId
          && asset.creatorId === where.creatorId
          && matchesMedia(where, asset.mediaId)
          && (where.catalogActive === undefined || asset.catalogActive === where.catalogActive)
        ));
      },
      async createMany({ data }) {
        let count = 0;
        for (const row of data) {
          if (assets.has(row.mediaId)) continue;
          assets.set(row.mediaId, {
            id: row.id,
            ...row,
            sentCount: 0,
            soldCount: 0,
            notOpenedCount: 0,
            freeCount: 0,
            revenueCents: 0,
            averagePriceCents: 0,
            uniqueBuyers: 0,
            lastSoldAt: null,
          });
          count += 1;
        }
        return { count };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const asset of assets.values()) {
          if (asset.agencyId !== where.agencyId || asset.creatorId !== where.creatorId || !matchesMedia(where, asset.mediaId)) continue;
          Object.assign(asset, data);
          count += 1;
        }
        return { count };
      },
    },
    creatorMediaUsageSourceState: {
      async findUnique({ where }) {
        return sourceStates.get(where.creatorId_sourceKey.sourceKey) || null;
      },
      async upsert({ where, create, update }) {
        const key = where.creatorId_sourceKey.sourceKey;
        const next = sourceStates.has(key) ? { ...sourceStates.get(key), ...update } : { ...create };
        sourceStates.set(key, next);
        return next;
      },
    },
    creatorMediaUsageContribution: {
      async findMany({ where }) {
        return contributions.filter((row) => row.agencyId === where.agencyId && row.creatorId === where.creatorId && row.sourceKey === where.sourceKey);
      },
      async deleteMany({ where }) {
        let count = 0;
        for (let index = contributions.length - 1; index >= 0; index -= 1) {
          const row = contributions[index];
          if (row.agencyId === where.agencyId && row.creatorId === where.creatorId && row.sourceKey === where.sourceKey) {
            contributions.splice(index, 1);
            count += 1;
          }
        }
        return { count };
      },
      async createMany({ data }) {
        contributions.push(...data.map((row) => ({ ...row })));
        return { count: data.length };
      },
      async groupBy({ where }) {
        const ids = new Set(where.mediaId.in);
        const grouped = new Map();
        for (const row of contributions) {
          if (row.agencyId !== where.agencyId || row.creatorId !== where.creatorId || !ids.has(row.mediaId)) continue;
          const group = grouped.get(row.mediaId) || {
            mediaId: row.mediaId,
            _sum: { sentCount: 0, soldCount: 0, notOpenedCount: 0, freeCount: 0, revenueCents: 0, uniqueBuyers: 0 },
            _max: { lastSoldAt: null, capturedAt: null },
          };
          for (const field of Object.keys(group._sum)) group._sum[field] += row[field] || 0;
          if (row.lastSoldAt && (!group._max.lastSoldAt || row.lastSoldAt > group._max.lastSoldAt)) group._max.lastSoldAt = row.lastSoldAt;
          if (row.capturedAt && (!group._max.capturedAt || row.capturedAt > group._max.capturedAt)) group._max.capturedAt = row.capturedAt;
          grouped.set(row.mediaId, group);
        }
        return [...grouped.values()];
      },
    },
    async $transaction(callback, options) {
      transactionCalls.push(options || null);
      return callback(db);
    },
  };
  if (rawSql) {
    db.$queryRawUnsafe = async (...args) => {
      usageLocks.push(args);
      return [{ pg_advisory_xact_lock: null }];
    };
    db.$executeRawUnsafe = async (query, agencyId, creatorId, payload) => {
      const projections = JSON.parse(payload);
      bulkUsageUpdates.push({ query, agencyId, creatorId, projections });
      for (const projection of projections) {
        const asset = assets.get(projection.mediaId);
        if (asset && asset.agencyId === agencyId && asset.creatorId === creatorId) Object.assign(asset, projection);
      }
      return projections.length;
    };
  }
  return { db, assets, contributions, transactionCalls, usageLocks, bulkUsageUpdates };
}

test("usage sources replace atomically, reject stale revisions, and retain missing ids only as inactive placeholders", async () => {
  const { db, assets, contributions } = usageDb();
  const first = await replaceUsageSources({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    db,
    sources: [{
      sourceKey: "opaque-dialog",
      sourceRevision: "2026-07-19T10:00:00.000Z",
      capturedAt: "2026-07-19T10:00:00.000Z",
      items: [
        { mediaId: "m1", sentCount: 2, soldCount: 1, notOpenedCount: 0, freeCount: 0, revenueCents: 500, uniqueBuyers: 1 },
        { mediaId: "missing", sentCount: 1, soldCount: 0, notOpenedCount: 0, freeCount: 1, revenueCents: 0, uniqueBuyers: 0 },
      ],
    }],
  });
  assert.deepEqual(first.missingMediaIds, ["missing"]);
  assert.equal(assets.get("missing").catalogActive, false);
  assert.equal(assets.get("m1").sentCount, 2);
  assert.equal(assets.get("m1").revenueCents, 500);

  const replaced = await replaceUsageSources({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    db,
    sources: [{
      sourceKey: "opaque-dialog",
      sourceRevision: "2026-07-19T11:00:00.000Z",
      capturedAt: "2026-07-19T11:00:00.000Z",
      items: [{ mediaId: "m1", sentCount: 5, soldCount: 0, notOpenedCount: 0, freeCount: 5, revenueCents: 0, uniqueBuyers: 0 }],
    }],
  });
  assert.equal(replaced.acceptedSources, 1);
  assert.equal(assets.get("m1").sentCount, 5);
  assert.equal(assets.get("missing").sentCount, 0);
  assert.equal(contributions.some((row) => row.mediaId === "missing"), false);

  const stale = await replaceUsageSources({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    db,
    sources: [{
      sourceKey: "opaque-dialog",
      sourceRevision: "2026-07-19T10:30:00.000Z",
      capturedAt: "2026-07-19T10:30:00.000Z",
      items: [{ mediaId: "m1", sentCount: 99, soldCount: 99, notOpenedCount: 0, freeCount: 0, revenueCents: 9999, uniqueBuyers: 1 }],
    }],
  });
  assert.equal(stale.staleSources, 1);
  assert.equal(assets.get("m1").sentCount, 5);
});

test("usage batches commit one bounded source transaction and bulk projection at a time", async () => {
  const { db, assets, transactionCalls, usageLocks, bulkUsageUpdates } = usageDb({ rawSql: true });
  const result = await replaceUsageSources({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    db,
    sources: [
      {
        sourceKey: "opaque-dialog-a",
        sourceRevision: "2026-07-19T12:00:00.000Z",
        capturedAt: "2026-07-19T12:00:00.000Z",
        items: [{ mediaId: "m1", sentCount: 2, soldCount: 1, notOpenedCount: 0, freeCount: 0, revenueCents: 500, uniqueBuyers: 1 }],
      },
      {
        sourceKey: "opaque-dialog-b",
        sourceRevision: "2026-07-19T12:01:00.000Z",
        capturedAt: "2026-07-19T12:01:00.000Z",
        items: [{ mediaId: "m1", sentCount: 3, soldCount: 0, notOpenedCount: 0, freeCount: 3, revenueCents: 0, uniqueBuyers: 0 }],
      },
    ],
  });

  assert.equal(result.acceptedSources, 2);
  assert.equal(transactionCalls.length, 2);
  assert.equal(transactionCalls.every((options) => options.maxWait === 10_000 && options.timeout === 30_000), true);
  assert.equal(usageLocks.length, 2);
  assert.equal(usageLocks.every((call) => /pg_advisory_xact_lock[\s\S]*::text/.test(call[0])), true);
  assert.equal(bulkUsageUpdates.length, 2);
  assert.match(bulkUsageUpdates[0].query, /jsonb_to_recordset/);
  assert.equal(assets.get("m1").sentCount, 5);
  assert.equal(assets.get("m1").revenueCents, 500);
});
