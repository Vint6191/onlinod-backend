"use strict";

const HIGH_PRIVILEGE_KEYS = new Set(["owner", "manager", "admin"]);

function isSeniorAgencyMember(member) {
  const role = String(member?.role || "").toUpperCase();
  const roleKey = String(member?.roleKey || "").toLowerCase();
  return role === "OWNER" || role === "MANAGER" || role === "ADMIN" || HIGH_PRIVILEGE_KEYS.has(roleKey);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function assignedCreatorIds(member) {
  const raw = member?.assignedCreators;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  const obj = object(raw);
  if (Array.isArray(obj.ids)) return obj.ids.map(String).filter(Boolean);
  if (Array.isArray(obj.creatorIds)) return obj.creatorIds.map(String).filter(Boolean);
  return [];
}

function hasBroadCreatorAccess(member) {
  const role = String(member?.role || "").toUpperCase();
  const roleKey = String(member?.roleKey || "").toLowerCase();
  if (role === "OWNER" || roleKey === "owner") return true;
  const raw = member?.assignedCreators;
  if (raw === null || raw === undefined || raw === "all") return true;
  const obj = object(raw);
  return obj.all === true || obj.mode === "all";
}

function canAccessCreator(member, creatorId) {
  if (!creatorId) return false;
  if (hasBroadCreatorAccess(member)) return true;
  return assignedCreatorIds(member).includes(String(creatorId));
}

async function requireCreatorAccess({ agencyId, member, creatorId, db = null }) {
  const client = db || require("../prisma");
  const creator = await client.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true, agencyId: true, displayName: true, username: true, status: true },
  });
  if (!creator) {
    const error = new Error("Creator not found");
    error.code = "CREATOR_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  if (!canAccessCreator(member, creator.id)) {
    const error = new Error("You do not have access to this creator");
    error.code = "CREATOR_ACCESS_FORBIDDEN";
    error.status = 403;
    throw error;
  }
  return creator;
}

function automationCreatorParamRequired() {
  return async (req, res, next, creatorId) => {
    try {
      const creator = await requireCreatorAccess({
        agencyId: req.auth.agencyId,
        member: req.auth.membership || req.member,
        creatorId,
      });
      req.automationCreator = creator;
      return next();
    } catch (error) {
      return res.status(Number(error.status) || 403).json({
        ok: false,
        code: error.code || "CREATOR_ACCESS_FORBIDDEN",
        error: error.message || "Creator access denied",
      });
    }
  };
}

async function allowedCreatorScope({ agencyId, member, requestedCreatorId = null, db = null }) {
  if (requestedCreatorId) {
    const creator = await requireCreatorAccess({ agencyId, member, creatorId: requestedCreatorId, db });
    return { broad: false, creatorIds: [creator.id], creator };
  }
  if (hasBroadCreatorAccess(member)) return { broad: true, creatorIds: null, creator: null };
  const ids = assignedCreatorIds(member);
  if (!ids.length) return { broad: false, creatorIds: [], creator: null };
  const client = db || require("../prisma");
  const rows = await client.creatorAccount.findMany({
    where: { agencyId, deletedAt: null, id: { in: ids } },
    select: { id: true },
    take: 10000,
  });
  return { broad: false, creatorIds: rows.map((row) => row.id), creator: null };
}

module.exports = {
  assignedCreatorIds,
  hasBroadCreatorAccess,
  canAccessCreator,
  requireCreatorAccess,
  automationCreatorParamRequired,
  allowedCreatorScope,
};
