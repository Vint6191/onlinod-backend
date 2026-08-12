"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { TEAM_CAPABILITIES, canUseTeamCapability } = require("../services/team-capabilities");
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
const {
  listTeamResponseCases,
  listTeamDialogSessions,
  listTeamCoverageSessions,
} = require("../services/team-response-read-service");

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
    select: { id: true, agencyId: true, userId: true, role: true, roleKey: true, permissions: true, assignedCreators: true },
  });
}


function analyticsCreatorScope(member) {
  const isOwner = String(member?.role || "").toUpperCase() === "OWNER" || String(member?.roleKey || "").toLowerCase() === "owner";
  if (isOwner) return null;
  const raw = member?.assignedCreators;
  if (raw === null || raw === undefined || raw === "all") return null;
  if (Array.isArray(raw)) return Array.from(new Set(raw.map(String).map((id) => id.trim()).filter(Boolean)));
  if (raw && typeof raw === "object") {
    if (raw.all === true || raw.mode === "all") return null;
    const ids = Array.isArray(raw.creatorIds) ? raw.creatorIds : (Array.isArray(raw.ids) ? raw.ids : []);
    return Array.from(new Set(ids.map(String).map((id) => id.trim()).filter(Boolean)));
  }
  return [];
}

async function requireTeamAnalyticsViewer(req, res) {
  const id = requireAgency(req, res);
  if (!id) return null;
  const member = await loadAgencyMember(req, id);
  if (!member) {
    res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    return null;
  }
  const canView = await canUseTeamCapability({ member, key: TEAM_CAPABILITIES.VIEW_ANALYTICS });
  if (!canView) {
    res.status(403).json({
      ok: false,
      code: "TEAM_ANALYTICS_VIEW_REQUIRED",
      error: "team.analytics.view permission is required",
    });
    return null;
  }
  const includeMoney = await canUseTeamCapability({ member, key: TEAM_CAPABILITIES.VIEW_ATTRIBUTION });
  const allowedCreatorIds = analyticsCreatorScope(member);
  req.agencyMember = member;
  return { agencyId: id, member, includeMoney, allowedCreatorIds };
}


async function requirePpvClaimsManager(req, res) {
  const id = requireAgency(req, res);
  if (!id) return null;

  const member = await prisma.agencyMember.findFirst({
    where: { agencyId: id, userId: req.auth?.userId, deletedAt: null },
    select: { id: true, agencyId: true, userId: true, role: true, roleKey: true, permissions: true, assignedCreators: true },
  });

  if (!member) {
    res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    return null;
  }

  const allowed = await canUseTeamCapability({ member, key: TEAM_CAPABILITIES.RESOLVE_ATTRIBUTION });
  if (!allowed) {
    res.status(403).json({
      ok: false,
      code: "PPV_ATTRIBUTION_RESOLVE_REQUIRED",
      error: "money.resolve_attribution permission is required",
    });
    return null;
  }

  req.agencyMember = member;
  return { agencyId: id, member, allowedCreatorIds: analyticsCreatorScope(member) };
}

router.get("/ppv/resolve-jobs", async (req, res) => {
  try {
    const id = requireAgency(req, res); if (!id) return;
    const actor = await loadAgencyMember(req, id);
    if (!actor) return res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    const jobs = await listResolveJobs({
      agencyId: id,
      limit: req.query.limit || 100,
      allowedCreatorIds: analyticsCreatorScope(actor),
    });
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

    const canResolveAgencyWide = await canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.RESOLVE_ATTRIBUTION });
    const result = await submitResolveResults({
      agencyId: id,
      deviceId: req.auth.deviceId || req.body?.deviceId || null,
      results: req.body?.results || [],
      actorMemberId: actor.id,
      actorUserId: actor.userId,
      senior: canResolveAgencyWide,
      allowedCreatorIds: analyticsCreatorScope(actor),
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "PPV_RESOLVE_RESULTS_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/ppv/conflicts", async (req, res) => {
  try {
    const viewer = await requirePpvClaimsManager(req, res); if (!viewer) return;
    const includeClosed = String(req.query.includeClosed || req.query.include_closed || "") === "1" || String(req.query.includeClosed || "").toLowerCase() === "true";
    const conflicts = await listPpvConflicts({
      agencyId: viewer.agencyId,
      limit: req.query.limit || 100,
      includeClosed,
      allowedCreatorIds: viewer.allowedCreatorIds,
    });
    return res.json({ ok: true, conflicts });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "PPV_CONFLICTS_FAILED", error: err?.message || "Failed" });
  }
});

const ppvConflictResolutionSchema = z.object({
  action: z.enum(["assign", "unresolved", "creator_revenue", "reject", "reopen"]),
  memberId: z.string().min(1).max(160).optional().nullable(),
  reason: z.string().max(1000).optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.action === "assign" && !String(value.memberId || "").trim()) {
    ctx.addIssue({ code: "custom", path: ["memberId"], message: "memberId is required for assign" });
  }
  if (["assign", "reject", "creator_revenue"].includes(value.action) && String(value.reason || "").trim().length < 3) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "A reason of at least 3 characters is required" });
  }
});

router.post("/ppv/conflicts/:jobId/resolve", async (req, res) => {
  try {
    const viewer = await requirePpvClaimsManager(req, res); if (!viewer) return;
    const input = ppvConflictResolutionSchema.parse({
      action: req.body?.action || (req.body?.memberId || req.body?.attributedMemberId ? "assign" : "unresolved"),
      memberId: req.body?.memberId || req.body?.attributedMemberId || null,
      reason: req.body?.reason || null,
    });
    const result = await resolvePpvConflict({
      agencyId: viewer.agencyId,
      jobId: req.params.jobId,
      memberId: input.memberId,
      actorMemberId: req.agencyMember.id,
      action: input.action,
      reason: input.reason,
      deviceId: req.auth.deviceId || req.body?.deviceId || null,
      allowedCreatorIds: viewer.allowedCreatorIds,
    });
    if (result.code) {
      const status = result.code === "PPV_CONFLICT_NOT_FOUND" ? 404 : (result.code === "CREATOR_ACCESS_FORBIDDEN" ? 403 : 400);
      return res.status(status).json({ ok: false, ...result });
    }
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    return res.status(500).json({ ok: false, code: "PPV_CONFLICT_RESOLVE_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/responses", async (req, res) => {
  try {
    const viewer = await requireTeamAnalyticsViewer(req, res); if (!viewer) return;
    return res.json(await listTeamResponseCases({
      agencyId: viewer.agencyId,
      rangeKey: req.query.range || "7d",
      allowedCreatorIds: viewer.allowedCreatorIds,
      memberId: req.query.memberId || null,
      classification: req.query.classification || null,
      limit: req.query.limit || 100,
    }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_RESPONSES_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/dialog-sessions", async (req, res) => {
  try {
    const viewer = await requireTeamAnalyticsViewer(req, res); if (!viewer) return;
    return res.json(await listTeamDialogSessions({
      agencyId: viewer.agencyId,
      rangeKey: req.query.range || "7d",
      allowedCreatorIds: viewer.allowedCreatorIds,
      memberId: req.query.memberId || null,
      limit: req.query.limit || 100,
    }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_DIALOG_SESSIONS_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/coverage-sessions", async (req, res) => {
  try {
    const viewer = await requireTeamAnalyticsViewer(req, res); if (!viewer) return;
    return res.json(await listTeamCoverageSessions({
      agencyId: viewer.agencyId,
      rangeKey: req.query.range || "7d",
      allowedCreatorIds: viewer.allowedCreatorIds,
      memberId: req.query.memberId || null,
      limit: req.query.limit || 100,
    }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_COVERAGE_SESSIONS_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/overview", async (req, res) => {
  try {
    const viewer = await requireTeamAnalyticsViewer(req, res); if (!viewer) return;
    return res.json(await buildTeamOverview({ agencyId: viewer.agencyId, rangeKey: req.query.range || "7d", includeMoney: viewer.includeMoney, allowedCreatorIds: viewer.allowedCreatorIds }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_OVERVIEW_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/members", async (req, res) => {
  try {
    const viewer = await requireTeamAnalyticsViewer(req, res); if (!viewer) return;
    return res.json(await buildTeamMembers({ agencyId: viewer.agencyId, rangeKey: req.query.range || "7d", includeMoney: viewer.includeMoney, allowedCreatorIds: viewer.allowedCreatorIds }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_MEMBERS_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/alerts", async (req, res) => {
  try {
    const viewer = await requireTeamAnalyticsViewer(req, res); if (!viewer) return;
    return res.json(await buildTeamAlerts({ agencyId: viewer.agencyId, rangeKey: req.query.range || "7d", includeMoney: viewer.includeMoney, allowedCreatorIds: viewer.allowedCreatorIds }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_ALERTS_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/flags", async (req, res) => {
  try {
    const viewer = await requireTeamAnalyticsViewer(req, res); if (!viewer) return;
    return res.json(await buildTeamFlags({ agencyId: viewer.agencyId, rangeKey: req.query.range || "7d", includeMoney: viewer.includeMoney, allowedCreatorIds: viewer.allowedCreatorIds }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TEAM_ANALYTICS_FLAGS_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
