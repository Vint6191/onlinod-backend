"use strict";
// Old links never mint customer credentials, including during a rolling upgrade.
const router=require("express").Router();
router.all("/claim",(_req,res)=>res.status(410).json({ok:false,code:"LEGACY_IMPERSONATION_RETIRED",error:"Use the scoped Support view in the admin console"}));
module.exports=router;
