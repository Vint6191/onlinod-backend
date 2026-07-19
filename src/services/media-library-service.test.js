"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getMediaMetadata,
  upsertMediaMetadata,
  importMediaMetadata,
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
      async findUnique({ where }) {
        return assets.get(where.creatorId_mediaId.mediaId) || null;
      },
      async findMany({ where }) {
        const ids = new Set(where.mediaId?.in || []);
        return [...assets.values()].filter((asset) => (
          asset.agencyId === where.agencyId
          && asset.creatorId === where.creatorId
          && (!ids.size || ids.has(asset.mediaId))
        ));
      },
      async upsert({ where, create, update }) {
        const mediaId = where.creatorId_mediaId.mediaId;
        const previous = assets.get(mediaId);
        const next = previous
          ? { ...previous, ...update, updatedAt: new Date() }
          : {
              id: `asset-${mediaId}`,
              createdAt: new Date(),
              updatedAt: new Date(),
              manualTags: [],
              visibleBodyParts: [],
              metadata: {},
              ...create,
            };
        assets.set(mediaId, next);
        return next;
      },
    },
    async $transaction(callback) { return callback(db); },
  };
  return { db, assets };
}

test("metadata enrichment never activates catalog membership and older JSON cannot win", async () => {
  const newer = new Date("2026-07-20T00:00:00.000Z");
  const { db, assets } = metadataDb([{
    id: "asset-current",
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaId: "current",
    catalogActive: true,
    mediaType: "photo",
    durationSec: 0,
    description: "new server description",
    manualTags: ["new"],
    visibleBodyParts: [],
    accessType: "paid",
    minPriceCents: 0,
    idealPriceCents: 0,
    storylineName: null,
    storylineOrder: null,
    storylineRole: null,
    metadataUpdatedAt: newer,
    createdAt: newer,
    updatedAt: newer,
  }]);

  const imported = await importMediaMetadata({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    db,
    items: [
      {
        onlyfansMediaId: "current",
        mediaType: "video",
        description: "stale JSON description",
        manualTags: ["old"],
        updatedAt: "2026-07-19T00:00:00.000Z",
      },
      {
        onlyfansMediaId: "placeholder",
        mediaType: "video",
        description: "imported metadata",
        manualTags: [" My Tag ", "my tag"],
        updatedAt: "2026-07-19T01:00:00.000Z",
      },
    ],
  });

  assert.equal(imported.accepted, 1);
  assert.equal(imported.skippedOlder, 1);
  assert.deepEqual(imported.importedMediaIds, ["current", "placeholder"]);
  assert.equal(assets.get("current").description, "new server description");
  assert.equal(assets.get("current").catalogActive, true);
  assert.equal(assets.get("placeholder").catalogActive, false);
  assert.deepEqual(assets.get("placeholder").manualTags, ["my_tag"]);

  const saved = await upsertMediaMetadata({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaId: "metadata-only",
    db,
    input: {
      mediaType: "photo",
      description: "manager note",
      manualTags: [],
      visibleBodyParts: [],
      accessType: "paid",
      minPrice: 0,
      idealPrice: 0,
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(assets.get("metadata-only").catalogActive, false);

  const queried = await getMediaMetadata({
    agencyId: AGENCY_ID,
    creatorId: CREATOR_ID,
    mediaIds: ["placeholder", "metadata-only"],
    db,
  });
  assert.deepEqual(queried.items.map((item) => item.onlyfansMediaId), ["placeholder", "metadata-only"]);
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
