"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { requireCreatorAccess } = require("../middleware/automation-permissions");

const SOURCE_CUSTOM = "CUSTOM";
const MAX_MEDIA_IDS = 200;

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function clean(value, max = 12_000) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function uniqueMediaIds(values) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(values) ? values : []).slice(0, MAX_MEDIA_IDS)) {
    const value = clean(raw, 240);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeFolderIds(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const item = clean(raw, 240);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizePriceCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(2_147_483_647, Math.round(number))) : 0;
}

function isCompleteSubmission(row) {
  const telegramIds = Array.isArray(row?.telegramMessageIds) ? row.telegramMessageIds : [];
  const mediaIds = uniqueMediaIds(row?.ofMediaIds);
  return telegramIds.length > 0 && mediaIds.length === telegramIds.length;
}

async function loadOrder(db, { agencyId, creatorId, customOrderId }) {
  if (!customOrderId) return null;
  const order = await db.customOrder.findFirst({
    where: { id: customOrderId, agencyId, creatorId },
    select: { id: true, type: true, scenario: true, priceCents: true },
  });
  if (!order) throw fail("CUSTOM_SUBMISSION_ORDER_NOT_FOUND", "Custom order was not found for this creator", 404);
  if (String(order.type || "").toUpperCase() !== "CONTENT") {
    throw fail("CUSTOM_SUBMISSION_ORDER_TYPE_INVALID", "Only CONTENT custom orders can own Content Library assets", 409);
  }
  return order;
}

async function loadContext(db, { agencyId, member, submissionId, requireFolder }) {
  const id = clean(submissionId, 180);
  if (!id) throw fail("CUSTOM_SUBMISSION_ID_REQUIRED", "submissionId is required");
  const submission = await db.customContentSubmission.findFirst({ where: { id, agencyId } });
  if (!submission) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: submission.creatorId, db });
  if (!isCompleteSubmission(submission)) {
    throw fail("CUSTOM_SUBMISSION_NOT_READY_FOR_LIBRARY", "Submission must have one OnlyFans media id for every Telegram source message", 409);
  }
  const creator = await db.creatorAccount.findFirst({
    where: { id: submission.creatorId, agencyId, deletedAt: null },
    select: { id: true, customsVaultFolderId: true },
  });
  if (!creator) throw fail("CREATOR_NOT_FOUND", "Creator not found", 404);
  const folderId = clean(creator.customsVaultFolderId, 240) || null;
  if (requireFolder && !folderId) {
    throw fail("CUSTOMS_VAULT_DESTINATION_REQUIRED", "Customs Vault destination is not configured", 409);
  }
  const order = await loadOrder(db, {
    agencyId,
    creatorId: submission.creatorId,
    customOrderId: submission.customOrderId || null,
  });
  return { submission, creator, folderId, order, mediaIds: uniqueMediaIds(submission.ofMediaIds) };
}

function desiredAutoMetadata(asset, order) {
  // Human edits win forever. Automatic Customs sync may seed or correct only rows
  // that have never been edited through Media Library metadata UI.
  if (asset?.metadataUpdatedAt) return {};
  if (!order) {
    return {
      description: null,
      idealPriceCents: 0,
      accessType: "paid",
    };
  }
  const priceCents = normalizePriceCents(order.priceCents);
  return {
    description: clean(order.scenario, 12_000) || null,
    idealPriceCents: priceCents,
    accessType: priceCents > 0 ? "paid" : "free",
  };
}

function needsUpdate(asset, { order, folderId }) {
  const expectedOrderId = order?.id || null;
  const expectedPrice = order ? normalizePriceCents(order.priceCents) : null;
  if (String(asset.source || "GENERAL") !== SOURCE_CUSTOM) return true;
  if ((asset.customOrderId || null) !== expectedOrderId) return true;
  if ((asset.customFullPriceCents == null ? null : normalizePriceCents(asset.customFullPriceCents)) !== expectedPrice) return true;
  if (asset.catalogActive !== true) return true;
  const folders = new Set(normalizeFolderIds(asset.folderIds));
  if (folderId && !folders.has(folderId)) return true;
  if (folderId && String(asset.sortingStatus || "").toUpperCase() !== "SORTED") return true;
  if (!asset.metadataUpdatedAt) {
    const auto = desiredAutoMetadata(asset, order);
    if ((asset.description || null) !== auto.description) return true;
    if (normalizePriceCents(asset.idealPriceCents) !== normalizePriceCents(auto.idealPriceCents)) return true;
    if (String(asset.accessType || "paid") !== auto.accessType) return true;
  }
  return false;
}

async function syncRows(db, { agencyId, creatorId, mediaIds, folderId, order, allowCreate, now }) {
  let rows = await db.creatorMediaAsset.findMany({
    where: { agencyId, creatorId, mediaId: { in: mediaIds } },
    take: mediaIds.length,
  });
  const byId = new Map(rows.map((row) => [String(row.mediaId), row]));
  const missing = mediaIds.filter((mediaId) => !byId.has(mediaId));

  let created = 0;
  if (missing.length && allowCreate) {
    const priceCents = order ? normalizePriceCents(order.priceCents) : null;
    const autoDescription = order ? (clean(order.scenario, 12_000) || null) : null;
    const createdResult = await db.creatorMediaAsset.createMany({
      data: missing.map((mediaId) => ({
        id: crypto.randomUUID(),
        agencyId,
        creatorId,
        mediaId,
        source: SOURCE_CUSTOM,
        customOrderId: order?.id || null,
        customFullPriceCents: priceCents,
        catalogActive: true,
        sortingStatus: folderId ? "SORTED" : "UNSORTED",
        folderIds: folderId ? [folderId] : [],
        description: autoDescription,
        accessType: order && priceCents === 0 ? "free" : "paid",
        idealPriceCents: priceCents || 0,
        firstSeenAt: now,
        lastSeenAt: now,
      })),
      skipDuplicates: true,
    });
    created = Math.max(0, Number(createdResult?.count || 0));
    rows = await db.creatorMediaAsset.findMany({
      where: { agencyId, creatorId, mediaId: { in: mediaIds } },
      take: mediaIds.length,
    });
  }

  if (rows.length !== mediaIds.length) {
    return { complete: false, changed: 0, items: rows };
  }

  let changed = 0;
  for (const asset of rows) {
    if (!needsUpdate(asset, { order, folderId })) continue;
    const folders = new Set(normalizeFolderIds(asset.folderIds));
    if (folderId) folders.add(folderId);
    const update = {
      source: SOURCE_CUSTOM,
      customOrderId: order?.id || null,
      customFullPriceCents: order ? normalizePriceCents(order.priceCents) : null,
      catalogActive: true,
      lastSeenAt: now,
      folderIds: [...folders],
      ...(folderId ? { sortingStatus: "SORTED" } : {}),
      ...desiredAutoMetadata(asset, order),
    };
    await db.creatorMediaAsset.update({ where: { id: asset.id }, data: update });
    changed += 1;
  }
  return { complete: true, changed: created + changed, items: rows };
}

/**
 * Called only after Desktop has confirmed move-only/folder settlement for every
 * committed OF media id. The resulting CUSTOM CreatorMediaAsset rows are the
 * durable finalization marker; CustomContentSubmission itself stays compact.
 */
async function finalizeCustomContentSubmissionLibrary({ agencyId, member, submissionId, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const context = await loadContext(client, { agencyId, member, submissionId, requireFolder: true });
  const { submission, folderId, order, mediaIds } = context;
  const result = await syncRows(client, {
    agencyId,
    creatorId: submission.creatorId,
    mediaIds,
    folderId,
    order,
    allowCreate: true,
    now: new Date(now),
  });
  if (!result.complete) throw fail("CUSTOM_CONTENT_LIBRARY_FINALIZE_INCOMPLETE", "Could not materialize all submission media in Content Library", 409);

  if (result.changed > 0) {
    await audit({
      agencyId,
      actorUserId: member.userId || null,
      action: "custom_content_submission.content_library_finalize",
      targetType: "CustomContentSubmission",
      targetId: submission.id,
      metadata: {
        creatorId: submission.creatorId,
        customOrderId: order?.id || null,
        mediaCount: mediaIds.length,
        fullContentPriceCents: order ? normalizePriceCents(order.priceCents) : null,
      },
      db: client,
    });
  }

  return {
    ok: true,
    idempotent: result.changed === 0,
    submissionId: String(submission.id),
    creatorId: String(submission.creatorId),
    customOrderId: order?.id || null,
    mediaIds,
    fullContentPriceCents: order ? normalizePriceCents(order.priceCents) : null,
    fullContentPrice: order ? normalizePriceCents(order.priceCents) / 100 : null,
  };
}

/**
 * Assignment can happen after an unassigned submission was already uploaded and
 * finalized. In that case update provenance/pricing on the existing CUSTOM rows.
 * If rows do not exist yet, do nothing: upload/folder recovery must finalize first.
 */
async function syncFinalizedSubmissionAssignment({ agencyId, member, submissionId, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const context = await loadContext(client, { agencyId, member, submissionId, requireFolder: false });
  const { submission, folderId, order, mediaIds } = context;
  const existing = await client.creatorMediaAsset.findMany({
    where: { agencyId, creatorId: submission.creatorId, mediaId: { in: mediaIds }, source: SOURCE_CUSTOM },
    take: mediaIds.length,
  });
  if (existing.length !== mediaIds.length) return { ok: true, synced: false, reason: "NOT_FINALIZED" };
  const result = await syncRows(client, {
    agencyId,
    creatorId: submission.creatorId,
    mediaIds,
    folderId,
    order,
    allowCreate: false,
    now: new Date(now),
  });
  return { ok: true, synced: result.complete, changed: result.changed };
}

module.exports = {
  SOURCE_CUSTOM,
  finalizeCustomContentSubmissionLibrary,
  isCompleteSubmission,
  syncFinalizedSubmissionAssignment,
  uniqueMediaIds,
};
