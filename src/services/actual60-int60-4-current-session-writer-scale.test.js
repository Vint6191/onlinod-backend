"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function block(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `missing block ${startNeedle} -> ${endNeedle}`);
  return source.slice(start, end);
}

test("INT60.4 scale: agency retirement revokes only live RefreshSession rows", () => {
  const source = read("src/routes/admin.js");
  const agencyDelete = block(source, 'router.delete("/agencies/:id"', 'router.post("/agencies/:id/restore"');
  assert.match(agencyDelete, /agencyId:\s*before\.id,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*scheduledAt\s*\}/);
  assert.match(agencyDelete, /agencyId:\s*before\.id,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*deletedAt\s*\}/);
});

test("INT60.4 scale: admin account lifecycle writers exclude expired-unrevoked history", () => {
  const source = read("src/routes/admin.js");
  const userPatch = block(source, 'router.patch("/users/:id"', 'router.post("/users/:id/force-logout"');
  assert.match(userPatch, /sessionRevokedAt[\s\S]*userId:\s*before\.id,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*sessionRevokedAt\s*\}/);

  const forceLogout = block(source, 'router.post("/users/:id/force-logout"', 'router.post("/users/:id/reset-password"');
  assert.match(forceLogout, /userId:\s*user\.id,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*now\s*\}/);

  const resetPassword = block(source, 'router.post("/users/:id/reset-password"', 'router.get("/creators"');
  assert.match(resetPassword, /userId:\s*user\.id,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*revokedAt\s*\}/);

  const kickStart = source.indexOf('payload: { reason: req.body?.reason || "admin kick" }');
  assert.ok(kickStart >= 0);
  const kick = source.slice(kickStart, kickStart + 1800);
  assert.match(kick, /sessionRevokedAt[\s\S]*userId:\s*device\.userId,\s*agencyId:\s*device\.agencyId,\s*deviceId:\s*device\.id,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*sessionRevokedAt\s*\}/);
});

test("INT60.4 scale: account recovery, crypto retirement and Team removal mutate only live session rows", () => {
  const authRoute = read("src/routes/auth.js");
  const reset = block(authRoute, 'router.post("/reset-password"', 'module.exports');
  assert.match(reset, /userId:\s*record\.userId,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*revokedAt\s*\}/);

  const crypto = read("src/services/client-e2e-keyring-service.js");
  const retireStart = crypto.indexOf("async function retireCurrentDeviceIdentity");
  assert.ok(retireStart >= 0);
  const retire = crypto.slice(retireStart, retireStart + 9000);
  assert.match(retire, /userId,\s*agencyId,\s*deviceId:\s*id,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*now\s*\}/);

  const team = read("src/services/team-administration-service.js");
  const setStatus = block(team, "async function setMemberStatus", "async function removeMember");
  assert.match(setStatus, /userId:\s*liveTarget\.userId,\s*agencyId,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*deactivatedAt\s*\}/);
  const remove = block(team, "async function removeMember", "async function updateMemberAccessByPlatformAdmin");
  assert.match(remove, /userId:\s*liveTarget\.userId,\s*agencyId,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*deletedAt\s*\}/);
});

test("INT60.4 scale: exact-session revokes may remain history-addressed because id bounds work independently of rotation cardinality", () => {
  const auth = read("src/services/auth-service.js");
  assert.match(auth, /where:\s*\{\s*id:\s*session\.id,\s*revokedAt:\s*null\s*\}/);
  const settings = read("src/services/settings-service.js");
  assert.match(settings, /where:\s*\{\s*id:\s*session\.id,\s*userId,\s*revokedAt:\s*null\s*\}/);
});
