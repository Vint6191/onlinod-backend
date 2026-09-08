"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "team-administration-service.js"), "utf8");

function bodyBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source range ${startMarker}`);
  return source.slice(start, end);
}

function assertBefore(text, left, right, message) {
  const a = text.indexOf(left);
  const b = text.indexOf(right);
  assert.ok(a >= 0 && b >= 0 && a < b, message || `${left} must precede ${right}`);
}

test("role permission/access writes bump affected member accessEpoch inside the same transaction", () => {
  for (const [start, end] of [
    ["async function setRoleAccess", "async function setRolePermission"],
    ["async function setRolePermission", "async function resetRole"],
    ["async function resetRole", "async function deleteCustomRole"],
  ]) {
    const body = bodyBetween(start, end);
    assert.match(body, /db\.\$transaction\(async \(tx\) =>/);
    assert.match(body, /bumpLiveRoleMemberAccessEpochs\(\{ tx, agencyId, roleKey: key \}\)/);
    assertBefore(body, "bumpLiveRoleMemberAccessEpochs", "publishRoleMemberAccessEpochs", "epoch invalidation must commit before publication");
  }
});

test("role epoch fence covers active explicit and legacy preset members", () => {
  const body = bodyBetween("function liveRoleMemberWhere", "async function accessibleCreatorIdsForMember");
  assert.match(body, /key === "manager"[\s\S]*\["ADMIN", "MANAGER"\]/);
  assert.match(body, /key === "chatter"[\s\S]*\["OPERATOR"\]/);
  assert.match(body, /\{ roleKey: key \}/);
  assert.match(body, /\{ roleKey: null, role: \{ in: legacyRoles \} \}/);
  assert.match(body, /deletedAt:\s*null/);
  assert.match(body, /deactivatedAt:\s*null/);
  assert.match(body, /accessEpoch:\s*\{ increment: 1 \}/);
});

test("post-commit ACCESS_EPOCH_CHANGED targets every affected member and carries actor device context", () => {
  const helper = bodyBetween("function publishRoleMemberAccessEpochs", "async function accessibleCreatorIdsForMember");
  assert.match(helper, /publishMemberAccessEpoch\(\{ agencyId, member, sourceDeviceId \}\)/);
  for (const [start, end] of [
    ["async function setRoleAccess", "async function setRolePermission"],
    ["async function setRolePermission", "async function resetRole"],
    ["async function resetRole", "async function deleteCustomRole"],
  ]) {
    const body = bodyBetween(start, end);
    assert.match(body, /actorDeviceId = null/);
    assert.match(body, /sourceDeviceId: actorDeviceId/);
  }
});


test("role lifecycle serializes assignment/invites against configuration writers and deletion", () => {
  const helper = bodyBetween("async function lockTeamRoleLifecycle", "async function bumpLiveRoleMemberAccessEpochs");
  assert.match(helper, /FOR UPDATE/);
  assert.match(helper, /FOR SHARE/);
  assert.match(helper, /AgencyCustomRole/);
  assert.match(helper, /SELECT "id", "deletedAt" FROM "Agency"/);
  assertBefore(helper, 'FROM "Agency"', 'FROM "AgencyCustomRole"', "stable Agency role root must be locked before custom role row");

  const memberMutation = bodyBetween("async function updateMemberSettings", "async function setMemberStatus");
  const memberCommit = memberMutation.slice(memberMutation.indexOf("serializableTeamTransaction"));
  assert.match(memberCommit, /lockTeamRoleLifecycle\(\{ tx, agencyId, roleKey: nextRoleKey, mode: "share" \}\)/);
  assertBefore(memberCommit, "lockTeamRoleLifecycle", "assertActorCanAssignRole", "role existence must stay locked through member assignment");

  const statusMutation = bodyBetween("async function setMemberStatus", "async function removeMember");
  assert.match(statusMutation, /status !== "deactivated"[\s\S]*lockTeamRoleLifecycle\(\{ tx, agencyId, roleKey: memberRoleKey\(liveTarget\), mode: "share" \}\)/);

  const inviteMutation = bodyBetween("async function createInvitation", "async function reissueInvitation");
  assert.match(inviteMutation, /serializableTeamTransaction/);
  assert.match(inviteMutation, /lockTeamRoleLifecycle\(\{ tx, agencyId, roleKey, mode: "share" \}\)/);
  assertBefore(inviteMutation, "lockTeamRoleLifecycle", "agencyInvitation.create", "role lifecycle fence must precede invitation creation");

  const reissueMutation = bodyBetween("async function reissueInvitation", "async function revokeInvitation");
  assert.match(reissueMutation, /serializableTeamTransaction/);
  assert.match(reissueMutation, /lockTeamRoleLifecycle\(\{ tx, agencyId, roleKey: inv.roleKey, mode: "share" \}\)/);
  assertBefore(reissueMutation, "lockTeamRoleLifecycle", "agencyInvitation.update", "role lifecycle fence must precede invitation revival");

  for (const [start, end] of [
    ["async function setRoleAccess", "async function setRolePermission"],
    ["async function setRolePermission", "async function resetRole"],
  ]) {
    const body = bodyBetween(start, end);
    assert.match(body, /lockTeamRoleLifecycle\(\{ tx, agencyId, roleKey: key, mode: "update" \}\)/);
  }

  const reset = bodyBetween("async function resetRole", "async function deleteCustomRole");
  assert.match(reset, /lockTeamRoleLifecycle\(\{ tx, agencyId, roleKey: key, mode: "update" \}\)/);

  const metadata = bodyBetween("async function updateRoleMetadata", "async function setRoleAccess");
  assert.match(metadata, /serializableTeamTransaction/);
  assert.match(metadata, /lockTeamRoleLifecycle\(\{ tx, agencyId, roleKey: key, mode: "update" \}\)/);

  const deletion = bodyBetween("async function deleteCustomRole", "module.exports = {");
  assert.match(deletion, /serializableTeamTransaction/);
  assert.match(deletion, /lockTeamRoleLifecycle\(\{ tx, agencyId, roleKey: key, mode: "update" \}\)/);
  assertBefore(deletion, "lockTeamRoleLifecycle", "agencyMember.count", "delete must own the role lifecycle before checking users");
  assertBefore(deletion, "agencyMember.count", "agencyCustomRole.delete", "delete must recheck usage before removing the role");
});
