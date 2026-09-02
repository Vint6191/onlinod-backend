"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("V8 Team Administration schema migration is additive and reversible deactivation is separate from delete", () => {
  const migration = read("prisma/migrations/20260812222000_team_administration_v1/migration.sql");
  const schema = read("prisma/schema.prisma");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "deactivatedAt"/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "functions" JSONB/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN)/i);
  assert.match(schema, /deactivatedAt\s+DateTime\?/);
  assert.match(schema, /functions\s+Json\?/);
});

test("V8 Team routes expose atomic member settings, status, reissue and explicit function compatibility", () => {
  const route = read("src/routes/team.js");
  assert.match(route, /router\.patch\("\/members\/:memberId\/settings"/);
  assert.match(route, /router\.patch\("\/members\/:memberId\/status"/);
  assert.match(route, /router\.post\("\/invitations\/:invitationId\/reissue"/);
  assert.ok(route.includes('router.patch("/members/:memberId/functions"'));
  assert.ok(route.includes('const TEAM_FUNCTION_KEYS = Object.freeze(["CHATTER", "CONTENT", "SUPERVISOR"])'));
});

test("V8 service protects owner, self-removal, creator-scope escalation, session revocation and historical attribution", () => {
  const service = read("src/services/team-administration-service.js");
  assert.match(service, /CANNOT_DEACTIVATE_SELF/);
  assert.match(service, /CANNOT_REMOVE_SELF/);
  assert.match(service, /LAST_OWNER/);
  assert.match(service, /OWNER_MANAGEMENT_REQUIRED/);
  assert.match(service, /CREATOR_SCOPE_ESCALATION/);
  assert.match(service, /ROLE_PRIVILEGE_ESCALATION/);
  assert.match(service, /ROLE_CONFIGURATION_PRIVILEGE_ESCALATION/);
  assert.match(service, /assertRoleConfigurationWithinActor/);
  assert.match(service, /displayName:\s*member\.displayName \|\| null/);
  assert.match(service, /refreshSession\.updateMany/);
  assert.match(service, /historicalAttributionPreserved:\s*true/);
  assert.match(service, /ROLE_IN_USE/);
});

test("invitation claim writes role, creator scope, functions and claimedMemberId in the same transaction", () => {
  const route = read("src/routes/invitations.js");
  assert.match(route, /tx\.teamMemberFunction\.deleteMany/);
  assert.match(route, /tx\.teamMemberFunction\.createMany/);
  assert.match(route, /claimedMemberId:\s*member\.id/);
  assert.match(route, /MEMBER_DEACTIVATED/);
  assert.match(route, /INVITE_CREATOR_SCOPE_STALE/);
  assert.match(route, /ensureRoleExists\(\{ agencyId: currentInvite\.agencyId, roleKey: currentInvite\.roleKey, db: tx \}\)/);
  assert.match(route, /validateAssignedCreators\(\{[\s\S]*assignedCreators: currentInvite\.assignedCreators[\s\S]*db: tx/);
  assert.match(route, /team\.invitation\.claimed[\s\S]*db: tx/);
  assert.match(route, /updateMany\(\{\s*where:\s*\{ id: inv\.id, tokenHash, claimedAt: null, revokedAt: null/s);
});

test("deactivated users are rejected by auth and Team Analytics while removed performers remain historically resolvable", () => {
  const auth = read("src/middleware/auth.js");
  const analyticsRoute = read("src/routes/team-analytics.js");
  const analyticsService = read("src/services/team-analytics-service.js");
  assert.match(auth, /deactivatedAt:\s*null/);
  assert.match(analyticsRoute, /deactivatedAt:\s*null/);
  assert.match(analyticsService, /where:\s*\{ agencyId \}/);
  assert.match(analyticsService, /memberHasHistoricalActivity/);
  assert.match(analyticsService, /status:\s*member\.deletedAt \? "removed"/);
});

test("creator scope is authoritative for creator listing and automation broad access", () => {
  const permissions = read("src/middleware/automation-permissions.js");
  const creators = read("src/routes/creators.js");
  assert.doesNotMatch(permissions, /if \(isSeniorAgencyMember\(member\)\) return true/);
  assert.match(permissions, /role === "OWNER" \|\| roleKey === "owner"/);
  assert.match(creators, /allowedCreatorScope/);
  assert.match(creators, /CREATOR_CREATE_REQUIRES_ALL_SCOPE/);
  assert.match(creators, /requireCreatorAccess/);
  assert.match(creators, /pendingInvitations/);
});


test("V8 role writes are fenced against self-escalation and automation writes use effective permissions", () => {
  const service = read("src/services/team-administration-service.js");
  const automationControl = read("src/routes/automation-control.js");
  const automationStore = read("src/routes/automation-store.js");
  assert.match(service, /ROLE_CONFIGURATION_PRIVILEGE_ESCALATION/);
  assert.match(service, /resolveEffectivePermissions\(\{ member: actorMember, db \}\)/);
  assert.match(automationControl, /automation\.manage/);
  assert.match(automationControl, /automation\.view_logs/);
  assert.match(automationStore, /automation\.manage/);
});

test("invite registration path enforces the same role, creator-scope and function semantics as claim", () => {
  const auth = read("src/routes/auth.js");
  assert.match(auth, /ensureRoleExists\(\{ agencyId: inv\.agencyId, roleKey: inv\.roleKey, db: tx \}\)/);
  assert.match(auth, /validateAssignedCreators\(\{[\s\S]*assignedCreators: inv\.assignedCreators/);
  assert.match(auth, /const functions = cleanFunctions\(inv\.functions\)/);
  assert.match(auth, /tx\.teamMemberFunction\.createMany/);
  assert.match(auth, /tokenHash: hashInviteToken\(inviteToken\)/);
  assert.match(auth, /claimedMemberId: member\.id/);
  assert.match(auth, /team\.invitation\.claimed/);
});

test("auth middleware blocks deactivated memberships without resolving role permissions on every request", () => {
  const auth = read("src/middleware/auth.js");
  assert.match(auth, /deactivatedAt:\s*null/);
  assert.doesNotMatch(auth, /resolveEffectivePermissions/);
  const authRoutes = read("src/routes/auth.js");
  assert.match(authRoutes, /router\.get\("\/me"[\s\S]*resolveEffectivePermissions/);
});

test("V8 role editor mutates only public enforceable controls and preserves hidden legacy role state", () => {
  const service = read("src/services/team-administration-service.js");
  const access = read("src/services/team-access-control.js");
  assert.match(service, /!PUBLIC_PERMISSION_KEY_SET\.has\(permissionKey\)/);
  assert.match(service, /subPermKey:\s*\{ in:\s*\[\.\.\.PUBLIC_PERMISSION_KEYS\] \}/);
  assert.match(service, /const preservedAccess = \{ \.\.\.\(existingAccessOverride\.access \|\| \{\}\) \}/);
  assert.match(service, /PUBLIC_PERMISSION_KEY_SET\.has\(permissionKey\) && detail\.source !== "zone"/);
  assert.match(access, /"content\.manage_vault"/);
  assert.match(access, /"creator_analytics\.refresh"/);
  assert.match(access, /"traffic\.manage_costs"/);
  assert.doesNotMatch(access, /PUBLIC_PERMISSION_KEYS[\s\S]{0,1200}"creatorAnalytics\./);
});

test("V8 legacy invitations fail closed when creator scope is missing", () => {
  const auth = read("src/routes/auth.js");
  const invitations = read("src/routes/invitations.js");
  const service = read("src/services/team-administration-service.js");
  assert.match(auth, /assignedCreators: inv\.assignedCreators \?\? \[\]/);
  assert.doesNotMatch(auth, /assignedCreators: inv\.assignedCreators \?\? "all"/);
  assert.match(invitations, /assignedCreators: currentInvite\.assignedCreators \?\? \[\]/);
  assert.match(invitations, /assignedCreators: inv\.assignedCreators \?\? \[\]/);
  assert.doesNotMatch(invitations, /assignedCreators: (?:currentInvite|inv)\.assignedCreators \?\? "all"/);
  assert.match(service, /creatorAccess: normalizeAssignedCreators\(inv\.assignedCreators \?\? \[\]\)/);
});

test("V8 creator scope is checked before creator mutation handlers and before avatar upload writes a file", () => {
  const creators = read("src/routes/creators.js");
  assert.match(creators, /async function creatorAccessRequired\(req, res, next\)/);
  assert.match(creators, /res\.status\(Number\(error\?\.status\) \|\| 403\)/);
  assert.match(creators, /router\.patch\("\/:id", creatorManagementRequired, creatorAccessRequired/);
  assert.match(creators, /router\.delete\("\/:id", creatorManagementRequired, creatorAccessRequired/);
  assert.match(creators, /router\.post\("\/:id\/complete-connection", creatorManagementRequired, creatorAccessRequired/);
  assert.match(creators, /router\.post\("\/:id\/avatar", creatorManagementRequired, creatorAccessRequired, upload\.single/);
});

test("V8 never creates or reissues OWNER invitations", () => {
  const service = read("src/services/team-administration-service.js");
  const ownerInviteGuards = service.match(/CANNOT_INVITE_OWNER/g) || [];
  assert.ok(ownerInviteGuards.length >= 2, "create and reissue must both reject owner invitations");
  assert.match(service, /reissuableByViewer: client\.roleKey !== "owner"/);
});

test("V20.19 owner demotion, deactivation and removal revoke owner-root distribution in the same team transaction", () => {
  const service = read("src/services/team-administration-service.js");
  assert.match(service, /revokeOwnerRootAccessForMember/);
  assert.match(service, /const liveOwnerDemoted = isOwner\(liveTarget\) && nextRoleKey !== "owner"/);
  assert.match(service, /if \(liveOwnerDemoted\)[\s\S]*revokeOwnerRootAccessForMember/);
  assert.match(service, /status === "deactivated"[\s\S]*revokeOwnerRootAccessForMember/);
  assert.match(service, /deletedAt, deactivatedAt: deletedAt[\s\S]*revokeOwnerRootAccessForMember/);
});
