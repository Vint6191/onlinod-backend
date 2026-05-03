"use strict";

const express = require("express");
const {
  buildTeamOverview,
  buildTeamMembers,
  buildTeamAlerts,
  buildTeamFlags,
} = require("../services/team-analytics-service");

const router = express.Router();

function agencyId(req) {
  return String(req.query.agencyId || req.auth.agencyId || "");
}

function requireAgency(req, res) {
  const id = agencyId(req);
  if (!id) {
    res.status(400).json({ ok: false, code: "NO_AGENCY", error: "Agency is missing" });
    return null;
  }
  if (id !== req.auth.agencyId) {
    res.status(403).json({ ok: false, code: "AGENCY_FORBIDDEN", error: "No access to agency" });
    return null;
  }
  return id;
}

router.get("/overview", async (req, res) => {
  try {
    const id = requireAgency(req, res); if (!id) return;
    return res.json(await buildTeamOverview({ agencyId: id, rangeKey: req.query.range || "7d" }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_OVERVIEW_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/members", async (req, res) => {
  try {
    const id = requireAgency(req, res); if (!id) return;
    return res.json(await buildTeamMembers({ agencyId: id, rangeKey: req.query.range || "7d" }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_MEMBERS_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/alerts", async (req, res) => {
  try {
    const id = requireAgency(req, res); if (!id) return;
    return res.json(await buildTeamAlerts({ agencyId: id, rangeKey: req.query.range || "7d" }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_ALERTS_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/flags", async (req, res) => {
  try {
    const id = requireAgency(req, res); if (!id) return;
    return res.json(await buildTeamFlags({ agencyId: id, rangeKey: req.query.range || "7d" }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_FLAGS_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
