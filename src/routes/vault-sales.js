"use strict";

const express = require("express");
const prisma = require("../prisma");
const { cleanString, optionalString, jsonArray, jsonObject, centsFromAny, parseLimit, parseOffset, requireCreator, sendError } = require("../services/server-store-utils");

const { isSeniorAgencyMember } = require("../middleware/team-permissions");
const { audit } = require("../services/audit-service");
const { rebuildCreatorAggregates, scheduleDialogScan } = require("../services/dialog-intelligence-service");

const router = express.Router();

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

const LEGACY_VAULT_SALES_MUTATIONS = new Set([
  "POST /purchase-messages/upsert",
  "POST /purchase-messages/bulk",
  "POST /media-sales/upsert",
  "POST /media-sales/bulk",
]);
router.use((req, res, next) => {
  if (!LEGACY_VAULT_SALES_MUTATIONS.has(`${req.method} ${req.path}`)) return next();
  return res.status(410).json({
    ok: false,
    code: "LEGACY_VAULT_SALES_DISABLED",
    error: "Legacy Alpha Vault Sales ingestion is disabled; use Dialog Intelligence projection endpoints.",
  });
});

router.get("/purchase-messages", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const fanId = cleanString(req.query.fanId, 80);
    if (creatorId) where.creatorId = creatorId;
    if (fanId) where.fanId = fanId;
    const take = parseLimit(req.query.limit, 200, 1000);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.vaultPurchaseMessage.findMany({ where, orderBy: { purchasedAt: "desc" }, take, skip }),
      prisma.vaultPurchaseMessage.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "VAULT_PURCHASE_MESSAGES_FAILED"); }
});

router.post("/purchase-messages/upsert", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const messageId = cleanString(req.body?.messageId || req.body?.id, 100);
    if (!messageId) return res.status(400).json({ ok: false, code: "MESSAGE_ID_MISSING", error: "messageId is required" });
    const data = {
      agencyId: req.auth.agencyId,
      creatorId,
      fanId: optionalString(req.body?.fanId, 80),
      dialogId: optionalString(req.body?.dialogId, 80),
      messageId,
      amountCents: centsFromAny(req.body || {}, "amountCents", "amount"),
      currency: cleanString(req.body?.currency || "USD", 10).toUpperCase() || "USD",
      purchasedAt: parseDate(req.body?.purchasedAt || req.body?.purchased_at),
      resolved: req.body?.resolved === true,
      resolvedAt: parseDate(req.body?.resolvedAt || req.body?.resolved_at),
      metadata: jsonObject(req.body?.metadata),
    };
    const item = await prisma.vaultPurchaseMessage.upsert({ where: { creatorId_messageId: { creatorId, messageId } }, create: data, update: { ...data, agencyId: undefined, creatorId: undefined, messageId: undefined } });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "VAULT_PURCHASE_MESSAGE_UPSERT_FAILED"); }
});

router.post("/purchase-messages/bulk", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const items = jsonArray(req.body?.items);
    let count = 0;
    for (const raw of items) {
      const messageId = cleanString(raw.messageId || raw.id, 100);
      if (!messageId) continue;
      await prisma.vaultPurchaseMessage.upsert({
        where: { creatorId_messageId: { creatorId, messageId } },
        create: { agencyId: req.auth.agencyId, creatorId, messageId, fanId: optionalString(raw.fanId, 80), dialogId: optionalString(raw.dialogId, 80), amountCents: centsFromAny(raw, "amountCents", "amount"), currency: cleanString(raw.currency || "USD", 10).toUpperCase() || "USD", purchasedAt: parseDate(raw.purchasedAt || raw.purchased_at), resolved: raw.resolved === true, resolvedAt: parseDate(raw.resolvedAt || raw.resolved_at), metadata: jsonObject(raw.metadata) },
        update: { fanId: optionalString(raw.fanId, 80), dialogId: optionalString(raw.dialogId, 80), amountCents: centsFromAny(raw, "amountCents", "amount"), currency: cleanString(raw.currency || "USD", 10).toUpperCase() || "USD", purchasedAt: parseDate(raw.purchasedAt || raw.purchased_at), resolved: raw.resolved === true, resolvedAt: parseDate(raw.resolvedAt || raw.resolved_at), metadata: jsonObject(raw.metadata) },
      });
      count += 1;
    }
    return res.json({ ok: true, count });
  } catch (err) { return sendError(res, err, "VAULT_PURCHASE_MESSAGES_BULK_FAILED"); }
});

router.get("/media-sales", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const mediaId = cleanString(req.query.mediaId, 100);
    const status = cleanString(req.query.status, 40);
    if (creatorId) where.creatorId = creatorId;
    if (mediaId) where.mediaId = mediaId;
    if (status) where.status = status;
    const take = parseLimit(req.query.limit, 200, 1000);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.vaultMediaSale.findMany({ where, orderBy: { purchasedAt: "desc" }, take, skip }),
      prisma.vaultMediaSale.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "VAULT_MEDIA_SALES_FAILED"); }
});

router.post("/media-sales/upsert", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const messageId = cleanString(req.body?.messageId, 100);
    const mediaId = cleanString(req.body?.mediaId, 100);
    if (!messageId || !mediaId) return res.status(400).json({ ok: false, code: "MESSAGE_MEDIA_ID_MISSING", error: "messageId and mediaId are required" });
    const data = {
      agencyId: req.auth.agencyId,
      creatorId,
      messageId,
      mediaId,
      fanId: optionalString(req.body?.fanId, 80),
      dialogId: optionalString(req.body?.dialogId, 80),
      status: cleanString(req.body?.status || "sold", 40) || "sold",
      allocatedAmountCents: centsFromAny(req.body || {}, "allocatedAmountCents", "allocatedAmount"),
      packagePriceCents: centsFromAny(req.body || {}, "packagePriceCents", "packagePrice"),
      packSize: Number(req.body?.packSize || 1) || 1,
      reason: optionalString(req.body?.reason, 500),
      purchasedAt: parseDate(req.body?.purchasedAt || req.body?.purchased_at),
      metadata: jsonObject(req.body?.metadata),
    };
    const item = await prisma.vaultMediaSale.upsert({ where: { creatorId_messageId_mediaId: { creatorId, messageId, mediaId } }, create: data, update: { ...data, agencyId: undefined, creatorId: undefined, messageId: undefined, mediaId: undefined } });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "VAULT_MEDIA_SALE_UPSERT_FAILED"); }
});

router.post("/media-sales/bulk", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    let count = 0;
    for (const raw of jsonArray(req.body?.items)) {
      const messageId = cleanString(raw.messageId, 100);
      const mediaId = cleanString(raw.mediaId, 100);
      if (!messageId || !mediaId) continue;
      await prisma.vaultMediaSale.upsert({
        where: { creatorId_messageId_mediaId: { creatorId, messageId, mediaId } },
        create: { agencyId: req.auth.agencyId, creatorId, messageId, mediaId, fanId: optionalString(raw.fanId, 80), dialogId: optionalString(raw.dialogId, 80), status: cleanString(raw.status || "sold", 40) || "sold", allocatedAmountCents: centsFromAny(raw, "allocatedAmountCents", "allocatedAmount"), packagePriceCents: centsFromAny(raw, "packagePriceCents", "packagePrice"), packSize: Number(raw.packSize || 1) || 1, reason: optionalString(raw.reason, 500), purchasedAt: parseDate(raw.purchasedAt || raw.purchased_at), metadata: jsonObject(raw.metadata) },
        update: { fanId: optionalString(raw.fanId, 80), dialogId: optionalString(raw.dialogId, 80), status: cleanString(raw.status || "sold", 40) || "sold", allocatedAmountCents: centsFromAny(raw, "allocatedAmountCents", "allocatedAmount"), packagePriceCents: centsFromAny(raw, "packagePriceCents", "packagePrice"), packSize: Number(raw.packSize || 1) || 1, reason: optionalString(raw.reason, 500), purchasedAt: parseDate(raw.purchasedAt || raw.purchased_at), metadata: jsonObject(raw.metadata) },
      });
      count += 1;
    }
    return res.json({ ok: true, count });
  } catch (err) { return sendError(res, err, "VAULT_MEDIA_SALES_BULK_FAILED"); }
});

router.get("/summary/:creatorId", async (req, res) => {
  try {
    const creatorId = cleanString(req.params.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const [messageAgg, saleAgg, soldCount, pendingCount] = await Promise.all([
      prisma.vaultPurchaseMessage.aggregate({ where: { agencyId: req.auth.agencyId, creatorId }, _sum: { amountCents: true }, _count: { _all: true } }),
      prisma.vaultMediaSale.aggregate({ where: { agencyId: req.auth.agencyId, creatorId, status: "sold" }, _sum: { allocatedAmountCents: true }, _count: { _all: true } }),
      prisma.vaultMediaSale.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "sold" } }),
      prisma.vaultPurchaseMessage.count({ where: { agencyId: req.auth.agencyId, creatorId, resolved: false } }),
    ]);
    return res.json({ ok: true, summary: { creatorId, messageCount: messageAgg._count._all || 0, grossCents: messageAgg._sum.amountCents || 0, soldMediaCount: soldCount, allocatedCents: saleAgg._sum.allocatedAmountCents || 0, pendingCount } });
  } catch (err) { return sendError(res, err, "VAULT_SALES_SUMMARY_FAILED"); }
});


function seniorRequired(req, res, next) {
  const member = req.auth?.membership || req.member;
  if (!member || !isSeniorAgencyMember(member)) {
    return res.status(403).json({ ok: false, code: "VAULT_SALES_WRITE_FORBIDDEN", error: "Owner, admin or manager permission is required" });
  }
  return next();
}

router.get("/v2/summary/:creatorId", async (req, res) => {
  try {
    const creatorId = cleanString(req.params.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const soldWhere = {
      agencyId: req.auth.agencyId,
      creatorId,
      isOpened: true,
      isFree: false,
      priceCents: { gt: 0 },
      status: { notIn: ["REFUNDED", "INVALID", "EXCLUDED_FAN_MEDIA"] },
    };
    const [sold, opened, notOpened, free, unresolved, buyers, deletedBuyers, assets, lastSale] = await Promise.all([
      prisma.vaultPurchaseLedger.aggregate({ where: soldWhere, _sum: { priceCents: true }, _count: { _all: true } }),
      prisma.vaultPurchaseLedger.count({ where: { agencyId: req.auth.agencyId, creatorId, isOpened: true, isFree: false } }),
      prisma.vaultPurchaseLedger.count({ where: { agencyId: req.auth.agencyId, creatorId, isOpened: false, isFree: false, priceCents: { gt: 0 } } }),
      prisma.vaultPurchaseLedger.count({ where: { agencyId: req.auth.agencyId, creatorId, OR: [{ isFree: true }, { priceCents: { lte: 0 } }] } }),
      prisma.vaultPurchaseLedger.count({ where: { agencyId: req.auth.agencyId, creatorId, resolveState: { not: "RESOLVED" } } }),
      prisma.vaultPurchaseLedger.findMany({ where: soldWhere, distinct: ["buyerId"], select: { buyerId: true }, take: 100000 }),
      prisma.vaultPurchaseLedger.count({ where: { agencyId: req.auth.agencyId, creatorId, buyerDeleted: true } }),
      prisma.vaultAssetSalesAggregate.count({ where: { agencyId: req.auth.agencyId, creatorId, soldCount: { gt: 0 } } }),
      prisma.vaultPurchaseLedger.findFirst({ where: soldWhere, orderBy: { purchasedAt: "desc" }, select: { purchasedAt: true } }),
    ]);
    return res.json({
      ok: true,
      summary: {
        creatorId,
        soldAssets: assets,
        totalSales: sold._count._all || 0,
        revenueCents: sold._sum.priceCents || 0,
        opened: opened,
        notOpened,
        free,
        unresolved,
        uniqueBuyers: buyers.filter((item) => item.buyerId).length,
        deletedBuyers,
        lastSaleAt: lastSale?.purchasedAt || null,
      },
    });
  } catch (err) { return sendError(res, err, "VAULT_SALES_V2_SUMMARY_FAILED"); }
});

router.get("/v2/assets", async (req, res) => {
  try {
    const creatorId = cleanString(req.query.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const take = parseLimit(req.query.limit, 100, 250);
    const skip = parseOffset(req.query.offset);
    const mediaType = cleanString(req.query.mediaType, 80);
    const where = { agencyId: req.auth.agencyId, creatorId, ...(mediaType ? { mediaType } : {}) };
    const [items, count] = await Promise.all([
      prisma.vaultAssetSalesAggregate.findMany({ where, orderBy: [{ totalRevenueCents: "desc" }, { lastSoldAt: "desc" }], skip, take }),
      prisma.vaultAssetSalesAggregate.count({ where }),
    ]);
    return res.json({ ok: true, items, count, offset: skip, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "VAULT_SALES_V2_ASSETS_FAILED"); }
});

router.get("/v2/purchases", async (req, res) => {
  try {
    const creatorId = cleanString(req.query.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const take = parseLimit(req.query.limit, 100, 250);
    const skip = parseOffset(req.query.offset);
    const status = cleanString(req.query.status, 60);
    const buyerId = cleanString(req.query.buyerId, 160);
    const assetId = cleanString(req.query.assetId, 240);
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const where = {
      agencyId: req.auth.agencyId,
      creatorId,
      ...(status ? { status } : {}),
      ...(buyerId ? { buyerId } : {}),
      ...(from || to ? { purchasedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(assetId ? { media: { some: { assetId } } } : {}),
    };
    const [items, count] = await Promise.all([
      prisma.vaultPurchaseLedger.findMany({ where, orderBy: [{ purchasedAt: "desc" }, { id: "desc" }], skip, take, include: { media: true } }),
      prisma.vaultPurchaseLedger.count({ where }),
    ]);
    return res.json({ ok: true, items, count, offset: skip, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "VAULT_SALES_V2_PURCHASES_FAILED"); }
});

router.post("/v2/reconcile/:creatorId", seniorRequired, async (req, res) => {
  try {
    const creatorId = cleanString(req.params.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const signals = await prisma.dialogPurchaseSignal.findMany({
      where: { agencyId: req.auth.agencyId, creatorId, resolveState: { not: "RESOLVED" }, dialogId: { not: null }, sourceMessageId: { not: null } },
      orderBy: { lastSeenAt: "asc" },
      take: Math.max(1, Math.min(1000, Number(req.body?.limit) || 250)),
    });
    let scheduled = 0;
    for (const signal of signals) {
      const result = await scheduleDialogScan({
        agencyId: req.auth.agencyId, creatorId, dialogId: signal.dialogId, fanId: signal.buyerId,
        mode: "targeted", targetMessageId: signal.sourceMessageId, source: "vault_reconciliation",
        priority: 120, userId: req.auth.userId,
      });
      if (result.created) scheduled += 1;
    }
    await audit({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, action: "vault_sales.reconciliation_started", targetType: "creator", targetId: creatorId, metadata: { selected: signals.length, scheduled } });
    return res.status(202).json({ ok: true, selected: signals.length, scheduled });
  } catch (err) { return sendError(res, err, "VAULT_SALES_RECONCILE_FAILED"); }
});

router.post("/v2/rebuild/:creatorId", seniorRequired, async (req, res) => {
  try {
    const creatorId = cleanString(req.params.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const result = await rebuildCreatorAggregates({ agencyId: req.auth.agencyId, creatorId });
    await audit({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, action: "vault_sales.aggregate_rebuilt", targetType: "creator", targetId: creatorId, metadata: result });
    return res.json(result);
  } catch (err) { return sendError(res, err, "VAULT_SALES_REBUILD_FAILED"); }
});

module.exports = router;
