"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hasBroadCreatorAccess, canAccessCreator } = require("../middleware/automation-permissions");
const { canManageCreators } = require("../middleware/creator-management-permissions");

test("manager privilege no longer bypasses an explicit creator scope", () => {
  const manager = { role: "MANAGER", roleKey: "manager", assignedCreators: ["creator-a"] };
  assert.equal(hasBroadCreatorAccess(manager), false);
  assert.equal(canAccessCreator(manager, "creator-a"), true);
  assert.equal(canAccessCreator(manager, "creator-b"), false);
});

test("owner remains broad and explicit all remains broad for non-owner roles", () => {
  assert.equal(hasBroadCreatorAccess({ role: "OWNER", assignedCreators: [] }), true);
  assert.equal(hasBroadCreatorAccess({ role: "OPERATOR", roleKey: "chatter", assignedCreators: "all" }), true);
});


test("an explicit creators.manage deny beats the legacy manager shortcut", () => {
  assert.equal(canManageCreators({ role: "MANAGER", roleKey: "manager", permissions: { "creators.manage": false } }), false);
  assert.equal(canManageCreators({ role: "OPERATOR", roleKey: "chatter", permissions: { "creators.manage": true } }), true);
});

test("device-side services keep creator scope authoritative and reject deactivated membership", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "../..");
  const lease = fs.readFileSync(path.join(root, "src/services/job-lease-service.js"), "utf8");
  const delivery = fs.readFileSync(path.join(root, "src/services/automation-action-delivery-service.js"), "utf8");
  const workspace = fs.readFileSync(path.join(root, "src/routes/workspace.js"), "utf8");
  assert.match(lease, /deactivatedAt:\s*null/);
  assert.match(delivery, /deactivatedAt:\s*null/);
  assert.match(lease, /normalizeAssignedCreators/);
  assert.match(delivery, /normalizeAssignedCreators/);
  assert.doesNotMatch(lease, /roleKey === "manager"/);
  assert.doesNotMatch(delivery, /\["owner", "manager", "admin"\]\.includes/);
  assert.match(workspace, /deactivatedAt:\s*null/);
  assert.doesNotMatch(workspace, /roleKey === "manager"/);
});
