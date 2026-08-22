"use strict";

const { allowedCreatorScope } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { isCompleteSubmission, uniqueMediaIds } = require("./custom-content-library-service");
const { paymentSnapshot } = require("./custom-orders-service");

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
  creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, customsVaultFolderId: true } },
  customOrder: {
    select: {
      id: true, creatorId: true, dialogId: true, scenario: true, internalNote: true, type: true, contentKind: true,
      status: true, deliveredAt: true, priceCents: true, paidAmountCents: true, createdAt: true,
      creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, customsVaultFolderId: true } },
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
        creatorId: true, mediaId: true, source: true, customOrderId: true, customFullPriceCents: true,
        mediaType: true, thumbUrl: true, previewUrl: true, fullUrl: true, folderIds: true,
      },
      take,
    });
    for (const asset of assets || []) map.set(assetKey(asset.creatorId, asset.mediaId), asset);
  }
  return map;
}

function isReady(row, assets) {
  const order = row?.customOrder;
  if (!order || String(order.type || "") !== "CONTENT") return false;
  if (String(order.status || "") !== "PENDING" || order.deliveredAt) return false;
  if (String(row.reviewStatus || "") !== "APPROVED" || !row.reviewedAt) return false;
  if (!isCompleteSubmission(row)) return false;
  const ids = uniqueMediaIds(row.ofMediaIds);
  if (!ids.length) return false;
  const expectedPrice = Math.max(0, Math.round(Number(order.priceCents) || 0));
  return ids.every((mediaId) => {
    const asset = assets.get(assetKey(row.creatorId, mediaId));
    return asset
      && String(asset.source || "") === "CUSTOM"
      && String(asset.customOrderId || "") === String(order.id)
      && Number(asset.customFullPriceCents) === expectedPrice;
  });
}

function serializeDelivery(row, assets) {
  const order = row.customOrder;
  const creator = order.creator || row.creator || null;
  const payment = paymentSnapshot(order.priceCents, order.paidAmountCents);
  const media = uniqueMediaIds(row.ofMediaIds).map((mediaId) => {
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
    deliveryPriceCents: payment.remainingAmountCents,
    freeDelivery: payment.remainingAmountCents === 0,
    media,
    mediaCount: media.length,
    readyAt: new Date(row.reviewedAt).toISOString(),
    vaultFolderId: clean(creator?.customsVaultFolderId, 180) || null,
  };
}

async function listCustomReadyDeliveries({ agencyId, member, limit = 100, db = null } = {}) {
  const client = db || require("../prisma");
  await requireDeliveryAccess({ agencyId, member, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
  const items = [];
  let cursor = null;
  for (let pass = 0; pass < 10 && items.length < take; pass += 1) {
    const rows = await client.customContentSubmission.findMany({
      where: {
        agencyId,
        reviewStatus: "APPROVED",
        reviewedAt: { not: null },
        customOrderId: { not: null },
        customOrder: { is: { type: "CONTENT", status: "PENDING", deliveredAt: null } },
        ...scopeWhere(scope),
      },
      include: DELIVERY_INCLUDE,
      orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    const candidates = rows.filter((row) => row.customOrder && String(row.customOrder.type || "") === "CONTENT" && String(row.customOrder.status || "") === "PENDING" && !row.customOrder.deliveredAt && isCompleteSubmission(row));
    const assets = await loadAssets(client, agencyId, candidates);
    for (const row of candidates) {
      if (items.length >= take) break;
      if (isReady(row, assets)) items.push(serializeDelivery(row, assets));
    }
    if (rows.length < 200) break;
  }
  return { ok: true, items, count: items.length, serverNow: new Date().toISOString() };
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
      customOrderId: orderId,
      reviewStatus: "APPROVED",
      reviewedAt: { not: null },
      customOrder: { is: { type: "CONTENT", status: "PENDING", deliveredAt: null } },
      ...scopeWhere(scope),
    },
    include: DELIVERY_INCLUDE,
  });
  if (!row) throw fail("CUSTOM_DELIVERY_NOT_READY", "Approved custom delivery was not found", 404);
  const assets = await loadAssets(client, agencyId, [row]);
  if (!isReady(row, assets)) throw fail("CUSTOM_DELIVERY_NOT_READY", "Custom content is not ready for chatter delivery", 409);
  return { ok: true, item: serializeDelivery(row, assets), serverNow: new Date().toISOString() };
}

module.exports = { listCustomReadyDeliveries, getCustomReadyDelivery };
