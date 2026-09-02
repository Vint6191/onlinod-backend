"use strict";

const express = require("express");
const { buildHomeSummary } = require("../services/home-summary-service");

const router = express.Router();

router.get("/summary", async (req, res) => {
  try {
    const agencyId = String(req.query.agencyId || req.auth.agencyId || "");
    if (!agencyId) return res.status(400).json({ ok: false, code: "NO_AGENCY", error: "Agency is missing" });
    if (agencyId !== req.auth.agencyId) return res.status(403).json({ ok: false, code: "AGENCY_FORBIDDEN", error: "No access to agency" });

    const summary = await buildHomeSummary({ agencyId, member: req.auth.membership || req.member, rangeKey: req.query.range || "7d" });
    return res.json(summary);
  } catch (err) {
    console.error("[home/summary] failed:", err);
    return res.status(Number(err?.status) || 500).json({ ok: false, code: err?.code || "HOME_SUMMARY_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
