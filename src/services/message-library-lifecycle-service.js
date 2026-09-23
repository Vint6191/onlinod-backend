"use strict";
const { randomUUID } = require("node:crypto");
const { assertManagementCommitAuthority } = require("./management-commit-authority-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { lockLiveTeamControlPlaneCreators } = require("./team-control-plane-authority-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const KIND = "message_library_script";
const RETENTION_DAYS = 14;
const fail = (code, message, status=409) => Object.assign(new Error(message), {code,status});
const isTrash = row => Boolean(row?.deletedAt) || ["trash","deleted","deleting"].includes(row?.status);
const trashPurgeAfter = now => new Date(now.getTime()+RETENTION_DAYS*86400000);

async function lockContentScope({tx,agencyId,creatorId,actorMember=null,userId=null,manager=true}) {
  if(!agencyId || !creatorId) throw fail("MESSAGE_LIBRARY_SCOPE_REQUIRED","Agency and creator are required",400);
  if(actorMember) return assertManagementCommitAuthority({tx,agencyId,actorMember:{...actorMember,userId},creatorIds:[creatorId],permissionKey:manager?"message_library.manage":null});
  const agency=await lockAgencyLifecycleBarrier({db:tx,agencyId});
  if(!agency.row || agency.row.deletedAt) throw fail("AGENCY_RETIRED","Agency is retired");
  const creators=await lockLiveTeamControlPlaneCreators({tx,agencyId,creatorIds:[creatorId]});
  if(creators.missingCreatorIds.length) throw fail("CREATOR_RETIRED","Creator is retired");
}
async function lockMessageLibraryScript({tx,agencyId,creatorId,scriptId,expectedUpdatedAt=null,includeBlocks=false}) {
  if(!scriptId) throw fail("MESSAGE_LIBRARY_SCRIPT_ID_MISSING","Script identity is required",400);
  // Also serializes concurrent creation: the unique namespace is agency/clientId.
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",`message-library:${agencyId}:${scriptId}`);
  await tx.$queryRawUnsafe('SELECT "id" FROM "ContentCollection" WHERE "agencyId"=$1 AND "clientId"=$2 FOR UPDATE',agencyId,scriptId);
  const row=await tx.contentCollection.findFirst({where:{agencyId,clientId:scriptId},...(includeBlocks?{include:{blocks:{orderBy:[{order:"asc"},{createdAt:"asc"}]}}}:{})});
  if(row && (row.kind!==KIND || row.creatorId!==creatorId)) throw fail("MESSAGE_LIBRARY_SCRIPT_CREATOR_MISMATCH","Script belongs to another content scope");
  if(expectedUpdatedAt && (!row || new Date(row.updatedAt).getTime()!==new Date(expectedUpdatedAt).getTime())) throw fail("MESSAGE_LIBRARY_REVISION_CONFLICT","Script changed; reload before editing");
  return row;
}
async function contentAudit({tx,agencyId,userId,creatorId,scriptId,action,metadata={}}) {
  await tx.auditLog.create({data:{agencyId,actorUserId:userId||null,action:`message_library.${action}`,targetType:"ContentCollection",targetId:scriptId||creatorId,metadata:{creatorId,...metadata}}});
}
async function withMessageLibraryMutation({db,agencyId,creatorId,actorMember,userId,scriptId,action,manager=true,expectedUpdatedAt=null,work}) {
  if(!actorMember || !userId) throw fail("MESSAGE_LIBRARY_ACTOR_REQUIRED","Current membership is required",401);
  return db.$transaction(async tx=>{
    await lockContentScope({tx,agencyId,creatorId,actorMember,userId,manager});
    const existing=await lockMessageLibraryScript({tx,agencyId,creatorId,scriptId,expectedUpdatedAt,includeBlocks:action === "usage"});
    const now=await dbAuthorityNow({db:tx});
    const result=await work({tx,existing,now});
    await contentAudit({tx,agencyId,userId,creatorId,scriptId:existing?.id||result?.id,action});
    return result;
  },{maxWait:5000,timeout:15000});
}
async function upsertMessageLibraryBlocks({tx,collectionId,blocks,now}) {
  if(!blocks.length)return;
  const rows=blocks.map(b=>({...b,id:randomUUID(),collectionId,status:"active",deletedAt:null,purgeAfter:null,trashedByUserId:null,createdAt:now,updatedAt:now}));
  const types={id:"text",collectionId:"text",clientId:"text",order:"integer",role:"text",title:"text",text:"text",priceCents:"integer",currency:"text",lockedText:"boolean",media:"jsonb",note:"text",metadata:"jsonb",status:"text",deletedAt:"timestamp",purgeAfter:"timestamp",trashedByUserId:"text",createdAt:"timestamp",updatedAt:"timestamp"};
  const columns=Object.keys(types),quoted=columns.map(k=>'"'+k+'"').join(',');
  const updates=columns.filter(k=>!["id","collectionId","clientId","createdAt"].includes(k)).map(k=>'"'+k+'"=EXCLUDED."'+k+'"').join(',');
  await tx.$executeRawUnsafe(`INSERT INTO "ContentBlock" (${quoted}) SELECT ${quoted} FROM jsonb_to_recordset($1::jsonb) AS r(${columns.map(k=>'"'+k+'" '+types[k]).join(',')}) ORDER BY "clientId" ON CONFLICT ("collectionId","clientId") DO UPDATE SET ${updates}`,JSON.stringify(rows));
}

async function changeMessageLibraryLifecycle({tx,existing,now,action,userId=null,messageId=null,includeBlocks=true}) {
  if(!existing) throw fail("MESSAGE_LIBRARY_SCRIPT_NOT_FOUND","Script not found",404);
  if(existing.status==="deleting") {
    if(action==="permanent") return {item:existing,permanent:true,pendingCleanup:true};
    throw fail("MESSAGE_LIBRARY_DELETE_COMMITTED","Permanent deletion has already been committed");
  }
  if(messageId) {
    if(isTrash(existing)) throw fail("MESSAGE_LIBRARY_SCRIPT_TRASHED","Restore the script before editing its messages");
    const block=await tx.contentBlock.findFirst({where:{collectionId:existing.id,OR:[{clientId:messageId},{id:messageId}]}});
    if(!block) throw fail("MESSAGE_LIBRARY_BLOCK_NOT_FOUND","Message block not found",404);
    const data=action==="restore"?{status:"active",deletedAt:null,purgeAfter:null,trashedByUserId:null}:{status:"trash",deletedAt:block.deletedAt||now,purgeAfter:block.purgeAfter||trashPurgeAfter(now),trashedByUserId:userId};
    const updated=await tx.contentBlock.update({where:{id:block.id},data});
    await tx.contentCollection.update({where:{id:existing.id},data:{updatedByUserId:userId,updatedAt:now}});
    return {block:updated};
  }
  if(action==="permanent" && !isTrash(existing)) throw fail("MESSAGE_LIBRARY_SCRIPT_NOT_TRASHED","Move the script to trash before deleting it forever");
  const data=action==="restore"?{status:"active",deletedAt:null,purgeAfter:null,trashedByUserId:null,updatedByUserId:userId}:
    action==="permanent"?{status:"deleting",deletedAt:existing.deletedAt||now,purgeAfter:now,updatedByUserId:userId}:
    {status:"trash",deletedAt:existing.deletedAt||now,purgeAfter:existing.purgeAfter||trashPurgeAfter(now),trashedByUserId:userId,updatedByUserId:userId};
  const item=await tx.contentCollection.update({where:{id:existing.id},data,...(includeBlocks && action!=="permanent"?{include:{blocks:{orderBy:[{order:"asc"},{createdAt:"asc"}]}}}:{})});
  return {item,...(action==="permanent"?{permanent:true,pendingCleanup:true}:{})};
}
// Durable deleting state is the cleanup intent. Every worker rechecks it under
// the same parent lock; deleting the final parent never cascades a large history.
async function cleanupMessageLibraryScript({db,agencyId,creatorId,scriptId,batchSize=200,actorMember=null,userId=null}) {
  return db.$transaction(async tx=>{
    await lockContentScope({tx,agencyId,creatorId,actorMember,userId});
    let row=await lockMessageLibraryScript({tx,agencyId,creatorId,scriptId});
    if(!row) return {scriptsDeleted:0,blocksDeleted:0,hasMore:false};
    const now=await dbAuthorityNow({db:tx});
    if(isTrash(row) && row.purgeAfter && row.purgeAfter<=now && row.status!=="deleting") row=await tx.contentCollection.update({where:{id:row.id},data:{status:"deleting"}});
    const removing=row.status==="deleting";
    const predicate=removing?{}:{purgeAfter:{lte:now},OR:[{status:"trash"},{deletedAt:{not:null}}]};
    const take=Math.max(1,Math.min(200,Math.floor(Number(batchSize)||200)));
    const blocks=await tx.contentBlock.findMany({where:{collectionId:row.id,...predicate},select:{id:true},orderBy:{id:"asc"},take});
    const deleted=blocks.length?await tx.contentBlock.deleteMany({where:{collectionId:row.id,id:{in:blocks.map(b=>b.id)},...predicate}}):{count:0};
    const parent=removing?await tx.contentCollection.deleteMany({where:{id:row.id,agencyId,creatorId,status:"deleting",blocks:{none:{}}}}):{count:0};
    if(deleted.count || parent.count) await contentAudit({tx,agencyId,userId,creatorId,scriptId:row.id,action:"purge",metadata:{blocksDeleted:deleted.count,scriptsDeleted:parent.count}});
    return {scriptsDeleted:parent.count,blocksDeleted:deleted.count,hasMore:removing?!parent.count:blocks.length===take};
  },{maxWait:5000,timeout:15000});
}
async function runMessageLibraryTrashMaintenance({db,agencyId=null,creatorId=null,actorMember=null,userId=null,limit=10}={}) {
  const now=await dbAuthorityNow({db});
  const take=Math.max(1,Math.min(10,Math.floor(Number(limit)||10)));
  const scope={kind:KIND,clientId:{not:null},...(agencyId?{agencyId}:{}),...(creatorId?{creatorId}:{}),creator:{is:{deletedAt:null}},agency:{deletedAt:null}};
  const parents=await db.contentCollection.findMany({where:{...scope,purgeAfter:{lte:now},OR:[{status:{in:["trash","deleted","deleting"]}},{deletedAt:{not:null}}]},select:{id:true,agencyId:true,creatorId:true,clientId:true},orderBy:[{purgeAfter:"asc"},{id:"asc"}],take});
  const blocks=await db.contentBlock.findMany({where:{purgeAfter:{lte:now},OR:[{status:"trash"},{deletedAt:{not:null}}],collection:scope},select:{collection:{select:{id:true,agencyId:true,creatorId:true,clientId:true}}},orderBy:[{purgeAfter:"asc"},{id:"asc"}],take});
  const targets=[...new Map([...parents,...blocks.map(b=>b.collection)].filter(r=>r.clientId).map(r=>[r.id,r])).values()];
  const out={ok:true,scriptsDeleted:0,blocksDeleted:0,processed:0,hasMore:parents.length===take||blocks.length===take,errors:[]};
  const started=Date.now();
  for(const row of targets){
    if(Date.now()-started>=8000){out.hasMore=true;break;}
    try{const result=await cleanupMessageLibraryScript({db,agencyId:row.agencyId,creatorId:row.creatorId,scriptId:row.clientId,actorMember,userId});out.scriptsDeleted+=result.scriptsDeleted;out.blocksDeleted+=result.blocksDeleted;out.processed++;out.hasMore ||= result.hasMore;}
    catch(error){out.ok=false;out.errors.push({id:row.id,code:error.code||"MESSAGE_LIBRARY_CLEANUP_FAILED"});}
  }
  return out;
}
module.exports={upsertMessageLibraryBlocks,KIND,RETENTION_DAYS,trashPurgeAfter,isTrash,lockContentScope,lockMessageLibraryScript,withMessageLibraryMutation,changeMessageLibraryLifecycle,cleanupMessageLibraryScript,runMessageLibraryTrashMaintenance};
