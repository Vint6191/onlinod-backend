"use strict";
const bcrypt=require("bcryptjs");
const {z}=require("zod");
const {executeAdminCommand}=require("./admin-commit-authority-service");
const {deferCommitHint}=require("./db-commit-kernel");
const {ACTIONS,adminError,passwordFingerprint,reasonSchema}=require("./admin-command-contract");
const {passwordSchema}=require("./admin-identity-command-service");
const {dbAuthorityNow}=require("./db-time-authority-service");
const {assertTeamControlPlaneWriteAdmission}=require("./phase2-release-compatibility-authority-service");
const {lockAgencyPipelineLifecycle,lockAgencyPipelineLifecycleExclusive,assertAgencyCustomPipelineRetirable}=require("./custom-content-pipeline-authority-service");
const {assertAgencyMassCampaignRetirable}=require("./mass-campaign-authority-service");
const {assertAgencyHasOperationalOwner}=require("./team-operational-owner-authority-service");
const {removeMember,updateMemberAccessByPlatformAdmin,assertUserDisableOwnerSafety}=require("./team-administration-service");
const {acquireAuthorizationUserLock}=require("./authorization-session-authority-service");
const {retireCreatorWithinTransaction,publishCreatorRetirementControlEvents}=require("./creator-lifecycle-authority-service");
const {lockAgencyBillingMutation,syncAgencyBillingAggregate}=require("./billing-entitlement-service");
const {publishDomainWork,WORK_CLASS}=require("./domain-work-authority-service");
const {requeuePoisonedSubscriberMaintenanceSignal}=require("./subscriber-directory-maintenance-signal-service");
const {publishDesktopControlEvent}=require("./desktop-control-events");
function requireRow(row,kind){if(!row)throw adminError(`${kind}_NOT_FOUND`,`${kind} not found`,404);return row;}
function assertRevision(row,expected){if(!row?.updatedAt||new Date(row.updatedAt).getTime()!==new Date(expected).getTime())throw adminError("ADMIN_TARGET_REVISION_CONFLICT","Target changed; reload before editing");}
function publicUser(row){return {id:row.id,email:row.email,name:row.name,disabledAt:row.disabledAt,disabledReason:row.disabledReason,updatedAt:row.updatedAt,sessionsRevokedAt:row.sessionsRevokedAt};}
function publicMember(row){return {id:row.id,agencyId:row.agencyId,userId:row.userId,role:row.role,roleKey:row.roleKey,permissions:row.permissions,accessEpoch:row.accessEpoch,deletedAt:row.deletedAt};}
function publicAgency(row){return {id:row.id,name:row.name,status:row.status,deletedAt:row.deletedAt,deletedReason:row.deletedReason,updatedAt:row.updatedAt};}
async function queueLogout({tx,command,actorId,userId,agencyId=null,deviceId=null,now,reason}){
 // Existing durable DeviceCommand outbox: no capped JS enumeration and no effect
 // can escape an audit/domain rollback. Push events remain latency hints only.
 return tx.$executeRawUnsafe(`INSERT INTO "DeviceCommand" ("id","deviceId","agencyId","command","payload","issuedByAdmin","createdAt") SELECT md5($1||':'||d."id"),d."id",d."agencyId",'FORCE_LOGOUT',$2::jsonb,$3,$4 FROM "WorkerDevice" d WHERE d."userId"=$5 AND ($6::text IS NULL OR d."agencyId"=$6) AND ($7::text IS NULL OR d."id"=$7) ORDER BY d."id" ON CONFLICT ("id") DO NOTHING`,command.id,JSON.stringify({reason,userId,issuedAt:now.toISOString()}),actorId,now,userId,agencyId,deviceId);
}
async function operationalWork({tx,commitContext,action,targetId,input,command,actor,passwordHash,effects}){
 const now=await dbAuthorityNow({db:tx});
 if(action.startsWith("agency.")){
  await assertTeamControlPlaneWriteAdmission(tx);
  await lockAgencyPipelineLifecycleExclusive({db:tx,agencyId:targetId,allowDeleted:true});
  const before=requireRow(await tx.agency.findUnique({where:{id:targetId}}),"AGENCY");assertRevision(before,input.expectedUpdatedAt);
  let after,pending=false;
  if(action==="agency.update") after=await tx.agency.update({where:{id:targetId},data:{name:input.name}});
  else if(action==="agency.restore"){
   if(!before.deletedAt)throw adminError("AGENCY_NOT_DELETED","Agency is not deleted");
   const destructive=await tx.domainWorkItem.findFirst({where:{agencyId:targetId,workClass:WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,objectType:"Phase2AgencyDestructiveCleanup",objectId:targetId},select:{id:true}});
   if(destructive)throw adminError("AGENCY_DESTRUCTIVE_DELETE_IRREVERSIBLE","Hard deletion has started");
   await assertAgencyHasOperationalOwner({db:tx,agencyId:targetId});
   await lockAgencyBillingMutation(tx,targetId);
   await tx.agency.update({where:{id:targetId},data:{deletedAt:null,deletedReason:null}});
   await syncAgencyBillingAggregate(tx,targetId,now);after=await tx.agency.findUnique({where:{id:targetId}});
  }else{
   await assertAgencyCustomPipelineRetirable({db:tx,agencyId:targetId});
   await assertAgencyMassCampaignRetirable({db:tx,agencyId:targetId,requireFreshProviderSnapshot:!before.deletedAt});
   after=before.deletedAt?before:await tx.agency.update({where:{id:targetId},data:{deletedAt:now,deletedReason:input.reason,status:"LOCKED"}});
   await tx.refreshSession.updateMany({where:{agencyId:targetId,revokedAt:null,expiresAt:{gt:now}},data:{revokedAt:now}});
   if(input.hard){await publishDomainWork({db:tx,agencyId:targetId,workClass:WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,objectType:"Phase2AgencyDestructiveCleanup",objectId:targetId,partitionKey:targetId,creatorId:null,availableAt:now});pending=true;}
  }
  return {agencyId:targetId,statusCode:pending?202:200,body:{ok:true,agency:publicAgency(after),hard:input.hard===true,pending},audit:{before:publicAgency(before),after:publicAgency(after),cleanupScheduled:pending}};
 }
 if(action.startsWith("member.")){
  const options={db:tx,commitContext,agencyId:input.agencyId,memberId:targetId,expectedAccessEpoch:input.expectedAccessEpoch,publishEvents:false};
  let before,updated;
  if(action==="member.remove"){
   before=requireRow(await tx.agencyMember.findFirst({where:{id:targetId,agencyId:input.agencyId,deletedAt:null}}),"MEMBER");
   const result=await removeMember({...options,platformAdmin:true});updated={...before,...result};
  }else{
   const roleKey=input.role==="OWNER"?"owner":["ADMIN","MANAGER"].includes(input.role)?"manager":"chatter";
   ({before,updated}=await updateMemberAccessByPlatformAdmin({...options,...(action==="member.role.set"?{legacyRole:input.role,roleKey}:{permissions:input.permissions})}));
  }
  await tx.refreshSession.updateMany({where:{userId:before.userId,agencyId:input.agencyId,revokedAt:null,expiresAt:{gt:now}},data:{revokedAt:now}});
  const queued=await queueLogout({tx,command,actorId:actor.adminId,userId:before.userId,agencyId:input.agencyId,now,reason:input.reason});
  effects.push(()=>publishDesktopControlEvent({type:"ACCESS_EPOCH_CHANGED",agencyId:input.agencyId,targetUserId:before.userId,targetMemberId:targetId,accessEpoch:updated.accessEpoch}));
  return {agencyId:input.agencyId,body:{ok:true,member:publicMember(updated),softDeleted:action==="member.remove",historyPreserved:true,queuedDeviceCommands:queued},audit:{before:publicMember(before),after:publicMember(updated),queuedDeviceCommands:queued}};
 }
 if(action.startsWith("user.")){
  if(action==="user.update"&&input.disabled!==undefined)await assertTeamControlPlaneWriteAdmission(tx);
  await acquireAuthorizationUserLock(tx,{userId:targetId});
  await tx.$queryRawUnsafe('SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE',targetId);
  const before=requireRow(await tx.user.findUnique({where:{id:targetId}}),"USER");
  if(input.expectedUpdatedAt)assertRevision(before,input.expectedUpdatedAt);
  const data={};const revoke=action!=="user.update"||input.disabled===true;
  if(action==="user.update"){
   if(input.name!==undefined)data.name=input.name;
   if(input.disabled===true&&!before.disabledAt)await assertUserDisableOwnerSafety({tx,userId:targetId});
   if(input.disabled===true){data.disabledAt=before.disabledAt||now;data.disabledReason=input.disabledReason||input.reason;}
   if(input.disabled===false){data.disabledAt=null;data.disabledReason=null;}
  }
  if(action==="user.password.reset")data.passwordHash=passwordHash;
  if(revoke)data.sessionsRevokedAt=now;
  const updated=await tx.user.update({where:{id:targetId},data});
  if(input.disabled!==undefined&&Boolean(before.disabledAt)!==Boolean(updated.disabledAt))await tx.$executeRawUnsafe('UPDATE "AgencyMember" SET "accessEpoch"="accessEpoch"+1,"updatedAt"=$2 WHERE "userId"=$1 AND "deletedAt" IS NULL',targetId,now);
  let revokedSessions=0,queuedDeviceCommands=0;
  if(revoke){revokedSessions=(await tx.refreshSession.updateMany({where:{userId:targetId,revokedAt:null,expiresAt:{gt:now}},data:{revokedAt:now}})).count;queuedDeviceCommands=await queueLogout({tx,command,actorId:actor.adminId,userId:targetId,now,reason:input.reason});}
  return {body:{ok:true,user:publicUser(updated),sessionsRevokedAt:updated.sessionsRevokedAt,revokedSessions,queuedDeviceCommands,credentialsRotated:action==="user.password.reset"},audit:{before:publicUser(before),after:publicUser(updated),revokedSessions,queuedDeviceCommands,credentialsRotated:action==="user.password.reset"}};
 }
 if(action==="creator.retire"){
  await assertTeamControlPlaneWriteAdmission(tx);
  await lockAgencyPipelineLifecycle({db:tx,agencyId:input.agencyId,allowDeleted:true});
  await lockAgencyBillingMutation(tx,input.agencyId);
  const before=requireRow(await tx.creatorAccount.findUnique({where:{id:targetId}}),"CREATOR");
  if(before.agencyId!==input.agencyId)throw adminError("CREATOR_SCOPE_MISMATCH","Creator belongs to another agency");assertRevision(before,input.expectedUpdatedAt);
  const reason=input.hard?"ADMIN_CREATOR_HARD_DELETE_PENDING":"ADMIN_CREATOR_REMOVED";
  const result=await retireCreatorWithinTransaction({tx,agencyId:input.agencyId,creatorId:targetId,actorUserId:null,mode:input.hard?"HARD":"SOFT",retiredAt:now,sourceRequestId:`admin-command:${command.id}`,revokeReason:reason,agencyAlreadyLocked:true,expectedUpdatedAt:input.expectedUpdatedAt});
  await syncAgencyBillingAggregate(tx,input.agencyId,now);
  effects.push(()=>publishCreatorRetirementControlEvents({agencyId:input.agencyId,creatorId:targetId,reason,memberEpochs:result.memberEpochs||[]}));
  return {agencyId:input.agencyId,statusCode:input.hard?202:200,body:{ok:true,id:targetId,hard:input.hard,pending:input.hard,historyPreserved:!input.hard},audit:{creatorId:targetId,retiredAt:now,hard:input.hard}};
 }
 if(action==="device.kick"){
  await acquireAuthorizationUserLock(tx,{userId:input.userId});
  await tx.$queryRawUnsafe('SELECT "id" FROM "WorkerDevice" WHERE "id"=$1 FOR UPDATE',targetId);
  const device=requireRow(await tx.workerDevice.findUnique({where:{id:targetId}}),"DEVICE");
  if(device.agencyId!==input.agencyId||device.userId!==input.userId)throw adminError("DEVICE_SCOPE_MISMATCH","Device identity changed; reload");
  const revoked=await tx.refreshSession.updateMany({where:{userId:input.userId,agencyId:input.agencyId,deviceId:targetId,revokedAt:null,expiresAt:{gt:now}},data:{revokedAt:now}});
  const queued=await queueLogout({tx,command,actorId:actor.adminId,userId:input.userId,agencyId:input.agencyId,deviceId:targetId,now,reason:input.reason});
  return {agencyId:input.agencyId,body:{ok:true,queuedDeviceCommands:queued,revokedSessions:revoked.count},audit:{deviceId:targetId,userId:input.userId,revokedSessions:revoked.count,queuedDeviceCommands:queued}};
 }
 if(action==="maintenance.subscriber.requeue"){
  await lockAgencyPipelineLifecycle({db:tx,agencyId:input.agencyId});
  await tx.$queryRawUnsafe('SELECT "id" FROM "SubscriberDirectoryMaintenanceSignal" WHERE "id"=$1 FOR UPDATE',targetId);
  const before=requireRow(await tx.subscriberDirectoryMaintenanceSignal.findUnique({where:{id:targetId}}),"SIGNAL");
  if(before.agencyId!==input.agencyId||before.creatorId!==input.creatorId)throw adminError("SIGNAL_SCOPE_MISMATCH","Signal belongs to another scope");
  const result=await requeuePoisonedSubscriberMaintenanceSignal({db:tx,signalId:targetId,reason:"ADMIN_BREAK_GLASS_REQUEUE"});
  if(!result.requeued)throw adminError("SUBSCRIBER_MAINTENANCE_SIGNAL_NOT_POISONED","Signal is no longer poison-eligible");
  return {agencyId:input.agencyId,body:{ok:true,signal:{id:targetId,revision:String(result.signal.revision),dueAt:result.signal.dueAt}},audit:{creatorId:input.creatorId,signalId:targetId,revision:String(result.signal.revision)}};
 }
 throw adminError("ADMIN_ACTION_UNKNOWN","Unknown operation",400);
}
async function executeAdminOperation({db,actor,commandId,action,targetId,payload}){
 if(!require("./admin-operational-command-contract").OPERATIONAL_ACTIONS[action])throw adminError("ADMIN_ACTION_UNKNOWN","Unknown operation",400);
 let input,passwordHash;
 if(action==="user.password.reset"){
  const parsed=z.object({password:passwordSchema,reason:reasonSchema,expectedUpdatedAt:z.string().datetime()}).strict().parse(payload);
  const {password,...safe}=parsed;input={...safe,passwordFingerprint:passwordFingerprint(password)};passwordHash=await bcrypt.hash(password,12);
 }else input=ACTIONS[action].schema.parse(payload);
 return executeAdminCommand({db,actor,commandId,action,targetId,payload:input,work:async ctx=>{
  const effects=[];
  const outcome=await operationalWork({...ctx,action,targetId,input,actor,passwordHash,effects});
  for(const [index,effect] of effects.entries())deferCommitHint(ctx.commitContext,`admin-operation:${commandId}:${index}`,effect);
  return outcome;
 }});
}
module.exports={executeAdminOperation,queueLogout,publicUser,publicMember,publicAgency};
