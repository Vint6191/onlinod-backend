"use strict";

const express = require("express");
const prisma = require("../prisma");
const { cleanString, optionalString, jsonArray, jsonObject, parseLimit, parseOffset, requireCreator, sendError } = require("../services/server-store-utils");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId, deletedAt: null };
    const creatorId = cleanString(req.query.creatorId, 100);
    const type = cleanString(req.query.type, 40);
    if (creatorId) where.creatorId = creatorId;
    if (type) where.type = type;
    const take = parseLimit(req.query.limit, 100, 500);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.fanList.findMany({ where, include: { _count: { select: { members: true } } }, orderBy: { updatedAt: "desc" }, take, skip }),
      prisma.fanList.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "FAN_LISTS_FAILED"); }
});

router.post("/", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    if (creatorId) await requireCreator(prisma, req.auth.agencyId, creatorId);
    const item = await prisma.fanList.create({
      data: {
        agencyId: req.auth.agencyId,
        creatorId: creatorId || null,
        name: cleanString(req.body?.name || "Untitled list", 160) || "Untitled list",
        description: optionalString(req.body?.description, 2000),
        type: cleanString(req.body?.type || "manual", 40) || "manual",
        filters: jsonObject(req.body?.filters),
        status: cleanString(req.body?.status || "active", 40) || "active",
        createdByUserId: req.auth.userId,
      },
    });
    return res.status(201).json({ ok: true, item });
  } catch (err) { return sendError(res, err, "FAN_LIST_CREATE_FAILED"); }
});

router.patch("/:id", async (req, res) => {
  try {
    const existing = await prisma.fanList.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "FAN_LIST_NOT_FOUND", error: "Fan list not found" });
    const data = {};
    if (req.body?.name !== undefined) data.name = cleanString(req.body.name, 160) || existing.name;
    if (req.body?.description !== undefined) data.description = optionalString(req.body.description, 2000);
    if (req.body?.type !== undefined) data.type = cleanString(req.body.type, 40) || existing.type;
    if (req.body?.filters !== undefined) data.filters = jsonObject(req.body.filters);
    if (req.body?.status !== undefined) data.status = cleanString(req.body.status, 40) || existing.status;
    if (req.body?.creatorId !== undefined) {
      const creatorId = cleanString(req.body.creatorId, 100);
      if (creatorId) await requireCreator(prisma, req.auth.agencyId, creatorId);
      data.creatorId = creatorId || null;
    }
    const item = await prisma.fanList.update({ where: { id: existing.id }, data });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "FAN_LIST_UPDATE_FAILED"); }
});

router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.fanList.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "FAN_LIST_NOT_FOUND", error: "Fan list not found" });
    const item = await prisma.fanList.update({ where: { id: existing.id }, data: { deletedAt: new Date(), status: "deleted" } });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "FAN_LIST_DELETE_FAILED"); }
});

router.get("/:id/members", async (req, res) => {
  try {
    const existing = await prisma.fanList.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "FAN_LIST_NOT_FOUND", error: "Fan list not found" });
    const take = parseLimit(req.query.limit, 200, 1000);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.fanListMember.findMany({ where: { listId: existing.id }, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.fanListMember.count({ where: { listId: existing.id } }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "FAN_LIST_MEMBERS_FAILED"); }
});

router.put("/:id/members", async (req, res) => {
  try {
    const existing = await prisma.fanList.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "FAN_LIST_NOT_FOUND", error: "Fan list not found" });
    const members = jsonArray(req.body?.members).map((m) => {
      const fanId = cleanString(m.fanId || m.userId || m.id, 80);
      if (!fanId) return null;
      const creatorId = cleanString(m.creatorId || existing.creatorId, 100);
      return {
        agencyId: req.auth.agencyId,
        listId: existing.id,
        creatorId: creatorId || null,
        fanId,
        dialogId: optionalString(m.dialogId, 80),
        username: optionalString(m.username, 120),
        name: optionalString(m.name, 180),
        source: cleanString(m.source || "manual", 60) || "manual",
        matchedReasons: jsonArray(m.matchedReasons || m.matched),
        metadata: jsonObject(m.metadata),
        createdByUserId: req.auth.userId,
      };
    }).filter(Boolean);
    await prisma.$transaction(async (tx) => {
      await tx.fanListMember.deleteMany({ where: { listId: existing.id } });
      if (members.length) await tx.fanListMember.createMany({ data: members, skipDuplicates: true });
      await tx.fanList.update({ where: { id: existing.id }, data: { updatedAt: new Date() } });
    });
    return res.json({ ok: true, count: members.length });
  } catch (err) { return sendError(res, err, "FAN_LIST_MEMBERS_REPLACE_FAILED"); }
});

router.post("/:id/members", async (req, res) => {
  try {
    const existing = await prisma.fanList.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "FAN_LIST_NOT_FOUND", error: "Fan list not found" });
    const fanId = cleanString(req.body?.fanId || req.body?.userId || req.body?.id, 80);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    const item = await prisma.fanListMember.upsert({
      where: { listId_fanId: { listId: existing.id, fanId } },
      create: {
        agencyId: req.auth.agencyId, listId: existing.id, creatorId: cleanString(req.body?.creatorId || existing.creatorId, 100) || null,
        fanId, dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180),
        source: cleanString(req.body?.source || "manual", 60) || "manual", matchedReasons: jsonArray(req.body?.matchedReasons || req.body?.matched), metadata: jsonObject(req.body?.metadata), createdByUserId: req.auth.userId,
      },
      update: { dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180), matchedReasons: jsonArray(req.body?.matchedReasons || req.body?.matched), metadata: jsonObject(req.body?.metadata) },
    });
    return res.status(201).json({ ok: true, item });
  } catch (err) { return sendError(res, err, "FAN_LIST_MEMBER_UPSERT_FAILED"); }
});

module.exports = router;
