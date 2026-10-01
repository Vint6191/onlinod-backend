"use strict";
const express = require("express");
const { requireProductCreator } = require("../middleware/product-access");
const { getTrafficOverview, getTrafficSourceMembers } = require("../services/traffic-service");
const router = express.Router();
const retired = (code, error) => (_req, res) => res.status(410).json({ ok: false, code, error });
router.post("/sources/upsert", retired("TRAFFIC_SOURCE_INGEST_RETIRED", "Traffic sources are projected from canonical Campaigns"));
router.post("/subscriptions/ingest", retired("TRAFFIC_SUBSCRIPTION_INGEST_RETIRED", "Subscription receipts are projected from canonical notification facts"));
router.post("/value-refresh/mark-dirty", retired("TRAFFIC_DIRECT_VALUE_REFRESH_RETIRED", "FanData observations and canonical notification facts own refresh demand"));
router.post("/creators/:creatorId/value-refresh/pending", retired("TRAFFIC_DIRECT_VALUE_REFRESH_RETIRED", "Use the leased FanData collector"));
router.post("/creators/:creatorId/refresh", retired("MANAGEMENT_COMMAND_REQUIRED", "Use operation.control / traffic_refresh"));
router.patch("/creators/:creatorId/sources/:sourceId", retired("MANAGEMENT_COMMAND_REQUIRED", "Use traffic.cost with the current cost revision"));
function input(req) {
  return { userId: req.auth?.userId || req.user?.id, creatorId: req.params.creatorId, sourceId: req.params.sourceId,
    rangeKey: req.query.range || "all", limit: Number(req.query.limit || 100), offset: Number(req.query.offset || 0), after: req.query.after || "",
    onlyPaying: ["true", "1"].includes(String(req.query.onlyPaying || req.query.paying || "").toLowerCase()) };
}
function read(fn) { return async (req,res) => {
  try { await requireProductCreator(req, req.params.creatorId); return res.json(await fn(input(req))); }
  catch (error) { return res.status(error.status || 500).json({ ok: false, code: error.code || "TRAFFIC_READ_FAILED", error: error.message }); }
}; }
router.get("/creators/:creatorId/overview", read(getTrafficOverview));
router.get("/creators/:creatorId/sources/:sourceId/members", read(getTrafficSourceMembers));
module.exports = router;
