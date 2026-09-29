"use strict";
const express = require("express");
const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { executeManagementCommand } = require("../services/management-command-service");
const router = express.Router();
router.use(authRequired);
function handler(cancel) {
  return async (req, res) => {
    try {
      let deviceId = req.auth.deviceId || null;
      if (!cancel && ["network.create", "network.update"].includes(req.body?.action))
        deviceId = requireAuthDevice(req, req.body?.payload?.deviceId, {
          requiredCode: "NETWORK_AUTH_DEVICE_BOUND_TOKEN_REQUIRED",
          mismatchCode: "NETWORK_AUTH_DEVICE_MISMATCH",
        });
      const result = await executeManagementCommand({
        db: prisma,
        agencyId: req.auth.agencyId,
        userId: req.auth.userId,
        actorMember: req.auth.membership,
        deviceId,
        input: req.body,
        cancel,
      });
      res.setHeader("Cache-Control", "no-store, private");
      return res.json(result);
    } catch (error) {
      // Never echo a malformed payload (it may contain credential fields).
      return res
        .status(error?.issues ? 400 : Number(error?.status) || 500)
        .json({
          ok: false,
          code: error?.issues ? "VALIDATION_ERROR" : error?.code || "MANAGEMENT_COMMAND_FAILED",
          error: error?.issues
            ? "Invalid management command"
            : error?.status
              ? error.message
              : "Management command failed; recover the pending action",
        });
    }
  };
}
router.post("/v1", handler(false));
router.post("/v1/cancel", handler(true));
module.exports = router;
