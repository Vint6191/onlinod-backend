"use strict";

const express = require("express");
const prisma = require("../prisma");
const { cleanString, optionalString, jsonArray, jsonObject, centsFromAny, parseLimit, parseOffset, positiveInt, sendError } = require("../services/server-store-utils");
const { canUsePermission } = require("../services/team-access-control");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { attachAutomationAudit } = require("../middleware/automation-audit");

const automationServer = require("../services/automation-server-service");
const { registerCoreRoutes } = require("./automation/core-routes");
const { registerBumpRoutes } = require("./automation/bumps-routes");
const { registerSfsRoutes } = require("./automation/sfs-routes");
const { registerEventRoutes } = require("./automation/events-routes");

const router = express.Router();
attachAutomationAudit(router);

async function requireSeniorAutomationWriter(req, res, next) {
  try {
    const agencyId = req.auth?.agencyId;
    const userId = req.auth?.userId || req.user?.id;
    if (!agencyId || !userId) {
      return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "Authentication required" });
    }

    const member = req.auth?.membership || req.member;

    if (!member) {
      return res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "You are not a member of this agency" });
    }

    if (!(await canUsePermission({ member, key: "automation.manage", db: prisma }))) {
      return res.status(403).json({
        ok: false,
        code: "WRITE_AUTOMATION_FORBIDDEN",
        error: "automation.manage permission is required",
      });
    }

    req.agencyMember = member;
    next();
  } catch (err) {
    next(err);
  }
}

async function requireAutomationCreatorAccess(req, creatorId) {
  return requireCreatorAccess({
    agencyId: req.auth.agencyId,
    member: req.auth.membership || req.member,
    creatorId,
  });
}

const automationRouteDeps = {
  automationServer,
  prisma,
  cleanString,
  optionalString,
  jsonArray,
  jsonObject,
  centsFromAny,
  parseLimit,
  parseOffset,
  positiveInt,
  sendError,
  requireSeniorAutomationWriter,
  requireAutomationCreatorAccess,
};

registerCoreRoutes(router, automationRouteDeps);
registerBumpRoutes(router, automationRouteDeps);
registerSfsRoutes(router, automationRouteDeps);
// P15: legacy AutomationJob enqueue/claim scheduler is physically disabled.
// JobInstance read-only orchestration remains available at /api/jobs.
registerEventRoutes(router, automationRouteDeps);
// P15: legacy Alpha Hidden Online scanner/projection/bump routes are physically
// not registered. Subscriber Directory and /api/automation own these paths.
// P11: legacy Alpha bump delivery routes are physically not registered.
// P10: legacy Alpha Follow Back routes are intentionally not registered.
// The only executable path is /api/automation -> AutomationDelivery write control plane.
// P11 stats are written only by the fenced /api/automation control plane.

module.exports = router;
