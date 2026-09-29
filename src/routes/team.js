"use strict";

const express = require("express");
const { teamReadRequired } = require("../middleware/team-permissions");
const { actorUserId, getTeamAdministrationState } = require("../services/team-administration-service");

const router = express.Router();

function validationError(res, error) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: error.issues?.[0]?.message || "Validation error",
    issues: error.issues || [],
  });
}

function serviceError(res, error, fallbackCode) {
  if (error?.issues) return validationError(res, error);
  const status = Number(error?.status);
  if (Number.isFinite(status) && status >= 400 && status < 600) {
    return res.status(status).json({
      ok: false,
      code: error.code || fallbackCode,
      error: error.message || "Request failed",
      ...(error.details ? { details: error.details } : {}),
    });
  }
  console.error(`[team] ${fallbackCode}:`, { code: String(error?.code || error?.name || "ERROR") });
  return res.status(500).json({ ok: false, code: fallbackCode, error: "Team administration request failed" });
}

function actor(req) {
  return {
    actorMember: req.agencyMember,
    actorUserId: actorUserId(req),
    // Never trust a renderer/body supplied device id for OWNER possession.
    // auth.deviceId is the signed JWT device claim established by authRequired.
    actorDeviceId: req.auth?.deviceId || null,
  };
}

// Agency identity comes only from the authenticated token. Service admission is
// current OWNER; the replay branch can still return a committed transfer receipt.
router.get("/ownership/plan/:memberId", async (req, res) => {
  try { return res.json(await require("../services/team-ownership-transfer-service").ownershipTransferPlan({db:require("../prisma"),agencyId:req.auth.agencyId,userId:req.auth.userId,memberId:req.params.memberId,actorDeviceId:actor(req).actorDeviceId,authorizationSessionId:req.auth.authorizationSessionId})); }
  catch (error) { return serviceError(res,error,"OWNERSHIP_PLAN_FAILED"); }
});
router.post("/ownership/transfer", async (req, res) => {
  try { return res.json(await require("../services/team-ownership-transfer-service").transferOwnership({db:require("../prisma"),agencyId:req.auth.agencyId,userId:req.auth.userId,actorDeviceId:actor(req).actorDeviceId,authorizationSessionId:req.auth.authorizationSessionId,
    input:req.body})); }
  catch (error) { return serviceError(res,error,"OWNERSHIP_TRANSFER_FAILED"); }
});

router.get("/state", teamReadRequired("workspace.view_team"), async (req, res) => {
  try {
    const state = await getTeamAdministrationState({
      agencyId: req.agencyId,
      viewerMember: req.agencyMember,
      includeAudit: true,
      auditLimit: req.query?.auditLimit,
    });
    return res.json(state);
  } catch (error) {
    return serviceError(res, error, "TEAM_STATE_FAILED");
  }
});

router.get("/invitations", teamReadRequired("workspace.view_team"), async (req, res) => {
  try {
    const state = await getTeamAdministrationState({ agencyId: req.agencyId, viewerMember: req.agencyMember, includeAudit: false });
    return res.json({ ok: true, invitations: state.invitations });
  } catch (error) {
    return serviceError(res, error, "TEAM_INVITATIONS_LIST_FAILED");
  }
});

// Unkeyed releases must fail before an effect instead of silently ignoring v2.
function upgradeRequired(req, res) {
  return res.status(410).json({ ok: false, code: "TEAM_COMMAND_V2_REQUIRED", error: "Update Desktop to use recoverable Team commands" });
}
router.patch("/members/:memberId/settings", upgradeRequired);
router.patch("/members/:memberId/status", upgradeRequired);
router.patch("/members/:memberId", upgradeRequired);
router.patch("/members/:memberId/functions", upgradeRequired);
router.patch("/members/:memberId/role", upgradeRequired);
router.delete("/members/:memberId", upgradeRequired);
router.post("/invitations", upgradeRequired);
router.post("/invitations/:invitationId/reissue", upgradeRequired);
router.delete("/invitations/:invitationId", upgradeRequired);
router.post("/roles", upgradeRequired);
router.patch("/roles/:roleKey", upgradeRequired);
router.patch("/roles/:roleKey/access", upgradeRequired);
router.patch("/roles/:roleKey/sub/:subPermKey", upgradeRequired);
router.post("/roles/:roleKey/reset", upgradeRequired);
router.post("/roles/duplicate", upgradeRequired);
router.delete("/roles/:roleKey", upgradeRequired);

function commandHandler(cancel) {
  return async (req, res) => {
    try {
      const result = await require("../services/team-command-service").executeTeamCommand({
        agencyId: req.auth?.agencyId, userId: req.auth?.userId, actorDeviceId: req.auth?.deviceId,
        input: req.body, cancel,
      });
      return res.json(result);
    } catch (error) { return serviceError(res, error, "TEAM_COMMAND_FAILED"); }
  };
}
router.post("/commands/v2", commandHandler(false));
router.post("/commands/v2/cancel", commandHandler(true));
module.exports = router;
