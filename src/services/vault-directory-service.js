"use strict";

const {
  getNeverUsedPipelineState,
} = require("./vault-never-used-service");
const { cleanMediaIds } = require("./media-library-service");

const MAX_MEDIA_IDS = 5000;
const TOP_ASSET_LIMIT = 100;

function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeMediaType(value) {
  const type = clean(value, 20).toLowerCase();
  return ["photo", "video", "audio", "gif"].includes(type) ? type : "unknown";
}

async function requireCreator(db, agencyId, creatorId) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true },
  });
  if (!creator) {
    const error = new Error("Creator not found");
    error.code = "CREATOR_NOT_FOUND";
    throw error;
  }
  return creator;
}

function analyticsBase(mediaId) {
  return {
    mediaId,
    sentCount: 0,
    soldCount: 0,
    notOpenedCount: 0,
    freeCount: 0,
    revenueCents: 0,
    averagePriceCents: 0,
    uniqueBuyers: 0,
    rank: null,
    neverUsed: false,
    usageState: "UNKNOWN",
    ownership: "UNKNOWN",
    sourceKind: "UNKNOWN",
    chatEligibility: "UNKNOWN",
    ownershipEvidence: null,
    inMessagesCatalog: false,
    authoritative: false,
  };
}

function assetAnalytics(asset, authoritative, rank = null) {
  const mediaId = clean(asset.mediaId);
  const sentCount = integer(asset.sentCount);
  const active = asset.catalogActive === true;
  const usageState = sentCount > 0
    ? "USED"
    : active
      ? authoritative ? "NEVER_USED" : "PENDING"
      : authoritative ? "NOT_APPLICABLE" : "UNKNOWN";
  return {
    ...analyticsBase(mediaId),
    sentCount,
    soldCount: integer(asset.soldCount),
    notOpenedCount: integer(asset.notOpenedCount),
    freeCount: integer(asset.freeCount),
    revenueCents: integer(asset.revenueCents),
    averagePriceCents: integer(asset.averagePriceCents),
    uniqueBuyers: integer(asset.uniqueBuyers),
    rank,
    neverUsed: usageState === "NEVER_USED",
    usageState,
    ownership: active ? "CREATOR_OWNED" : "UNKNOWN",
    sourceKind: active ? "VAULT" : "UNKNOWN",
    chatEligibility: active ? "ELIGIBLE" : authoritative ? "NOT_ELIGIBLE" : "UNKNOWN",
    ownershipEvidence: active ? "media_library_membership" : null,
    inMessagesCatalog: active,
    authoritative,
  };
}

function topAsset(asset, authoritative, rank) {
  const analytics = assetAnalytics(asset, authoritative, rank);
  return {
    ...analytics,
    assetId: analytics.mediaId,
    mediaType: normalizeMediaType(asset.mediaType),
    thumbUrl: asset.thumbUrl || "",
    previewUrl: asset.previewUrl || asset.thumbUrl || "",
    fullUrl: asset.fullUrl || asset.previewUrl || asset.thumbUrl || "",
    lastSoldAt: iso(asset.lastSoldAt),
  };
}

async function getVaultDirectoryIntelligence({ agencyId, creatorId, mediaIds = [], includePipeline = true, db = null }) {
  const client = db || require("../prisma");
  const cleanCreatorId = clean(creatorId, 100);
  await requireCreator(client, agencyId, cleanCreatorId);
  const ids = cleanMediaIds(mediaIds, MAX_MEDIA_IDS);
  const activeWhere = { agencyId, creatorId: cleanCreatorId, catalogActive: true };

  const [catalogCount, usedCount, totals, soldAssets, topRows, assetRows, latestAsset, pipelineResult] = await Promise.all([
    client.creatorMediaAsset.count({ where: activeWhere }),
    client.creatorMediaAsset.count({ where: { ...activeWhere, sentCount: { gt: 0 } } }),
    client.creatorMediaAsset.aggregate({
      where: activeWhere,
      _sum: { soldCount: true, revenueCents: true },
      _max: { lastSoldAt: true },
    }),
    client.creatorMediaAsset.count({ where: { ...activeWhere, soldCount: { gt: 0 } } }),
    client.creatorMediaAsset.findMany({
      where: { ...activeWhere, soldCount: { gt: 0 } },
      orderBy: [{ revenueCents: "desc" }, { soldCount: "desc" }, { lastSoldAt: "desc" }, { mediaId: "asc" }],
      take: TOP_ASSET_LIMIT,
    }),
    ids.length ? client.creatorMediaAsset.findMany({
      where: { ...activeWhere, mediaId: { in: ids } },
      take: ids.length,
    }) : Promise.resolve([]),
    client.creatorMediaAsset.findFirst({
      where: activeWhere,
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true, usageUpdatedAt: true },
    }),
    includePipeline
      ? getNeverUsedPipelineState({ agencyId, creatorId: cleanCreatorId, db: client })
      : Promise.resolve({ pipeline: null }),
  ]);

  const pipeline = pipelineResult.pipeline;
  const authoritative = pipeline?.authoritative === true;
  const rankById = new Map(topRows.map((asset, index) => [String(asset.mediaId), index + 1]));
  const assetById = new Map(assetRows.map((asset) => [String(asset.mediaId), asset]));
  const analytics = ids.map((mediaId) => {
    const asset = assetById.get(mediaId);
    if (asset) return assetAnalytics(asset, authoritative, rankById.get(mediaId) || null);
    return {
      ...analyticsBase(mediaId),
      usageState: authoritative ? "NOT_APPLICABLE" : "UNKNOWN",
      chatEligibility: authoritative ? "NOT_ELIGIBLE" : "UNKNOWN",
      authoritative,
    };
  });
  const topAssets = topRows.map((asset, index) => topAsset(asset, authoritative, index + 1));
  const freshnessCandidates = [latestAsset?.updatedAt, latestAsset?.usageUpdatedAt, pipeline?.updatedAt, totals?._max?.lastSoldAt]
    .map((value) => value ? new Date(value).getTime() : Number.NaN)
    .filter(Number.isFinite);

  return {
    ok: true,
    creatorId: cleanCreatorId,
    summary: {
      usedMediaCount: usedCount,
      protectedMediaCount: catalogCount,
      soldAssets,
      totalSales: integer(totals?._sum?.soldCount),
      revenueCents: integer(totals?._sum?.revenueCents),
      lastSaleAt: iso(totals?._max?.lastSoldAt),
    },
    analytics,
    topAssets,
    pipeline,
    freshness: freshnessCandidates.length ? new Date(Math.max(...freshnessCandidates)).toISOString() : null,
  };
}

async function checkProtectedVaultMedia({ agencyId, creatorId, mediaIds = [], db = null }) {
  const client = db || require("../prisma");
  const cleanCreatorId = clean(creatorId, 100);
  await requireCreator(client, agencyId, cleanCreatorId);
  const ids = cleanMediaIds(mediaIds, MAX_MEDIA_IDS);
  if (!ids.length) {
    return { ok: true, creatorId: cleanCreatorId, requested: 0, protectedMediaIds: [] };
  }
  const rows = await client.creatorMediaAsset.findMany({
    where: {
      agencyId,
      creatorId: cleanCreatorId,
      catalogActive: true,
      mediaId: { in: ids },
    },
    select: { mediaId: true },
    take: ids.length,
  });
  return {
    ok: true,
    creatorId: cleanCreatorId,
    requested: ids.length,
    protectedMediaIds: rows.map((row) => String(row.mediaId)),
  };
}

module.exports = {
  MAX_MEDIA_IDS,
  TOP_ASSET_LIMIT,
  cleanMediaIds,
  getVaultDirectoryIntelligence,
  checkProtectedVaultMedia,
};
