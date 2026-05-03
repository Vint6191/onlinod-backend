"use strict";

const express = require("express");
const prisma = require("../prisma");
const { getModuleRegistry } = require("../services/module-registry");

const router = express.Router();

router.get("/state", async (req, res) => {
  try {
    const settings = await prisma.moduleSetting.findMany({ where: { agencyId: req.auth.agencyId } });
    const byKey = new Map(settings.map((item) => [item.moduleKey, item]));
    const modules = getModuleRegistry().map((item) => {
      const setting = byKey.get(item.key);
      return {
        ...item,
        enabled: setting ? setting.enabled : true,
        status: setting?.status || item.status,
        config: setting?.config || {},
        updatedAt: setting?.updatedAt || null,
      };
    });
    return res.json({ ok: true, modules });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MODULES_STATE_FAILED", error: err?.message || "Failed" });
  }
});

router.patch("/:moduleKey", async (req, res) => {
  try {
    const moduleKey = String(req.params.moduleKey || "").trim();
    if (!moduleKey) return res.status(400).json({ ok: false, code: "MODULE_KEY_MISSING", error: "Module key is missing" });

    const updated = await prisma.moduleSetting.upsert({
      where: { agencyId_moduleKey: { agencyId: req.auth.agencyId, moduleKey } },
      create: {
        agencyId: req.auth.agencyId,
        moduleKey,
        enabled: req.body?.enabled !== false,
        status: String(req.body?.status || "partial"),
        config: req.body?.config && typeof req.body.config === "object" ? req.body.config : {},
      },
      update: {
        enabled: req.body?.enabled === undefined ? undefined : req.body.enabled === true,
        status: req.body?.status ? String(req.body.status) : undefined,
        config: req.body?.config && typeof req.body.config === "object" ? req.body.config : undefined,
      },
    });
    return res.json({ ok: true, module: updated });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MODULE_UPDATE_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
