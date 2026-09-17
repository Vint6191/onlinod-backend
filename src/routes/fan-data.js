"use strict";

const express = require("express");
const prisma = require("../prisma");
const { requireProductCreator, requireProductDevice } = require("../middleware/product-access");
const { authorizeActionProfileObservation } = require("../services/automation-action-delivery-service");
const { consumeActionFanObservationToken } = require("../services/fan-observation-token-service");
const { dbAuthorityNow } = require("../services/db-time-authority-service");
const {
  readFanCurrent, scheduleFanDataPointRefresh, onlyFansUserId, projectFanObservationBatch,
  FAN_DATA_POINT_REFRESH_MAX_FANS,
} = require("../services/fan-data-authority-service");

const router = express.Router();

function clean(value, max = 180) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

router.post("/current", async (req, res) => {
  try {
    const creatorId = clean(req.body?.creatorId);
    const creator = await requireProductCreator(req, creatorId);
    const ids = [...new Set((Array.isArray(req.body?.onlyFansUserIds) ? req.body.onlyFansUserIds : []).map(onlyFansUserId).filter(Boolean))];
    if (ids.length > FAN_DATA_POINT_REFRESH_MAX_FANS) {
      return res.status(413).json({
        ok: false,
        code: "FAN_DATA_CURRENT_REQUEST_TOO_LARGE",
        error: `Fan data current request exceeds ${FAN_DATA_POINT_REFRESH_MAX_FANS} fans`,
      });
    }
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
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length > 100) {
      return res.status(413).json({
        ok: false,
        code: "FAN_DATA_OBSERVATION_REQUEST_TOO_LARGE",
        error: "Action-scoped fan observation request exceeds 100 items",
      });
    }
    const deliveryId = clean(req.body?.deliveryId);
    const leaseToken = clean(req.body?.leaseToken, 2000);
    const leaseRevision = Number(req.body?.leaseRevision);
    const observationToken = clean(req.body?.observationToken, 500);
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
      let causalObservedAt = scope.causalObservedAt;
      const observationTokenRequired = Number(object(scope.delivery.result).profileObservationTokenVersion || 0) >= 1;
      if (observationTokenRequired || observationToken) {
        if (!observationToken) {
          const error = new Error("Current action USER_PROFILE observation requires a post-provider-read token");
          error.code = "FAN_DATA_OBSERVATION_TOKEN_REQUIRED";
          error.status = 409;
          throw error;
        }
        try {
          const consumed = await consumeActionFanObservationToken({
            db: tx,
            delivery: scope.delivery,
            deviceId: sourceDeviceId,
            leaseRevision,
            token: observationToken,
            purpose: "action_user_profile",
            subjects: fanIds,
          });
          causalObservedAt = consumed.observedAt;
        } catch (error) {
          const wrapped = new Error(error?.message || "Action USER_PROFILE observation token is invalid");
          wrapped.code = error?.message === "FAN_OBSERVATION_TOKEN_REPLAYED"
            ? "FAN_DATA_OBSERVATION_TOKEN_REPLAYED"
            : "FAN_DATA_OBSERVATION_TOKEN_INVALID";
          wrapped.status = 409;
          throw wrapped;
        }
      }
      return projectFanObservationBatch(tx, {
        agencyId: creator.agencyId,
        creatorId: creator.id,
        sourceDeviceId,
        sourceDeliveryId: scope.delivery.id,
        items,
        allowedSources: ["USER_PROFILE"],
        observedAtPolicy: "SERVER_GENERATION",
        receivedAt,
        causalObservedAt,
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
    const ids = [...new Set((Array.isArray(req.body?.onlyFansUserIds) ? req.body.onlyFansUserIds : []).map(onlyFansUserId).filter(Boolean))];
    if (ids.length > FAN_DATA_POINT_REFRESH_MAX_FANS) {
      return res.status(413).json({
        ok: false,
        code: "FAN_DATA_REFRESH_REQUEST_TOO_LARGE",
        error: `Fan data refresh request exceeds ${FAN_DATA_POINT_REFRESH_MAX_FANS} fans`,
      });
    }
    const decision = await scheduleFanDataPointRefresh({ agencyId: creator.agencyId, creatorId: creator.id, onlyFansUserIds: ids, reason: clean(req.body?.reason, 120) || "fan_data_api_refresh", priority: Number(req.body?.priority || 95) });
    return res.json({ ok: true, creatorId: creator.id, fanIds: ids, decision });
  } catch (error) {
    console.error("[fan-data/refresh] failed:", error);
    return res.status(Number(error?.status) || 500).json({ ok: false, code: error?.code || "FAN_DATA_REFRESH_FAILED", error: error?.message || "Fan data refresh scheduling failed" });
  }
});

module.exports = router;
