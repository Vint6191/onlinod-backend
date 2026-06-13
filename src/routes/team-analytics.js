"use strict";

const express = require("express");
const prisma = require("../prisma");
const { isSeniorAgencyMember } = require("../middleware/team-permissions");
const {
  buildTeamOverview,
  buildTeamMembers,
  buildTeamAlerts,
  buildTeamFlags,
} = require("../services/team-analytics-service");
const {
  listResolveJobs,
  submitResolveResults,
  listPpvConflicts,
  resolvePpvConflict,
} = require("../services/team-ppv-ledger-service");

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

async function loadAgencyMember(req, agencyIdValue) {
  const id = agencyIdValue || agencyId(req);
  if (!id || !req.auth?.userId) return null;
  return prisma.agencyMember.findFirst({
    where: { agencyId: id, userId: req.auth.userId, deletedAt: null },
    select: { id: true, userId: true, role: true, roleKey: true },
  });
}


async function requirePpvClaimsManager(req, res) {
  const id = requireAgency(req, res);
  if (!id) return null;

  const member = await prisma.agencyMember.findFirst({
    where: { agencyId: id, userId: req.auth?.userId, deletedAt: null },
    select: { id: true, role: true, roleKey: true },
  });

  if (!member) {
    res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    return null;
  }

  if (!isSeniorAgencyMember(member)) {
    res.status(403).json({
      ok: false,
      code: "PPV_CLAIMS_MANAGER_REQUIRED",
      error: "Only owner / manager / admin can view or resolve PPV attribution conflicts",
    });
    return null;
  }

  req.agencyMember = member;
  return id;
}

router.get("/ppv/resolve-jobs", async (req, res) => {
  try {
    const id = requireAgency(req, res); if (!id) return;
    const jobs = await listResolveJobs({ agencyId: id, limit: req.query.limit || 100 });
    return res.json({ ok: true, jobs });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "PPV_RESOLVE_JOBS_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/ppv/resolve-results", async (req, res) => {
  try {
    const id = requireAgency(req, res); if (!id) return;
    const actor = await loadAgencyMember(req, id);
    if (!actor) {
      return res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    }

    const result = await submitResolveResults({
      agencyId: id,
      deviceId: req.auth.deviceId || req.body?.deviceId || null,
      results: req.body?.results || [],
      actorMemberId: actor.id,
      actorUserId: actor.userId,
      senior: isSeniorAgencyMember(actor),
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "PPV_RESOLVE_RESULTS_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/ppv/conflicts", async (req, res) => {
  try {
    const id = await requirePpvClaimsManager(req, res); if (!id) return;
    const includeClosed = String(req.query.includeClosed || req.query.include_closed || "") === "1" || String(req.query.includeClosed || "").toLowerCase() === "true";
    const conflicts = await listPpvConflicts({ agencyId: id, limit: req.query.limit || 100, includeClosed });
    return res.json({ ok: true, conflicts });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "PPV_CONFLICTS_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/ppv/conflicts/:jobId/resolve", async (req, res) => {
  try {
    const id = await requirePpvClaimsManager(req, res); if (!id) return;
    const result = await resolvePpvConflict({
      agencyId: id,
      jobId: req.params.jobId,
      memberId: req.body?.memberId || req.body?.attributedMemberId,
      action: req.body?.action || (req.body?.memberId || req.body?.attributedMemberId ? "assign" : "unresolved"),
      reason: req.body?.reason || null,
      deviceId: req.auth.deviceId || req.body?.deviceId || null,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "PPV_CONFLICT_RESOLVE_FAILED", error: err?.message || "Failed" });
  }
});

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
