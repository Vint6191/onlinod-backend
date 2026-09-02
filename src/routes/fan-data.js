"use strict";

const express = require("express");
const prisma = require("../prisma");
const { requireProductCreator } = require("../middleware/product-access");
const { readFanCurrent, scheduleFanDataPointRefresh, onlyFansUserId } = require("../services/fan-data-authority-service");

const router = express.Router();

function clean(value, max = 180) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

router.post("/current", async (req, res) => {
  try {
    const creatorId = clean(req.body?.creatorId);
    const creator = await requireProductCreator(req, creatorId);
    const ids = [...new Set((Array.isArray(req.body?.onlyFansUserIds) ? req.body.onlyFansUserIds : []).map(onlyFansUserId).filter(Boolean))].slice(0, 500);
    const items = await readFanCurrent(prisma, { agencyId: creator.agencyId, creatorId: creator.id, onlyFansUserIds: ids });
    return res.json({ ok: true, creatorId: creator.id, items });
  } catch (error) {
    console.error("[fan-data/current] failed:", error);
    return res.status(Number(error?.status) || 500).json({ ok: false, code: error?.code || "FAN_DATA_CURRENT_FAILED", error: error?.message || "Fan data read failed" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const creatorId = clean(req.body?.creatorId);
    const creator = await requireProductCreator(req, creatorId);
    const ids = [...new Set((Array.isArray(req.body?.onlyFansUserIds) ? req.body.onlyFansUserIds : []).map(onlyFansUserId).filter(Boolean))].slice(0, 500);
    const decision = await scheduleFanDataPointRefresh({ agencyId: creator.agencyId, creatorId: creator.id, onlyFansUserIds: ids, reason: clean(req.body?.reason, 120) || "fan_data_api_refresh", priority: Number(req.body?.priority || 95) });
    return res.json({ ok: true, creatorId: creator.id, fanIds: ids, decision });
  } catch (error) {
    console.error("[fan-data/refresh] failed:", error);
    return res.status(Number(error?.status) || 500).json({ ok: false, code: error?.code || "FAN_DATA_REFRESH_FAILED", error: error?.message || "Fan data refresh scheduling failed" });
  }
});

module.exports = router;
