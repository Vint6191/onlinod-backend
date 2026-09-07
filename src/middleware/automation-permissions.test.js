"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assignedCreatorIds, hasBroadCreatorAccess, canAccessCreator, allowedCreatorScope } = require("./automation-permissions");

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


test("assigned creator scope has no hidden 10k correctness horizon", async () => {
  const ids = Array.from({ length: 10001 }, (_, index) => `creator-${index + 1}`);
  const calls = [];
  const db = {
    creatorAccount: {
      async findMany({ where, take }) {
        const batch = where.id.in;
        calls.push({ size: batch.length, take });
        // Simulate one deleted/nonexistent creator in the middle while keeping
        // the creator beyond the old 10k horizon alive.
        return batch.filter((id) => id !== "creator-5000").map((id) => ({ id }));
      },
    },
  };
  const scope = await allowedCreatorScope({
    agencyId: "agency-1",
    member: { role: "CHATTER", roleKey: "chatter", assignedCreators: ids },
    db,
  });
  assert.equal(scope.broad, false);
  assert.equal(scope.creatorIds.includes("creator-10001"), true);
  assert.equal(scope.creatorIds.includes("creator-5000"), false);
  assert.equal(scope.creatorIds.length, 10000);
  assert.equal(calls.every((call) => call.size <= 500 && call.take === call.size), true);
  assert.equal(calls.length > 1, true);
});
