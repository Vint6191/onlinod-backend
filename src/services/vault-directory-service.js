"use strict";

const {
  getNeverUsedPipelineState,
  usedMediaIdsForBatch,
} = require("./vault-never-used-service");

const MAX_MEDIA_IDS = 5000;
const TOP_ASSET_LIMIT = 100;

function clean(value, max = 240) { return String(value ?? "").trim().slice(0, max); }
function cleanMediaIds(values, limit = MAX_MEDIA_IDS) {
  const out = []; const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = clean(value); if (!id || seen.has(id)) continue;
    seen.add(id); out.push(id); if (out.length >= limit) break;
  }
  return out;
}
function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function firstUrl(preview) {
  const row = asObject(preview);
  return [row.thumbUrl, row.thumb_url, row.previewUrl, row.preview_url, row.fullUrl, row.full_url, row.url]
    .map((value) => clean(value, 4000)).find(Boolean) || "";
}
function mediaType(value) { const type = clean(value, 40).toLowerCase(); return ["photo", "video", "audio", "gif"].includes(type) ? type : "unknown"; }
async function requireCreator(db, agencyId, creatorId) {
  const creator = await db.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null }, select: { id: true } });
  if (!creator) { const error = new Error("Creator not found"); error.code = "CREATOR_NOT_FOUND"; throw error; }
  return creator;
}
function analyticsBase(id) {
  return {
    mediaId: id, sentCount: 0, soldCount: 0, notOpenedCount: 0, freeCount: 0, revenueCents: 0,
    averagePriceCents: 0, uniqueBuyers: 0, rank: null, neverUsed: false, usageState: "UNKNOWN",
    ownership: "UNKNOWN", sourceKind: "UNKNOWN", chatEligibility: "UNKNOWN", ownershipEvidence: null,
    inMessagesCatalog: false,
    authoritative: false,
  };
}
function normalizeAsset(row, rank = null) {
  const preview = asObject(row.preview);
  const id = clean(row.mediaId || row.assetId);
  return {
    ...analyticsBase(id),
    assetId: clean(row.assetId), mediaType: mediaType(row.mediaType), thumbUrl: firstUrl(preview), previewUrl: firstUrl(preview),
    fullUrl: clean(preview.fullUrl || preview.full_url || preview.url, 4000) || firstUrl(preview),
    soldCount: Number(row.soldCount || 0), notOpenedCount: Number(row.notOpenedCount || 0), freeCount: Number(row.freeCount || 0),
    revenueCents: Number(row.totalRevenueCents || 0), averagePriceCents: Number(row.averagePriceCents || 0),
    uniqueBuyers: Number(row.uniqueBuyers || 0), rank, lastSoldAt: row.lastSoldAt || null,
  };
}
function mapSentCounts(rows, field, target) {
  for (const row of rows || []) {
    const id = clean(row[field]);
    if (!id) continue;
    target.set(id, Math.max(Number(target.get(id) || 0), Number(row._count?._all || 0)));
  }
}

async function getVaultDirectoryIntelligence({ agencyId, creatorId, mediaIds = [], includePipeline = true, db = null }) {
  const client = db || require("../prisma");
  const cleanCreatorId = clean(creatorId, 100);
  await requireCreator(client, agencyId, cleanCreatorId);
  const ids = cleanMediaIds(mediaIds);

  const creatorEvidence = {
    agencyId,
    creatorId: cleanCreatorId,
    OR: [{ ownership: "CREATOR" }, { isFanMedia: false, messageLedger: { isFromCreator: true } }],
  };

  const [protectedRows, salesSummary, soldAssets, topRows, assetRows, latestMedia, catalogRows, pipelineResult] = await Promise.all([
    client.dialogMessageMedia.findMany({
      where: creatorEvidence,
      distinct: ["mediaId"], select: { mediaId: true }, take: 100000,
    }),
    client.vaultAssetSalesAggregate.aggregate({ where: { agencyId, creatorId: cleanCreatorId }, _sum: { totalRevenueCents: true, soldCount: true }, _max: { lastSoldAt: true } }),
    client.vaultAssetSalesAggregate.count({ where: { agencyId, creatorId: cleanCreatorId, soldCount: { gt: 0 } } }),
    client.vaultAssetSalesAggregate.findMany({ where: { agencyId, creatorId: cleanCreatorId, soldCount: { gt: 0 } }, orderBy: [{ totalRevenueCents: "desc" }, { soldCount: "desc" }, { lastSoldAt: "desc" }], take: TOP_ASSET_LIMIT }),
    ids.length ? client.vaultAssetSalesAggregate.findMany({ where: { agencyId, creatorId: cleanCreatorId, OR: [{ mediaId: { in: ids } }, { assetId: { in: ids } }] } }) : Promise.resolve([]),
    client.dialogMessageMedia.findFirst({ where: creatorEvidence, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    ids.length ? client.vaultUnsortedItem.findMany({
      where: { agencyId, creatorId: cleanCreatorId, status: { not: "HIDDEN" }, mediaId: { in: ids } },
      select: { mediaId: true, updatedAt: true }, take: MAX_MEDIA_IDS,
    }) : Promise.resolve([]),
    includePipeline ? getNeverUsedPipelineState({ agencyId, creatorId: cleanCreatorId, db: client }) : Promise.resolve({ pipeline: null }),
  ]);

  const pipeline = pipelineResult.pipeline;
  const authoritative = pipeline?.authoritative === true;
  const catalogIds = new Set(catalogRows.map((row) => String(row.mediaId)));
  const lookupIds = cleanMediaIds([...ids, ...topRows.flatMap((row) => [row.mediaId, row.assetId])], MAX_MEDIA_IDS + TOP_ASSET_LIMIT * 2);
  const [usedEvidence, sentMediaGroups, sentAssetGroups] = await Promise.all([
    usedMediaIdsForBatch(client, agencyId, cleanCreatorId, lookupIds),
    lookupIds.length ? client.dialogMessageMedia.groupBy({
      by: ["mediaId"], where: { ...creatorEvidence, mediaId: { in: lookupIds } }, _count: { _all: true },
    }) : Promise.resolve([]),
    lookupIds.length ? client.dialogMessageMedia.groupBy({
      by: ["assetId"], where: { ...creatorEvidence, assetId: { in: lookupIds } }, _count: { _all: true },
    }) : Promise.resolve([]),
  ]);
  const sentById = new Map();
  mapSentCounts(sentMediaGroups, "mediaId", sentById);
  mapSentCounts(sentAssetGroups, "assetId", sentById);

  const assetById = new Map();
  for (const row of assetRows) {
    const normalized = normalizeAsset(row, null);
    if (normalized.mediaId) assetById.set(normalized.mediaId, normalized);
    if (normalized.assetId) assetById.set(normalized.assetId, normalized);
  }
  const rankById = new Map();
  const topAssets = topRows.map((row, index) => {
    const normalized = normalizeAsset(row, index + 1);
    normalized.sentCount = sentById.get(normalized.mediaId) || sentById.get(normalized.assetId) || 0;
    normalized.usageState = "USED";
    normalized.ownership = "CREATOR_OWNED";
    normalized.chatEligibility = "ELIGIBLE";
    normalized.ownershipEvidence = "dialog_or_sales_evidence";
    normalized.inMessagesCatalog = catalogIds.has(normalized.mediaId) || catalogIds.has(normalized.assetId);
    normalized.authoritative = authoritative;
    if (normalized.mediaId) rankById.set(normalized.mediaId, index + 1);
    if (normalized.assetId) rankById.set(normalized.assetId, index + 1);
    return normalized;
  });

  const analytics = ids.map((id) => {
    const asset = assetById.get(id);
    const sentCount = sentById.get(id) || 0;
    const soldCount = Number(asset?.soldCount || 0);
    const inMessagesCatalog = catalogIds.has(id);
    const used = usedEvidence.ids.has(id) || sentCount > 0 || soldCount > 0;
    let usageState = "UNKNOWN";
    if (used) usageState = "USED";
    else if (inMessagesCatalog) usageState = authoritative ? "NEVER_USED" : "PENDING";
    else if (authoritative) usageState = "NOT_APPLICABLE";

    return {
      mediaId: id, sentCount, soldCount, notOpenedCount: Number(asset?.notOpenedCount || 0), freeCount: Number(asset?.freeCount || 0),
      revenueCents: Number(asset?.revenueCents || 0), averagePriceCents: Number(asset?.averagePriceCents || 0), uniqueBuyers: Number(asset?.uniqueBuyers || 0),
      rank: rankById.get(id) || null, neverUsed: usageState === "NEVER_USED", usageState,
      ownership: inMessagesCatalog || used ? "CREATOR_OWNED" : "UNKNOWN",
      sourceKind: inMessagesCatalog ? "VAULT" : "UNKNOWN",
      chatEligibility: inMessagesCatalog || used ? "ELIGIBLE" : authoritative ? "NOT_ELIGIBLE" : "UNKNOWN",
      ownershipEvidence: inMessagesCatalog ? "messages_catalog_membership" : used ? "dialog_or_sales_evidence" : null,
      inMessagesCatalog,
      authoritative,
    };
  });

  const freshnessCandidates = [latestMedia?.updatedAt, salesSummary?._max?.lastSoldAt, pipeline?.updatedAt, usedEvidence.updatedAt, ...catalogRows.slice(0, 1).map((row) => row.updatedAt), ...topRows.slice(0, 1).map((row) => row.updatedAt)]
    .map((value) => value ? new Date(value).getTime() : Number.NaN).filter(Number.isFinite);
  return {
    ok: true,
    creatorId: cleanCreatorId,
    summary: {
      usedMediaCount: protectedRows.length, protectedMediaCount: protectedRows.length, soldAssets,
      totalSales: Number(salesSummary?._sum?.soldCount || 0), revenueCents: Number(salesSummary?._sum?.totalRevenueCents || 0), lastSaleAt: salesSummary?._max?.lastSoldAt || null,
    },
    analytics, topAssets, pipeline,
    freshness: freshnessCandidates.length ? new Date(Math.max(...freshnessCandidates)).toISOString() : null,
  };
}

async function checkProtectedVaultMedia({ agencyId, creatorId, mediaIds = [], db = null }) {
  const client = db || require("../prisma");
  const cleanCreatorId = clean(creatorId, 100);
  await requireCreator(client, agencyId, cleanCreatorId);
  const ids = cleanMediaIds(mediaIds);
  if (!ids.length) return { ok: true, creatorId: cleanCreatorId, requested: 0, protectedMediaIds: [] };
  const rows = await client.dialogMessageMedia.findMany({
    where: { agencyId, creatorId: cleanCreatorId, mediaId: { in: ids }, OR: [{ ownership: "CREATOR" }, { isFanMedia: false, messageLedger: { isFromCreator: true } }] },
    distinct: ["mediaId"], select: { mediaId: true }, take: MAX_MEDIA_IDS,
  });
  return { ok: true, creatorId: cleanCreatorId, requested: ids.length, protectedMediaIds: rows.map((row) => String(row.mediaId)) };
}

module.exports = { MAX_MEDIA_IDS, TOP_ASSET_LIMIT, cleanMediaIds, getVaultDirectoryIntelligence, checkProtectedVaultMedia };
