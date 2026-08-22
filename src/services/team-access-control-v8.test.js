"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEAM_FUNCTION_KEYS,
  normalizeAssignedCreators,
  resolveRoleDefinition,
  resolveEffectivePermissions,
  publicPermissionZones,
} = require("./team-access-control");

function db(overrides = {}) {
  return {
    agencyCustomRole: { findUnique: async () => null },
    agencyRoleOverride: { findUnique: async () => null },
    agencySubPermissionOverride: { findMany: async () => [] },
    ...overrides,
  };
}

test("V8 keeps performance functions explicit and creator scopes deterministic", () => {
  assert.deepEqual(TEAM_FUNCTION_KEYS, ["CHATTER", "CONTENT", "SUPERVISOR"]);
  assert.deepEqual(normalizeAssignedCreators("all"), { mode: "all", creatorIds: [] });
  assert.deepEqual(normalizeAssignedCreators(["a", "a", "b"]), { mode: "scoped", creatorIds: ["a", "b"] });
  assert.deepEqual(normalizeAssignedCreators({ mode: "scoped", creatorIds: ["x"] }), { mode: "scoped", creatorIds: ["x"] });
});

test("owner is locked and always receives all known permissions", async () => {
  const role = await resolveRoleDefinition({ agencyId: "a", roleKey: "owner", db: db() });
  assert.equal(role.locked, true);
  assert.equal(role.access.creators, "all");
  assert.ok(Object.values(role.permissions).every(Boolean));
});

test("preset role overrides and granular overrides are resolved server-side", async () => {
  const mock = db({
    agencyRoleOverride: { findUnique: async () => ({ access: { money: "full" } }) },
    agencySubPermissionOverride: { findMany: async () => [{ subPermKey: "money.override_attribution", value: true }] },
  });
  const role = await resolveRoleDefinition({ agencyId: "a", roleKey: "manager", db: mock });
  assert.equal(role.access.money, "full");
  assert.equal(role.permissions["money.override_attribution"], true);
  assert.equal(role.permissionDetails["money.override_attribution"].source, "override");
});

test("direct member override wins over role but does not infer Team function", async () => {
  const permissions = await resolveEffectivePermissions({
    member: { agencyId: "a", roleKey: "chatter", role: "OPERATOR", permissions: { "chats.reply": false, "team.analytics.view": true } },
    db: db(),
  });
  assert.equal(permissions["chats.reply"], false);
  assert.equal(permissions["team.analytics.view"], true);
  assert.equal(Object.prototype.hasOwnProperty.call(permissions, "CHATTER"), false);
});


test("V8 does not expose unenforced Browser chat switches as fake permissions", () => {
  const zones = publicPermissionZones();
  assert.equal(zones.some((zone) => zone.key === "chats"), false);
  assert.ok(zones.some((zone) => zone.key === "workspace"));
  assert.ok(zones.some((zone) => zone.key === "automation"));
});

test("V8 only exposes enforceable Content/Automation/Creator controls", () => {
  const zones = publicPermissionZones();
  const content = zones.find((zone) => zone.key === "content");
  const automation = zones.find((zone) => zone.key === "automation");
  const creators = zones.find((zone) => zone.key === "creators");

  assert.equal(content?.label, "Content");
  assert.deepEqual(content?.levels, []);
  assert.deepEqual(content?.permissions.map((permission) => permission.key), ["content.review_customs", "message_library.manage"]);
  assert.equal(content?.permissions.some((permission) => permission.key === "content.manage"), false);
  assert.equal(content?.permissions.some((permission) => permission.key === "content.manage_vault"), false);
  assert.equal(content?.permissions.some((permission) => permission.key === "content.delete_posts"), false);

  assert.deepEqual(automation?.levels, []);
  assert.deepEqual(automation?.permissions.map((permission) => permission.key).sort(), ["automation.manage", "automation.view_logs"].sort());

  assert.deepEqual(creators?.levels, []);
  assert.deepEqual(creators?.permissions.map((permission) => permission.key), ["creators.manage"]);
});
