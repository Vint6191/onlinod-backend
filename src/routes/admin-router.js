"use strict";
const express=require("express");
// Express 4 does not forward rejected async route promises automatically.
// One registration boundary covers every admin read/mutation in these routers.
function createAdminRouter(){
 const router=express.Router();
 for(const method of["get","post","patch","put","delete"]){
  const register=router[method].bind(router);
  router[method]=(path,...handlers)=>register(path,...handlers.map(handler=>function(req,res,next){
   Promise.resolve().then(()=>handler(req,res,next)).catch(next);
  }));
 }
 return router;
}
module.exports={createAdminRouter};
