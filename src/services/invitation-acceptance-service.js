"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { runRootCommit, classifyCommitConflict } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { audit } = require("./audit-service");
const {
  cleanFunctions,
  ensureRoleExists,
  lockTeamRoleLifecycle,
  materializeInvitationMemberWithinTransaction,
} = require("./team-administration-service");
const { validateAssignedCreators } = require("./team-access-control");
const { lockTeamControlPlaneTopology, lockLiveTeamControlPlaneCreators } = require("./team-control-plane-authority-service");

const { acquireAuthorizationUserLock } = require("./authorization-session-authority-service");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function invitationFailure(inv, now = new Date()) {
  if (!inv) return { status: 404, code: "INVITE_NOT_FOUND", error: "Invitation not found" };
  if (inv.revokedAt) return { status: 409, code: "INVITE_REVOKED", error: "Invitation was revoked" };
  if (inv.claimedAt) return { status: 409, code: "INVITE_CLAIMED", error: "Invitation already claimed" };
  if (inv.expiresAt < now) return { status: 410, code: "INVITE_EXPIRED", error: "Invitation expired" };
  if (inv.agency?.deletedAt) return { status: 409, code: "AGENCY_DELETED", error: "Agency was deleted" };
  return null;
}


function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function throwInvitationFailure(inv) {
  const failure = invitationFailure(inv);
  if (failure) fail(failure.status, failure.code, failure.error);
}
function assertInvitationEmail(inv, me) {
  if (inv?.email && String(me.email || "").trim().toLowerCase() !== String(inv.email).trim().toLowerCase())
    fail(403, "EMAIL_MISMATCH", "This invitation was sent to a different email address");
}
function assertInvitationAccount(me, verifiedUser) {
  if (!me || me.disabledAt) fail(403, "USER_DISABLED", "Account is unavailable");
  if (!me.emailVerifiedAt) fail(403, "EMAIL_NOT_VERIFIED", "Confirm your email before accepting an invitation");
  if (verifiedUser && (me.id !== verifiedUser.id || me.passwordHash !== verifiedUser.passwordHash || me.email !== verifiedUser.email))
    fail(409, "LOGIN_PRINCIPAL_CHANGED", "Account credentials changed; sign in again");
}
async function claimedInvitationMembership(db, inv, me, allowReplay) {
  if (!allowReplay || !inv?.claimedAt || inv.claimedByUserId !== me.id || inv.revokedAt || inv.agency?.deletedAt) return null;
  assertInvitationEmail(inv, me);
  const member = await db.agencyMember.findFirst({ where: {
    id: inv.claimedMemberId, userId: me.id, agencyId: inv.agencyId, deletedAt: null, deactivatedAt: null,
  } });
  if (!member) fail(409, "INVITE_MEMBERSHIP_UNAVAILABLE", "Invitation was accepted, but the membership is no longer active");
  return { member, restored: false, replayed: true, roleKey: member.roleKey, functions: cleanFunctions(inv.functions), agency: inv.agency };
}
async function invitationAgencyForAccount({ token, user, db = prisma }) {
  const inv = await db.agencyInvitation.findUnique({ where: { tokenHash: sha256(token) }, include: { agency: true } });
  assertInvitationAccount(user, null);
  const replay = await claimedInvitationMembership(db, inv, user, true);
  if (!replay) throwInvitationFailure(inv);
  assertInvitationEmail(inv, user);
  return inv.agency;
}

// Verified account identity is sufficient to accept an invitation. An existing
// membership in some other workspace is not an authentication prerequisite.
async function acceptInvitationForUser({ token, userId, verifiedUser = null, expectedAgencyId = null, allowClaimedReplay = false, db = prisma }) {
    const tokenHash = sha256(token);
    const [inv, me] = await Promise.all([
      db.agencyInvitation.findUnique({ where: { tokenHash }, include: { agency: true } }),
      db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, disabledAt: true, emailVerifiedAt: true, passwordHash: true } }),
    ]);
    assertInvitationAccount(me, verifiedUser);
    if (inv && expectedAgencyId && inv.agencyId !== expectedAgencyId) fail(409, "INVITE_AGENCY_MISMATCH", "The invitation belongs to another agency");
    const replay = await claimedInvitationMembership(db, inv, me, allowClaimedReplay);
    if (replay) return replay;
    throwInvitationFailure(inv);
    assertInvitationEmail(inv, me);

    const result = await runRootCommit(db, async ({ tx }) => {
      await acquireAuthorizationUserLock(tx, { userId });
      await tx.$queryRawUnsafe('SELECT "id" FROM "User" WHERE "id"=$1 FOR SHARE', userId);
      const currentUser = await tx.user.findUnique({ where: { id: userId } });
      assertInvitationAccount(currentUser, verifiedUser);
      const currentInvite = await tx.agencyInvitation.findUnique({ where: { id: inv.id }, include: { agency: true } });
      if (currentInvite && expectedAgencyId && currentInvite.agencyId !== expectedAgencyId) fail(409, "INVITE_AGENCY_MISMATCH", "The invitation belongs to another agency");
      const racedReplay = await claimedInvitationMembership(tx, currentInvite, currentUser, allowClaimedReplay);
      if (racedReplay) return racedReplay;
      assertInvitationEmail(currentInvite, currentUser);
      const currentFailure = invitationFailure(currentInvite, await dbAuthorityNow({ db: tx }));
      if (currentFailure) {
        const error = new Error(currentFailure.error);
        error.status = currentFailure.status;
        error.code = currentFailure.code;
        throw error;
      }

      let roleKey;
      try {
        // Claim is itself a role assignment. Hold the same shared lifecycle
        // capability used by Team Administration until member + invite claim
        // commit, so custom-role deletion cannot race an invitation that was
        // validated just before expiry. Preset roles intentionally no-op here.
        await lockTeamControlPlaneTopology({ tx, agencyId: currentInvite.agencyId });
        await lockTeamRoleLifecycle({ tx, agencyId: currentInvite.agencyId, roleKey: currentInvite.roleKey, mode: "share", agencyAlreadyLocked: true });
        roleKey = await ensureRoleExists({ agencyId: currentInvite.agencyId, roleKey: currentInvite.roleKey, db: tx });
      } catch (lockError) {
        if (classifyCommitConflict(lockError)) throw lockError;
        if (String(lockError?.code || "").startsWith("TEAM_CONTROL_PLANE_")) throw lockError;
        const error = new Error("Invitation role is no longer available");
        error.status = 409;
        error.code = "INVITE_ROLE_STALE";
        throw error;
      }
      if (roleKey === "owner") {
        const error = new Error("Owner membership cannot be granted by invitation");
        error.status = 409;
        error.code = "INVITE_OWNER_FORBIDDEN";
        throw error;
      }

      const creatorScope = await validateAssignedCreators({
        agencyId: currentInvite.agencyId,
        assignedCreators: currentInvite.assignedCreators ?? [],
        db: tx,
      });
      if (!creatorScope.ok) {
        const error = new Error("Invitation contains creators that are no longer available");
        error.status = 409;
        error.code = "INVITE_CREATOR_SCOPE_STALE";
        error.details = { unknownCreatorIds: creatorScope.unknownCreatorIds };
        throw error;
      }
      const creatorLocks = await lockLiveTeamControlPlaneCreators({
        tx,
        agencyId: currentInvite.agencyId,
        creatorIds: creatorScope.normalized?.mode === "scoped" ? creatorScope.normalized.creatorIds : [],
        mode: "share",
      });
      if (creatorLocks.missingCreatorIds.length) {
        const error = new Error("Invitation contains creators that are no longer available");
        error.status = 409;
        error.code = "INVITE_CREATOR_SCOPE_STALE";
        error.details = { unknownCreatorIds: creatorLocks.missingCreatorIds };
        throw error;
      }
      const functions = cleanFunctions(currentInvite.functions);

      const membership = await materializeInvitationMemberWithinTransaction({
        tx,
        agencyId: currentInvite.agencyId,
        userId,
        roleKey,
        displayName: currentInvite.displayName || currentUser.name || null,
        initials: String(currentInvite.displayName || currentUser.name || currentUser.email || "??").trim().slice(0, 2).toUpperCase(),
        commission: currentInvite.commission ?? { kind: "none" },
        assignedCreators: creatorScope.value,
      });
      const member = membership.member;
      const restored = membership.restored;

      await tx.teamMemberFunction.deleteMany({ where: { agencyId: currentInvite.agencyId, memberId: member.id } });
      if (functions.length) {
        await tx.teamMemberFunction.createMany({
          data: functions.map((functionKey) => ({ agencyId: currentInvite.agencyId, memberId: member.id, functionKey })),
          skipDuplicates: true,
        });
      }

      const now = await dbAuthorityNow({ db: tx });
      const claimed = await tx.agencyInvitation.updateMany({
        where: { id: inv.id, agencyId: currentInvite.agencyId, tokenHash, claimedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { claimedAt: now, claimedByUserId: userId, claimedMemberId: member.id },
      });
      if (claimed.count !== 1) {
        const error = new Error("Invitation was claimed, revoked, expired, or reissued while this request was in progress");
        error.status = 409;
        error.code = "INVITE_CHANGED";
        throw error;
      }

      await audit({
        agencyId: currentInvite.agencyId,
        actorUserId: userId,
        action: restored ? "team.invitation.member_restored" : "team.invitation.claimed",
        targetType: "agency_member",
        targetId: member.id,
        metadata: { invitationId: currentInvite.id, roleKey, functions, restored },
        db: tx,
        required: true,
      });

      return { member, restored, roleKey, functions, agency: currentInvite.agency };
    }, { profile: "TEAM_MANAGEMENT", authority: { kind: "INVITATION_CLAIM", agencyId: inv.agencyId, userId }, conflictCode: "INVITE_CONCURRENT_CHANGE" });

    return result;
}

module.exports = { acceptInvitationForUser, invitationAgencyForAccount, invitationFailure };
