"use strict";

const express = require("express");
const prisma = require("../prisma");
const { cleanString, optionalString, jsonArray, jsonObject, centsFromAny, parseLimit, parseOffset, positiveInt, requireCreator, sendError } = require("../services/server-store-utils");
const { isSeniorAgencyMember } = require("../middleware/team-permissions");

const automationServer = require("../services/automation-server-service");
const { createDeliveryHelpers } = require("./automation/delivery-helpers");
const { registerCoreRoutes } = require("./automation/core-routes");
const { registerBumpRoutes } = require("./automation/bumps-routes");
const { registerSfsRoutes } = require("./automation/sfs-routes");
const { registerJobRoutes } = require("./automation/jobs-routes");
const { registerEventRoutes } = require("./automation/events-routes");
const { registerHiddenOnlineRoutes } = require("./automation/hidden-online-routes");

const router = express.Router();

async function requireSeniorAutomationWriter(req, res, next) {
  try {
    const agencyId = req.auth?.agencyId;
    const userId = req.auth?.userId || req.user?.id;
    if (!agencyId || !userId) {
      return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "Authentication required" });
    }

    const member = await prisma.agencyMember.findFirst({
      where: { agencyId, userId, deletedAt: null, agency: { deletedAt: null } },
      select: { id: true, role: true, roleKey: true },
      take: 1,
    });

    if (!member) {
      return res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "You are not a member of this agency" });
    }

    if (!isSeniorAgencyMember(member)) {
      return res.status(403).json({
        ok: false,
        code: "INSUFFICIENT_TEAM_ROLE",
        error: "Only OWNER / MANAGER / ADMIN can modify automation",
      });
    }

    req.agencyMember = member;
    next();
  } catch (err) {
    next(err);
  }
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
  requireCreator,
  sendError,
  requireSeniorAutomationWriter,
};

const deliveryHelpers = createDeliveryHelpers(automationRouteDeps);
const automationDeliveryRouteDeps = { ...automationRouteDeps, ...deliveryHelpers };

registerCoreRoutes(router, automationRouteDeps);
registerBumpRoutes(router, automationRouteDeps);
registerSfsRoutes(router, automationRouteDeps);
registerJobRoutes(router, automationRouteDeps);
registerEventRoutes(router, automationRouteDeps);
// P11: legacy Alpha bump delivery routes are physically not registered.
registerHiddenOnlineRoutes(router, automationDeliveryRouteDeps);
// P10: legacy Alpha Follow Back routes are intentionally not registered.
// The only executable path is /api/automation -> AutomationDelivery write control plane.
// P11 stats are written only by the fenced /api/automation control plane.

module.exports = router;
