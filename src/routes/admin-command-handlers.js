"use strict";
const { classifyCommitConflict } = require("../services/db-commit-kernel");

const { setAdminBillingPolicy, setAdminBillingHold, setAdminEntitlement } = require("../services/admin-billing-access-command-service");
const { archiveAdminDeliveries } = require("../services/admin-delivery-archive-command-service");
const { changeAdminContentLifecycle } = require("../services/admin-content-lifecycle-command-service");
const prisma = require("../prisma");
const { submitAdminBulkPricing, cancelAdminBulkPricing } = require("../services/admin-bulk-pricing-command-service");
const { commandRequest } = require("../services/admin-command-contract");
const { setAdminPricing } = require("../services/admin-pricing-command-service");
const { createAdminIdentity, patchAdminIdentity, resetAdminPassword } = require("../services/admin-identity-command-service");

function sendCommandError(res, error) {
  if (classifyCommitConflict(error)) return res.status(409).json({ ok:false, code:"TEAM_CONTROL_PLANE_SERIALIZATION_CONFLICT", error:"State changed concurrently; retry with the same command identity" });
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

function operationHandler(action, param = "id") {
  return async (req, res) => {
    try {
      const result = await require("../services/admin-operational-command-service").executeAdminOperation({ db: prisma, ...commandRequest(req), action, targetId: req.params[param], payload: req.body });
      res.setHeader("Idempotency-Replayed", String(result.replayed));
      return res.status(result.statusCode).json(result.body);
    } catch (error) { return sendCommandError(res, error); }
  };
}

module.exports = { commercialPolicyHandler: handler(require("../services/admin-commercial-policy-command-service").setAdminCommercialPolicy), operationHandler, contentLifecycleHandler: handler(changeAdminContentLifecycle, "targetId"), archiveDeliveriesHandler: handler(archiveAdminDeliveries, "creatorId"), cancelBulkPricingHandler: handler(cancelAdminBulkPricing, "agencyId"), bulkPricingHandler: handler(submitAdminBulkPricing, "agencyId"), setBillingPolicyHandler: handler(setAdminBillingPolicy, "agencyId"), setBillingHoldHandler: handler(setAdminBillingHold, "agencyId"), setEntitlementHandler: handler(setAdminEntitlement, "creatorId"), sendCommandError, setPricingHandler: handler(setAdminPricing, "creatorId"), createAdminHandler: handler(createAdminIdentity), patchAdminHandler: handler(patchAdminIdentity, "targetId"), resetAdminPasswordHandler: handler(resetAdminPassword, "targetId") };
