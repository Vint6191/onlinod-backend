"use strict";

const express = require("express");
const prisma = require("../prisma");

const router = express.Router();

router.get("/workspace", async (req, res) => {
  try {
    const [agency, settings, subscription] = await Promise.all([
      prisma.agency.findUnique({ where: { id: req.auth.agencyId } }),
      prisma.workspaceSetting.findMany({ where: { agencyId: req.auth.agencyId } }),
      prisma.agencySubscription.findFirst({ where: { agencyId: req.auth.agencyId }, orderBy: { createdAt: "desc" } }),
    ]);
    return res.json({
      ok: true,
      agency,
      settings: Object.fromEntries(settings.map((item) => [item.key, item.value])),
      subscription,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "WORKSPACE_SETTINGS_FAILED", error: err?.message || "Failed" });
  }
});

router.patch("/workspace", async (req, res) => {
  try {
    const patch = req.body || {};
    if (patch.name) {
      await prisma.agency.update({ where: { id: req.auth.agencyId }, data: { name: String(patch.name).slice(0, 160) } });
    }

    const allowedSettings = ["timezone", "currency", "locale", "syncPolicy", "runtimePolicy"];
    for (const key of allowedSettings) {
      if (patch[key] === undefined) continue;
      await prisma.workspaceSetting.upsert({
        where: { agencyId_key: { agencyId: req.auth.agencyId, key } },
        create: { agencyId: req.auth.agencyId, key, value: patch[key] },
        update: { value: patch[key] },
      });
    }

    const settings = await prisma.workspaceSetting.findMany({ where: { agencyId: req.auth.agencyId } });
    return res.json({ ok: true, settings: Object.fromEntries(settings.map((item) => [item.key, item.value])) });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "WORKSPACE_SETTINGS_UPDATE_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/runtime", async (req, res) => {
  try {
    const [devices, jobs] = await Promise.all([
      prisma.workerDevice.findMany({ where: { agencyId: req.auth.agencyId }, orderBy: { lastSeenAt: "desc" }, take: 20 }),
      prisma.jobInstance.groupBy({ by: ["status"], where: { agencyId: req.auth.agencyId }, _count: { _all: true } }).catch(() => []),
    ]);
    return res.json({ ok: true, devices, jobs: Object.fromEntries(jobs.map((j) => [j.status, j._count._all])) });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "RUNTIME_SETTINGS_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
