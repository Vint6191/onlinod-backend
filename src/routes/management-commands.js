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
      if (!cancel && ["network.create", "network.update", "creator.beginConnection"].includes(req.body?.action))
        deviceId = requireAuthDevice(req, req.body?.payload?.deviceId, {
          requiredCode:
            req.body.action === "creator.beginConnection"
              ? "CREATOR_CONNECTION_AUTH_DEVICE_BOUND_TOKEN_REQUIRED"
              : "NETWORK_AUTH_DEVICE_BOUND_TOKEN_REQUIRED",
          mismatchCode:
            req.body.action === "creator.beginConnection"
              ? "CREATOR_CONNECTION_AUTH_DEVICE_MISMATCH"
              : "NETWORK_AUTH_DEVICE_MISMATCH",
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
      return res.status(error?.issues ? 400 : Number(error?.status) || 500).json({
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
// A read-only plan captures the version before Main persists its immutable intent.
router.post("/v1/operation-preview", async(req,res)=>{
 try {
  const {z}=require("zod");
  const envelope=z.object({creatorId:z.string().trim().max(180),family:z.string(),operation:z.string(),input:z.record(z.unknown())}).strict().parse(req.body);
  const {creatorId,...intent}=envelope;
  const p=require("../services/operational-command-contract").operation.parse({...intent,expectedRevision:'0'.repeat(64)});
  const owner=require("../services/operational-command-service");
  const result=await require("../services/db-commit-kernel").runRootCommit(prisma,async({tx})=>{
   if((p.family==='dialog_module') !== (envelope.creatorId===''))throw Object.assign(new Error('Invalid target'),{status:400});
   const authority=await require("../services/management-commit-authority-service").assertManagementCommitAuthority({tx,agencyId:req.auth.agencyId,actorMember:req.auth.membership,creatorIds:envelope.creatorId?[envelope.creatorId]:[]});
   await owner.authorizeExtra(tx,authority.member,p);
   return {ok:true,expectedRevision:await owner.snapshot(tx,req.auth.agencyId,envelope.creatorId,p)};
  },{profile:"SECRET_READ",maxAttempts:1});
  res.setHeader("Cache-Control","no-store, private");return res.json(result);
 }catch(error){return res.status(error?.issues?400:Number(error?.status)||500).json({ok:false,code:error?.issues?"VALIDATION_ERROR":error?.code||"OPERATION_PREVIEW_FAILED",error:"Operation could not be prepared; refresh current data"});}
});
router.post("/v1", handler(false));
router.post("/v1/cancel", handler(true));
module.exports = router;
