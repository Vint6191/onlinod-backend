"use strict";

const HIGH_PRIVILEGE_KEYS = new Set(["owner", "manager", "admin"]);
const CREATOR_SCOPE_QUERY_CHUNK = 500;

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
  const ids = Array.from(new Set(assignedCreatorIds(member)));
  if (!ids.length) return { broad: false, creatorIds: [], creator: null };
  const client = db || require("../prisma");
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += CREATOR_SCOPE_QUERY_CHUNK) {
    const batch = ids.slice(offset, offset + CREATOR_SCOPE_QUERY_CHUNK);
    rows.push(...await client.creatorAccount.findMany({
      where: { agencyId, deletedAt: null, id: { in: batch } },
      select: { id: true },
      // Transport/parameter chunk only: every assigned id is queried before
      // the authoritative scope is returned. Never turn a resource batch size
      // into a correctness horizon.
      take: batch.length,
    }));
  }
  const live = new Set(rows.map((row) => String(row.id)));
  return { broad: false, creatorIds: ids.filter((id) => live.has(String(id))), creator: null };
}

module.exports = {
  assignedCreatorIds,
  hasBroadCreatorAccess,
  canAccessCreator,
  requireCreatorAccess,
  automationCreatorParamRequired,
  allowedCreatorScope,
};
