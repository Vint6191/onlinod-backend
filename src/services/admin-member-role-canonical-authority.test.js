"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const admin = fs.readFileSync(path.join(__dirname, "../routes/admin.js"), "utf8");

function range(start, end) {
  const a = admin.indexOf(start);
  const b = admin.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing ${start}`);
  return admin.slice(a, b);
}

test("super-admin legacy role mutation writes canonical roleKey in the same accessEpoch update", () => {
  assert.match(admin, /function canonicalMemberRoleKeyFromLegacy/);
  assert.match(admin, /OWNER"\) return "owner"/);
  assert.match(admin, /ADMIN" \|\| value === "MANAGER"\) return "manager"/);
  const body = range('router.patch("/members/:memberId/role"', 'const memberPermsSchema');
  assert.match(body, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(body, /lockAgencyPipelineLifecycle\(\{ db: tx, agencyId: snapshot\.agencyId, allowDeleted: true \}\)/);
  assert.match(body, /role: input\.role,[\s\S]*roleKey: canonicalMemberRoleKeyFromLegacy\(input\.role\),[\s\S]*accessEpoch: \{ increment: 1 \}/);
});

test("super-admin last-owner guards recognize both canonical and legacy owner generations", () => {
  assert.match(admin, /function memberIsCanonicalOwner/);
  for (const body of [
    range('router.patch("/members/:memberId/role"', 'const memberPermsSchema'),
    range('router.delete("/members/:memberId"', '// ════════════════════════════════════════════════════════════\n// USERS'),
  ]) {
    assert.match(body, /memberIsCanonicalOwner\(before\)/);
    assert.match(body, /deletedAt: null/);
    assert.match(body, /deactivatedAt: null/);
    assert.match(body, /OR: \[\{ role: "OWNER" \}, \{ roleKey: "owner" \}\]/);
  }
});
