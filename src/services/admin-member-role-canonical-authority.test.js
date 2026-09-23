"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const owner = fs.readFileSync(path.join(__dirname, "admin-operational-command-service.js"), "utf8");
const admin = fs.readFileSync(path.join(__dirname, "../routes/admin.js"), "utf8");

function range(start, end) {
  const a = admin.indexOf(start);
  const b = admin.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing ${start}`);
  return admin.slice(a, b);
}

test("super-admin legacy role mutation delegates canonical role/access semantics to Team authority", () => {
  assert.match(admin, /function canonicalMemberRoleKeyFromLegacy/);
  assert.match(admin, /OWNER"\) return "owner"/);
  assert.match(admin, /ADMIN" \|\| value === "MANAGER"\) return "manager"/);
  const body = range('router.patch("/members/:memberId/role"', 'const memberPermsSchema');
  assert.match(body, /operationHandler\("member.role.set"/);
  assert.match(owner, /updateMemberAccessByPlatformAdmin\(\{/);
  assert.match(owner, /legacyRole:input\.role/);
  assert.match(owner, /input\.role==="OWNER"\?"owner"/);
  assert.match(owner, /\["ADMIN","MANAGER"\]\.includes\(input\.role\)\?"manager":"chatter"/);
  assert.doesNotMatch(body, /agencyMember\.update|agencyMember\.delete/);
});

test("super-admin member removal and role changes share canonical owner-safety and retention authority", () => {
  const team = fs.readFileSync(path.join(__dirname, "team-administration-service.js"), "utf8");
  const roleBody = range('router.patch("/members/:memberId/role"', 'const memberPermsSchema');
  const deleteBody = range('router.delete("/members/:memberId"', '// ════════════════════════════════════════════════════════════\n// USERS');
  assert.match(roleBody, /operationHandler\("member.role.set"/);
  assert.match(deleteBody, /operationHandler\("member.remove"/);
  assert.match(owner, /removeMember\(\{[\s\S]*platformAdmin:\s*true/);
  assert.doesNotMatch(deleteBody, /agencyMember\.delete/);
  assert.match(team, /lockTeamControlPlaneTopology/);
  assert.doesNotMatch(team, /team-owner-safety:/);
  assert.match(team, /assertOwnerSafety/);
  assert.match(team, /deletedAt, deactivatedAt: deletedAt, accessEpoch: \{ increment: 1 \}/);
  assert.match(team, /historicalAttributionPreserved:\s*true/);
});
