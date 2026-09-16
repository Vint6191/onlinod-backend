"use strict";

const express = require("express");
const prisma = require("../prisma");
const { requireProductCreator, requireProductDevice } = require("../middleware/product-access");
const { authorizeActionProfileObservation } = require("../services/automation-action-delivery-service");
const { dbAuthorityNow } = require("../services/db-time-authority-service");
const { readFanCurrent, scheduleFanDataPointRefresh, onlyFansUserId, projectFanObservationBatch } = require("../services/fan-data-authority-service");

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

router.post("/observations", async (req, res) => {
  try {
    const creatorId = clean(req.body?.creatorId);
    const creator = await requireProductCreator(req, creatorId);
    const sourceDeviceId = requireProductDevice(req, req.auth?.deviceId, {
      requiredCode: "FAN_DATA_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "FAN_DATA_DEVICE_IDENTITY_MISMATCH",
    });
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
    const deliveryId = clean(req.body?.deliveryId);
    const leaseToken = clean(req.body?.leaseToken, 2000);
    const leaseRevision = Number(req.body?.leaseRevision);
    if (!deliveryId || !leaseToken || !Number.isInteger(leaseRevision)) {
      return res.status(400).json({ ok: false, code: "FAN_DATA_OBSERVATION_ACTION_SCOPE_REQUIRED", error: "Action-scoped profile observation requires delivery lease proof" });
    }
    const fanIds = [...new Set(items.map((item) => onlyFansUserId(item?.onlyFansUserId)).filter(Boolean))];
    const result = await prisma.$transaction(async (tx) => {
      const receivedAt = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
      const scope = await authorizeActionProfileObservation({
        db: tx,
        deliveryId,
        userId: req.auth.userId,
        deviceId: sourceDeviceId,
        leaseToken,
        leaseRevision,
        creatorId: creator.id,
        onlyFansUserIds: fanIds,
      });
      return projectFanObservationBatch(tx, {
        agencyId: creator.agencyId,
        creatorId: creator.id,
        sourceDeviceId,
        sourceDeliveryId: scope.delivery.id,
        items,
        allowedSources: ["USER_PROFILE"],
        observedAtPolicy: "SERVER_GENERATION",
        receivedAt,
        causalObservedAt: scope.causalObservedAt,
      });
    });
    return res.json({ ok: true, creatorId: creator.id, ...result });
  } catch (error) {
    console.error("[fan-data/observations] failed:", error);
    return res.status(Number(error?.status) || 500).json({ ok: false, code: error?.code || "FAN_DATA_OBSERVATION_INGEST_FAILED", error: error?.message || "Fan observation ingest failed" });
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
