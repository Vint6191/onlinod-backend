"use strict";

const HIGH_PRIVILEGE_KEYS = new Set(["owner", "manager", "admin"]);

function isSeniorAgencyMember(member) {
  const role = String(member?.role || "").toUpperCase();
  const roleKey = String(member?.roleKey || "").toLowerCase();
  return role === "OWNER" || role === "MANAGER" || role === "ADMIN" || HIGH_PRIVILEGE_KEYS.has(roleKey);
}

module.exports = {
  HIGH_PRIVILEGE_KEYS,
  isSeniorAgencyMember,
};
