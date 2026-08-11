"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEAM_CAPABILITIES,
  nestedPermissionValue,
  canUseTeamCapability,
} = require("./team-capabilities");

const noOverrides = { agencySubPermissionOverride: { findUnique: async () => null } };

test("Team capabilities support flat and nested explicit permissions", () => {
  assert.equal(nestedPermissionValue({ "money.resolve_attribution": true }, "money.resolve_attribution"), true);
  assert.equal(nestedPermissionValue({ money: { resolve_attribution: false } }, "money.resolve_attribution"), false);
  assert.equal(nestedPermissionValue({}, "money.resolve_attribution"), null);
});

test("owner remains recovery-capable even if an explicit false is present", async () => {
  const allowed = await canUseTeamCapability({
    member: { agencyId: "a", role: "OWNER", roleKey: "owner", permissions: { "money.resolve_attribution": false } },
    key: TEAM_CAPABILITIES.RESOLVE_ATTRIBUTION,
    prismaClient: noOverrides,
  });
  assert.equal(allowed, true);
});

test("custom role can receive attribution resolution without being named manager", async () => {
  const prismaClient = {
    agencySubPermissionOverride: {
      findUnique: async ({ where }) => {
        assert.equal(where.agencyId_roleKey_subPermKey.roleKey, "senior_chatter");
        return { value: true };
      },
    },
  };
  const allowed = await canUseTeamCapability({
    member: { agencyId: "a", role: "OPERATOR", roleKey: "senior_chatter", permissions: {} },
    key: TEAM_CAPABILITIES.RESOLVE_ATTRIBUTION,
    prismaClient,
  });
  assert.equal(allowed, true);
});

test("explicit false overrides manager default for dangerous attribution actions", async () => {
  const allowed = await canUseTeamCapability({
    member: { agencyId: "a", role: "MANAGER", roleKey: "manager", permissions: { "money.override_attribution": false } },
    key: TEAM_CAPABILITIES.OVERRIDE_ATTRIBUTION,
    prismaClient: noOverrides,
  });
  assert.equal(allowed, false);
});

test("ordinary chatter keeps own claim/release but cannot resolve agency-wide conflicts", async () => {
  const member = { agencyId: "a", role: "OPERATOR", roleKey: "chatter", permissions: {} };
  assert.equal(await canUseTeamCapability({ member, key: TEAM_CAPABILITIES.CLAIM_OWN, prismaClient: noOverrides }), true);
  assert.equal(await canUseTeamCapability({ member, key: TEAM_CAPABILITIES.RELEASE_OWN, prismaClient: noOverrides }), true);
  assert.equal(await canUseTeamCapability({ member, key: TEAM_CAPABILITIES.RESOLVE_ATTRIBUTION, prismaClient: noOverrides }), false);
});
