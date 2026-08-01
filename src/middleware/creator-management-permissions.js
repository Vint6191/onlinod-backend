"use strict";

const { isSeniorAgencyMember } = require("./agency-member-role");

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
  if (isSeniorAgencyMember(member)) return true;
  const permissions = member?.permissions && typeof member.permissions === "object" ? member.permissions : {};
  return CREATOR_MANAGEMENT_PERMISSION_KEYS.some((key) => permissionValue(permissions, key) === true);
}

function creatorManagementRequired(req, res, next) {
  const member = req.auth?.membership || req.member || null;
  if (!canManageCreators(member)) {
    return res.status(403).json({
      ok: false,
      code: "CREATOR_MANAGEMENT_FORBIDDEN",
      error: "Creator management permission is required",
    });
  }
  return next();
}

module.exports = {
  CREATOR_MANAGEMENT_PERMISSION_KEYS,
  canManageCreators,
  creatorManagementRequired,
};
