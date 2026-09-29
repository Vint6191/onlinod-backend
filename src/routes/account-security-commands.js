"use strict";
const router = require("express").Router();
const db = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { executeAccountSecurityCommand } = require("../services/account-security-command-service");
router.use(authRequired);
function handler(cancel) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    try {
      return res.json(await executeAccountSecurityCommand({ db, ...req.auth, actorMember: req.auth.membership, input: req.body, cancel }));
    } catch (error) {
      return res.status(error?.issues ? 400 : Number(error?.status) || 500).json({ ok: false,
        code: error?.issues ? "VALIDATION_ERROR" : error?.code || "ACCOUNT_SECURITY_COMMAND_FAILED",
        error: error?.issues ? "Invalid account action" : error?.status ? error.message : "Account action could not be confirmed; recover it in Settings" });
    }
  };
}
router.post("/v1", handler(false));
router.post("/v1/cancel", handler(true));
module.exports = router;
