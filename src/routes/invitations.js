"use strict";

const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { audit } = require("../services/audit-service");
const {
  cleanFunctions,
  ensureRoleExists,
  roleKeyToLegacy,
} = require("../services/team-administration-service");
const { validateAssignedCreators } = require("../services/team-access-control");

const router = express.Router();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function actorUserId(req) {
  return req.auth?.userId || req.user?.id || null;
}

function invitationFailure(inv, now = new Date()) {
  if (!inv) return { status: 404, code: "INVITE_NOT_FOUND", error: "Invitation not found" };
  if (inv.revokedAt) return { status: 409, code: "INVITE_REVOKED", error: "Invitation was revoked" };
  if (inv.claimedAt) return { status: 409, code: "INVITE_CLAIMED", error: "Invitation already claimed" };
  if (inv.expiresAt < now) return { status: 410, code: "INVITE_EXPIRED", error: "Invitation expired" };
  if (inv.agency?.deletedAt) return { status: 409, code: "AGENCY_DELETED", error: "Agency was deleted" };
  return null;
}

router.get("/preview/:token", async (req, res) => {
  try {
    const inv = await prisma.agencyInvitation.findUnique({
      where: { tokenHash: sha256(req.params.token) },
      include: { agency: { select: { id: true, name: true, deletedAt: true } } },
    });
    const failure = invitationFailure(inv);
    if (failure) return res.status(failure.status).json({ ok: false, code: failure.code, error: failure.error });

    return res.json({
      ok: true,
      invitation: {
        agency: { id: inv.agency.id, name: inv.agency.name },
        email: inv.email,
        roleKey: inv.roleKey,
        displayName: inv.displayName,
        functions: cleanFunctions(inv.functions),
        assignedCreators: inv.assignedCreators ?? [],
        expiresAt: inv.expiresAt,
      },
    });
  } catch (error) {
    console.error("[invitations/preview] failed:", error);
    return res.status(500).json({ ok: false, code: "INVITE_PREVIEW_FAILED", error: "Failed to preview invitation" });
  }
});

const claimSchema = z.object({ token: z.string().min(10).max(512) }).strict();

router.post("/claim", authRequired, async (req, res) => {
  try {
    const userId = actorUserId(req);
    if (!userId) return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "Login required to claim invitation" });

    const input = claimSchema.parse(req.body || {});
    const tokenHash = sha256(input.token);
    const [inv, me] = await Promise.all([
      prisma.agencyInvitation.findUnique({ where: { tokenHash }, include: { agency: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } }),
    ]);
    const failure = invitationFailure(inv);
    if (failure) return res.status(failure.status).json({ ok: false, code: failure.code, error: failure.error });
    if (!me) return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "User no longer exists" });

    if (inv.email && String(me.email || "").toLowerCase() !== String(inv.email).toLowerCase()) {
      return res.status(403).json({ ok: false, code: "EMAIL_MISMATCH", error: "This invitation was sent to a different email address" });
    }

    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const currentInvite = await tx.agencyInvitation.findUnique({ where: { id: inv.id }, include: { agency: true } });
      const currentFailure = invitationFailure(currentInvite, now);
      if (currentFailure) {
        const error = new Error(currentFailure.error);
        error.status = currentFailure.status;
        error.code = currentFailure.code;
        throw error;
      }

      let roleKey;
      try {
        roleKey = await ensureRoleExists({ agencyId: currentInvite.agencyId, roleKey: currentInvite.roleKey, db: tx });
      } catch (_) {
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
      const functions = cleanFunctions(currentInvite.functions);

      const existing = await tx.agencyMember.findUnique({ where: { agencyId_userId: { agencyId: inv.agencyId, userId } } });
      let member;
      let restored = false;

      if (existing && !existing.deletedAt) {
        const error = new Error(existing.deactivatedAt
          ? "Your membership is deactivated. A manager must reactivate it before you can sign in."
          : "You are already a member of this agency");
        error.status = 409;
        error.code = existing.deactivatedAt ? "MEMBER_DEACTIVATED" : "ALREADY_MEMBER";
        error.details = { memberId: existing.id };
        throw error;
      }

      if (existing?.deletedAt) {
        member = await tx.agencyMember.update({
          where: { id: existing.id },
          data: {
            deletedAt: null,
            deactivatedAt: null,
            roleKey,
            role: roleKeyToLegacy(roleKey),
            displayName: currentInvite.displayName || existing.displayName || me.name || null,
            assignedCreators: creatorScope.value,
            commission: currentInvite.commission ?? existing.commission ?? { kind: "none" },
            lastSeenLabel: "just rejoined",
          },
        });
        restored = true;
      } else {
        const initials = String(currentInvite.displayName || me.name || me.email || "??").trim().slice(0, 2).toUpperCase();
        member = await tx.agencyMember.create({
          data: {
            agencyId: currentInvite.agencyId,
            userId,
            role: roleKeyToLegacy(roleKey),
            roleKey,
            displayName: currentInvite.displayName || me.name || null,
            initials,
            tone: "amber",
            commission: currentInvite.commission || { kind: "none" },
            assignedCreators: creatorScope.value,
            lastSeenLabel: "just joined",
          },
        });
      }

      await tx.teamMemberFunction.deleteMany({ where: { agencyId: currentInvite.agencyId, memberId: member.id } });
      if (functions.length) {
        await tx.teamMemberFunction.createMany({
          data: functions.map((functionKey) => ({ agencyId: currentInvite.agencyId, memberId: member.id, functionKey })),
          skipDuplicates: true,
        });
      }

      const claimed = await tx.agencyInvitation.updateMany({
        where: { id: inv.id, tokenHash, claimedAt: null, revokedAt: null, expiresAt: { gt: now } },
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
      });

      return { member, restored, roleKey, functions, agency: currentInvite.agency };
    });

    return res.json({
      ok: true,
      created: !result.restored,
      restored: result.restored,
      memberId: result.member.id,
      agency: { id: result.agency.id, name: result.agency.name },
      roleKey: result.roleKey,
      functions: result.functions,
    });
  } catch (error) {
    if (error?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues[0]?.message || "Validation error", issues: error.issues });
    if (Number(error?.status) >= 400 && Number(error?.status) < 600) {
      return res.status(Number(error.status)).json({ ok: false, code: error.code || "INVITE_CLAIM_FAILED", error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    console.error("[invitations/claim] failed:", error);
    return res.status(500).json({ ok: false, code: "INVITE_CLAIM_FAILED", error: "Failed to claim invitation" });
  }
});

module.exports = router;
