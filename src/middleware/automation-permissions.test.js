"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assignedCreatorIds, hasBroadCreatorAccess, canAccessCreator } = require("./automation-permissions");

test("senior automation roles have broad creator access", () => {
  assert.equal(hasBroadCreatorAccess({ role: "OWNER", assignedCreators: [] }), true);
  assert.equal(hasBroadCreatorAccess({ roleKey: "manager", assignedCreators: ["a"] }), true);
});

test("assigned creator JSON variants are normalized", () => {
  assert.deepEqual(assignedCreatorIds({ assignedCreators: ["a", 2] }), ["a", "2"]);
  assert.deepEqual(assignedCreatorIds({ assignedCreators: { creatorIds: ["x"] } }), ["x"]);
  assert.equal(canAccessCreator({ role: "CHATTER", assignedCreators: ["x"] }, "x"), true);
  assert.equal(canAccessCreator({ role: "CHATTER", assignedCreators: ["x"] }, "y"), false);
});
