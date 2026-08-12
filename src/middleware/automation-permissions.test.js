"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assignedCreatorIds, hasBroadCreatorAccess, canAccessCreator } = require("./automation-permissions");

test("creator scope is authoritative even for manager roles; only owner is inherently broad", () => {
  assert.equal(hasBroadCreatorAccess({ role: "OWNER", assignedCreators: [] }), true);
  assert.equal(hasBroadCreatorAccess({ roleKey: "manager", assignedCreators: ["a"] }), false);
  assert.equal(hasBroadCreatorAccess({ roleKey: "manager", assignedCreators: "all" }), true);
});

test("assigned creator JSON variants are normalized", () => {
  assert.deepEqual(assignedCreatorIds({ assignedCreators: ["a", 2] }), ["a", "2"]);
  assert.deepEqual(assignedCreatorIds({ assignedCreators: { creatorIds: ["x"] } }), ["x"]);
  assert.equal(canAccessCreator({ role: "CHATTER", assignedCreators: ["x"] }, "x"), true);
  assert.equal(canAccessCreator({ role: "CHATTER", assignedCreators: ["x"] }, "y"), false);
});
