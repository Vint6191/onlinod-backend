"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260827113000_desktop_access_epoch_bootstrap/migration.sql");
const creators = read("src/routes/creators.js");
const admin = read("src/routes/admin.js");
const team = read("src/services/team-administration-service.js");
const invitations = read("src/routes/invitations.js");
const desktopRoute = read("src/routes/desktop.js");
const server = read("src/server.js");

test("D accessEpoch is a durable monotonic AgencyMember field", () => {
  assert.match(schema, /accessEpoch\s+Int\s+@default\(1\)/);
  assert.match(migration, /ALTER TABLE "AgencyMember"[\s\S]*ADD COLUMN "accessEpoch" INTEGER NOT NULL DEFAULT 1/);
});

test("D creator-set changes bump access epoch or revoke scoped access transactionally", () => {
  assert.match(creators, /createCreatorDraft\(\{[\s\S]*beforeCommit: async \(tx\) => \{[\s\S]*bumpAgencyAccessEpoch\(\{ db: tx, agencyId: req\.auth\.agencyId \}\)/);
  assert.match(creators, /router\.delete\("\/:id"[\s\S]*retireCreatorWithinTransaction\(\{/);
  const lifecycle = read("src/services/creator-lifecycle-authority-service.js");
  const scope = read("src/services/creator-access-scope-authority-service.js");
  assert.match(lifecycle, /retireCreatorCurrentAccess\(\{ tx, agencyId: agency, creatorId: creator \}\)/);
  assert.match(scope, /"accessEpoch"=m\."accessEpoch"\+1/);
});

test("D member role, permission, assignment and lifecycle changes increment accessEpoch through canonical Team authority", () => {
  assert.match(admin, /updateMemberAccessByPlatformAdmin\(\{/);
  assert.match(admin, /removeTeamMember\(\{/);
  assert.doesNotMatch(admin, /agencyMember\.delete\(/);
  assert.match(team, /patch\.roleKey !== undefined \|\| creatorScope[\s\S]*accessEpoch: \{ increment: 1 \}/);
  assert.match(team, /const data = \{ accessEpoch: \{ increment: 1 \} \};[\s\S]*if \(permissions !== undefined\) data\.permissions = permissions/);
  assert.match(team, /deactivatedAt, accessEpoch: \{ increment: 1 \}/);
  assert.match(team, /deletedAt, deactivatedAt: deletedAt, accessEpoch: \{ increment: 1 \}/);
  assert.match(invitations, /materializeInvitationMemberWithinTransaction/);
  const invitationMaterializer = team.slice(team.indexOf("async function materializeInvitationMemberWithinTransaction"), team.indexOf("function invitationUrl"));
  assert.match(invitationMaterializer, /assignedCreators,[\s\S]*accessEpoch: \{ increment: 1 \}/);
});

test("D desktop bootstrap is device-bound and mounted once", () => {
  assert.match(desktopRoute, /DESKTOP_BOOTSTRAP_DEVICE_BOUND_TOKEN_REQUIRED/);
  assert.match(desktopRoute, /buildDesktopBootstrap/);
  assert.match(server, /app\.use\("\/api\/desktop", desktopRoutes\)/);
});
