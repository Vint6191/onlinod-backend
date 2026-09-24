"use strict";
const {executeAdminCommand} = require("./admin-commit-authority-service");
const {lockAdminActor,assertAdminSessionLifetime} = require("./admin-session-authority-service");
const {adminError} = require("./admin-command-contract");
const {dbAuthorityNow} = require("./db-time-authority-service");
const {z} = require("zod");
const {runRootCommit} = require("./db-commit-kernel");

const pageSchema = z.object({cursor:z.string().min(1).max(180).optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const agencySelect = {id:true,name:true,status:true,plan:true,deletedAt:true,billingSupportHold:true,trialEndsAt:true,currentPeriodEnd:true};
const creatorSelect = {id:true,agencyId:true,displayName:true,username:true,status:true,deletedAt:true,updatedAt:true,
  sessionState:{select:{status:true,revision:true,portableReady:true,updatedAt:true}}};
function publicGrant(row) {
  return {id:row.id,agencyId:row.agencyId,createdAt:row.createdAt,expiresAt:row.expiresAt,revokedAt:row.revokedAt,reason:row.reason,mode:"AGENCY_DIAGNOSTICS"};
}
async function lockAgency(tx, agencyId) {
  await tx.$queryRawUnsafe('SELECT "id" FROM "Agency" WHERE "id"=$1 FOR SHARE',agencyId);
  const agency=await tx.agency.findUnique({where:{id:agencyId},select:agencySelect});
  if(!agency || agency.deletedAt) throw adminError("SUPPORT_AGENCY_UNAVAILABLE","Agency is missing or retired",409);
  return agency;
}
async function openAdminSupport({db,actor,commandId,payload}) {
  return executeAdminCommand({db,actor,commandId,action:"support.grant.open",targetId:payload?.agencyId,payload,
    work:async({tx,authority,payload:input})=>{
      const agency=await lockAgency(tx,input.agencyId);
      const now=await dbAuthorityNow({db:tx});
      const expiresAt=new Date(Math.min(now.getTime()+input.durationMinutes*60000,new Date(authority.session.expiresAt).getTime()));
      if(expiresAt<=now) throw adminError("ADMIN_AUTH_INVALID","Admin session expired while opening support",401);
      const grant=await tx.adminSupportGrant.create({data:{actorId:actor.adminId,sessionId:actor.sessionId,actorAccessEpoch:actor.accessEpoch,agencyId:agency.id,reason:input.reason,createdAt:now,expiresAt}});
      return {agencyId:agency.id,body:{ok:true,grant:publicGrant(grant)},audit:{grantId:grant.id,expiresAt,mode:"AGENCY_DIAGNOSTICS"}};
    }});
}
async function revokeAdminSupport({db,actor,commandId,grantId,payload}) {
  return executeAdminCommand({db,actor,commandId,action:"support.grant.revoke",targetId:grantId,payload,
    work:async({tx,authority})=>{
      await tx.$queryRawUnsafe('SELECT "id" FROM "AdminSupportGrant" WHERE "id"=$1 FOR UPDATE',grantId);
      const grant=await tx.adminSupportGrant.findUnique({where:{id:grantId}});
      if(!grant || (grant.actorId!==actor.adminId && authority.admin.role!=="SUPER_ADMIN")) throw adminError("SUPPORT_GRANT_NOT_FOUND","Support grant not found",404);
      const current=grant.revokedAt?grant:await tx.adminSupportGrant.update({where:{id:grantId},data:{revokedAt:await dbAuthorityNow({db:tx})}});
      return {agencyId:grant.agencyId,body:{ok:true,grant:publicGrant(current)},audit:{grantId,alreadyRevoked:Boolean(grant.revokedAt)}};
    }});
}
async function readAdminSupport({db,actor,grantId,query={}}) {
  const page=pageSchema.parse(query);
  return runRootCommit(db,async ({tx})=>{
    const authority=await lockAdminActor(tx,actor);
    const initial=await tx.adminSupportGrant.findUnique({where:{id:grantId}});
    if(!initial || initial.actorId!==actor.adminId || initial.sessionId!==actor.sessionId) throw adminError("SUPPORT_GRANT_NOT_FOUND","Support grant not found for this admin session",404);
    const agency=await lockAgency(tx,initial.agencyId);
    await tx.$queryRawUnsafe('SELECT "id" FROM "AdminSupportGrant" WHERE "id"=$1 FOR SHARE',grantId);
    const grant=await tx.adminSupportGrant.findUnique({where:{id:grantId}});
    const now=await dbAuthorityNow({db:tx});
    if(!grant || grant.revokedAt || new Date(grant.expiresAt)<=now || grant.actorAccessEpoch!==actor.accessEpoch) throw adminError("SUPPORT_GRANT_EXPIRED","Support access expired or was revoked",403);
    // Agency/id unique index bounds each page independently of tenant count,
    // history size and other tenants. Retired creators remain visible as diagnostics.
    const rows=await tx.creatorAccount.findMany({where:{agencyId:grant.agencyId,...(page.cursor?{id:{gt:page.cursor}}:{})},orderBy:{id:"asc"},take:page.limit+1,select:creatorSelect});
    const responseNow=await dbAuthorityNow({db:tx});
    if(new Date(grant.expiresAt)<=responseNow) throw adminError("SUPPORT_GRANT_EXPIRED","Support access expired while reading diagnostics",403);
    await assertAdminSessionLifetime(tx,authority);
    const creators=rows.slice(0,page.limit);
    return {ok:true,grant:publicGrant(grant),agency,creators,nextCursor:rows.length>page.limit?creators.at(-1).id:null,authorityNow:responseNow};
  },{profile:"ADMIN_SUPPORT_READ",authority:{kind:"ADMIN_SUPPORT_READ",adminId:actor.adminId},conflictCode:"ADMIN_SUPPORT_READ_CONFLICT"});
}
module.exports={openAdminSupport,revokeAdminSupport,readAdminSupport,pageSchema,publicGrant};
