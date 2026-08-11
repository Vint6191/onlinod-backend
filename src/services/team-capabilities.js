"use strict";

const { isSeniorAgencyMember } = require("../middleware/agency-member-role");

const TEAM_CAPABILITIES = Object.freeze({
  VIEW_ATTRIBUTION: "money.view_attribution",
  CLAIM_OWN: "money.claim",
  RELEASE_OWN: "money.release_own_claim",
  RESOLVE_ATTRIBUTION: "money.resolve_attribution",
  OVERRIDE_ATTRIBUTION: "money.override_attribution",
  VIEW_AUDIT: "money.view_audit",
});

function nestedPermissionValue(permissions, key) {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return null;
  if (Object.prototype.hasOwnProperty.call(permissions, key) && typeof permissions[key] === "boolean") {
    return permissions[key];
  }
  const parts = String(key || "").split(".").filter(Boolean);
  let current = permissions;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return null;
    current = current[part];
  }
  return typeof current === "boolean" ? current : null;
}

function memberRoleKey(member) {
  return String(member?.roleKey || member?.role || "").trim().toLowerCase();
}

function isOwner(member) {
  return String(member?.role || "").toUpperCase() === "OWNER" || memberRoleKey(member) === "owner";
}

function defaultCapability(member, key) {
  if (isOwner(member)) return true;
  if (key === TEAM_CAPABILITIES.CLAIM_OWN || key === TEAM_CAPABILITIES.RELEASE_OWN) return true;
  return isSeniorAgencyMember(member);
}

async function canUseTeamCapability({ member, key, prismaClient = null }) {
  const db = prismaClient || require("../prisma");
  if (!member || !key) return false;
  // OWNER is intentionally locked/full in the Team model. An explicit false
  // cannot accidentally remove the owner's recovery/audit path.
  if (isOwner(member)) return true;

  const direct = nestedPermissionValue(member.permissions, key);
  if (direct !== null) return direct;

  const agencyId = String(member.agencyId || "").trim();
  const roleKey = memberRoleKey(member);
  if (agencyId && roleKey && db?.agencySubPermissionOverride?.findUnique) {
    const override = await db.agencySubPermissionOverride.findUnique({
      where: {
        agencyId_roleKey_subPermKey: {
          agencyId,
          roleKey,
          subPermKey: key,
        },
      },
      select: { value: true },
    });
    if (override && typeof override.value === "boolean") return override.value;
  }

  return defaultCapability(member, key);
}

module.exports = {
  TEAM_CAPABILITIES,
  nestedPermissionValue,
  memberRoleKey,
  isOwner,
  defaultCapability,
  canUseTeamCapability,
};
