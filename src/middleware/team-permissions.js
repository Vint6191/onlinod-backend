"use strict";

const prisma = require("../prisma");
const { HIGH_PRIVILEGE_KEYS, isSeniorAgencyMember } = require("./agency-member-role");
const { canUsePermission } = require("../services/team-access-control");

async function loadMembership(userId, agencyId) {
  if (!userId || !agencyId) return null;
  return prisma.agencyMember.findFirst({
    where: {
      agencyId,
      userId,
      deletedAt: null,
      deactivatedAt: null,
      agency: { deletedAt: null },
    },
  });
}

function pickAgencyId(req) {
  return req.params?.agencyId || req.body?.agencyId || req.query?.agencyId || req.auth?.agencyId || null;
}

function denial(res, code, error) {
  return res.status(403).json({ ok: false, code, error });
}

function teamReadRequired(permissionKey = "workspace.view_team") {
  return async (req, res, next) => {
    try {
      const agencyId = pickAgencyId(req);
      if (!agencyId) return res.status(400).json({ ok: false, code: "AGENCY_ID_REQUIRED", error: "agencyId is required" });
      const member = await loadMembership(req.auth?.userId || req.user?.id, agencyId);
      if (!member) return denial(res, "NOT_A_MEMBER", "You are not an active member of this agency");
      if (!(await canUsePermission({ member, key: permissionKey, db: prisma }))) {
        return denial(res, "TEAM_PERMISSION_REQUIRED", `${permissionKey} permission is required`);
      }
      req.agencyMember = member;
      req.agencyId = agencyId;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function teamWriteRequired(permissionKey = "workspace.manage_members") {
  return async (req, res, next) => {
    try {
      const agencyId = pickAgencyId(req);
      if (!agencyId) return res.status(400).json({ ok: false, code: "AGENCY_ID_REQUIRED", error: "agencyId is required" });
      const member = await loadMembership(req.auth?.userId || req.user?.id, agencyId);
      if (!member) return denial(res, "NOT_A_MEMBER", "You are not an active member of this agency");
      if (!(await canUsePermission({ member, key: permissionKey, db: prisma }))) {
        return denial(res, "TEAM_PERMISSION_REQUIRED", `${permissionKey} permission is required`);
      }
      req.agencyMember = member;
      req.agencyId = agencyId;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function rolesWriteRequired() {
  return teamWriteRequired("workspace.edit_roles");
}

module.exports = {
  teamReadRequired,
  teamWriteRequired,
  rolesWriteRequired,
  loadMembership,
  pickAgencyId,
  isSeniorAgencyMember,
  HIGH_PRIVILEGE_KEYS,
};
