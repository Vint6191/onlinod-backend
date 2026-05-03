"use strict";

const express = require("express");
const prisma = require("../prisma");

const router = express.Router();

router.get("/state", async (req, res) => {
  try {
    const [rules, runs] = await Promise.all([
      prisma.automationRule.findMany({ where: { agencyId: req.auth.agencyId, deletedAt: null }, orderBy: { updatedAt: "desc" } }),
      prisma.automationRun.findMany({ where: { agencyId: req.auth.agencyId }, orderBy: { createdAt: "desc" }, take: 30 }),
    ]);
    return res.json({ ok: true, rules, runs });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "AUTOMATION_STATE_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/rules", async (req, res) => {
  try {
    const rule = await prisma.automationRule.create({
      data: {
        agencyId: req.auth.agencyId,
        name: String(req.body?.name || "Untitled rule").slice(0, 160),
        enabled: req.body?.enabled === true,
        trigger: req.body?.trigger && typeof req.body.trigger === "object" ? req.body.trigger : {},
        action: req.body?.action && typeof req.body.action === "object" ? req.body.action : {},
        creatorScope: req.body?.creatorScope || null,
        safety: req.body?.safety || null,
        createdByUserId: req.auth.userId,
      },
    });
    return res.status(201).json({ ok: true, rule });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "AUTOMATION_RULE_CREATE_FAILED", error: err?.message || "Failed" });
  }
});

router.patch("/rules/:id", async (req, res) => {
  try {
    const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "AUTOMATION_RULE_NOT_FOUND", error: "Rule not found" });
    const rule = await prisma.automationRule.update({
      where: { id: existing.id },
      data: {
        name: req.body?.name === undefined ? undefined : String(req.body.name).slice(0, 160),
        enabled: req.body?.enabled === undefined ? undefined : req.body.enabled === true,
        trigger: req.body?.trigger && typeof req.body.trigger === "object" ? req.body.trigger : undefined,
        action: req.body?.action && typeof req.body.action === "object" ? req.body.action : undefined,
        creatorScope: req.body?.creatorScope === undefined ? undefined : req.body.creatorScope || null,
        safety: req.body?.safety === undefined ? undefined : req.body.safety || null,
      },
    });
    return res.json({ ok: true, rule });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "AUTOMATION_RULE_UPDATE_FAILED", error: err?.message || "Failed" });
  }
});

router.delete("/rules/:id", async (req, res) => {
  try {
    const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, agencyId: req.auth.agencyId, deletedAt: null } });
    if (!existing) return res.status(404).json({ ok: false, code: "AUTOMATION_RULE_NOT_FOUND", error: "Rule not found" });
    await prisma.automationRule.update({ where: { id: existing.id }, data: { deletedAt: new Date(), enabled: false } });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "AUTOMATION_RULE_DELETE_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/runs", async (req, res) => {
  try {
    const runs = await prisma.automationRun.findMany({ where: { agencyId: req.auth.agencyId }, orderBy: { createdAt: "desc" }, take: Math.min(100, Number(req.query.limit || 50)) });
    return res.json({ ok: true, runs });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "AUTOMATION_RUNS_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
