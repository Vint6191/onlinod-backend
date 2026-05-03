"use strict";

const express = require("express");
const prisma = require("../prisma");

const router = express.Router();

router.get("/state", async (req, res) => {
  try {
    const [groups, templates] = await Promise.all([
      prisma.messageTemplateGroup.findMany({ where: { agencyId: req.auth.agencyId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
      prisma.messageTemplate.findMany({ where: { agencyId: req.auth.agencyId, deletedAt: null }, orderBy: { updatedAt: "desc" } }),
    ]);
    return res.json({ ok: true, groups, templates });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MESSAGE_LIBRARY_STATE_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/groups", async (req, res) => {
  try {
    const group = await prisma.messageTemplateGroup.create({ data: { agencyId: req.auth.agencyId, name: String(req.body?.name || "Untitled group").slice(0, 120), sortOrder: Number(req.body?.sortOrder || 0) } });
    return res.status(201).json({ ok: true, group });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MESSAGE_GROUP_CREATE_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/templates", async (req, res) => {
  try {
    const template = await prisma.messageTemplate.create({
      data: {
        agencyId: req.auth.agencyId,
        groupId: req.body?.groupId || null,
        title: String(req.body?.title || "Untitled template").slice(0, 160),
        body: String(req.body?.body || ""),
        priceCents: req.body?.priceCents === undefined ? null : Number(req.body.priceCents || 0),
        tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
        creatorScope: req.body?.creatorScope || null,
        createdByUserId: req.auth.userId,
      },
    });
    return res.status(201).json({ ok: true, template });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MESSAGE_TEMPLATE_CREATE_FAILED", error: err?.message || "Failed" });
  }
});

router.patch("/templates/:id", async (req, res) => {
  try {
    const existing = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "TEMPLATE_NOT_FOUND", error: "Template not found" });
    const template = await prisma.messageTemplate.update({
      where: { id: existing.id },
      data: {
        groupId: req.body?.groupId === undefined ? undefined : req.body.groupId || null,
        title: req.body?.title === undefined ? undefined : String(req.body.title).slice(0, 160),
        body: req.body?.body === undefined ? undefined : String(req.body.body),
        priceCents: req.body?.priceCents === undefined ? undefined : Number(req.body.priceCents || 0),
        tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
        creatorScope: req.body?.creatorScope === undefined ? undefined : req.body.creatorScope || null,
        status: req.body?.status === undefined ? undefined : String(req.body.status),
      },
    });
    return res.json({ ok: true, template });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MESSAGE_TEMPLATE_UPDATE_FAILED", error: err?.message || "Failed" });
  }
});

router.delete("/templates/:id", async (req, res) => {
  try {
    const existing = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "TEMPLATE_NOT_FOUND", error: "Template not found" });
    await prisma.messageTemplate.update({ where: { id: existing.id }, data: { deletedAt: new Date(), status: "deleted" } });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MESSAGE_TEMPLATE_DELETE_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/templates/:id/use", async (req, res) => {
  try {
    const existing = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "TEMPLATE_NOT_FOUND", error: "Template not found" });
    const usage = await prisma.messageTemplateUsageEvent.create({
      data: {
        agencyId: req.auth.agencyId,
        templateId: existing.id,
        userId: req.auth.userId,
        memberId: req.auth.memberId,
        creatorId: req.body?.creatorId || null,
        fanId: req.body?.fanId || null,
        metadata: req.body?.metadata || {},
      },
    });
    return res.status(201).json({ ok: true, usage });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MESSAGE_TEMPLATE_USE_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
