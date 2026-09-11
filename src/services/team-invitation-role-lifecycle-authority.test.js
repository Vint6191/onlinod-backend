"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, rel), "utf8");
}

function assertBefore(text, left, right, message) {
  const a = text.indexOf(left);
  const b = text.indexOf(right);
  assert.ok(a >= 0, `missing ${left}`);
  assert.ok(b >= 0, `missing ${right}`);
  assert.ok(a < b, message || `${left} must precede ${right}`);
}

const team = read("team-administration-service.js");
const agencyLifecycle = read("agency-lifecycle-barrier-service.js");
const invitations = read("../routes/invitations.js");
const auth = read("../routes/auth.js");

test("role lifecycle fence is exported as the shared assignment capability with an exclusive writer mode", () => {
  assert.match(team, /async function lockTeamRoleLifecycle/);
  assert.match(team, /lockAgencyLifecycleBarrier\(\{ db: tx, agencyId, mode: "shared" \}\)/);
  assert.match(team, /team-role-lifecycle:/);
  assert.match(team, /mode: write \? "exclusive" : "shared"/);
  assert.match(team, /const rowLock = write \? "FOR UPDATE" : "FOR SHARE"/);
  assert.match(agencyLifecycle, /normalizedMode === "exclusive" \? " FOR UPDATE" : ""/);
  assert.doesNotMatch(agencyLifecycle, /"FOR SHARE"/);
  assert.match(agencyLifecycle, /FROM "Agency" WHERE "id" = \$1/);
  assert.match(team, /\n\s*lockTeamRoleLifecycle,\n/);
});

test("authenticated invitation claim holds custom-role lifecycle through member assignment and claim CAS", () => {
  const start = invitations.indexOf('router.post("/claim"');
  assert.ok(start >= 0, "claim route missing");
  const body = invitations.slice(start);
  assert.match(body, /lockTeamRoleLifecycle\(\{ tx, agencyId: currentInvite\.agencyId, roleKey: currentInvite\.roleKey, mode: "share" \}\)/);
  assertBefore(body, "lockTeamRoleLifecycle", "ensureRoleExists", "role must be fenced before role resolution");
  assertBefore(body, "lockTeamRoleLifecycle", "materializeInvitationMemberWithinTransaction", "role fence must precede canonical member materialization");
  assert.match(team, /materializeInvitationMemberWithinTransaction[\s\S]*AgencyMember" WHERE "agencyId"=\$1 AND "userId"=\$2 FOR UPDATE/);
  assert.match(team, /materializeInvitationMemberWithinTransaction[\s\S]*agencyMember\.update/);
  assert.match(team, /materializeInvitationMemberWithinTransaction[\s\S]*agencyMember\.create/);
  assertBefore(body, "lockTeamRoleLifecycle", "agencyInvitation.updateMany", "role fence must remain held through claim CAS");
});

test("registration invitation claim uses the same custom-role lifecycle capability", () => {
  const start = auth.indexOf('router.post("/register"');
  const end = auth.indexOf('router.post("/login"', start);
  assert.ok(start >= 0 && end > start, "register route range missing");
  const body = auth.slice(start, end);
  assert.match(body, /lockTeamRoleLifecycle\(\{ tx, agencyId: inv\.agencyId, roleKey: inv\.roleKey, mode: "share" \}\)/);
  assertBefore(body, "lockTeamRoleLifecycle", "ensureRoleExists", "registration must fence the role before resolution");
  assertBefore(body, "lockTeamRoleLifecycle", "materializeInvitationMemberWithinTransaction", "registration must hold role fence before canonical member materialization");
  assertBefore(body, "lockTeamRoleLifecycle", "agencyInvitation.updateMany", "registration must hold role fence through invitation claim CAS");
});

