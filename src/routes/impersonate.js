/* src/routes/impersonate.js
   ────────────────────────────────────────────────────────────
   Public claim endpoint for impersonation tokens.
   
   No admin auth header — the URL token IS the auth. Token is
   one-shot, expires in 5 minutes (issued by /api/admin/agencies/:id/impersonate).
   
   Flow:
     1. Admin clicks "Impersonate" → POST /api/admin/agencies/:id/impersonate
        → backend returns { url: "/?impersonate=<token>" }
     2. Admin opens that URL in a new tab.
     3. The customer console at "/" reads ?impersonate from URL,
        calls POST /api/impersonate/claim { token }.
     4. We mark the token as used, issue a real accessToken+refreshToken
        for the target user (stamped with impersonatedByAdminId), and
        return them. Frontend stores them like any normal login.
     5. UI paints a banner "Viewing as <user> — admin: <admin>" so the
        admin doesn't forget which session they're in.
   ────────────────────────────────────────────────────────────
*/

"use strict";

const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const prisma = require("../prisma");
const { signAccessToken, refreshTokenDays } = require("../utils/tokens");

const router = express.Router();

function sha256(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function randomToken(bytes = 48) { return crypto.randomBytes(bytes).toString("hex"); }

const claimSchema = z.object({
  token: z.string().min(20),
});

router.post("/claim", async (req, res) => {
  try {
    const input = claimSchema.parse(req.body);
    const tokenHash = sha256(input.token);

    const record = await prisma.impersonationToken.findUnique({ where: { tokenHash } });
    if (!record)               return res.status(401).json({ ok: false, code: "TOKEN_INVALID",  error: "Impersonation token is invalid" });
    if (record.claimedAt)      return res.status(401).json({ ok: false, code: "TOKEN_USED",     error: "Impersonation token already used" });
    if (record.expiresAt < new Date())
                               return res.status(401).json({ ok: false, code: "TOKEN_EXPIRED", error: "Impersonation token expired" });

    // Resolve target context.
    const [user, agency, member, admin] = await Promise.all([
      prisma.user.findUnique({ where: { id: record.targetUserId } }),
      prisma.agency.findUnique({ where: { id: record.targetAgencyId } }),
      prisma.agencyMember.findFirst({
        where: { userId: record.targetUserId, agencyId: record.targetAgencyId },
      }),
      prisma.adminUser.findUnique({ where: { id: record.adminUserId } }),
    ]);

    if (!user || !agency || !member) {
      return res.status(409).json({ ok: false, code: "TARGET_GONE", error: "Target user/agency/membership no longer exists" });
    }

    // Mint tokens. Refresh session is stamped with impersonatedByAdminId
    // for audit and for the banner.
    const accessToken = signAccessToken({
      userId: user.id,
      agencyId: agency.id,
      role: member.role,
    });

    const refreshToken = randomToken(48);
    const refreshExpires = new Date(Date.now() + refreshTokenDays() * 24 * 60 * 60 * 1000);

    await prisma.$transaction([
      prisma.impersonationToken.update({
        where: { id: record.id },
        data: { claimedAt: new Date() },
      }),
      prisma.refreshSession.create({
        data: {
          userId: user.id,
          agencyId: agency.id,
          tokenHash: sha256(refreshToken),
          userAgent: req.headers["user-agent"] || null,
          ipAddress: req.ip || null,
          expiresAt: refreshExpires,
          impersonatedByAdminId: record.adminUserId,
        },
      }),
    ]);

    return res.json({
      ok: true,
      accessToken,
      refreshToken,
      user: {
        id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl,
      },
      agency: { id: agency.id, name: agency.name, status: agency.status },
      role: member.role,
      permissions: member.permissions || {},
      impersonation: {
        adminEmail: admin?.email || "unknown",
        adminName:  admin?.name  || null,
        startedAt:  new Date(),
      },
    });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error" });
    }
    console.error("[impersonate/claim] failed:", err);
    return res.status(500).json({ ok: false, code: "IMPERSONATE_CLAIM_FAILED", error: "Impersonation claim failed" });
  }
});

module.exports = router;
