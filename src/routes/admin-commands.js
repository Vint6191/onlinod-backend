"use strict";
const express = require("express");
const prisma = require("../prisma");
const { adminSessionRequired } = require("../middleware/admin-session");
const { readAdminCommand } = require("../services/admin-commit-authority-service");
const { sendCommandError } = require("./admin-command-handlers");
const router = express.Router();
router.use(adminSessionRequired);
router.get("/:id", async (req, res) => {
  try {
    return res.json(await readAdminCommand({ db: prisma, commandId: req.params.id, actor: { adminId: req.admin.id, sessionId: req.adminSession.id, accessEpoch: req.adminSession.issuedAccessEpoch } }));
  } catch (error) { return sendCommandError(res, error); }
});
module.exports = router;
