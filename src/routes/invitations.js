/* src/routes/invitations.js
   ────────────────────────────────────────────────────────────
   Public invitation endpoints. Mounted at /api/invitations.
   
   GET  /preview/:token
       → public, no auth. Returns { agency: {name}, roleKey, expired? }
         so the invite landing page can show "Join Bella's Studio
         as chatter" before login.
   
   POST /claim
       → AUTHENTICATED USER only (existing requireUser middleware).
         Body: { token }
         Creates AgencyMember with the role/scope/commission from
         the invitation, marks invitation as claimed.
   
   No team-permissions middleware here — invitation token IS the
   authorization.
   ────────────────────────────────────────────────────────────
*/

"use strict";

const express = require("express");
const crypto  = require("node:crypto");
const { z }   = require("zod");
const prisma  = require("../prisma");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function actorUserId(req) {
  return req.auth?.userId || actorUserId(req) || null;
}

function roleKeyToLegacy(roleKey) {
  const k = String(roleKey || "").toLowerCase();
  if (k === "owner")      return "OWNER";
  if (k === "manager")    return "MANAGER";
  if (k === "supervisor") return "MANAGER";
  if (k === "analyst")    return "OPERATOR";
  if (k === "chatter")    return "OPERATOR";
  return "OPERATOR";
}


// ════════════════════════════════════════════════════════════
// GET /preview/:token  — public, no auth
// ════════════════════════════════════════════════════════════

router.get("/preview/:token", async (req, res) => {
  try {
    const tokenHash = sha256(req.params.token);

    const inv = await prisma.agencyInvitation.findUnique({
      where: { tokenHash },
      include: {
        agency: { select: { id: true, name: true, deletedAt: true } },
      },
    });

    if (!inv) {
      return res.status(404).json({ ok: false, code: "INVITE_NOT_FOUND", error: "Invitation not found" });
    }
    if (inv.revokedAt) {
      return res.status(409).json({ ok: false, code: "INVITE_REVOKED", error: "Invitation was revoked" });
    }
    if (inv.claimedAt) {
      return res.status(409).json({ ok: false, code: "INVITE_CLAIMED", error: "Invitation already claimed" });
    }
    if (inv.expiresAt < new Date()) {
      return res.status(410).json({ ok: false, code: "INVITE_EXPIRED", error: "Invitation expired" });
    }
    if (inv.agency.deletedAt) {
      return res.status(409).json({ ok: false, code: "AGENCY_DELETED", error: "Agency was deleted" });
    }

    return res.json({
      ok: true,
      invitation: {
        agency: { id: inv.agency.id, name: inv.agency.name },
        email: inv.email,
        roleKey: inv.roleKey,
        displayName: inv.displayName,
        expiresAt: inv.expiresAt,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "INVITE_PREVIEW_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// POST /claim  — requires authenticated user
// ════════════════════════════════════════════════════════════

const claimSchema = z.object({
  token: z.string().min(10),
});

router.post("/claim", authRequired, async (req, res) => {
  try {
    if (!actorUserId(req)) {
      return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "Login required to claim invitation" });
    }

    const input = claimSchema.parse(req.body);
    const tokenHash = sha256(input.token);

    const inv = await prisma.agencyInvitation.findUnique({
      where: { tokenHash },
      include: { agency: true },
    });

    if (!inv) return res.status(404).json({ ok: false, code: "INVITE_NOT_FOUND", error: "Invitation not found" });
    if (inv.revokedAt) return res.status(409).json({ ok: false, code: "INVITE_REVOKED", error: "Invitation was revoked" });
    if (inv.claimedAt) return res.status(409).json({ ok: false, code: "INVITE_CLAIMED", error: "Invitation already claimed" });
    if (inv.expiresAt < new Date()) return res.status(410).json({ ok: false, code: "INVITE_EXPIRED", error: "Invitation expired" });
    if (inv.agency.deletedAt) return res.status(409).json({ ok: false, code: "AGENCY_DELETED", error: "Agency was deleted" });

    // If invitation has an email, it must match the claiming user's email.
    if (inv.email) {
      const me = await prisma.user.findUnique({ where: { id: actorUserId(req) } });
      if (!me || String(me.email).toLowerCase() !== String(inv.email).toLowerCase()) {
        return res.status(403).json({
          ok: false,
          code: "EMAIL_MISMATCH",
          error: "This invitation was sent to a different email address",
        });
      }
    }

    // Already a member?
    const existing = await prisma.agencyMember.findUnique({
      where: { agencyId_userId: { agencyId: inv.agencyId, userId: actorUserId(req) } },
    });

    if (existing) {
      // If member exists but was soft-deleted, restore. Otherwise — already in.
      if (existing.deletedAt) {
        await prisma.$transaction([
          prisma.agencyMember.update({
            where: { id: existing.id },
            data: {
              deletedAt: null,
              roleKey: inv.roleKey,
              role: roleKeyToLegacy(inv.roleKey),
              displayName: inv.displayName || existing.displayName,
              assignedCreators: inv.assignedCreators ?? existing.assignedCreators,
              commission: inv.commission ?? existing.commission,
            },
          }),
          prisma.agencyInvitation.update({
            where: { id: inv.id },
            data: {
              claimedAt: new Date(),
              claimedByUserId: actorUserId(req),
              claimedMemberId: existing.id,
            },
          }),
        ]);
        return res.json({
          ok: true,
          restored: true,
          memberId: existing.id,
          agency: { id: inv.agency.id, name: inv.agency.name },
          roleKey: inv.roleKey,
        });
      }

      return res.status(409).json({
        ok: false,
        code: "ALREADY_MEMBER",
        error: "You are already a member of this agency",
        memberId: existing.id,
      });
    }

    // Create new member.
    const me = await prisma.user.findUnique({ where: { id: actorUserId(req) } });
    const initials = String(me?.name || me?.email || "??").trim().slice(0, 2).toUpperCase();

    const [member, _] = await prisma.$transaction([
      prisma.agencyMember.create({
        data: {
          agencyId: inv.agencyId,
          userId: actorUserId(req),
          role: roleKeyToLegacy(inv.roleKey),
          roleKey: inv.roleKey,
          displayName: inv.displayName || me?.name || null,
          initials,
          tone: "amber",
          commission: inv.commission || { kind: "none" },
          assignedCreators: inv.assignedCreators ?? "all",
          lastSeenLabel: "just joined",
        },
      }),
      prisma.agencyInvitation.update({
        where: { id: inv.id },
        data: {
          claimedAt: new Date(),
          claimedByUserId: actorUserId(req),
        },
      }),
    ]);

    // Stamp claimedMemberId after create (we need member.id).
    await prisma.agencyInvitation.update({
      where: { id: inv.id },
      data: { claimedMemberId: member.id },
    });

    return res.json({
      ok: true,
      created: true,
      memberId: member.id,
      agency: { id: inv.agency.id, name: inv.agency.name },
      roleKey: inv.roleKey,
    });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        error: err.issues[0]?.message || "Validation error",
      });
    }
    console.error("[invitations/claim] failed:", err);
    return res.status(500).json({ ok: false, code: "INVITE_CLAIM_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
