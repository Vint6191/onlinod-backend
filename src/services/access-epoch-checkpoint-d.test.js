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

test("D creator-set changes bump access epoch transactionally", () => {
  assert.match(creators, /creatorAccount\.create[\s\S]*bumpAgencyAccessEpoch\(\{ db: tx, agencyId: req\.auth\.agencyId \}\)/);
  assert.match(creators, /status: "DISABLED", deletedAt: removedAt[\s\S]*bumpAgencyAccessEpoch\(\{ db: tx, agencyId: req\.auth\.agencyId \}\)/);
});

test("D member role, permission, assignment and lifecycle changes increment accessEpoch", () => {
  assert.match(admin, /role: input\.role, accessEpoch: \{ increment: 1 \}/);
  assert.match(admin, /permissions: input\.permissions, accessEpoch: \{ increment: 1 \}/);
  assert.match(team, /patch\.roleKey !== undefined \|\| creatorScope[\s\S]*accessEpoch: \{ increment: 1 \}/);
  assert.match(team, /deactivatedAt, accessEpoch: \{ increment: 1 \}/);
  assert.match(team, /deletedAt, deactivatedAt: deletedAt, accessEpoch: \{ increment: 1 \}/);
  assert.match(invitations, /assignedCreators: creatorScope\.value,[\s\S]*accessEpoch: \{ increment: 1 \}/);
});

test("D desktop bootstrap is device-bound and mounted once", () => {
  assert.match(desktopRoute, /DESKTOP_BOOTSTRAP_DEVICE_BOUND_TOKEN_REQUIRED/);
  assert.match(desktopRoute, /buildDesktopBootstrap/);
  assert.match(server, /app\.use\("\/api\/desktop", desktopRoutes\)/);
});
