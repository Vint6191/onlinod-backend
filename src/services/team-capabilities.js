"use strict";

const { isSeniorAgencyMember } = require("../middleware/agency-member-role");
const {
  PERMISSION_BY_KEY,
  canUsePermission,
  directPermissionValue,
  memberRoleKey,
  isOwner,
} = require("./team-access-control");

const TEAM_CAPABILITIES = Object.freeze({
  VIEW_ANALYTICS: "team.analytics.view",
  VIEW_ATTRIBUTION: "money.view_attribution",
  CLAIM_OWN: "money.claim",
  RELEASE_OWN: "money.release_own_claim",
  RESOLVE_ATTRIBUTION: "money.resolve_attribution",
  OVERRIDE_ATTRIBUTION: "money.override_attribution",
  VIEW_AUDIT: "money.view_audit",
});

function nestedPermissionValue(permissions, key) {
  return directPermissionValue(permissions, key);
}

function defaultCapability(member, key) {
  if (isOwner(member)) return true;
  if (key === TEAM_CAPABILITIES.CLAIM_OWN || key === TEAM_CAPABILITIES.RELEASE_OWN) return true;
  return isSeniorAgencyMember(member);
}

async function canUseTeamCapability({ member, key, prismaClient = null }) {
  const db = prismaClient || require("../prisma");
  if (!member || !key) return false;
  if (isOwner(member)) return true;

  const direct = nestedPermissionValue(member.permissions, key);
  if (direct !== null) return direct;

  // V8: known Team/role permissions are derived from the authoritative role
  // definition and role-level sub-permission overrides on every check. This
  // means changing a role takes effect without rewriting each member row.
  if (PERMISSION_BY_KEY.has(key)) {
    return canUsePermission({ member, key, db });
  }

  // Backward-compatible fallback for capability keys that predate the V8 role
  // registry. Existing deployments keep their previous senior-member defaults.
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
