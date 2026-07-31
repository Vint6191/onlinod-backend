"use strict";

const { isSeniorAgencyMember } = require("../middleware/agency-member-role");

const MONEY_VIEW_PERMISSION_KEYS = [
  "money.view_earnings",
  "creator_analytics.view_money",
  "creatorAnalytics.viewMoney",
];
const ANALYTICS_REFRESH_PERMISSION_KEYS = [
  "creator_analytics.refresh",
  "creatorAnalytics.refresh",
  "stats.refresh",
];
const TRAFFIC_VIEW_PERMISSION_KEYS = [
  "traffic.view",
  ...MONEY_VIEW_PERMISSION_KEYS,
  "traffic.manage_costs",
  "traffic.manageCosts",
  "creator_analytics.manage_traffic_costs",
];
const TRAFFIC_REFRESH_PERMISSION_KEYS = [
  "traffic.refresh",
  ...ANALYTICS_REFRESH_PERMISSION_KEYS,
];
const TRAFFIC_COST_PERMISSION_KEYS = [
  "traffic.manage_costs",
  "traffic.manageCosts",
  "creator_analytics.manage_traffic_costs",
];

function hasExplicitPermission(member, keys) {
  const permissions = member?.permissions && typeof member.permissions === "object" ? member.permissions : {};
  return keys.some((key) => permissions[key] === true);
}

function hasRoleOrPermission(member, keys) {
  return isSeniorAgencyMember(member) || hasExplicitPermission(member, keys);
}

function canViewEarnings(member) {
  return hasRoleOrPermission(member, MONEY_VIEW_PERMISSION_KEYS);
}

function canRefreshAnalytics(member) {
  return hasRoleOrPermission(member, ANALYTICS_REFRESH_PERMISSION_KEYS);
}

function canViewTraffic(member) {
  return hasRoleOrPermission(member, TRAFFIC_VIEW_PERMISSION_KEYS);
}

function canRefreshTraffic(member) {
  return hasRoleOrPermission(member, TRAFFIC_REFRESH_PERMISSION_KEYS);
}

function canManageTrafficCosts(member) {
  return hasRoleOrPermission(member, TRAFFIC_COST_PERMISSION_KEYS);
}

module.exports = {
  MONEY_VIEW_PERMISSION_KEYS,
  ANALYTICS_REFRESH_PERMISSION_KEYS,
  TRAFFIC_VIEW_PERMISSION_KEYS,
  TRAFFIC_REFRESH_PERMISSION_KEYS,
  TRAFFIC_COST_PERMISSION_KEYS,
  hasExplicitPermission,
  canViewEarnings,
  canRefreshAnalytics,
  canViewTraffic,
  canRefreshTraffic,
  canManageTrafficCosts,
};
