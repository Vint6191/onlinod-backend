"use strict";

const express = require("express");
const { z } = require("zod");
const {
  reportAnalyticsSnapshots,
  getLatestPayload,
} = require("../services/analytics-snapshot-service");

const router = express.Router();

const reportSchema = z.object({
  agencyId: z.string().optional().nullable(),
  deviceId: z.string().optional().nullable(),
  snapshots: z.array(z.object({
    scope: z.string().min(1),
    rangeKey: z.string().optional().nullable(),
    range: z.string().optional().nullable(),
    capturedAt: z.any().optional().nullable(),
    source: z.string().optional().nullable(),
    payload: z.any().optional().nullable(),
  })).max(100),
});

function resolveAgency(req, res, rawAgencyId = null) {
  const agencyId = String(rawAgencyId || req.auth.agencyId || "").trim();
  if (!agencyId) {
    res.status(400).json({ ok: false, code: "NO_AGENCY", error: "Agency is missing" });
    return null;
  }
  if (agencyId !== req.auth.agencyId) {
    res.status(403).json({ ok: false, code: "AGENCY_FORBIDDEN", error: "No access to agency" });
    return null;
  }
  return agencyId;
}

router.post("/snapshots/report", async (req, res) => {
  try {
    const input = reportSchema.parse(req.body || {});
    const agencyId = resolveAgency(req, res, input.agencyId);
    if (!agencyId) return;

    const result = await reportAnalyticsSnapshots({
      agencyId,
      userId: req.auth.userId,
      deviceId: input.deviceId || req.auth.deviceId || null,
      snapshots: input.snapshots,
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    }
    console.error("[analytics/snapshots/report] failed:", err);
    return res.status(500).json({ ok: false, code: "ANALYTICS_SNAPSHOT_REPORT_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/snapshots/latest", async (req, res) => {
  try {
    const agencyId = resolveAgency(req, res, req.query.agencyId);
    if (!agencyId) return;

    const scope = String(req.query.scope || "home");
    const rangeKey = String(req.query.range || req.query.rangeKey || "7d");
    const snapshot = await getLatestPayload({ agencyId, scope, rangeKey });

    return res.json({
      ok: true,
      scope,
      rangeKey,
      snapshot,
      source: snapshot ? "analytics_snapshot" : "snapshot_missing",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "ANALYTICS_SNAPSHOT_LATEST_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
