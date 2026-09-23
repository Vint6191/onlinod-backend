"use strict";

const prisma = require("../prisma");
const { commandRequest } = require("../services/admin-command-contract");
const { setAdminPricing } = require("../services/admin-pricing-command-service");
const { createAdminIdentity, patchAdminIdentity, resetAdminPassword } = require("../services/admin-identity-command-service");

function sendCommandError(res, error) {
  if (error?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues[0]?.message || "Invalid command" });
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error("[admin-command] failed:", error?.code || "INTERNAL_ERROR");
  return res.status(status).json({ ok: false, code: status < 500 ? error.code : "ADMIN_COMMAND_FAILED", error: status < 500 ? error.message : "Command could not be completed; retry with the same command identity", ...(status < 500 && error.details ? { details: error.details } : {}) });
}

function handler(service, targetKey) {
  return async (req, res) => {
    try {
      const context = commandRequest(req);
      const result = await service({ db: prisma, ...context, ...(targetKey ? { [targetKey]: req.params.id } : {}), payload: req.body });
      res.setHeader("Idempotency-Replayed", String(result.replayed));
      return res.status(result.statusCode).json(result.body);
    } catch (error) { return sendCommandError(res, error); }
  };
}

module.exports = { sendCommandError, setPricingHandler: handler(setAdminPricing, "creatorId"), createAdminHandler: handler(createAdminIdentity), patchAdminHandler: handler(patchAdminIdentity, "targetId"), resetAdminPasswordHandler: handler(resetAdminPassword, "targetId") };
