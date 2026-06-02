"use strict";

const express = require("express");
const prisma = require("../prisma");
const { cleanString, optionalString, jsonObject, parseLimit, parseOffset, requireCreator, sendError } = require("../services/server-store-utils");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId, deletedAt: null };
    const creatorId = cleanString(req.query.creatorId, 100);
    if (creatorId) where.creatorId = creatorId;
    const take = parseLimit(req.query.limit, 100, 500);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.savedSegment.findMany({ where, orderBy: { updatedAt: "desc" }, take, skip }),
      prisma.savedSegment.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "SEGMENTS_FAILED"); }
});

router.post("/", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    if (creatorId) await requireCreator(prisma, req.auth.agencyId, creatorId);
    const item = await prisma.savedSegment.create({ data: { agencyId: req.auth.agencyId, creatorId: creatorId || null, name: cleanString(req.body?.name || "Untitled segment", 160) || "Untitled segment", description: optionalString(req.body?.description, 2000), filters: jsonObject(req.body?.filters), safety: jsonObject(req.body?.safety), preview: jsonObject(req.body?.preview), createdByUserId: req.auth.userId } });
    return res.status(201).json({ ok: true, item });
  } catch (err) { return sendError(res, err, "SEGMENT_CREATE_FAILED"); }
});

router.patch("/:id", async (req, res) => {
  try {
    const existing = await prisma.savedSegment.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "SEGMENT_NOT_FOUND", error: "Segment not found" });
    const data = {};
    if (req.body?.creatorId !== undefined) { const cid = cleanString(req.body.creatorId, 100); if (cid) await requireCreator(prisma, req.auth.agencyId, cid); data.creatorId = cid || null; }
    if (req.body?.name !== undefined) data.name = cleanString(req.body.name, 160) || existing.name;
    if (req.body?.description !== undefined) data.description = optionalString(req.body.description, 2000);
    if (req.body?.filters !== undefined) data.filters = jsonObject(req.body.filters);
    if (req.body?.safety !== undefined) data.safety = jsonObject(req.body.safety);
    if (req.body?.preview !== undefined) data.preview = jsonObject(req.body.preview);
    if (req.body?.status !== undefined) data.status = cleanString(req.body.status, 40) || existing.status;
    const item = await prisma.savedSegment.update({ where: { id: existing.id }, data });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "SEGMENT_UPDATE_FAILED"); }
});

router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.savedSegment.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "SEGMENT_NOT_FOUND", error: "Segment not found" });
    const item = await prisma.savedSegment.update({ where: { id: existing.id }, data: { deletedAt: new Date(), status: "deleted" } });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "SEGMENT_DELETE_FAILED"); }
});

module.exports = router;
