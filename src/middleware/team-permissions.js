/* src/middleware/team-permissions.js
   ────────────────────────────────────────────────────────────
   Permission middleware for /api/team/* routes.
   
   These endpoints all assume the caller is an AUTHENTICATED USER
   (not admin), authed via the existing requireUser() middleware
   that populates req.user = { id, email, ... }.
   
   On top of that, team write actions need an agency context AND
   the right role within it:
   
   - team:read        → any member of the agency
   - team:write_team  → OWNER or roleKey "manager"
   - team:write_roles → OWNER only (changing role config is dangerous)
   ────────────────────────────────────────────────────────────
*/

"use strict";

const prisma = require("../prisma");

const HIGH_PRIVILEGE_KEYS = new Set(["owner", "manager"]);

async function loadMembership(userId, agencyId) {
  if (!userId || !agencyId) return null;

  return prisma.agencyMember.findFirst({
    where: { agencyId, userId, deletedAt: null, agency: { deletedAt: null } },
  });
}

// req.params.agencyId OR req.body.agencyId OR req.query.agencyId
function pickAgencyId(req) {
  return (
    req.params?.agencyId ||
    req.body?.agencyId ||
    req.query?.agencyId ||
    null
  );
}

function teamReadRequired() {
  return async (req, res, next) => {
    try {
      const agencyId = pickAgencyId(req);
      if (!agencyId) {
        return res.status(400).json({ ok: false, code: "AGENCY_ID_REQUIRED", error: "agencyId is required" });
      }

      const member = await loadMembership(req.auth?.userId || req.user?.id, agencyId);
      if (!member) {
        return res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "You are not a member of this agency" });
      }

      req.agencyMember = member;
      req.agencyId = agencyId;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function teamWriteRequired() {
  return async (req, res, next) => {
    try {
      const agencyId = pickAgencyId(req);
      if (!agencyId) {
        return res.status(400).json({ ok: false, code: "AGENCY_ID_REQUIRED", error: "agencyId is required" });
      }

      const member = await loadMembership(req.auth?.userId || req.user?.id, agencyId);
      if (!member) {
        return res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "You are not a member of this agency" });
      }

      const isOwnerLegacy = member.role === "OWNER";
      const isHighPriv = HIGH_PRIVILEGE_KEYS.has(String(member.roleKey || "").toLowerCase());

      if (!isOwnerLegacy && !isHighPriv) {
        return res.status(403).json({
          ok: false,
          code: "INSUFFICIENT_TEAM_ROLE",
          error: "Only OWNER or manager can modify team",
        });
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
  return async (req, res, next) => {
    try {
      const agencyId = pickAgencyId(req);
      if (!agencyId) {
        return res.status(400).json({ ok: false, code: "AGENCY_ID_REQUIRED", error: "agencyId is required" });
      }

      const member = await loadMembership(req.auth?.userId || req.user?.id, agencyId);
      if (!member) {
        return res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "You are not a member of this agency" });
      }

      // Role config changes — OWNER only. Even "manager" can't.
      const isOwnerLegacy = member.role === "OWNER";
      const isOwnerKey    = String(member.roleKey || "").toLowerCase() === "owner";

      if (!isOwnerLegacy && !isOwnerKey) {
        return res.status(403).json({
          ok: false,
          code: "OWNER_ONLY",
          error: "Only OWNER can modify role configuration",
        });
      }

      req.agencyMember = member;
      req.agencyId = agencyId;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  teamReadRequired,
  teamWriteRequired,
  rolesWriteRequired,
};
