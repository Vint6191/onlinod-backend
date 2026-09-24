"use strict";
const prisma=require("../prisma");
const {createAdminRouter}=require("./admin-router");
const {adminSessionRequired}=require("../middleware/admin-session");
const {commandRequest}=require("../services/admin-command-contract");
const {sendCommandError}=require("./admin-command-handlers");
const {openAdminSupport,revokeAdminSupport,readAdminSupport}=require("../services/admin-support-command-service");
const router=createAdminRouter();
router.use(adminSessionRequired);
router.use((_req,res,next)=>{res.setHeader("Cache-Control","no-store");next();});
const actor=req=>({adminId:req.admin.id,sessionId:req.adminSession.id,accessEpoch:req.adminSession.issuedAccessEpoch});
router.post("/grants",async(req,res)=>{
 try{const result=await openAdminSupport({db:prisma,...commandRequest(req),payload:req.body});res.setHeader("Idempotency-Replayed",String(result.replayed));return res.status(result.statusCode).json(result.body);}catch(e){return sendCommandError(res,e);}
});
router.post("/grants/:id/revoke",async(req,res)=>{
 try{const result=await revokeAdminSupport({db:prisma,...commandRequest(req),grantId:req.params.id,payload:req.body});res.setHeader("Idempotency-Replayed",String(result.replayed));return res.status(result.statusCode).json(result.body);}catch(e){return sendCommandError(res,e);}
});
router.get("/grants/:id",async(req,res)=>{
 try{return res.json(await readAdminSupport({db:prisma,actor:actor(req),grantId:req.params.id,query:req.query}));}catch(e){return sendCommandError(res,e);}
});
module.exports=router;
