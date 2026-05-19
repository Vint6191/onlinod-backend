"use strict";

const express = require("express");
const {
  upsertDeliveryEvents,
  upsertMediaAssetMeta,
  getMediaAnalytics,
} = require("../services/vault-intelligence-service");

const router = express.Router();

function errorResponse(res, err, fallbackCode = "VAULT_INTELLIGENCE_FAILED") {
  const code = err?.code || fallbackCode;
  const status = code === "CREATOR_NOT_FOUND" ? 404 : code === "MEDIA_ID_MISSING" ? 400 : 500;
  return res.status(status).json({ ok: false, code, error: String(err?.message || err || "Failed") });
}

router.post("/:creatorId/events/bulk", async (req, res) => {
  try {
    const result = await upsertDeliveryEvents({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      events: req.body?.events || [],
    });
    return res.json(result);
  } catch (err) {
    return errorResponse(res, err, "VAULT_INTELLIGENCE_EVENTS_BULK_FAILED");
  }
});


router.get("/:creatorId/media", async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    const result = await getMediaAnalytics({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaIds: ids,
    });
    return res.json(result);
  } catch (err) {
    return errorResponse(res, err, "VAULT_INTELLIGENCE_MEDIA_ANALYTICS_FAILED");
  }
});

router.patch("/:creatorId/media/:mediaId/meta", async (req, res) => {
  try {
    const result = await upsertMediaAssetMeta({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      mediaId: req.params.mediaId,
      patch: req.body || {},
    });
    return res.json(result);
  } catch (err) {
    return errorResponse(res, err, "VAULT_INTELLIGENCE_MEDIA_META_FAILED");
  }
});

module.exports = router;
