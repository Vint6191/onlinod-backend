"use strict";

const express = require("express");
const prisma = require("../prisma");
const { cleanString, optionalString, jsonArray, jsonObject, centsFromAny, parseLimit, parseOffset, requireCreator, sendError } = require("../services/server-store-utils");

const router = express.Router();

function normalizeDraft(body = {}, req, creatorId) {
  return {
    agencyId: req.auth.agencyId,
    creatorId,
    segmentId: optionalString(body.segmentId, 100),
    contentCollectionId: optionalString(body.contentCollectionId, 100),
    title: optionalString(body.title, 180),
    text: cleanString(body.text || "", 12000),
    priceCents: centsFromAny(body, "priceCents", "price"),
    currency: cleanString(body.currency || "USD", 10).toUpperCase() || "USD",
    lockedText: body.lockedText === true,
    media: jsonArray(body.media || body.mediaFiles).map((x) => typeof x === "object" ? x : { id: String(x) }),
    previews: jsonArray(body.previews),
    filters: jsonObject(body.filters),
    manualUserIds: jsonArray(body.manualUserIds || body.userIds).map((x) => String(x || "").trim()).filter(Boolean),
    status: cleanString(body.status || "draft", 40) || "draft",
    createdByUserId: req.auth.userId,
  };
}

router.get("/drafts", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId, deletedAt: null };
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    if (creatorId) where.creatorId = creatorId;
    if (status) where.status = status;
    const take = parseLimit(req.query.limit, 100, 500);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.campaignDraft.findMany({ where, orderBy: { updatedAt: "desc" }, take, skip }),
      prisma.campaignDraft.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "CAMPAIGN_DRAFTS_FAILED"); }
});

router.post("/drafts", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const item = await prisma.campaignDraft.create({ data: normalizeDraft(req.body || {}, req, creatorId) });
    return res.status(201).json({ ok: true, item });
  } catch (err) { return sendError(res, err, "CAMPAIGN_DRAFT_CREATE_FAILED"); }
});

router.patch("/drafts/:id", async (req, res) => {
  try {
    const existing = await prisma.campaignDraft.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CAMPAIGN_DRAFT_NOT_FOUND", error: "Campaign draft not found" });
    const body = req.body || {};
    const data = {};
    if (body.creatorId !== undefined) { const cid = cleanString(body.creatorId, 100); await requireCreator(prisma, req.auth.agencyId, cid); data.creatorId = cid; }
    if (body.segmentId !== undefined) data.segmentId = optionalString(body.segmentId, 100);
    if (body.contentCollectionId !== undefined) data.contentCollectionId = optionalString(body.contentCollectionId, 100);
    if (body.title !== undefined) data.title = optionalString(body.title, 180);
    if (body.text !== undefined) data.text = cleanString(body.text, 12000);
    if (body.price !== undefined || body.priceCents !== undefined) data.priceCents = centsFromAny(body, "priceCents", "price");
    if (body.currency !== undefined) data.currency = cleanString(body.currency, 10).toUpperCase() || existing.currency;
    if (body.lockedText !== undefined) data.lockedText = body.lockedText === true;
    if (body.media !== undefined || body.mediaFiles !== undefined) data.media = jsonArray(body.media || body.mediaFiles).map((x) => typeof x === "object" ? x : { id: String(x) });
    if (body.previews !== undefined) data.previews = jsonArray(body.previews);
    if (body.filters !== undefined) data.filters = jsonObject(body.filters);
    if (body.manualUserIds !== undefined || body.userIds !== undefined) data.manualUserIds = jsonArray(body.manualUserIds || body.userIds).map((x) => String(x || "").trim()).filter(Boolean);
    if (body.status !== undefined) data.status = cleanString(body.status, 40) || existing.status;
    const item = await prisma.campaignDraft.update({ where: { id: existing.id }, data });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "CAMPAIGN_DRAFT_UPDATE_FAILED"); }
});

router.delete("/drafts/:id", async (req, res) => {
  try {
    const existing = await prisma.campaignDraft.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CAMPAIGN_DRAFT_NOT_FOUND", error: "Campaign draft not found" });
    const item = await prisma.campaignDraft.update({ where: { id: existing.id }, data: { deletedAt: new Date(), status: "deleted" } });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "CAMPAIGN_DRAFT_DELETE_FAILED"); }
});

router.post("/queue-status", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const ofQueueId = cleanString(req.body?.ofQueueId || req.body?.queueId || req.body?.id, 100);
    if (!ofQueueId) return res.status(400).json({ ok: false, code: "OF_QUEUE_ID_MISSING", error: "ofQueueId is required" });
    const item = await prisma.campaignQueueStatus.upsert({
      where: { creatorId_ofQueueId: { creatorId, ofQueueId } },
      create: {
        agencyId: req.auth.agencyId,
        creatorId,
        draftId: optionalString(req.body?.draftId, 100),
        ofQueueId,
        status: cleanString(req.body?.status || "active", 40) || "active",
        audienceCount: Number(req.body?.audienceCount || 0) || 0,
        priceCents: centsFromAny(req.body || {}, "priceCents", "price"),
        mediaCount: Number(req.body?.mediaCount || 0) || 0,
        payload: jsonObject(req.body?.payload),
        lastOfResponse: jsonObject(req.body?.lastOfResponse || req.body?.queue),
        createdByUserId: req.auth.userId,
      },
      update: {
        draftId: req.body?.draftId === undefined ? undefined : optionalString(req.body.draftId, 100),
        status: req.body?.status === undefined ? undefined : cleanString(req.body.status, 40) || "active",
        audienceCount: req.body?.audienceCount === undefined ? undefined : Number(req.body.audienceCount || 0) || 0,
        priceCents: req.body?.price !== undefined || req.body?.priceCents !== undefined ? centsFromAny(req.body || {}, "priceCents", "price") : undefined,
        mediaCount: req.body?.mediaCount === undefined ? undefined : Number(req.body.mediaCount || 0) || 0,
        payload: req.body?.payload === undefined ? undefined : jsonObject(req.body.payload),
        lastOfResponse: req.body?.lastOfResponse !== undefined || req.body?.queue !== undefined ? jsonObject(req.body.lastOfResponse || req.body.queue) : undefined,
      },
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "CAMPAIGN_QUEUE_STATUS_UPSERT_FAILED"); }
});

router.get("/queue-status", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    if (creatorId) where.creatorId = creatorId;
    if (status) where.status = status;
    const items = await prisma.campaignQueueStatus.findMany({ where, orderBy: { updatedAt: "desc" }, take: parseLimit(req.query.limit, 100, 500) });
    return res.json({ ok: true, items });
  } catch (err) { return sendError(res, err, "CAMPAIGN_QUEUE_STATUS_FAILED"); }
});

module.exports = router;
