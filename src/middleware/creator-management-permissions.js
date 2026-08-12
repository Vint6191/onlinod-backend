"use strict";

const { isSeniorAgencyMember } = require("./agency-member-role");
const { canUsePermission } = require("../services/team-access-control");

const CREATOR_MANAGEMENT_PERMISSION_KEYS = [
  "creators.manage",
  "creator.manage",
  "creator_management.manage",
  "models.manage",
];

function permissionValue(permissions, key) {
  if (!permissions || typeof permissions !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(permissions, key)) return permissions[key];
  const parts = key.split(".");
  let current = permissions;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function canManageCreators(member) {
  const permissions = member?.permissions && typeof member.permissions === "object" ? member.permissions : {};
  let sawExplicit = false;
  for (const key of CREATOR_MANAGEMENT_PERMISSION_KEYS) {
    const value = permissionValue(permissions, key);
    if (value === true) return true;
    if (value === false) sawExplicit = true;
  }
  if (sawExplicit) return false;
  return isSeniorAgencyMember(member);
}

async function creatorManagementRequired(req, res, next) {
  try {
    const member = req.auth?.membership || req.member || null;
    if (!member) {
      return res.status(403).json({ ok: false, code: "CREATOR_MANAGEMENT_FORBIDDEN", error: "Creator management permission is required" });
    }
    // Canonical V8 permission is role-authoritative. Legacy aliases remain a
    // compatibility fallback only when the member row explicitly carries one.
    // Resolve Prisma only when no direct decision exists, so explicit denies
    // fail closed even in minimal/test runtimes and do not load DB machinery.
    const explicitAlias = CREATOR_MANAGEMENT_PERMISSION_KEYS.slice(1).some((key) => permissionValue(member.permissions, key) === true);
    const explicitAliasDeny = CREATOR_MANAGEMENT_PERMISSION_KEYS.slice(1).some((key) => permissionValue(member.permissions, key) === false);
    const canonicalDirect = permissionValue(member.permissions, "creators.manage");
    let allowed;
    if (canonicalDirect === false) allowed = false;
    else if (canonicalDirect === true || explicitAlias) allowed = true;
    else if (explicitAliasDeny) allowed = false;
    else {
      const prisma = require("../prisma");
      allowed = await canUsePermission({ member, key: "creators.manage", db: prisma });
    }
    if (!allowed) {
      return res.status(403).json({
        ok: false,
        code: "CREATOR_MANAGEMENT_FORBIDDEN",
        error: "Creator management permission is required",
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  CREATOR_MANAGEMENT_PERMISSION_KEYS,
  canManageCreators,
  creatorManagementRequired,
};
