"use strict";
const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { adminSessionRequired } = require("../middleware/admin-session");
const { loginAdmin, logoutAdmin } = require("../services/admin-session-authority-service");
const { publicAdmin } = require("../services/admin-command-contract");
const { sendCommandError } = require("./admin-command-handlers");
const router = express.Router();
// Login still accepts old long passwords; newly set credentials reject bcrypt truncation.
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(8).max(1024) }).strict();
router.post("/login", async (req, res) => {
  try { return res.json(await loginAdmin({ db: prisma, ...loginSchema.parse(req.body), ip: req.ip || null, userAgent: String(req.headers["user-agent"] || "").slice(0, 1000) || null })); }
  catch (error) { return sendCommandError(res, error); }
});
router.get("/me", adminSessionRequired, (req, res) => res.json({ ok: true, admin: publicAdmin(req.admin) }));
router.post("/logout", adminSessionRequired, async (req, res) => {
  try { return res.json(await logoutAdmin({ db: prisma, actor: { adminId: req.admin.id, sessionId: req.adminSession.id, accessEpoch: req.adminSession.issuedAccessEpoch } })); }
  catch (error) { return sendCommandError(res, error); }
});
module.exports = router;
