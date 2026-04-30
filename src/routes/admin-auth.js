const express = require("express");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const prisma = require("../prisma");
const { adminSessionRequired } = require("../middleware/admin-session");

const router = express.Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });

function sha256(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function newToken() { return crypto.randomBytes(32).toString("base64url"); }

router.post("/login", async (req, res) => {
  try {
    const input = loginSchema.parse(req.body);
    const email = input.email.trim().toLowerCase();
    const admin = await prisma.adminUser.findUnique({ where: { email } });

    if (!admin || !admin.active || !(await bcrypt.compare(input.password, admin.passwordHash))) {
      return res.status(401).json({ ok: false, code: "ADMIN_AUTH_INVALID", error: "Invalid admin credentials" });
    }

    const token = newToken();
    const expiresAt = new Date(Date.now() + Number(process.env.ADMIN_SESSION_DAYS || 7) * 86400000);

    await prisma.adminSession.create({
      data: {
        adminUserId: admin.id,
        tokenHash: sha256(token),
        expiresAt,
        ip: req.ip || null,
        userAgent: req.headers["user-agent"] || null,
      },
    });

    await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

    return res.json({
      ok: true,
      token,
      expiresAt,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error" });
    console.error("[admin-auth/login] failed:", err);
    return res.status(500).json({ ok: false, code: "ADMIN_LOGIN_FAILED", error: "Admin login failed" });
  }
});

router.get("/me", adminSessionRequired, async (req, res) => {
  return res.json({ ok: true, admin: { id: req.admin.id, email: req.admin.email, name: req.admin.name, role: req.admin.role } });
});

router.post("/logout", adminSessionRequired, async (req, res) => {
  await prisma.adminSession.update({ where: { id: req.adminSession.id }, data: { revokedAt: new Date() } });
  return res.json({ ok: true });
});

module.exports = router;
