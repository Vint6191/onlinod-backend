"use strict";

const express = require("express");
const prisma = require("../prisma");
const {
  cleanString,
  optionalString,
  jsonArray,
  jsonObject,
  centsFromAny,
  parseLimit,
  parseOffset,
  requireCreator,
  sendError,
} = require("../services/server-store-utils");

const router = express.Router();

function collectionSelect() {
  return {
    include: {
      blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
    },
  };
}

async function normalizeCollectionInput(req, { patch = false } = {}) {
  const body = req.body || {};
  const data = {};

  if (!patch || body.kind !== undefined) data.kind = cleanString(body.kind || "message_library", 40) || "message_library";
  if (!patch || body.title !== undefined) data.title = cleanString(body.title || "Untitled", 180) || "Untitled";
  if (!patch || body.description !== undefined) data.description = optionalString(body.description, 2000);
  if (!patch || body.tags !== undefined) data.tags = jsonArray(body.tags).map((x) => cleanString(x, 60)).filter(Boolean).slice(0, 100);
  if (!patch || body.status !== undefined) data.status = cleanString(body.status || "active", 40) || "active";
  if (!patch || body.clientId !== undefined) data.clientId = optionalString(body.clientId, 120);

  if (body.creatorId !== undefined) {
    const creatorId = cleanString(body.creatorId, 100);
    if (creatorId) await requireCreator(prisma, req.auth.agencyId, creatorId);
    data.creatorId = creatorId || null;
  } else if (!patch) {
    data.creatorId = null;
  }

  if (!patch) {
    data.agencyId = req.auth.agencyId;
    data.createdByUserId = req.auth.userId;
  }
  data.updatedByUserId = req.auth.userId;

  return data;
}

function normalizeBlockInput(body = {}, index = 0, { patch = false } = {}) {
  const data = {};
  if (!patch || body.order !== undefined) data.order = Number.isFinite(Number(body.order)) ? Number(body.order) : index;
  if (!patch || body.role !== undefined) data.role = cleanString(body.role || "message", 40) || "message";
  if (!patch || body.title !== undefined) data.title = optionalString(body.title, 180);
  if (!patch || body.text !== undefined) data.text = cleanString(body.text || "", 12000);
  if (!patch || body.priceCents !== undefined || body.price !== undefined) data.priceCents = centsFromAny(body, "priceCents", "price");
  if (!patch || body.currency !== undefined) data.currency = cleanString(body.currency || "USD", 10).toUpperCase() || "USD";
  if (!patch || body.lockedText !== undefined) data.lockedText = body.lockedText === true;
  if (!patch || body.media !== undefined) data.media = jsonArray(body.media);
  if (!patch || body.note !== undefined) data.note = optionalString(body.note, 2000);
  if (!patch || body.metadata !== undefined) data.metadata = jsonObject(body.metadata);
  if (!patch || body.clientId !== undefined) data.clientId = optionalString(body.clientId, 120);
  return data;
}

router.get("/collections", async (req, res) => {
  try {
    const where = {
      agencyId: req.auth.agencyId,
      deletedAt: null,
    };
    const kind = cleanString(req.query.kind, 40);
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    const q = cleanString(req.query.q, 120);

    if (kind) where.kind = kind;
    if (creatorId) where.creatorId = creatorId;
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    const take = parseLimit(req.query.limit, 100, 500);
    const skip = parseOffset(req.query.offset);

    const [items, count] = await Promise.all([
      prisma.contentCollection.findMany({
        where,
        include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
        orderBy: [{ updatedAt: "desc" }],
        take,
        skip,
      }),
      prisma.contentCollection.count({ where }),
    ]);

    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTIONS_FAILED");
  }
});

router.get("/collections/:id", async (req, res) => {
  try {
    const item = await prisma.contentCollection.findFirst({
      where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null },
      ...collectionSelect(),
    });
    if (!item) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    return res.json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTION_FAILED");
  }
});

router.post("/collections", async (req, res) => {
  try {
    const collectionData = await normalizeCollectionInput(req);
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const item = await prisma.contentCollection.create({
      data: {
        ...collectionData,
        blocks: { create: blocks.map((block, index) => normalizeBlockInput(block, index)) },
      },
      ...collectionSelect(),
    });
    return res.status(201).json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTION_CREATE_FAILED");
  }
});

router.patch("/collections/:id", async (req, res) => {
  try {
    const existing = await prisma.contentCollection.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    const data = await normalizeCollectionInput(req, { patch: true });
    const item = await prisma.contentCollection.update({ where: { id: existing.id }, data, ...collectionSelect() });
    return res.json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTION_UPDATE_FAILED");
  }
});

router.delete("/collections/:id", async (req, res) => {
  try {
    const existing = await prisma.contentCollection.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    const item = await prisma.contentCollection.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), status: "deleted", updatedByUserId: req.auth.userId },
    });
    return res.json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_COLLECTION_DELETE_FAILED");
  }
});

router.put("/collections/:id/blocks", async (req, res) => {
  try {
    const existing = await prisma.contentCollection.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const item = await prisma.$transaction(async (tx) => {
      await tx.contentBlock.deleteMany({ where: { collectionId: existing.id } });
      if (blocks.length) {
        await tx.contentBlock.createMany({ data: blocks.map((block, index) => ({ collectionId: existing.id, ...normalizeBlockInput(block, index) })) });
      }
      return tx.contentCollection.update({
        where: { id: existing.id },
        data: { updatedByUserId: req.auth.userId },
        include: { blocks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
      });
    });
    return res.json({ ok: true, item });
  } catch (err) {
    return sendError(res, err, "CONTENT_BLOCKS_REPLACE_FAILED");
  }
});

router.post("/collections/:id/usage", async (req, res) => {
  try {
    const existing = await prisma.contentCollection.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "CONTENT_COLLECTION_NOT_FOUND", error: "Collection not found" });
    const event = await prisma.contentUsageEvent.create({
      data: {
        agencyId: req.auth.agencyId,
        collectionId: existing.id,
        blockId: optionalString(req.body?.blockId, 100),
        creatorId: optionalString(req.body?.creatorId || existing.creatorId, 100),
        fanId: optionalString(req.body?.fanId, 80),
        dialogId: optionalString(req.body?.dialogId, 80),
        eventType: cleanString(req.body?.eventType || "used", 40) || "used",
        metadata: jsonObject(req.body?.metadata),
        createdByUserId: req.auth.userId,
      },
    });
    return res.status(201).json({ ok: true, event });
  } catch (err) {
    return sendError(res, err, "CONTENT_USAGE_FAILED");
  }
});

module.exports = router;
