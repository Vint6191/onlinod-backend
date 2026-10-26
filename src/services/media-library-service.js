"use strict";
const { runDbTransaction } = require("./db-transaction-service");
const { mediaOffset, exactMediaCount, readMediaPage } = require("./media-read-page");


const { lockDbAdvisoryXact } = require("./db-transaction-service");
const crypto = require("node:crypto");
const prisma = require("../prisma");
const { unresolvedPipelineSubmissionWhere } = require("./custom-content-pipeline-authority-service");
const { resolveCustomMediaProvenance } = require("./custom-media-provenance-authority-service");
const { publishMediaResult } = require("./media-entity-change-service");
const { normalizeUsageFactSource, mergeUsageFactSourceTx } = require("./media-usage-fact-service");
const { currentCommitContext } = require("./db-commit-kernel");

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
    source: String(asset.source || "GENERAL").toUpperCase() === "CUSTOM" ? "CUSTOM" : "GENERAL",
    customOrderId: asset.customOrderId == null ? null : String(asset.customOrderId),
    customSubmissionId: asset.customSubmissionId == null ? null : String(asset.customSubmissionId),
    customFullPrice: asset.customFullPriceCents == null ? null : centsToDollars(asset.customFullPriceCents),
    customFullPriceCents: asset.customFullPriceCents == null ? null : Math.max(0, integer(asset.customFullPriceCents)),
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

function searchTagCandidates(value) {
  const raw = clean(value, 240).toLowerCase();
  if (!raw) return [];
  const candidates = [
    raw.replace(/\s+/g, "_"),
    ...raw.split(/[\s,;|]+/g).map((part) => part.trim().replace(/\s+/g, "_")),
  ];
  return [...new Set(candidates.filter(Boolean))].slice(0, 12);
}

function jsonArrayContainsAny(field, values) {
  return uniqueStrings(values, 500, 240).map((value) => ({ [field]: { array_contains: [value] } }));
}

function assetToSearchItem(asset) {
  return {
    mediaId: String(asset.mediaId),
    mediaType: normalizeMediaType(asset.mediaType),
    durationSec: Number(asset.durationSec || 0) > 0 ? Number(asset.durationSec) : null,
    thumbUrl: clean(asset.thumbUrl, 4000),
    previewUrl: clean(asset.previewUrl, 4000),
    fullUrl: clean(asset.fullUrl, 4000),
    folderIds: uniqueStrings(asset.folderIds, 500, 240),
    metadata: assetToMetadata(asset),
  };
}

async function searchMediaLibrary({
  agencyId, creatorId, query, scope = "everything", folderId = null, folderMatchIds = [],
  mediaType = null, offset = 0, limit = 40, db = prisma,
}) {
  const id = await requireCreator(db, agencyId, creatorId);
  const q = clean(query, 240);
  const searchScope = ["everything", "description", "tags", "folders"].includes(clean(scope, 30).toLowerCase())
    ? clean(scope, 30).toLowerCase()
    : "everything";
  const skip = mediaOffset(offset);
  const take = integer(limit, 40, 1, 100);
  const activeFolderId = clean(folderId, 240);
  const matchedFolders = uniqueStrings(folderMatchIds, 500, 240);
  const type = clean(mediaType, 20).toLowerCase();
  const normalizedType = type && type !== "all" ? normalizeMediaType(type) : null;

  // Human-authored metadata is durable even before/without catalog activation.
  // Search must therefore see rows created by metadata edits (catalogActive=false),
  // otherwise the Picker can visibly show a description/tag via getManyByMediaIds()
  // and then return 0 results for the exact same text. Folder membership remains a
  // catalog concept, so folder-scoped searches still require an active catalog row.
  const folderScoped = Boolean(activeFolderId && activeFolderId !== "all");
  const catalogOnly = !q || searchScope === "folders" || folderScoped;
  const and = [
    { agencyId, creatorId: id },
    ...(catalogOnly
      ? [{ catalogActive: true }]
      : [{ OR: [{ catalogActive: true }, { metadataUpdatedAt: { not: null } }] }]),
    ...(normalizedType ? [{ mediaType: normalizedType }] : []),
    ...(folderScoped ? [{ folderIds: { array_contains: [activeFolderId] } }] : []),
  ];

  if (q) {
    const tagClauses = searchTagCandidates(q).map((tag) => ({ manualTags: { array_contains: [tag] } }));
    const folderClauses = jsonArrayContainsAny("folderIds", matchedFolders);
    if (searchScope === "description") {
      and.push({ description: { contains: q, mode: "insensitive" } });
    } else if (searchScope === "tags") {
      and.push(tagClauses.length ? { OR: tagClauses } : { mediaId: "__nod_no_tag_match__" });
    } else if (searchScope === "folders") {
      and.push(folderClauses.length ? { OR: folderClauses } : { mediaId: "__nod_no_folder_match__" });
    } else {
      const clauses = [
        { description: { contains: q, mode: "insensitive" } },
        ...tagClauses,
        ...(folderClauses.length ? [{ AND: [{ catalogActive: true }, { OR: folderClauses }] }] : []),
      ];
      and.push({ OR: clauses });
    }
  }

  const where = { AND: and };
  const { rows: assets, count } = await readMediaPage(db, {
    where, orderBy: [{ lastSeenAt: "desc" }, { mediaId: "desc" }], offset: skip, limit: take,
  });
  const items = assets.map(assetToSearchItem);
  return {
    ok: true,
    creatorId: id,
    items,
    count,
    offset: skip,
    nextOffset: skip + items.length,
    hasMore: skip + items.length < count,
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
  return runDbTransaction(db, async (tx) => {
    const asset = await tx.creatorMediaAsset.upsert({
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
    await publishMediaResult({ db: tx, agencyId, creatorId: id, kind: "METADATA", entityId: `asset:${cleanMediaId}`,
      mediaId: cleanMediaId, state: metadata });
    return { ok: true, creatorId: id, item: assetToMetadata(asset) };
  });
}

async function listStorylines({ agencyId, creatorId, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  // Aggregate in the database; the dropdown contains every distinct name,
  // regardless of how many media belong to it. Normalize names in JS to keep
  // the existing trim/case/numeric-sort semantics for historical metadata.
  const rows = await db.creatorMediaAsset.groupBy({
    by: ["storylineName", "storylineRole"],
    where: { agencyId, creatorId: id, catalogActive: true, storylineName: { not: null } },
    _count: { _all: true },
    _min: { storylineOrder: true },
    _max: { storylineOrder: true },
    orderBy: [{ storylineName: "asc" }, { storylineRole: "asc" }],
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
    const count = exactMediaCount(row._count._all);
    item.mediaCount = exactMediaCount(item.mediaCount + count);
    if (row.storylineRole === "main") item.mainCount = exactMediaCount(item.mainCount + count);
    if (row.storylineRole === "additional") item.additionalCount = exactMediaCount(item.additionalCount + count);
    if (row._min.storylineOrder != null) {
      item.minOrder = item.minOrder == null ? row._min.storylineOrder : Math.min(item.minOrder, row._min.storylineOrder);
      item.maxOrder = item.maxOrder == null ? row._max.storylineOrder : Math.max(item.maxOrder, row._max.storylineOrder);
    }
    byName.set(key, item);
  }
  const storylines = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { ok: true, creatorId: id, storylines, count: storylines.length };
}


async function lockMediaLibraryUsageTx(db, agencyId, creatorId) {
  await lockDbAdvisoryXact({ db, key: `media_library_usage:${agencyId}:${creatorId}` });
}

async function replaceUsageSourceTx(tx, { agencyId, creatorId, source }) {
  await lockMediaLibraryUsageTx(tx, agencyId, creatorId);
  return mergeUsageFactSourceTx(tx, { agencyId, creatorId, source });
}

async function replaceUsageSources({ agencyId, creatorId, sources, db = prisma, commitGuard = null }) {
  if (Array.isArray(sources) && sources.length > MAX_USAGE_SOURCES) {
    throw Object.assign(new Error("MEDIA_LIBRARY_USAGE_BATCH_TOO_LARGE"), { code: "MEDIA_LIBRARY_USAGE_BATCH_TOO_LARGE", status: 413 });
  }
  const normalized = (Array.isArray(sources) ? sources : [])
    .map(normalizeUsageFactSource)
    .filter(Boolean);
  const id = await requireCreator(db, agencyId, creatorId);
  const result = {
    ok: true,
    creatorId: id,
    received: Array.isArray(sources) ? sources.length : 0,
    acceptedSources: 0,
    staleSources: 0,
    acceptedItems: 0,
    missingMediaIds: [],
    awaitingCompleteSources: [],
    awaitingCompleteReasons: {},
  };
  if (!normalized.length) return result;

  const missing = new Set();
  // One source is the atomic unit. If source N fails, sources 1..N-1 remain
  // committed and the caller can safely retry the whole request: their durable
  // revisions make them cheap stale no-ops on the next attempt.
  for (const source of normalized) {
    const sourceResult = await runDbTransaction(db, 
      async (tx) => {
        if (typeof commitGuard === "function") await commitGuard(tx);
        return replaceUsageSourceTx(tx, { agencyId, creatorId: id, source });
      },
      MEDIA_LIBRARY_USAGE_TRANSACTION_OPTIONS,
    );
    if (sourceResult.awaitingCompleteSource) {
      result.awaitingCompleteSources.push(source.sourceKey);
      result.awaitingCompleteReasons[source.sourceKey] = sourceResult.awaitingCompleteReason;
    }
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

async function liveCustomOwnershipByMedia({ agencyId, creatorId, mediaIds, db }) {
  const ids = cleanMediaIds(mediaIds, MAX_MEDIA_IDS);
  const ownership = new Map();
  if (!ids.length) return ownership;
  const provenance = await resolveCustomMediaProvenance({
    agencyId, creatorId, mediaIds: ids, db, maxMediaIds: MAX_MEDIA_IDS,
  });
  const submissionIds = Array.from(new Set(ids.flatMap((mediaId) =>
    [...(provenance.referencesByMedia.get(mediaId)?.values() || [])]
      .map((ref) => clean(ref.submissionId, 180)).filter(Boolean)
  )));
  if (!submissionIds.length) return ownership;
  const live = await db.customContentSubmission.findMany({
    where: { id: { in: submissionIds }, agencyId, creatorId, ...unresolvedPipelineSubmissionWhere() },
    select: { id: true, executionVaultFolderId: true },
    take: submissionIds.length,
  });
  const liveById = new Map((live || []).map((row) => [String(row.id), row]));
  for (const mediaId of ids) {
    const rows = [];
    for (const ref of provenance.referencesByMedia.get(mediaId)?.values() || []) {
      const submission = liveById.get(String(ref.submissionId || ""));
      if (submission) rows.push(submission);
    }
    if (rows.length) ownership.set(mediaId, rows);
  }
  return ownership;
}

async function mutateFolderMembership({ agencyId, creatorId, mediaIds, folderId, action, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const ids = cleanMediaIds(mediaIds);
  const cleanFolderId = clean(folderId, 240);
  const normalizedAction = action === "remove" ? "remove" : "add";
  if (!ids.length || !cleanFolderId) return { ok: true, creatorId: id, updated: 0 };
  let updated = 0;
  await runDbTransaction(db, async (tx) => {
    const assets = await tx.creatorMediaAsset.findMany({
      where: { agencyId, creatorId: id, catalogActive: true, mediaId: { in: ids } },
      select: { id: true, mediaId: true, source: true, customSubmissionId: true, folderIds: true },
      take: ids.length,
    });
    if (normalizedAction === "remove") {
      const ownership = await liveCustomOwnershipByMedia({ agencyId, creatorId: id, mediaIds: ids, db: tx });
      const blockedMediaIds = ids.filter((mediaId) => {
        const submissions = ownership.get(mediaId) || [];
        return submissions.some((submission) => {
          const pinnedFolderId = clean(submission.executionVaultFolderId, 240);
          return !pinnedFolderId || pinnedFolderId === cleanFolderId;
        });
      });
      if (blockedMediaIds.length) {
        throw Object.assign(new Error("Live Custom pipeline media cannot be removed from its pinned Vault folder"), {
          code: "MEDIA_LIBRARY_CUSTOM_PIPELINE_FOLDER_OWNED", status: 409, mediaIds: blockedMediaIds, folderId: cleanFolderId,
        });
      }
    }
    const changes = [];
    for (const asset of assets) {
      const folders = new Set(uniqueStrings(asset.folderIds, 500, 240));
      if (normalizedAction === "add") folders.add(cleanFolderId);
      else folders.delete(cleanFolderId);
      const next = [...folders];
      if (JSON.stringify(next) === JSON.stringify(asset.folderIds)) continue;
      await tx.creatorMediaAsset.update({
        where: { id: asset.id },
        data: { folderIds: next, sortingStatus: next.length ? "SORTED" : "UNSORTED" },
      });
      changes.push({ mediaId: asset.mediaId, folderIds: next });
      updated += 1;
    }
    if (changes.length) await publishMediaResult({ db: tx, agencyId, creatorId: id, kind: "FOLDER_MEMBERSHIP", state: changes });
  });
  return { ok: true, creatorId: id, updated };
}

async function deleteMediaAssets({ agencyId, creatorId, mediaIds, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  const ids = cleanMediaIds(mediaIds, 10000);
  if (!ids.length) return { ok: true, creatorId: id, deleted: 0 };
  const mutate = async (tx) => {
    await lockMediaLibraryUsageTx(tx, agencyId, id);
    const ownership = await liveCustomOwnershipByMedia({ agencyId, creatorId: id, mediaIds: ids, db: tx });
    const blockedMediaIds = ids.filter((mediaId) => (ownership.get(mediaId) || []).length > 0);
    if (blockedMediaIds.length) {
      const error = Object.assign(new Error("Live Custom pipeline media cannot be deleted from Media Library"), {
        code: "MEDIA_LIBRARY_CUSTOM_PIPELINE_OWNED", status: 409, mediaIds: blockedMediaIds,
      });
      throw error;
    }
    const deleted = await tx.creatorMediaAsset.deleteMany({ where: { agencyId, creatorId: id, mediaId: { in: ids } } });
    if (deleted.count) {
      // This is the explicit, protected deletion owner. Absence in a Desktop
      // usage page never removes facts; an accepted asset deletion does.
      await tx.creatorMediaUsageFact.deleteMany({ where: { agencyId, creatorId: id, mediaId: { in: ids } } });
      await publishMediaResult({ db: tx, agencyId, creatorId: id, kind: "ASSETS_DELETED",
        state: { commit: currentCommitContext().rootId, mediaIds: ids, count: deleted.count } });
    }
    return { ok: true, creatorId: id, deleted: deleted.count };
  };
  return runDbTransaction(db, mutate);
}

async function getMediaSalesSummary({ agencyId, creatorId, db = prisma }) {
  const id = await requireCreator(db, agencyId, creatorId);
  // One statement gives the sums and distinct opaque usage sources one MVCC
  // snapshot. No buyer keys or source rows are materialized in application RAM.
  const [totals] = await db.$queryRawUnsafe(`
    SELECT COUNT(*) FILTER (WHERE a."soldCount" > 0) AS "soldAssets",
      COALESCE(SUM(a."soldCount"), 0) AS "totalSales",
      COALESCE(SUM(a."revenueCents"), 0) AS "revenueCents",
      COALESCE(SUM(a."revenueUnknownCount"), 0) AS "revenueUnknownCount",
      COALESCE(SUM(a."notOpenedCount"), 0) AS "notOpened",
      COALESCE(SUM(a."freeCount"), 0) AS "free",
      MAX(a."lastSoldAt") AS "lastSaleAt",
      (SELECT COUNT(DISTINCT u."sourceKey")
       FROM "CreatorMediaUsageContribution" u
       JOIN "CreatorMediaAsset" sold ON sold.id = u."assetId"
       WHERE u."agencyId" = $1 AND u."creatorId" = $2 AND u."soldCount" > 0
         AND sold."agencyId" = $1 AND sold."creatorId" = $2 AND sold."catalogActive" = true
      ) AS "uniqueBuyers"
    FROM "CreatorMediaAsset" a
    WHERE a."agencyId" = $1 AND a."creatorId" = $2 AND a."catalogActive" = true
  `, agencyId, id);
  const moneyState = await require("./media-financial-projection-service").financialProjectionState(db, id);
  return {
    ok: true,
    summary: {
      creatorId: id,
      soldAssets: exactMediaCount(totals.soldAssets),
      totalSales: exactMediaCount(totals.totalSales),
      revenueCents: exactMediaCount(totals.revenueCents),
      revenueUnknownCount: exactMediaCount(totals.revenueUnknownCount),
      revenueAvailable: moneyState.available && exactMediaCount(totals.revenueUnknownCount) === 0,
      revenuePending: moneyState.pending,
      revenueComplete: moneyState.ready && exactMediaCount(totals.revenueUnknownCount) === 0,
      opened: exactMediaCount(totals.totalSales),
      notOpened: exactMediaCount(totals.notOpened),
      free: exactMediaCount(totals.free),
      unresolved: 0,
      uniqueBuyers: exactMediaCount(totals.uniqueBuyers),
      deletedBuyers: 0,
      lastSaleAt: iso(totals.lastSaleAt),
    },
  };
}


function assetToSalesAsset(asset, moneyState = {ready:true,available:true,pending:false}) {
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
    revenueUnknownCount: integer(asset.revenueUnknownCount),
    revenueAvailable: moneyState.available && integer(asset.revenueUnknownCount) === 0,
    revenuePending: moneyState.pending,
    revenueComplete: moneyState.ready && integer(asset.revenueUnknownCount) === 0,
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
  const skip = mediaOffset(offset);
  const take = integer(limit, 100, 1, 500);
  const normalizedType = mediaType ? normalizeMediaType(mediaType) : null;
  const where = {
    agencyId,
    creatorId: id,
    catalogActive: true,
    soldCount: { gt: 0 },
    ...(normalizedType ? { mediaType: normalizedType } : {}),
  };
  const { rows: assets, count } = await readMediaPage(db, {
    where, orderBy: [{ revenueCents: "desc" }, { soldCount: "desc" }, { lastSoldAt: "desc" }, { mediaId: "asc" }], offset: skip, limit: take,
  });
  const moneyState = await require("./media-financial-projection-service").financialProjectionState(db, id);
  const items = assets.map(asset => assetToSalesAsset(asset, moneyState));
  return { ok: true, items, count, offset: skip, nextOffset: skip + items.length, hasMore: skip + items.length < count };
}

module.exports = {
  MAX_MEDIA_IDS,
  MAX_USAGE_SOURCES,
  MAX_USAGE_ITEMS_PER_SOURCE,
  cleanMediaIds,
  assetToMetadata,
  getMediaMetadata,
  searchMediaLibrary,
  upsertMediaMetadata,
  listStorylines,
  replaceUsageSources,
  mutateFolderMembership,
  deleteMediaAssets,
  getMediaSalesSummary,
  listMediaSalesAssets,
};
