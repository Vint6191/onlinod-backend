"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canViewEarnings,
  canRefreshAnalytics,
  canViewTraffic,
  canRefreshTraffic,
  canManageTrafficCosts,
} = require("./creator-analytics-permissions");

const member = (role, permissions = {}) => ({ role, permissions });

test("senior agency roles can use all Creator Analytics capabilities", () => {
  for (const role of ["OWNER", "ADMIN", "MANAGER"]) {
    const row = member(role);
    assert.equal(canViewEarnings(row), true);
    assert.equal(canRefreshAnalytics(row), true);
    assert.equal(canViewTraffic(row), true);
    assert.equal(canRefreshTraffic(row), true);
    assert.equal(canManageTrafficCosts(row), true);
  }
});

test("explicit permissions grant only their intended capabilities", () => {
  assert.equal(canViewEarnings(member("CHATTER", { "money.view_earnings": true })), true);
  assert.equal(canRefreshAnalytics(member("CHATTER", { "creator_analytics.refresh": true })), true);
  assert.equal(canViewTraffic(member("CHATTER", { "traffic.view": true })), true);
  assert.equal(canRefreshTraffic(member("CHATTER", { "traffic.refresh": true })), true);
  assert.equal(canManageTrafficCosts(member("CHATTER", { "traffic.manage_costs": true })), true);
});

test("traffic cost permission implies traffic visibility but not earnings visibility", () => {
  const row = member("CHATTER", { "traffic.manage_costs": true });
  assert.equal(canViewTraffic(row), true);
  assert.equal(canManageTrafficCosts(row), true);
  assert.equal(canViewEarnings(row), false);
  assert.equal(canRefreshTraffic(row), false);
});

test("unprivileged members cannot read financial analytics or trigger refreshes", () => {
  const row = member("CHATTER", {});
  assert.equal(canViewEarnings(row), false);
  assert.equal(canRefreshAnalytics(row), false);
  assert.equal(canViewTraffic(row), false);
  assert.equal(canRefreshTraffic(row), false);
  assert.equal(canManageTrafficCosts(row), false);
});
