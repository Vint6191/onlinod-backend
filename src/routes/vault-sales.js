"use strict";

const express = require("express");
const prisma = require("../prisma");
const { cleanString, optionalString, jsonArray, jsonObject, centsFromAny, parseLimit, parseOffset, requireCreator, sendError } = require("../services/server-store-utils");

const router = express.Router();

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

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

module.exports = router;
