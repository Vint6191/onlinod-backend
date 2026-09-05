"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { confirmedRelaySequence } = require("./custom-relay-result-proof-service");

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

function normalizeMediaHints(value, allowedMediaIds) {
  const allowed = new Set((allowedMediaIds || []).map(String));
  const out = new Map();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const mediaId = clean(raw.mediaId, 240);
    if (!mediaId || !allowed.has(mediaId)) continue;
    const mediaType = clean(raw.mediaType, 40).toLowerCase() || null;
    const url = (candidate) => clean(candidate, 8_000) || null;
    out.set(mediaId, {
      mediaType,
      thumbUrl: url(raw.thumbUrl),
      previewUrl: url(raw.previewUrl),
      fullUrl: url(raw.fullUrl),
    });
  }
  return out;
}

function previewSeed(asset, hint) {
  if (!hint) return {};
  return {
    ...((!asset || !clean(asset.mediaType, 40) || String(asset.mediaType).toLowerCase() === "unknown") && hint.mediaType ? { mediaType: hint.mediaType } : {}),
    ...(!asset?.thumbUrl && hint.thumbUrl ? { thumbUrl: hint.thumbUrl } : {}),
    ...(!asset?.previewUrl && hint.previewUrl ? { previewUrl: hint.previewUrl } : {}),
    ...(!asset?.fullUrl && hint.fullUrl ? { fullUrl: hint.fullUrl } : {}),
  };
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
  const telegramIds = Array.isArray(submission.telegramMessageIds) ? submission.telegramMessageIds : [];
  if (!telegramIds.length) throw fail("CUSTOM_SUBMISSION_NOT_READY_FOR_LIBRARY", "Submission has no Telegram source messages", 409);
  const proofs = await confirmedRelaySequence({
    agencyId, creatorId: submission.creatorId, submissionId: submission.id,
    expectedTelegramSourceAccountId: submission.telegramSourceAccountId,
    expectedTelegramSourceUserId: submission.telegramSourceUserId,
    expectedTelegramMessageIds: telegramIds, db,
  });
  const provenMediaIds = proofs.map((proof) => proof.mediaId);
  const storedMediaIds = uniqueMediaIds(submission.ofMediaIds);
  if (storedMediaIds.length !== provenMediaIds.length || storedMediaIds.some((value, index) => value !== provenMediaIds[index])) {
    const changed = await db.customContentSubmission.updateMany({ where: { id: submission.id, agencyId, updatedAt: submission.updatedAt }, data: { ofMediaIds: provenMediaIds } });
    if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_SUBMISSION_LIBRARY_PROJECTION_CONFLICT", "Submission changed while proven relay results were being projected", 409);
    submission.ofMediaIds = provenMediaIds;
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
  return { submission, creator, folderId, order, mediaIds: provenMediaIds };
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

function needsUpdate(asset, { order, folderId, previewHint, submissionId }) {
  const expectedOrderId = order?.id || null;
  const expectedPrice = order ? normalizePriceCents(order.priceCents) : null;
  if (String(asset.source || "GENERAL") !== SOURCE_CUSTOM) return true;
  if ((asset.customSubmissionId || null) !== (submissionId || null)) return true;
  if ((asset.customOrderId || null) !== expectedOrderId) return true;
  if ((asset.customFullPriceCents == null ? null : normalizePriceCents(asset.customFullPriceCents)) !== expectedPrice) return true;
  if (asset.catalogActive !== true) return true;
  if (Object.keys(previewSeed(asset, previewHint)).length) return true;
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

function assertCustomSubmissionOwnership(rows, submissionId) {
  const expected = submissionId || null;
  for (const asset of rows || []) {
    if (String(asset.source || "GENERAL") !== SOURCE_CUSTOM) continue;
    const owner = asset.customSubmissionId || null;
    if (owner && expected && String(owner) !== String(expected)) {
      throw fail("CUSTOM_CONTENT_LIBRARY_PROVENANCE_CONFLICT", "Content Library media is already owned by a different Custom submission", 409);
    }
  }
}

async function syncRows(db, { agencyId, creatorId, submissionId, mediaIds, folderId, order, allowCreate, now, mediaHints = new Map() }) {
  let rows = await db.creatorMediaAsset.findMany({
    where: { agencyId, creatorId, mediaId: { in: mediaIds } },
    take: mediaIds.length,
  });
  assertCustomSubmissionOwnership(rows, submissionId);
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
        customSubmissionId: submissionId || null,
        customFullPriceCents: priceCents,
        catalogActive: true,
        sortingStatus: folderId ? "SORTED" : "UNSORTED",
        folderIds: folderId ? [folderId] : [],
        description: autoDescription,
        accessType: order && priceCents === 0 ? "free" : "paid",
        idealPriceCents: priceCents || 0,
        ...previewSeed(null, mediaHints.get(mediaId)),
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
    // createMany(skipDuplicates) can race another submission materializing the same media id.
    // Re-check after reload before any provenance update so that race cannot steal ownership.
    assertCustomSubmissionOwnership(rows, submissionId);
  }

  if (rows.length !== mediaIds.length) {
    return { complete: false, changed: 0, items: rows };
  }

  let changed = 0;
  const projectedRows = [];
  for (const originalAsset of rows) {
    const previewHint = mediaHints.get(String(originalAsset.mediaId)) || null;
    let asset = originalAsset;
    let rowChanged = false;

    // Media Library metadata is human-owned once metadataUpdatedAt is set. A manager can
    // edit description/price while this projection is between read and write, so a plain
    // update({ id }) can overwrite that newer human fact with stale automatic metadata.
    // CAS on updatedAt and reload the row on a race; after reload desiredAutoMetadata()
    // observes metadataUpdatedAt and drops all auto-owned metadata fields while provenance
    // and folder projection can still converge.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!needsUpdate(asset, { order, folderId, previewHint, submissionId })) break;
      const folders = new Set(normalizeFolderIds(asset.folderIds));
      if (folderId) folders.add(folderId);
      const update = {
        source: SOURCE_CUSTOM,
        customOrderId: order?.id || null,
        customSubmissionId: submissionId || null,
        customFullPriceCents: order ? normalizePriceCents(order.priceCents) : null,
        catalogActive: true,
        lastSeenAt: now,
        folderIds: [...folders],
        ...(folderId ? { sortingStatus: "SORTED" } : {}),
        ...desiredAutoMetadata(asset, order),
        ...previewSeed(asset, previewHint),
      };
      const applied = await db.creatorMediaAsset.updateMany({
        where: { id: asset.id, updatedAt: asset.updatedAt },
        data: update,
      });
      if (Number(applied?.count || 0) === 1) {
        rowChanged = true;
        asset = await db.creatorMediaAsset.findFirst({ where: { id: asset.id, agencyId, creatorId } }) || { ...asset, ...update };
        break;
      }
      asset = await db.creatorMediaAsset.findFirst({ where: { id: asset.id, agencyId, creatorId } });
      if (!asset) throw fail("CUSTOM_CONTENT_LIBRARY_ASSET_NOT_FOUND", "Content Library asset disappeared during Customs projection", 409);
    }
    if (needsUpdate(asset, { order, folderId, previewHint, submissionId })) {
      throw fail("CUSTOM_CONTENT_LIBRARY_PROJECTION_RACE", "Content Library asset kept changing during Customs projection", 409);
    }
    if (rowChanged) changed += 1;
    projectedRows.push(asset);
  }
  return { complete: true, changed: created + changed, items: projectedRows };
}

/**
 * Called only after Desktop has confirmed move-only/folder settlement for every
 * committed OF media id. The resulting CUSTOM CreatorMediaAsset rows are the
 * durable finalization marker; CustomContentSubmission itself stays compact.
 */
async function finalizeCustomContentSubmissionLibrary({ agencyId, member, submissionId, mediaHints = null, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const context = await loadContext(client, { agencyId, member, submissionId, requireFolder: true });
  const { submission, folderId, order, mediaIds } = context;
  const normalizedHints = normalizeMediaHints(mediaHints, mediaIds);
  const result = await syncRows(client, {
    agencyId,
    creatorId: submission.creatorId,
    submissionId: submission.id,
    mediaIds,
    folderId,
    order,
    allowCreate: true,
    now: new Date(now),
    mediaHints: normalizedHints,
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
        authority: "CUSTOM_RELAY_SEND_CONFIRMED",
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
    submissionId: submission.id,
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
  normalizeMediaHints,
  syncFinalizedSubmissionAssignment,
  uniqueMediaIds,
};
