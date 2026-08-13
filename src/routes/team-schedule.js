"use strict";

const express = require("express");
const prisma = require("../prisma");
const { TEAM_CAPABILITIES, canUseTeamCapability } = require("../services/team-capabilities");
const { canUsePermission } = require("../services/team-access-control");
const {
  buildTeamSchedule,
  createTeamShift,
  updateTeamShift,
  cancelTeamShift,
} = require("../services/team-schedule-service");

const router = express.Router();

function agencyId(req) {
  return String(req.query?.agencyId || req.body?.agencyId || req.auth?.agencyId || "").trim();
}

function creatorScope(member) {
  const owner = String(member?.role || "").toUpperCase() === "OWNER" || String(member?.roleKey || "").toLowerCase() === "owner";
  if (owner) return null;
  const raw = member?.assignedCreators;
  if (raw === null || raw === undefined || raw === "all") return null;
  if (Array.isArray(raw)) return Array.from(new Set(raw.map(String).map((id) => id.trim()).filter(Boolean)));
  if (raw && typeof raw === "object") {
    if (raw.all === true || String(raw.mode || "").toLowerCase() === "all") return null;
    const ids = Array.isArray(raw.creatorIds) ? raw.creatorIds : (Array.isArray(raw.ids) ? raw.ids : []);
    return Array.from(new Set(ids.map(String).map((id) => id.trim()).filter(Boolean)));
  }
  return [];
}

async function viewer(req, res, { write = false } = {}) {
  const id = agencyId(req);
  if (!id) {
    res.status(400).json({ ok: false, code: "NO_AGENCY", error: "Agency is missing" });
    return null;
  }
  if (id !== req.auth?.agencyId) {
    res.status(403).json({ ok: false, code: "AGENCY_FORBIDDEN", error: "No access to agency" });
    return null;
  }
  const member = await prisma.agencyMember.findFirst({
    where: { agencyId: id, userId: req.auth?.userId, deletedAt: null, deactivatedAt: null },
    select: { id: true, agencyId: true, userId: true, role: true, roleKey: true, permissions: true, assignedCreators: true },
  });
  if (!member) {
    res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No active agency membership" });
    return null;
  }

  const canView = await canUseTeamCapability({ member, key: TEAM_CAPABILITIES.VIEW_ANALYTICS });
  if (!canView) {
    res.status(403).json({ ok: false, code: "TEAM_ANALYTICS_VIEW_REQUIRED", error: "team.analytics.view permission is required" });
    return null;
  }
  const canManageSchedule = await canUsePermission({ member, key: "workspace.manage_schedule" });
  if (write && !canManageSchedule) {
    res.status(403).json({ ok: false, code: "TEAM_SCHEDULE_MANAGE_REQUIRED", error: "workspace.manage_schedule permission is required" });
    return null;
  }
  return { agencyId: id, member, allowedCreatorIds: creatorScope(member), canManageSchedule };
}

function sendError(res, err, fallbackCode) {
  const status = Number(err?.status);
  return res.status(Number.isFinite(status) && status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    code: err?.code || fallbackCode,
    error: err?.message || "Request failed",
    ...(Array.isArray(err?.creatorIds) ? { creatorIds: err.creatorIds } : {}),
  });
}

router.get("/", async (req, res) => {
  try {
    const actor = await viewer(req, res); if (!actor) return;
    return res.json(await buildTeamSchedule({
      agencyId: actor.agencyId,
      rangeKey: req.query.range || "7d",
      allowedCreatorIds: actor.allowedCreatorIds,
      canManageSchedule: actor.canManageSchedule,
    }));
  } catch (err) {
    return sendError(res, err, "TEAM_SCHEDULE_READ_FAILED");
  }
});

router.post("/shifts", async (req, res) => {
  try {
    const actor = await viewer(req, res, { write: true }); if (!actor) return;
    return res.status(201).json(await createTeamShift({
      agencyId: actor.agencyId,
      actorUserId: actor.member.userId,
      actorMemberId: actor.member.id,
      actorAllowedCreatorIds: actor.allowedCreatorIds,
      input: req.body || {},
    }));
  } catch (err) {
    return sendError(res, err, "TEAM_SCHEDULE_CREATE_FAILED");
  }
});

router.patch("/shifts/:shiftId", async (req, res) => {
  try {
    const actor = await viewer(req, res, { write: true }); if (!actor) return;
    return res.json(await updateTeamShift({
      agencyId: actor.agencyId,
      shiftId: req.params.shiftId,
      actorUserId: actor.member.userId,
      actorMemberId: actor.member.id,
      actorAllowedCreatorIds: actor.allowedCreatorIds,
      input: req.body || {},
    }));
  } catch (err) {
    return sendError(res, err, "TEAM_SCHEDULE_UPDATE_FAILED");
  }
});

router.post("/shifts/:shiftId/cancel", async (req, res) => {
  try {
    const actor = await viewer(req, res, { write: true }); if (!actor) return;
    return res.json(await cancelTeamShift({
      agencyId: actor.agencyId,
      shiftId: req.params.shiftId,
      actorUserId: actor.member.userId,
      actorMemberId: actor.member.id,
      actorAllowedCreatorIds: actor.allowedCreatorIds,
      reason: req.body?.reason || null,
    }));
  } catch (err) {
    return sendError(res, err, "TEAM_SCHEDULE_CANCEL_FAILED");
  }
});

module.exports = router;
