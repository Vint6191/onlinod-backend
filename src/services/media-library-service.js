"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");

const MAX_MEDIA_IDS = 5000;
const MAX_USAGE_SOURCES = 25;
const MAX_USAGE_ITEMS_PER_SOURCE = 2000;
const MEDIA_LIBRARY_USAGE_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 30_000 });
const MEDIA_TYPES = new Set(["photo", "video", "audio", "gif", "unknown"]);
const ACCESS_TYPES = new Set(["free", "paid"]);
const STORYLINE_ROLES = new Set(["main", "additional"]);
const BODY_PARTS = new Set([
  "face", "arms", "boobs_no_nipples", "boobs_nipples_visible",
  "pussy_frontal", "pussy_spread", "pussy_rear_view", "ass",
  "butthole", "penis", "balls", "feet", "belly",
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function integer(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function optionalInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : null;
}

function date(value, fallback = null) {
  if (!value) return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function iso(value) {
  const parsed = date(value);
  return parsed ? parsed.toISOString() : null;
}

function uniqueStrings(values, limit = 100, maxLength = 120) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const item = clean(value, maxLength);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanMediaIds(values, limit = MAX_MEDIA_IDS) {
  return uniqueStrings(values, limit, 240);
}

function normalizeMediaType(value) {
  const type = clean(value, 20).toLowerCase();
  return MEDIA_TYPES.has(type) ? type : "unknown";
}

function normalizeAccessType(value) {
  const type = clean(value, 20).toLowerCase();
  return ACCESS_TYPES.has(type) ? type : "paid";
}

function normalizeStorylineRole(value) {
  const role = clean(value, 20).toLowerCase();
  return STORYLINE_ROLES.has(role) ? role : null;
}

function normalizeTags(values) {
  const normalized = uniqueStrings(values, 200, 80)
    .map((value) => value.toLowerCase().replace(/\s+/g, "_"));
  return [...new Set(normalized)].slice(0, 100);
}

function normalizeBodyParts(values) {
  return normalizeTags(values).filter((value) => BODY_PARTS.has(value));
}

function dollarsToCents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function centsToDollars(value) {
  return Math.max(0, integer(value)) / 100;
}

async function requireCreator(db, agencyId, creatorIdInput) {
  const creatorId = clean(creatorIdInput, 100);
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true },
  });
  if (!creator) {
    const error = new Error("Creator not found");
    error.code = "CREATOR_NOT_FOUND";
    throw error;
  }
  return creator.id;
}

function assetToMetadata(asset) {
  return {
    id: String(asset.id),
    agencyId: String(asset.agencyId),
    creatorId: String(asset.creatorId),
    onlyfansMediaId: String(asset.mediaId),
    mediaType: normalizeMediaType(asset.mediaType),
    durationSec: Number(asset.durationSec || 0) > 0 ? Number(asset.durationSec) : null,
    description: clean(asset.description, 12000),
    manualTags: uniqueStrings(asset.manualTags, 100, 80),
    visibleBodyParts: normalizeBodyParts(asset.visibleBodyParts),
    accessType: normalizeAccessType(asset.accessType),
    minPrice: centsToDollars(asset.minPriceCents),
    idealPrice: centsToDollars(asset.idealPriceCents),
    storylineName: clean(asset.storylineName, 200) || null,
    storylineOrder: asset.storylineOrder == null ? null : Number(asset.storylineOrder),
    storylineRole: normalizeStorylineRole(asset.storylineRole),
    createdAt: iso(asset.createdAt),
    updatedAt: iso(asset.metadataUpdatedAt || asset.updatedAt),
  };
}

function normalizeMetadata(value) {
  const input = object(value);
  return {
    mediaType: normalizeMediaType(input.mediaType),
    durationSec: optionalInteger(input.durationSec, 0, 24 * 60 * 60) || 0,
    description: clean(input.description, 12000) || null,
    manualTags: normalizeTags(input.manualTags),
    visibleBodyParts: normalizeBodyParts(input.visibleBodyParts),
    accessType: normalizeAccessType(input.accessType),
    minPriceCents: dollarsToCents(input.minPrice),
    idealPriceCents: dollarsToCents(input.idealPrice),
    storylineName: clean(input.storylineName, 200) || null,
    storylineOrder: optionalInteger(input.storylineOrder, -100000, 100000),
    storylineRole: normalizeStorylineRole(input.storylineRole),
  };
}

async function getMediaMetadata({ agencyId, creatorId, mediaIds, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const ids = cleanMediaIds(mediaIds);
  if (!ids.length) return { ok: true, creatorId: id, items: [] };
  const assets = await db.creatorMediaAsset.findMany({
    // Reads include inactive placeholders too: metadata is durable independently
    // of whether the canonical Messages catalog has activated this media yet.
    where: { agencyId, creatorId: id, mediaId: { in: ids } },
    take: ids.length,
  });
  const byId = new Map(assets.map((asset) => [String(asset.mediaId), asset]));
  return {
    ok: true,
    creatorId: id,
    items: ids.map((mediaId) => byId.get(mediaId)).filter(Boolean).map(assetToMetadata),
  };
}

async function upsertMediaMetadata({ agencyId, creatorId, mediaId, input, userId = null, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const cleanMediaId = clean(mediaId, 240);
  if (!cleanMediaId) {
    const error = new Error("mediaId is required");
    error.code = "MEDIA_ID_MISSING";
    throw error;
  }

  // A human metadata edit is not proof of canonical Vault membership. Persist it
  // even when the Messages catalog has not discovered this media yet, but keep a
  // newly-created row inactive. The normal catalog scanner later reuses the same
  // (creatorId, mediaId) row, sets catalogActive=true and preserves metadata.
  const now = new Date();
  const metadata = normalizeMetadata(input);
  const asset = await db.creatorMediaAsset.upsert({
    where: { creatorId_mediaId: { creatorId: id, mediaId: cleanMediaId } },
    create: {
      id: crypto.randomUUID(),
      agencyId,
      creatorId: id,
      mediaId: cleanMediaId,
      catalogActive: false,
      sortingStatus: "UNSORTED",
      firstSeenAt: now,
      lastSeenAt: now,
      metadataUpdatedAt: now,
      metadataUpdatedByUserId: userId || null,
      ...metadata,
    },
    update: {
      metadataUpdatedAt: now,
      metadataUpdatedByUserId: userId || null,
      ...metadata,
    },
  });
  return { ok: true, creatorId: id, item: assetToMetadata(asset) };
}

async function listStorylines({ agencyId, creatorId, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const rows = await db.creatorMediaAsset.findMany({
    where: { agencyId, creatorId: id, catalogActive: true, storylineName: { not: null } },
    select: { storylineName: true, storylineOrder: true, storylineRole: true },
    take: 100000,
  });
  const byName = new Map();
  for (const row of rows) {
    const name = clean(row.storylineName, 200);
    if (!name) continue;
    const key = name.toLowerCase();
    const item = byName.get(key) || {
      name,
      mediaCount: 0,
      mainCount: 0,
      additionalCount: 0,
      minOrder: null,
      maxOrder: null,
    };
    item.mediaCount += 1;
    if (row.storylineRole === "main") item.mainCount += 1;
    if (row.storylineRole === "additional") item.additionalCount += 1;
    if (row.storylineOrder != null) {
      item.minOrder = item.minOrder == null ? row.storylineOrder : Math.min(item.minOrder, row.storylineOrder);
      item.maxOrder = item.maxOrder == null ? row.storylineOrder : Math.max(item.maxOrder, row.storylineOrder);
    }
    byName.set(key, item);
  }
  const storylines = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { ok: true, creatorId: id, storylines, count: storylines.length };
}

function normalizeUsageItem(value) {
  const input = object(value);
  const mediaId = clean(input.mediaId, 240);
  if (!mediaId) return null;
  return {
    mediaId,
    sentCount: integer(input.sentCount, 0, 0, 10_000_000),
    soldCount: integer(input.soldCount, 0, 0, 10_000_000),
    notOpenedCount: integer(input.notOpenedCount, 0, 0, 10_000_000),
    freeCount: integer(input.freeCount, 0, 0, 10_000_000),
    revenueCents: integer(input.revenueCents, 0, 0, 2_000_000_000),
    uniqueBuyers: integer(input.uniqueBuyers, 0, 0, 10_000_000),
    lastSoldAt: date(input.lastSoldAt),
  };
}

function normalizeUsageSource(value) {
  const input = object(value);
  const sourceKey = clean(input.sourceKey, 240);
  const sourceRevision = clean(input.sourceRevision || input.capturedAt, 100);
  if (!sourceKey || !sourceRevision) return null;
  const merged = new Map();
  for (const raw of (Array.isArray(input.items) ? input.items : []).slice(0, MAX_USAGE_ITEMS_PER_SOURCE)) {
    const item = normalizeUsageItem(raw);
    if (!item) continue;
    const current = merged.get(item.mediaId);
    if (!current) {
      merged.set(item.mediaId, item);
      continue;
    }
    current.sentCount += item.sentCount;
    current.soldCount += item.soldCount;
    current.notOpenedCount += item.notOpenedCount;
    current.freeCount += item.freeCount;
    current.revenueCents += item.revenueCents;
    current.uniqueBuyers += item.uniqueBuyers;
    if (!current.lastSoldAt || (item.lastSoldAt && item.lastSoldAt > current.lastSoldAt)) current.lastSoldAt = item.lastSoldAt;
  }
  return {
    sourceKey,
    sourceRevision,
    capturedAt: date(input.capturedAt || sourceRevision, new Date()),
    items: [...merged.values()],
  };
}

function compareRevisions(left, right) {
  const leftTime = date(left)?.getTime();
  const rightTime = date(right)?.getTime();
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return String(left).localeCompare(String(right));
}

async function recomputeUsage(db, agencyId, creatorId, mediaIds) {
  const ids = cleanMediaIds(mediaIds, MAX_USAGE_SOURCES * MAX_USAGE_ITEMS_PER_SOURCE);
  if (!ids.length) return;
  const now = new Date();
  await db.creatorMediaAsset.updateMany({
    where: { agencyId, creatorId, mediaId: { in: ids } },
    data: {
      sentCount: 0,
      soldCount: 0,
      notOpenedCount: 0,
      freeCount: 0,
      revenueCents: 0,
      averagePriceCents: 0,
      uniqueBuyers: 0,
      lastSoldAt: null,
      usageUpdatedAt: now,
    },
  });

  const groups = await db.creatorMediaUsageContribution.groupBy({
    by: ["mediaId"],
    where: { agencyId, creatorId, mediaId: { in: ids } },
    _sum: {
      sentCount: true,
      soldCount: true,
      notOpenedCount: true,
      freeCount: true,
      revenueCents: true,
      uniqueBuyers: true,
    },
    _max: { lastSoldAt: true, capturedAt: true },
  });
  const projections = groups.map((group) => {
    const soldCount = integer(group._sum?.soldCount);
    const revenueCents = integer(group._sum?.revenueCents);
    return {
      mediaId: clean(group.mediaId, 240),
      sentCount: integer(group._sum?.sentCount, 0, 0, 2_000_000_000),
      soldCount: integer(soldCount, 0, 0, 2_000_000_000),
      notOpenedCount: integer(group._sum?.notOpenedCount, 0, 0, 2_000_000_000),
      freeCount: integer(group._sum?.freeCount, 0, 0, 2_000_000_000),
      revenueCents: integer(revenueCents, 0, 0, 2_000_000_000),
      averagePriceCents: soldCount > 0 ? integer(Math.round(revenueCents / soldCount), 0, 0, 2_000_000_000) : 0,
      uniqueBuyers: integer(group._sum?.uniqueBuyers, 0, 0, 2_000_000_000),
      lastSoldAt: iso(group._max?.lastSoldAt),
      usageUpdatedAt: iso(group._max?.capturedAt || now),
    };
  }).filter((group) => group.mediaId);

  if (projections.length && typeof db.$executeRawUnsafe === "function") {
    // Prisma's per-row update loop is prohibitively expensive against hosted
    // Postgres. The values were already normalized above; jsonb_to_recordset
    // applies every aggregate in one parameterized UPDATE.
    await db.$executeRawUnsafe(`
      UPDATE "CreatorMediaAsset" AS asset
      SET
        "sentCount" = projection."sentCount",
        "soldCount" = projection."soldCount",
        "notOpenedCount" = projection."notOpenedCount",
        "freeCount" = projection."freeCount",
        "revenueCents" = projection."revenueCents",
        "averagePriceCents" = projection."averagePriceCents",
        "uniqueBuyers" = projection."uniqueBuyers",
        "lastSoldAt" = projection."lastSoldAt",
        "usageUpdatedAt" = projection."usageUpdatedAt",
        "updatedAt" = NOW()
      FROM jsonb_to_recordset($3::jsonb) AS projection(
        "mediaId" text,
        "sentCount" integer,
        "soldCount" integer,
        "notOpenedCount" integer,
        "freeCount" integer,
        "revenueCents" integer,
        "averagePriceCents" integer,
        "uniqueBuyers" integer,
        "lastSoldAt" timestamptz,
        "usageUpdatedAt" timestamptz
      )
      WHERE asset."agencyId" = $1
        AND asset."creatorId" = $2
        AND asset."mediaId" = projection."mediaId"
    `, agencyId, creatorId, JSON.stringify(projections));
    return;
  }

  // Test doubles and non-Postgres adapters keep the portable fallback.
  for (const projection of projections) {
    await db.creatorMediaAsset.updateMany({
      where: { agencyId, creatorId, mediaId: projection.mediaId },
      data: {
        sentCount: projection.sentCount,
        soldCount: projection.soldCount,
        notOpenedCount: projection.notOpenedCount,
        freeCount: projection.freeCount,
        revenueCents: projection.revenueCents,
        averagePriceCents: projection.averagePriceCents,
        uniqueBuyers: projection.uniqueBuyers,
        lastSoldAt: date(projection.lastSoldAt),
        usageUpdatedAt: date(projection.usageUpdatedAt, now),
      },
    });
  }
}

async function lockMediaLibraryUsageTx(db, agencyId, creatorId) {
  if (typeof db.$queryRawUnsafe !== "function") return;
  await db.$queryRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1))::text AS \"acquired\"",
    `media_library_usage:${agencyId}:${creatorId}`,
  );
}

async function replaceUsageSourceTx(tx, { agencyId, creatorId, source }) {
  await lockMediaLibraryUsageTx(tx, agencyId, creatorId);
  const state = await tx.creatorMediaUsageSourceState.findUnique({
    where: { creatorId_sourceKey: { creatorId, sourceKey: source.sourceKey } },
  });
  if (state && compareRevisions(source.sourceRevision, state.sourceRevision) <= 0) {
    return { accepted: false, stale: true, acceptedItems: 0, missingMediaIds: [] };
  }

  const affected = new Set();
  const missing = new Set();
  const existing = await tx.creatorMediaUsageContribution.findMany({
    where: { agencyId, creatorId, sourceKey: source.sourceKey },
    select: { mediaId: true },
    take: MAX_USAGE_ITEMS_PER_SOURCE,
  });
  for (const row of existing) affected.add(String(row.mediaId));

  const incomingIds = source.items.map((item) => item.mediaId);
  const activeAssets = incomingIds.length ? await tx.creatorMediaAsset.findMany({
    where: { agencyId, creatorId, catalogActive: true, mediaId: { in: incomingIds } },
    select: { id: true, mediaId: true },
    take: incomingIds.length,
  }) : [];
  const activeMediaIds = new Set(activeAssets.map((asset) => String(asset.mediaId)));
  for (const mediaId of incomingIds) {
    if (!activeMediaIds.has(mediaId)) missing.add(mediaId);
  }

  if (incomingIds.length) {
    await tx.creatorMediaAsset.createMany({
      data: incomingIds.map((mediaId) => ({
        id: crypto.randomUUID(),
        agencyId,
        creatorId,
        mediaId,
        catalogActive: false,
        sortingStatus: "UNSORTED",
        firstSeenAt: source.capturedAt,
        lastSeenAt: source.capturedAt,
      })),
      skipDuplicates: true,
    });
  }

  const assets = incomingIds.length ? await tx.creatorMediaAsset.findMany({
    where: { agencyId, creatorId, mediaId: { in: incomingIds } },
    select: { id: true, mediaId: true },
    take: incomingIds.length,
  }) : [];
  const assetByMediaId = new Map(assets.map((asset) => [String(asset.mediaId), asset]));
  await tx.creatorMediaUsageContribution.deleteMany({
    where: { agencyId, creatorId, sourceKey: source.sourceKey },
  });

  const rows = [];
  for (const item of source.items) {
    const asset = assetByMediaId.get(item.mediaId);
    if (!asset) continue;
    affected.add(item.mediaId);
    rows.push({
      id: crypto.randomUUID(),
      agencyId,
      creatorId,
      assetId: asset.id,
      mediaId: item.mediaId,
      sourceKey: source.sourceKey,
      sourceRevision: source.sourceRevision,
      sentCount: item.sentCount,
      soldCount: item.soldCount,
      notOpenedCount: item.notOpenedCount,
      freeCount: item.freeCount,
      revenueCents: item.revenueCents,
      uniqueBuyers: item.uniqueBuyers,
      lastSoldAt: item.lastSoldAt,
      capturedAt: source.capturedAt,
    });
  }
  if (rows.length) await tx.creatorMediaUsageContribution.createMany({ data: rows });
  await tx.creatorMediaUsageSourceState.upsert({
    where: { creatorId_sourceKey: { creatorId, sourceKey: source.sourceKey } },
    create: {
      agencyId,
      creatorId,
      sourceKey: source.sourceKey,
      sourceRevision: source.sourceRevision,
      capturedAt: source.capturedAt,
    },
    update: {
      sourceRevision: source.sourceRevision,
      capturedAt: source.capturedAt,
    },
  });
  await recomputeUsage(tx, agencyId, creatorId, [...affected]);
  return {
    accepted: true,
    stale: false,
    acceptedItems: rows.length,
    missingMediaIds: [...missing],
  };
}

async function replaceUsageSources({ agencyId, creatorId, sources, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const normalized = (Array.isArray(sources) ? sources : [])
    .slice(0, MAX_USAGE_SOURCES)
    .map(normalizeUsageSource)
    .filter(Boolean);
  const result = {
    ok: true,
    creatorId: id,
    received: Array.isArray(sources) ? sources.length : 0,
    acceptedSources: 0,
    staleSources: 0,
    acceptedItems: 0,
    missingMediaIds: [],
  };
  if (!normalized.length) return result;

  const missing = new Set();
  // One source is the atomic unit. If source N fails, sources 1..N-1 remain
  // committed and the caller can safely retry the whole request: their durable
  // revisions make them cheap stale no-ops on the next attempt.
  for (const source of normalized) {
    const sourceResult = await db.$transaction(
      (tx) => replaceUsageSourceTx(tx, { agencyId, creatorId: id, source }),
      MEDIA_LIBRARY_USAGE_TRANSACTION_OPTIONS,
    );
    if (sourceResult.stale) {
      result.staleSources += 1;
      continue;
    }
    result.acceptedSources += 1;
    result.acceptedItems += sourceResult.acceptedItems;
    for (const mediaId of sourceResult.missingMediaIds) missing.add(mediaId);
  }
  result.missingMediaIds = [...missing];
  return result;
}

async function mutateFolderMembership({ agencyId, creatorId, mediaIds, folderId, action, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const ids = cleanMediaIds(mediaIds);
  const cleanFolderId = clean(folderId, 240);
  const normalizedAction = action === "remove" ? "remove" : "add";
  if (!ids.length || !cleanFolderId) return { ok: true, creatorId: id, updated: 0 };
  let updated = 0;
  await db.$transaction(async (tx) => {
    const assets = await tx.creatorMediaAsset.findMany({
      where: { agencyId, creatorId: id, catalogActive: true, mediaId: { in: ids } },
      select: { id: true, folderIds: true },
      take: ids.length,
    });
    for (const asset of assets) {
      const folders = new Set(uniqueStrings(asset.folderIds, 500, 240));
      if (normalizedAction === "add") folders.add(cleanFolderId);
      else folders.delete(cleanFolderId);
      const next = [...folders];
      await tx.creatorMediaAsset.update({
        where: { id: asset.id },
        data: { folderIds: next, sortingStatus: next.length ? "SORTED" : "UNSORTED" },
      });
      updated += 1;
    }
  });
  return { ok: true, creatorId: id, updated };
}

async function deleteMediaAssets({ agencyId, creatorId, mediaIds, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const ids = cleanMediaIds(mediaIds, 10000);
  if (!ids.length) return { ok: true, creatorId: id, deleted: 0 };
  const deleted = await db.creatorMediaAsset.deleteMany({
    where: { agencyId, creatorId: id, mediaId: { in: ids } },
  });
  return { ok: true, creatorId: id, deleted: deleted.count };
}

async function getMediaSalesSummary({ agencyId, creatorId, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const where = { agencyId, creatorId: id, catalogActive: true };
  const [aggregate, soldAssets, buyers, lastSale] = await Promise.all([
    db.creatorMediaAsset.aggregate({
      where,
      _sum: { soldCount: true, revenueCents: true, notOpenedCount: true, freeCount: true },
    }),
    db.creatorMediaAsset.count({ where: { ...where, soldCount: { gt: 0 } } }),
    db.creatorMediaUsageContribution.findMany({
      where: { agencyId, creatorId: id, soldCount: { gt: 0 }, asset: { is: { catalogActive: true } } },
      distinct: ["sourceKey"],
      select: { sourceKey: true },
      take: 100000,
    }),
    db.creatorMediaAsset.findFirst({
      where: { ...where, lastSoldAt: { not: null } },
      orderBy: { lastSoldAt: "desc" },
      select: { lastSoldAt: true },
    }),
  ]);
  return {
    ok: true,
    summary: {
      creatorId: id,
      soldAssets,
      totalSales: integer(aggregate._sum?.soldCount),
      revenueCents: integer(aggregate._sum?.revenueCents),
      opened: integer(aggregate._sum?.soldCount),
      notOpened: integer(aggregate._sum?.notOpenedCount),
      free: integer(aggregate._sum?.freeCount),
      unresolved: 0,
      uniqueBuyers: buyers.length,
      deletedBuyers: 0,
      lastSaleAt: iso(lastSale?.lastSoldAt),
    },
  };
}

async function rebuildMediaUsage({ agencyId, creatorId, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const assets = await db.creatorMediaAsset.findMany({
    where: { agencyId, creatorId: id, catalogActive: true },
    select: { mediaId: true },
    take: 100000,
  });
  const mediaIds = assets.map((asset) => String(asset.mediaId));
  await db.$transaction(async (tx) => {
    for (let offset = 0; offset < mediaIds.length; offset += MAX_MEDIA_IDS) {
      await recomputeUsage(tx, agencyId, id, mediaIds.slice(offset, offset + MAX_MEDIA_IDS));
    }
  });
  return { ok: true, creatorId: id, rebuilt: mediaIds.length };
}

function assetToSalesAsset(asset) {
  return {
    id: String(asset.id),
    creatorId: String(asset.creatorId),
    assetId: String(asset.mediaId),
    mediaId: String(asset.mediaId),
    mediaType: normalizeMediaType(asset.mediaType),
    preview: {
      thumbUrl: asset.thumbUrl || "",
      previewUrl: asset.previewUrl || asset.thumbUrl || "",
      fullUrl: asset.fullUrl || asset.previewUrl || asset.thumbUrl || "",
    },
    soldCount: integer(asset.soldCount),
    totalRevenueCents: integer(asset.revenueCents),
    uniqueBuyers: integer(asset.uniqueBuyers),
    averagePriceCents: integer(asset.averagePriceCents),
    openedCount: integer(asset.soldCount),
    notOpenedCount: integer(asset.notOpenedCount),
    freeCount: integer(asset.freeCount),
    lastSoldAt: iso(asset.lastSoldAt),
  };
}

async function listMediaSalesAssets({ agencyId, creatorId, offset = 0, limit = 100, mediaType = null, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const skip = integer(offset, 0, 0, 10_000_000);
  const take = integer(limit, 100, 1, 500);
  const normalizedType = mediaType ? normalizeMediaType(mediaType) : null;
  const where = {
    agencyId,
    creatorId: id,
    catalogActive: true,
    soldCount: { gt: 0 },
    ...(normalizedType ? { mediaType: normalizedType } : {}),
  };
  const [assets, count] = await Promise.all([
    db.creatorMediaAsset.findMany({
      where,
      orderBy: [{ revenueCents: "desc" }, { soldCount: "desc" }, { lastSoldAt: "desc" }, { mediaId: "asc" }],
      skip,
      take,
    }),
    db.creatorMediaAsset.count({ where }),
  ]);
  const items = assets.map(assetToSalesAsset);
  return { ok: true, items, count, offset: skip, nextOffset: skip + items.length, hasMore: skip + items.length < count };
}

module.exports = {
  MAX_MEDIA_IDS,
  MAX_USAGE_SOURCES,
  MAX_USAGE_ITEMS_PER_SOURCE,
  cleanMediaIds,
  assetToMetadata,
  getMediaMetadata,
  upsertMediaMetadata,
  listStorylines,
  replaceUsageSources,
  mutateFolderMembership,
  deleteMediaAssets,
  getMediaSalesSummary,
  listMediaSalesAssets,
  rebuildMediaUsage,
  recomputeUsage,
};
