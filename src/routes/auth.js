const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const { z } = require("zod");

const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { sha256 } = require("../utils/crypto");
const {
  publicUser,
  getPrimaryMembership,
  issueEmailVerification,
  issuePasswordReset,
  issueLoginTokens,
  verifyEmailByToken,
  verifyEmailByCode,
  refreshAccessToken,
  revokeRefreshToken,
} = require("../services/auth-service");

const router = express.Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(80).optional(),
  agencyName: z.string().min(1).max(120).optional(),
  inviteToken: z.string().min(10).optional().nullable(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  rememberDevice: z.boolean().optional(),
  deviceId: z.string().max(160).optional().nullable(),
  client: z.string().max(80).optional().nullable(),
});

const verifyCodeSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(12),
});

const emailOnlySchema = z.object({
  email: z.string().email(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20),
  deviceId: z.string().max(160).optional().nullable(),
  client: z.string().max(80).optional().nullable(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(20),
  password: z.string().min(8),
});


function hashInviteToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function roleKeyToLegacy(roleKey) {
  const k = String(roleKey || "").toLowerCase();
  if (k === "owner") return "OWNER";
  if (k === "manager") return "MANAGER";
  if (k === "supervisor") return "MANAGER";
  if (k === "analyst") return "OPERATOR";
  if (k === "chatter") return "OPERATOR";
  if (k === "sexter") return "OPERATOR";
  return "OPERATOR";
}

function initialsFrom(value) {
  return String(value || "??").trim().slice(0, 2).toUpperCase();
}

async function loadValidInvitation(token, tx = prisma) {
  const rawToken = String(token || "").trim();
  if (!rawToken) return null;

  const inv = await tx.agencyInvitation.findUnique({
    where: { tokenHash: hashInviteToken(rawToken) },
    include: { agency: true },
  });

  if (!inv) {
    return { ok: false, status: 404, code: "INVITE_NOT_FOUND", error: "Invitation not found" };
  }

  if (inv.revokedAt) {
    return { ok: false, status: 409, code: "INVITE_REVOKED", error: "Invitation was revoked" };
  }

  if (inv.claimedAt) {
    return { ok: false, status: 409, code: "INVITE_CLAIMED", error: "Invitation already claimed" };
  }

  if (inv.expiresAt < new Date()) {
    return { ok: false, status: 410, code: "INVITE_EXPIRED", error: "Invitation expired" };
  }

  if (inv.agency?.deletedAt) {
    return { ok: false, status: 409, code: "AGENCY_DELETED", error: "Agency was deleted" };
  }

  return { ok: true, invitation: inv };
}


function validationError(res, err) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: err.issues?.[0]?.message || "Validation error",
    issues: err.issues || [],
  });
}

router.post("/register", async (req, res) => {
  try {
    const input = registerSchema.parse(req.body);
    const email = input.email.toLowerCase().trim();
    const inviteToken = String(input.inviteToken || "").trim();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({
        ok: false,
        code: "EMAIL_TAKEN",
        error: inviteToken
          ? "Email is already registered. Sign in first, then accept the invitation."
          : "Email is already registered",
        inviteLoginRequired: !!inviteToken,
      });
    }

    let invitationCheck = null;
    if (inviteToken) {
      invitationCheck = await loadValidInvitation(inviteToken);
      if (!invitationCheck?.ok) {
        return res.status(invitationCheck.status || 400).json(invitationCheck);
      }

      if (invitationCheck.invitation.email) {
        const inviteEmail = String(invitationCheck.invitation.email).toLowerCase().trim();
        if (inviteEmail !== email) {
          return res.status(403).json({
            ok: false,
            code: "EMAIL_MISMATCH",
            error: "This invitation was sent to a different email address",
          });
        }
      }
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          name: input.name || null,
        },
      });

      if (inviteToken) {
        const checked = await loadValidInvitation(inviteToken, tx);
        if (!checked?.ok) {
          const err = new Error(checked?.error || "Invitation is no longer valid");
          err.status = checked?.status || 400;
          err.code = checked?.code || "INVITE_INVALID";
          throw err;
        }

        const inv = checked.invitation;
        const member = await tx.agencyMember.create({
          data: {
            userId: user.id,
            agencyId: inv.agencyId,
            role: roleKeyToLegacy(inv.roleKey),
            roleKey: inv.roleKey,
            displayName: inv.displayName || input.name || null,
            initials: initialsFrom(inv.displayName || input.name || email),
            tone: "amber",
            commission: inv.commission || { kind: "none" },
            assignedCreators: inv.assignedCreators ?? "all",
            permissions: {},
            lastSeenLabel: "just joined",
          },
        });

        await tx.agencyInvitation.update({
          where: { id: inv.id },
          data: {
            claimedAt: new Date(),
            claimedByUserId: user.id,
            claimedMemberId: member.id,
          },
        });

        return {
          user,
          agency: inv.agency,
          member,
          invitationClaimed: true,
          inviteRoleKey: inv.roleKey,
        };
      }

      const agency = await tx.agency.create({
        data: {
          name: input.agencyName || "Onlinod Agency",
        },
      });

      const member = await tx.agencyMember.create({
        data: {
          userId: user.id,
          agencyId: agency.id,
          role: "OWNER",
          roleKey: "owner",
          displayName: input.name || null,
          assignedCreators: "all",
          permissions: {},
        },
      });

      return { user, agency, member, invitationClaimed: false };
    });

    const verification = await issueEmailVerification(result.user);

    return res.status(201).json({
      ok: true,
      emailVerificationRequired: true,
      emailSent: verification.emailResult?.ok === true && !verification.emailResult?.skipped,
      user: publicUser(result.user),
      agency: result.agency,
      role: result.member.role,
      roleKey: result.member.roleKey || result.inviteRoleKey || null,
      invitationClaimed: result.invitationClaimed === true,
      devVerificationUrl: verification.emailResult?.skipped ? verification.emailResult?.verifyUrl : undefined,
      devVerificationCode: verification.emailResult?.skipped ? verification.code : undefined,
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    if (err?.code && String(err.code).startsWith("INVITE_")) {
      return res.status(err.status || 400).json({ ok: false, code: err.code, error: err.message });
    }
    console.error("[auth/register] failed:", err);
    return res.status(500).json({ ok: false, code: "REGISTER_FAILED", error: "Registration failed" });
  }
});

router.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).send("Verification token is missing.");

    const result = await verifyEmailByToken(token);
    if (!result.ok) return res.status(400).send(`${result.error || "Verification failed"} (${result.code})`);

    return res.send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Onlinod email verified</title>
          <style>
            body { font-family: Inter, Arial, sans-serif; background:#070b13; color:#fff; display:grid; place-items:center; min-height:100vh; margin:0; }
            .card { border:1px solid rgba(255,255,255,.12); border-radius:18px; padding:28px; background:#0d1420; max-width:420px; box-shadow:0 30px 80px rgba(0,0,0,.35); }
            h1 { margin:0 0 10px; color:#f7b84b; }
            p { color:#cbd5e1; }
            a { color:#f7b84b; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Email verified</h1>
            <p>Your Onlinod account is ready. You can return to the console and log in.</p>
            <p><a href="/">Open Onlinod Console</a></p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("[auth/verify-email GET] failed:", err);
    return res.status(500).send("Verification failed.");
  }
});

router.post("/verify-email", async (req, res) => {
  try {
    const input = verifyCodeSchema.parse(req.body);
    const result = await verifyEmailByCode(input);
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ok: true, user: publicUser(result.user) });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[auth/verify-email POST] failed:", err);
    return res.status(500).json({ ok: false, code: "VERIFY_EMAIL_FAILED", error: "Email verification failed" });
  }
});

router.post("/resend-verification", async (req, res) => {
  try {
    const input = emailOnlySchema.parse(req.body);
    const email = input.email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) return res.json({ ok: true });
    if (user.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true });

    const verification = await issueEmailVerification(user);
    return res.json({
      ok: true,
      emailSent: verification.emailResult?.ok === true && !verification.emailResult?.skipped,
      devVerificationUrl: verification.emailResult?.skipped ? verification.emailResult?.verifyUrl : undefined,
      devVerificationCode: verification.emailResult?.skipped ? verification.code : undefined,
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[auth/resend-verification] failed:", err);
    return res.status(500).json({ ok: false, code: "RESEND_VERIFICATION_FAILED", error: "Failed to resend verification" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const input = loginSchema.parse(req.body);
    const email = input.email.toLowerCase().trim();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ ok: false, code: "INVALID_CREDENTIALS", error: "Invalid email or password" });
    }

    if (user.disabledAt) {
      return res.status(403).json({ ok: false, code: "USER_DISABLED", error: "User is disabled" });
    }

    const passwordOk = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordOk) {
      return res.status(401).json({ ok: false, code: "INVALID_CREDENTIALS", error: "Invalid email or password" });
    }

    if (!user.emailVerifiedAt) {
      return res.status(403).json({ ok: false, code: "EMAIL_NOT_VERIFIED", error: "Email is not verified" });
    }

    const membership = await getPrimaryMembership(user.id);
    if (!membership) {
      return res.status(401).json({ ok: false, code: "NO_AGENCY", error: "User has no agency" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await issueLoginTokens({
      user: updatedUser,
      membership,
      req,
      rememberDevice: input.rememberDevice === true,
      deviceId: input.deviceId || null,
      client: input.client || null,
    });

    return res.json({
      ok: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      user: publicUser(updatedUser),
      agency: membership.agency,
      activeAgency: membership.agency,
      activeAgencyId: membership.agencyId,
      activeMemberId: membership.id,
      role: membership.role,
      permissions: membership.permissions || {},
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[auth/login] failed:", err);
    return res.status(500).json({ ok: false, code: "LOGIN_FAILED", error: "Login failed" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const input = refreshSchema.parse(req.body);
    const result = await refreshAccessToken({
      refreshToken: input.refreshToken,
      req,
      deviceId: input.deviceId || null,
      client: input.client || null,
    });
    if (!result.ok) return res.status(401).json(result);

    return res.json({
      ok: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt,
      user: publicUser(result.user),
      agency: result.membership.agency,
      activeAgency: result.membership.agency,
      activeAgencyId: result.membership.agencyId,
      activeMemberId: result.membership.id,
      role: result.membership.role,
      permissions: result.membership.permissions || {},
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[auth/refresh] failed:", err);
    return res.status(500).json({ ok: false, code: "REFRESH_FAILED", error: "Failed to refresh session" });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const input = refreshSchema.safeParse(req.body || {});
    if (input.success) await revokeRefreshToken(input.data.refreshToken);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[auth/logout] failed:", err);
    return res.json({ ok: true });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const input = emailOnlySchema.parse(req.body);
    const email = input.email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) return res.json({ ok: true });

    const reset = await issuePasswordReset(user);
    return res.json({
      ok: true,
      emailSent: reset.emailResult?.ok === true && !reset.emailResult?.skipped,
      devResetUrl: reset.emailResult?.skipped ? reset.emailResult?.resetUrl : undefined,
      devResetToken: reset.emailResult?.skipped ? reset.token : undefined,
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[auth/forgot-password] failed:", err);
    return res.status(500).json({ ok: false, code: "FORGOT_PASSWORD_FAILED", error: "Failed to start password reset" });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const input = resetPasswordSchema.parse(req.body);
    const tokenHash = sha256(input.token);

    const record = await prisma.authToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!record || record.type !== "PASSWORD_RESET") {
      return res.status(400).json({ ok: false, code: "TOKEN_INVALID", error: "Reset token is invalid" });
    }
    if (record.usedAt) {
      return res.status(400).json({ ok: false, code: "TOKEN_USED", error: "Reset token was already used" });
    }
    if (record.expiresAt < new Date()) {
      return res.status(400).json({ ok: false, code: "TOKEN_EXPIRED", error: "Reset token expired" });
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    await prisma.$transaction(async (tx) => {
      await tx.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await tx.refreshSession.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    return res.json({ ok: true });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[auth/reset-password] failed:", err);
    return res.status(500).json({ ok: false, code: "RESET_PASSWORD_FAILED", error: "Failed to reset password" });
  }
});

router.get("/me", authRequired, async (req, res) => {
  return res.json({
    ok: true,
    user: publicUser(req.auth.user),
    agency: req.auth.agency,
    activeAgency: req.auth.agency,
    activeAgencyId: req.auth.agencyId,
    activeMemberId: req.auth.memberId,
    role: req.auth.role,
    permissions: req.auth.permissions || {},
  });
});

module.exports = router;
