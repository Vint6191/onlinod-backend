"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEAM_CAPABILITIES,
  nestedPermissionValue,
  canUseTeamCapability,
} = require("./team-capabilities");

function v8Db({ customRoles = {}, accessOverrides = {}, permissionOverrides = {} } = {}) {
  return {
    agencyCustomRole: {
      findUnique: async ({ where }) => {
        const key = where?.agencyId_key?.key;
        const role = customRoles[key];
        return role ? { id: `role-${key}`, agencyId: "a", key, label: role.label || key, tone: "amber", description: role.description || "custom", access: role.access || {}, basedOn: role.basedOn || "chatter" } : null;
      },
    },
    agencyRoleOverride: {
      findUnique: async ({ where }) => {
        const key = where?.agencyId_roleKey?.roleKey;
        return accessOverrides[key] ? { access: accessOverrides[key] } : null;
      },
    },
    agencySubPermissionOverride: {
      findMany: async ({ where }) => {
        const key = where?.roleKey;
        return Object.entries(permissionOverrides[key] || {}).map(([subPermKey, value]) => ({ subPermKey, value }));
      },
    },
  };
}

const noOverrides = v8Db();

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
  const prismaClient = v8Db({
    customRoles: { senior_chatter: { label: "Senior Chatter", access: { money: "view", workspace: "view" } } },
    permissionOverrides: { senior_chatter: { [TEAM_CAPABILITIES.RESOLVE_ATTRIBUTION]: true } },
  });
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

test("team analytics view is role-authoritative and custom roles can receive it explicitly", async () => {
  const chatter = { agencyId: "a", role: "OPERATOR", roleKey: "chatter", permissions: {} };
  const manager = { agencyId: "a", role: "MANAGER", roleKey: "manager", permissions: {} };
  assert.equal(await canUseTeamCapability({ member: chatter, key: TEAM_CAPABILITIES.VIEW_ANALYTICS, prismaClient: noOverrides }), false);
  assert.equal(await canUseTeamCapability({ member: manager, key: TEAM_CAPABILITIES.VIEW_ANALYTICS, prismaClient: noOverrides }), true);

  const custom = v8Db({
    customRoles: { qa_supervisor: { label: "QA Supervisor", access: { workspace: "hidden" } } },
    permissionOverrides: { qa_supervisor: { [TEAM_CAPABILITIES.VIEW_ANALYTICS]: true } },
  });
  assert.equal(await canUseTeamCapability({
    member: { agencyId: "a", role: "OPERATOR", roleKey: "qa_supervisor", permissions: {} },
    key: TEAM_CAPABILITIES.VIEW_ANALYTICS,
    prismaClient: custom,
  }), true);
});
