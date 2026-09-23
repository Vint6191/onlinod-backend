"use strict";
const {executeAdminCommand}=require("./admin-commit-authority-service");
const {contentLifecycleSchema,adminError}=require("./admin-command-contract");
const {lockContentScope,lockMessageLibraryScript,changeMessageLibraryLifecycle}=require("./message-library-lifecycle-service");
const {dbAuthorityNow}=require("./db-time-authority-service");
async function changeAdminContentLifecycle({db,actor,commandId,targetId,payload}){
 const input=contentLifecycleSchema.parse(payload);
 return executeAdminCommand({db,actor,commandId,targetId,action:"data.content.lifecycle",payload:input,work:async({tx})=>{
  const identity=await tx.contentCollection.findFirst({where:{id:targetId,agencyId:input.agencyId,creatorId:input.creatorId,kind:"message_library_script"}});
  if(!identity?.clientId)throw adminError("MESSAGE_LIBRARY_SCRIPT_NOT_FOUND","Script not found in this scope",404);
  await lockContentScope({tx,agencyId:input.agencyId,creatorId:input.creatorId});
  const existing=await lockMessageLibraryScript({tx,agencyId:input.agencyId,creatorId:input.creatorId,scriptId:identity.clientId,expectedUpdatedAt:input.expectedUpdatedAt});
  const result=await changeMessageLibraryLifecycle({tx,existing,now:await dbAuthorityNow({db:tx}),action:input.action,includeBlocks:false});
  const item=result.item;
  return {agencyId:input.agencyId,body:{ok:true,id:item.id,status:item.status,updatedAt:item.updatedAt,permanent:result.permanent===true,pendingCleanup:result.pendingCleanup===true},audit:{creatorId:input.creatorId,before:{status:existing.status,deletedAt:existing.deletedAt,purgeAfter:existing.purgeAfter},after:{status:item.status,deletedAt:item.deletedAt,purgeAfter:item.purgeAfter},operation:input.action}};
 }});
}
module.exports={changeAdminContentLifecycle};
