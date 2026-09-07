"use strict";

const { allowedCreatorScope } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { isCompleteSubmission, uniqueMediaIds } = require("./custom-content-library-service");
const { paymentSnapshot } = require("./custom-orders-service");
const { hasCurrentVaultSettlement, customAssetMatchesPipelineProjection, derivePipelineStage } = require("./custom-content-pipeline-authority-service");

const CUSTOM_DELIVERY_OVERDUE_MS = 2 * 60 * 60 * 1000;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 500) { return String(value == null ? "" : value).trim().slice(0, max); }
function scopeWhere(scope) {
  if (scope?.broad) return {};
  const ids = Array.isArray(scope?.creatorIds) ? scope.creatorIds.map(String).filter(Boolean) : [];
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}

async function requireDeliveryAccess({ agencyId, member, db }) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_DELIVERY_ACTOR_REQUIRED", "Agency membership is required", 403);
  if (!await canUsePermission({ member, key: "chats.reply", db })) {
    throw fail("CUSTOM_DELIVERY_FORBIDDEN", "chats.reply permission is required", 403);
  }
}

const DELIVERY_INCLUDE = {
  creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
  customOrder: {
    select: {
      id: true, creatorId: true, dialogId: true, scenario: true, internalNote: true, type: true, contentKind: true,
      status: true, deliveredAt: true, fanDeliveredAt: true, deliverySentMediaIds: true, deliveryMessageIds: true, deliveryOfferedCents: true,
      priceCents: true, paidAmountCents: true, createdAt: true,
      creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
    },
  },
};

function assetKey(creatorId, mediaId) { return `${creatorId}\n${mediaId}`; }

async function loadAssets(db, agencyId, rows) {
  const byCreator = new Map();
  for (const row of rows || []) {
    const creatorId = clean(row?.creatorId, 180);
    if (!creatorId) continue;
    let ids = byCreator.get(creatorId);
    if (!ids) { ids = new Set(); byCreator.set(creatorId, ids); }
    for (const mediaId of uniqueMediaIds(row?.ofMediaIds)) ids.add(mediaId);
  }
  const groups = [...byCreator.entries()].filter(([, ids]) => ids.size).map(([creatorId, ids]) => ({ creatorId, mediaId: { in: [...ids] } }));
  const map = new Map();
  for (let offset = 0; offset < groups.length; offset += 50) {
    const or = groups.slice(offset, offset + 50);
    const take = or.reduce((sum, group) => sum + group.mediaId.in.length, 0);
    const assets = await db.creatorMediaAsset.findMany({
      where: { agencyId, source: "CUSTOM", OR: or },
      select: {
        creatorId: true, mediaId: true, source: true, customOrderId: true, customSubmissionId: true, customFullPriceCents: true,
        mediaType: true, thumbUrl: true, previewUrl: true, fullUrl: true, folderIds: true, sortingStatus: true, catalogActive: true,
      },
      take,
    });
    for (const asset of assets || []) map.set(assetKey(asset.creatorId, asset.mediaId), asset);
  }
  return map;
}

function isReady(row, assets) {
  const order = row?.customOrder;
  if (!order || !row?.reviewedAt) return false;
  const ids = uniqueMediaIds(row.ofMediaIds);
  if (!ids.length) return false;
  const finalized = hasCurrentVaultSettlement(row)
    && isCompleteSubmission(row)
    && ids.every((mediaId) => customAssetMatchesPipelineProjection(row, assets.get(assetKey(row.creatorId, mediaId)), order));
  return derivePipelineStage({
    submission: row,
    order,
    finalized,
    blockedCode: row.pipelineBlockedCode,
  }) === "APPROVED_DELIVERY_READY";
}

function serializeDelivery(row, assets, nowInput = new Date()) {
  const order = row.customOrder;
  const creator = order.creator || row.creator || null;
  const payment = paymentSnapshot(order.priceCents, order.paidAmountCents);
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const readyAtDate = new Date(row.reviewedAt);
  const overdueAtDate = new Date(readyAtDate.getTime() + CUSTOM_DELIVERY_OVERDUE_MS);
  const overdueForSeconds = Math.max(0, Math.floor((now.getTime() - overdueAtDate.getTime()) / 1000));
  const approvedMediaIds = uniqueMediaIds(row.ofMediaIds);
  const deliveredMediaIds = uniqueMediaIds(order.deliverySentMediaIds);
  const remainingMediaIds = approvedMediaIds.filter((mediaId) => !deliveredMediaIds.includes(mediaId));
  const deliveryOfferedCents = Math.max(0, Math.round(Number(order.deliveryOfferedCents) || 0));
  const deliveryPriceCents = Math.max(payment.remainingAmountCents - deliveryOfferedCents, 0);
  const media = remainingMediaIds.map((mediaId) => {
    const asset = assets.get(assetKey(row.creatorId, mediaId)) || {};
    return {
      mediaId,
      mediaType: String(asset.mediaType || "unknown"),
      thumbUrl: asset.thumbUrl || null,
      previewUrl: asset.previewUrl || null,
      fullUrl: asset.fullUrl || null,
    };
  });
  return {
    submissionId: String(row.id),
    customOrderId: String(order.id),
    creatorId: String(row.creatorId),
    dialogId: String(order.dialogId),
    creator: creator ? {
      displayName: creator.displayName || null,
      username: creator.username || null,
      avatarUrl: creator.avatarUrl || null,
    } : null,
    scenario: String(order.scenario || ""),
    contentKind: order.contentKind || null,
    totalPriceCents: Math.max(0, Math.round(Number(order.priceCents) || 0)),
    paidAmountCents: payment.paidAmountCents,
    remainingAmountCents: payment.remainingAmountCents,
    paymentStatus: payment.paymentStatus,
    deliveryPriceCents,
    freeDelivery: deliveryPriceCents === 0,
    media,
    mediaCount: media.length,
    approvedMediaCount: approvedMediaIds.length,
    deliveredMediaIds,
    deliveredMediaCount: deliveredMediaIds.filter((id) => approvedMediaIds.includes(id)).length,
    deliveryMessageIds: uniqueMediaIds(order.deliveryMessageIds),
    deliveryOfferedCents,
    readyAt: readyAtDate.toISOString(),
    overdueAt: overdueAtDate.toISOString(),
    overdue: overdueForSeconds > 0,
    overdueForSeconds,
    vaultFolderId: clean(row.executionVaultFolderId, 180) || null,
  };
}

async function listCustomReadyDeliveries({ agencyId, member, limit = 100, cursor = null, db = null } = {}) {
  const client = db || require("../prisma");
  await requireDeliveryAccess({ agencyId, member, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
  const items = [];
  const serverNow = new Date();
  let scanCursor = clean(cursor, 180) || null;
  const seenCursors = new Set();

  while (items.length < take) {
    if (scanCursor && seenCursors.has(scanCursor)) throw fail("CUSTOM_DELIVERY_CURSOR_LOOP", "Ready-delivery cursor did not advance", 500);
    if (scanCursor) seenCursors.add(scanCursor);
    const rows = await client.customContentSubmission.findMany({
      where: {
        agencyId,
        pipelineDisposition: "ACTIVE",
        reviewStatus: "APPROVED",
        reviewedAt: { not: null },
        customOrderId: { not: null },
        customOrder: { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } },
        ...scopeWhere(scope),
      },
      include: DELIVERY_INCLUDE,
      orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
    });
    if (!rows.length) return { ok: true, items, count: items.length, nextCursor: null, serverNow: serverNow.toISOString() };

    const candidates = rows.filter((row) => row.customOrder
      && String(row.customOrder.type || "") === "CONTENT"
      && String(row.customOrder.status || "") === "PENDING"
      && !row.customOrder.fanDeliveredAt
      && isCompleteSubmission(row));
    const assets = await loadAssets(client, agencyId, candidates);
    const candidateIds = new Set(candidates.map((row) => String(row.id)));

    for (const row of rows) {
      scanCursor = String(row.id);
      if (candidateIds.has(String(row.id)) && isReady(row, assets)) items.push(serializeDelivery(row, assets, serverNow));
      if (items.length >= take) {
        // Cursor is the last row actually inspected, never the end of the fetched
        // batch. This keeps later eligible rows reachable across API pages.
        return { ok: true, items, count: items.length, nextCursor: scanCursor, serverNow: serverNow.toISOString() };
      }
    }
    if (rows.length < 200) return { ok: true, items, count: items.length, nextCursor: null, serverNow: serverNow.toISOString() };
  }
  return { ok: true, items, count: items.length, nextCursor: scanCursor, serverNow: serverNow.toISOString() };
}

async function getCustomReadyDelivery({ agencyId, member, customOrderId, db = null } = {}) {
  const client = db || require("../prisma");
  await requireDeliveryAccess({ agencyId, member, db: client });
  const orderId = clean(customOrderId, 180);
  if (!orderId) throw fail("CUSTOM_DELIVERY_ORDER_REQUIRED", "customOrderId is required");
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const row = await client.customContentSubmission.findFirst({
    where: {
      agencyId,
      pipelineDisposition: "ACTIVE",
      customOrderId: orderId,
      reviewStatus: "APPROVED",
      reviewedAt: { not: null },
      customOrder: { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } },
      ...scopeWhere(scope),
    },
    include: DELIVERY_INCLUDE,
  });
  if (!row) throw fail("CUSTOM_DELIVERY_NOT_READY", "Approved custom delivery was not found", 404);
  const assets = await loadAssets(client, agencyId, [row]);
  if (!isReady(row, assets)) throw fail("CUSTOM_DELIVERY_NOT_READY", "Custom content is not ready for chatter delivery", 409);
  const serverNow = new Date();
  return { ok: true, item: serializeDelivery(row, assets, serverNow), serverNow: serverNow.toISOString() };
}

async function resolveAttemptedCustomMedia({ client, agencyId, creatorId, attemptedMediaIds }) {
  const customAssets = await client.creatorMediaAsset.findMany({
    where: { agencyId, creatorId, source: "CUSTOM", mediaId: { in: attemptedMediaIds } },
    select: { mediaId: true, customOrderId: true, customSubmissionId: true },
    take: attemptedMediaIds.length,
  });
  const assetCustomIds = new Set((customAssets || []).map((asset) => clean(asset.mediaId, 180)).filter(Boolean));
  const missingProjectionIds = attemptedMediaIds.filter((mediaId) => !assetCustomIds.has(mediaId));
  // CreatorMediaAsset is only the fast typed projection. Proven submission media
  // remain CUSTOM even when that projection is missing/drifted.
  const provenanceRows = missingProjectionIds.length ? await client.customContentSubmission.findMany({
    where: { agencyId, creatorId, ofMediaIds: { hasSome: missingProjectionIds } },
    select: { id: true, customOrderId: true, ofMediaIds: true },
  }) : [];
  const provenBySubmission = new Set();
  const missing = new Set(missingProjectionIds);
  for (const row of provenanceRows || []) {
    for (const mediaId of uniqueMediaIds(row.ofMediaIds)) if (missing.has(mediaId)) provenBySubmission.add(mediaId);
  }
  return {
    customAssets,
    provenanceRows,
    customIds: new Set([...assetCustomIds, ...provenBySubmission]),
  };
}

async function preflightProgrammaticCustomMedia({ agencyId, member, creatorId, mediaIds, db = null } = {}) {
  const client = db || require("../prisma");
  const creator = clean(creatorId, 180);
  const rawAttempted = Array.isArray(mediaIds) ? mediaIds : [];
  const attemptedMediaIds = [];
  const seenAttempted = new Set();
  for (const raw of rawAttempted) {
    const mediaId = clean(raw, 240);
    if (!mediaId || seenAttempted.has(mediaId)) continue;
    seenAttempted.add(mediaId);
    attemptedMediaIds.push(mediaId);
  }
  if (attemptedMediaIds.length > 200) throw fail("CUSTOM_DELIVERY_MEDIA_LIMIT", "Too many media IDs for one programmatic send (max 200)", 413);
  if (!creator) throw fail("CUSTOM_DELIVERY_PREFLIGHT_CONTEXT_REQUIRED", "creatorId is required");
  if (!attemptedMediaIds.length) return { ok: true, matched: false, allow: true, code: null, customMediaIds: [] };
  await allowedCreatorScope({ agencyId, member, requestedCreatorId: creator, db: client });
  const provenance = await resolveAttemptedCustomMedia({ client, agencyId, creatorId: creator, attemptedMediaIds });
  const customMediaIds = attemptedMediaIds.filter((mediaId) => provenance.customIds.has(mediaId));
  if (!customMediaIds.length) return { ok: true, matched: false, allow: true, code: null, customMediaIds: [] };
  return {
    ok: true,
    matched: true,
    allow: false,
    code: "CUSTOM_MEDIA_PROGRAMMATIC_FORBIDDEN",
    error: "CUSTOM media may only be sent through the exact Custom delivery flow, never through automation/campaign programmatic writers",
    customMediaIds,
  };
}

async function preflightCustomManualSend({ agencyId, member, creatorId, dialogId, mediaIds, db = null } = {}) {
  const client = db || require("../prisma");
  await requireDeliveryAccess({ agencyId, member, db: client });
  const creator = clean(creatorId, 180);
  const dialog = clean(dialogId, 180);
  const rawAttempted = Array.isArray(mediaIds) ? mediaIds : [];
  const attemptedMediaIds = [];
  const seenAttempted = new Set();
  for (const raw of rawAttempted) {
    const mediaId = clean(raw, 240);
    if (!mediaId || seenAttempted.has(mediaId)) continue;
    seenAttempted.add(mediaId);
    attemptedMediaIds.push(mediaId);
  }
  if (attemptedMediaIds.length > 200) throw fail("CUSTOM_DELIVERY_MEDIA_LIMIT", "Too many media IDs for one manual send (max 200)", 413);
  if (!creator || !dialog) throw fail("CUSTOM_DELIVERY_PREFLIGHT_CONTEXT_REQUIRED", "creatorId and dialogId are required");
  if (!attemptedMediaIds.length) return { ok: true, matched: false, allow: true, code: null };
  await allowedCreatorScope({ agencyId, member, requestedCreatorId: creator, db: client });

  const { customAssets, provenanceRows, customIds } = await resolveAttemptedCustomMedia({
    client, agencyId, creatorId: creator, attemptedMediaIds,
  });
  if (!customIds.size) return { ok: true, matched: false, allow: true, code: null };
  if (customIds.size !== attemptedMediaIds.length) {
    return { ok: true, matched: true, allow: false, code: "CUSTOM_DELIVERY_MIXED_MEDIA", error: "Custom content cannot be mixed with unrelated media in one manual send" };
  }
  const orderIds = new Set([
    ...(customAssets || []).map((asset) => clean(asset.customOrderId, 180)).filter(Boolean),
    ...(provenanceRows || []).map((row) => clean(row.customOrderId, 180)).filter(Boolean),
  ]);
  const submissionIds = new Set([
    ...(customAssets || []).map((asset) => clean(asset.customSubmissionId, 180)).filter(Boolean),
    ...(provenanceRows || []).map((row) => clean(row.id, 180)).filter(Boolean),
  ]);
  if (orderIds.size !== 1 || submissionIds.size !== 1) {
    return { ok: true, matched: true, allow: false, code: "CUSTOM_DELIVERY_AMBIGUOUS_MEDIA", error: "Selected Custom media do not resolve to one exact approved submission" };
  }

  const customOrderId = [...orderIds][0];
  const customSubmissionId = [...submissionIds][0];
  let current;
  try {
    current = await getCustomReadyDelivery({ agencyId, member, customOrderId, db: client });
  } catch (error) {
    if (error?.code === "CUSTOM_DELIVERY_NOT_READY") {
      return { ok: true, matched: true, allow: false, code: "CUSTOM_DELIVERY_NOT_READY", error: "Custom is no longer ready for manual delivery", customOrderId };
    }
    throw error;
  }
  const item = current.item;
  if (String(item.creatorId) !== creator || String(item.dialogId) !== dialog || String(item.submissionId) !== customSubmissionId) {
    return { ok: true, matched: true, allow: false, code: "CUSTOM_DELIVERY_CONTEXT_MISMATCH", error: "Custom media no longer belong to this creator/dialog/current approved submission", customOrderId };
  }
  const approved = new Set([...(item.deliveredMediaIds || []), ...(item.media || []).map((media) => String(media.mediaId || "").trim())].filter(Boolean));
  if (attemptedMediaIds.some((mediaId) => !approved.has(mediaId))) {
    return { ok: true, matched: true, allow: false, code: "CUSTOM_DELIVERY_STALE_MEDIA", error: "Selected Custom media are not part of the current approved media set", customOrderId };
  }
  return { ok: true, matched: true, allow: true, code: null, item, attemptedCustomMediaIds: attemptedMediaIds };
}

module.exports = {
  listCustomReadyDeliveries,
  getCustomReadyDelivery,
  preflightCustomManualSend,
  preflightProgrammaticCustomMedia,
  CUSTOM_DELIVERY_OVERDUE_MS,
  loadAssets,
  isReady,
  serializeDelivery,
};
