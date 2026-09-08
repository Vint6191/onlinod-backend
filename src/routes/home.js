"use strict";

const express = require("express");
const prisma = require("../prisma");
const { buildHomeSummary } = require("../services/home-summary-service");
const { allowedCreatorScope } = require("../middleware/automation-permissions");
const { canUsePermission } = require("../services/team-access-control");
const { enqueueAgencyAnalyticsFreshnessDemand } = require("../services/analytics-collection-planner");

const router = express.Router();

function currentMember(req) {
  return req.auth?.membership || req.member || null;
}

router.get("/summary", async (req, res) => {
  try {
    const agencyId = String(req.query.agencyId || req.auth.agencyId || "");
    if (!agencyId) return res.status(400).json({ ok: false, code: "NO_AGENCY", error: "Agency is missing" });
    if (agencyId !== req.auth.agencyId) return res.status(403).json({ ok: false, code: "AGENCY_FORBIDDEN", error: "No access to agency" });
    const summary = await buildHomeSummary({ agencyId, member: currentMember(req), rangeKey: req.query.range || "7d" });
    return res.json(summary);
  } catch (err) {
    console.error("[home/summary] failed:", err);
    return res.status(Number(err?.status) || 500).json({ ok: false, code: err?.code || "HOME_SUMMARY_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const agencyId = String(req.auth?.agencyId || "");
    const member = currentMember(req);
    if (!agencyId || !member || String(member.agencyId || "") !== agencyId) {
      return res.status(403).json({ ok: false, code: "AGENCY_FORBIDDEN", error: "Current agency membership is required" });
    }
    const allowed = await canUsePermission({ member, key: "creator_analytics.refresh", db: prisma });
    if (!allowed) {
      return res.status(403).json({ ok: false, code: "FEATURE_FORBIDDEN", permission: "creator_analytics.refresh", error: "creator_analytics.refresh permission is required" });
    }
    const scope = await allowedCreatorScope({ agencyId, member, db: prisma });
    const demand = await enqueueAgencyAnalyticsFreshnessDemand({
      db: prisma,
      agencyId,
      creatorIds: scope.broad ? null : scope.creatorIds,
      rangeKey: req.body?.rangeKey || req.query?.rangeKey || "7d",
      reason: "INTERACTIVE_REFRESH",
      priority: 100,
      requestedByMemberId: member.id,
      requestedAccessEpoch: Number(member.accessEpoch || 1),
      now: new Date(),
      includePrevious: true,
    });
    return res.json({
      ok: true,
      agencyId,
      rangeKey: demand.rangeKey,
      queued: demand.queued === true,
      coalesced: demand.coalesced === true,
      demandKey: demand.key,
      requestRevision: demand.requestRevision,
    });
  } catch (err) {
    console.error("[home/refresh] failed:", err);
    const status = Number(err?.status) || (err?.code === "ANALYTICS_RANGE_INVALID" ? 400 : 500);
    return res.status(status).json({ ok: false, code: err?.code || "HOME_REFRESH_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
