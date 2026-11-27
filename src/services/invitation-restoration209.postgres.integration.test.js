"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

test("PostgreSQL: a fresh invitation restores identity with only its new grants; replay cannot reactivate it", { skip: !enabled }, async () => {
  const db = require("../prisma");
  const team = require("./team-administration-service");
  const { acceptInvitationForUser } = require("./invitation-acceptance-service");
  const { assertTeamControlPlaneWriteAdmission } = require("./database-write-contract-service");
  const { cleanupAgencyFixture } = require("../../scripts/test-support/phase2-postgres-integration-authority");
  const agencyId = "invite209-" + randomUUID(), ownerId = agencyId + "-owner", userId = agencyId + "-member";
  const token = randomUUID(), tokenHash = createHash("sha256").update(token).digest("hex");
  let owner, member, invitation;
  try {
    await db.$transaction(async tx => {
      await assertTeamControlPlaneWriteAdmission(tx);
      await tx.agency.create({ data: { id: agencyId, name: "Invitation restoration regression" } });
      for (const id of [ownerId, userId]) await tx.user.create({ data: { id, email: id + "@example.test", passwordHash: "synthetic", emailVerifiedAt: new Date() } });
      owner = await tx.agencyMember.create({ data: { agencyId, userId: ownerId, role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
      member = await tx.agencyMember.create({ data: { agencyId, userId, role: "MANAGER", roleKey: "manager", assignedCreators: "all",
        permissions: { "workspace.manage_members": true, "creators.manage": true, "money.view_earnings": true } } });
    });
    await team.removeMember({ agencyId, memberId: member.id, expectedRevision: member.editRevision, actorMember: owner, actorUserId: ownerId, db });
    await db.$transaction(async tx => {
      await assertTeamControlPlaneWriteAdmission(tx);
      invitation = await tx.agencyInvitation.create({ data: { agencyId, invitedByUserId: ownerId, email: userId + "@example.test", tokenHash,
        roleKey: "chatter", assignedCreators: [], functions: ["CHATTER"], expiresAt: new Date(Date.now() + 3600_000) } });
    });
    const accepted = await acceptInvitationForUser({ token, userId, allowClaimedReplay: true, db });
    assert.equal(accepted.restored, true); assert.equal(accepted.member.id, member.id);
    assert.equal(accepted.member.roleKey, "chatter"); assert.deepEqual(accepted.member.permissions, {});
    assert.deepEqual(accepted.member.assignedCreators, []);
    const effective = await team.resolveEffectivePermissions({ member: accepted.member, db });
    for (const key of ["workspace.manage_members", "creators.manage", "money.view_earnings"]) assert.equal(effective[key], false, key);
    assert.equal(await db.agencyMember.count({ where: { agencyId, userId } }), 1);

    // A receipt replay reads current membership; it must not reset legitimate
    // changes made after the accepted invitation, even after invite expiration.
    await db.$transaction(async tx => {
      await assertTeamControlPlaneWriteAdmission(tx);
      await tx.agencyInvitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await tx.agencyMember.update({ where: { id: member.id }, data: { permissions: { "workspace.manage_schedule": true }, accessEpoch: { increment: 1 } } });
    });
    const replay = await acceptInvitationForUser({ token, userId, allowClaimedReplay: true, db });
    assert.equal(replay.replayed, true); assert.equal(replay.member.id, member.id);
    assert.deepEqual(replay.member.permissions, { "workspace.manage_schedule": true });
    await assert.rejects(() => acceptInvitationForUser({ token, userId: ownerId, allowClaimedReplay: true, db }), { code: "INVITE_CLAIMED" });
    await team.setMemberStatus({ agencyId, memberId: member.id, status: "deactivated", expectedRevision: replay.member.editRevision, actorMember: owner, actorUserId: ownerId, db });
    await assert.rejects(() => acceptInvitationForUser({ token, userId, allowClaimedReplay: true, db }), { code: "INVITE_MEMBERSHIP_UNAVAILABLE" });
  } finally {
    try { await cleanupAgencyFixture(db, { agencyId, userIds: [ownerId, userId] }); }
    finally { await db.$disconnect(); }
  }
});
