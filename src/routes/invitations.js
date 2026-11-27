"use strict";

const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { cleanFunctions } = require("../services/team-administration-service");
const { publishDesktopControlEvent } = require("../services/desktop-control-events");
const { acceptInvitationForUser, invitationFailure } = require("../services/invitation-acceptance-service");

const router = express.Router();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function actorUserId(req) {
  return req.auth?.userId || req.user?.id || null;
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
    const result = await acceptInvitationForUser({ token: input.token, userId, db: prisma });

    try {
      publishDesktopControlEvent({
        type: "ACCESS_EPOCH_CHANGED",
        agencyId: result.agency.id,
        accessEpoch: Number(result.member.accessEpoch || 1),
        targetUserId: result.member.userId || userId,
        targetMemberId: result.member.id,
        sourceDeviceId: req.auth?.deviceId || null,
        requestId: req.headers?.["x-request-id"] || null,
      });
    } catch (eventError) {
      console.error("[invitations/control-access-epoch] failed:", eventError);
    }

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
