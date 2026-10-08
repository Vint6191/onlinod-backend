'use strict';
const {object,sha,failure,putProof,runDbTransaction,lockDbAdvisoryXact}=require('./phase7-legacy-storage-service');
const authority=require('./phase7-obligation-authority-service');
const contract=require('./phase7-cleanup-contract');
const P14='20260715153000_p14_sfs_automation';
const md5=x=>require('node:crypto').createHash('md5').update(x).digest('hex');
function targetOf(job){const a=String(job.fanId||'').trim(),b=String(object(job.payload).targetUserId||'').trim();
  if(a&&b&&a!==b)throw failure('PHASE7_LEGACY_TARGET_CONFLICT');return a||b||null;}
function baseOf({job,sourceHash}){return {cohortId:'automation_job',sourceTable:'AutomationJob',sourceId:job.id,sourceHash,
  agencyId:job.agencyId,creatorId:job.creatorId||job.accountId||null};}
function checkDelivery(d,c,source){
  if(!contract.isLegacyCleanup(d)||d.agencyId!==c.agencyId||d.creatorId!==c.creatorId
      ||d.targetId!==c.targetUserId||d.fanId!==c.targetUserId||object(d.payload).candidateId!==c.id
      ||(source&&object(d.payload).sourceJobId!==source.job.id))throw failure('PHASE7_SFS_DELIVERY_IDENTITY_UNPROVEN');
  if(c.safetyUnfollowDeliveryId&&c.safetyUnfollowDeliveryId!==d.id)throw failure('PHASE7_SFS_NEWER_CLEANUP_CONFLICT');
}
async function followReceipt(tx,c,generation){
  const rows=await tx.automationDelivery.findMany({where:{agencyId:c.agencyId,creatorId:c.creatorId,moduleKey:'sfs',
    actionType:'SFS_FOLLOW_TARGET',fanId:c.targetUserId,targetId:c.targetUserId,generation,status:'COMPLETED',
    writeCommitAt:{not:null},result:{path:['code'],equals:'followed'},payload:{path:['candidateId'],equals:c.id}},take:2});
  if(rows.length>1)throw failure('PHASE7_SFS_FOLLOW_RECEIPT_AMBIGUOUS');
  return rows[0]||null;
}
async function p14Basis(tx,source,d){
  if(!source)return null;
  const j=source.job;
  if(d.id!=='p14_sfs_cleanup_'+md5(j.id).slice(0,20)||d.generation!==1||j.status!=='canceled'
      ||j.error!=='P14_LEGACY_SFS_DISABLED'||d.idempotencyKey!==`sfs_unfollow:${j.creatorId}:${targetOf(j)}:1`)return null;
  const rows=await tx.$queryRawUnsafe('SELECT "checksum","started_at","finished_at" FROM "_prisma_migrations" WHERE "migration_name"=$1 AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL',P14);
  if(rows.length!==1||!(new Date(j.createdAt)<=new Date(rows[0].started_at)))return null;
  const sql=require('node:fs').readFileSync(require('node:path').join(__dirname,'../../prisma/migrations',P14,'migration.sql'));
  if(!require('../../scripts/database/phase7-migration-checksum').migrationChecksumReport(sql,rows[0].checksum).matches)return null;
  return 'P14_ACCEPTED_COMPENSATION:'+rows[0].checksum;
}
async function completeSource(tx,source,d,proof){
  const settled=await authority.recordCleanupSettlement(tx,{delivery:d,proof});
  if(!source)return settled;
  return putProof(tx,{...baseOf(source),creatorId:d.creatorId,targetId:d.targetId,providerSubject:proof.providerSubject,
    kind:'SETTLED',generation:d.generation,deliveryId:d.id,evidence:{basis:'CURRENT_CLEANUP_RECEIPT',candidateId:proof.evidence.candidateId,
      cleanupProofId:proof.id,settlementProofId:settled.id}});
}
async function attest(tx,{source,delivery,candidate,creator}){
  let d=delivery;
  if(!creator?.remoteId)throw failure('PHASE7_SFS_OWNER_UNPROVEN');
  if(d){
    checkDelivery(d,candidate,source);
    const existing=await authority.attachedProof(tx,{delivery:d,candidate,creator});
    if(existing){
      if(contract.isSettledCleanup(d))return completeSource(tx,source,d,existing);
      return source?authority.representLegacySource(tx,{source,proof:existing}):existing;
    }
  }
  const follow=await followReceipt(tx,candidate,d?.generation??candidate.generation);
  let basis=follow?'CURRENT_FOLLOW_RECEIPT':null;
  if(!d&&source&&follow){
    const key=`sfs_unfollow:${candidate.creatorId}:${candidate.targetUserId}:${follow.generation}`;
    const id='phase7_cleanup_'+sha(key).slice(0,32),date=new Date(source.job.runAfter);
    if(!Number.isFinite(date.getTime()))throw failure('PHASE7_SFS_SCHEDULE_INVALID');
    await tx.$executeRawUnsafe(`INSERT INTO "AutomationDelivery"
      ("id","agencyId","creatorId","originKind","moduleKey","actionType","targetId","fanId","idempotencyKey","generation",
       "priority","payload","status","scheduledAt","notBefore","maxAttempts","updatedAt")
      VALUES($1,$2,$3,'AUTOMATION','sfs','SFS_UNFOLLOW_TARGET',$4,$4,$5,$6,120,$7::jsonb,'QUEUED',CURRENT_TIMESTAMP,$8,20,CURRENT_TIMESTAMP)
      ON CONFLICT("idempotencyKey") DO NOTHING`,id,candidate.agencyId,candidate.creatorId,candidate.targetUserId,key,follow.generation,
      JSON.stringify({candidateId:candidate.id,safetyCleanup:true,legacyMigration:true,sourceJobId:source.job.id}),date);
    const found=await tx.automationDelivery.findUnique({where:{idempotencyKey:key}});
    d=found?await authority.lockDelivery(tx,found.id):null;
    if(d?.legacyCleanupProofId){
      checkDelivery(d,candidate,source);
      const existing=await authority.attachedProof(tx,{delivery:d,candidate,creator});
      if(contract.isSettledCleanup(d))return completeSource(tx,source,d,existing);
      return authority.representLegacySource(tx,{source,proof:existing});
    }
  }
  if(!d)throw failure('PHASE7_SFS_DELIVERY_IDENTITY_UNPROVEN');
  checkDelivery(d,candidate,source);
  basis ||= await p14Basis(tx,source,d);
  if(!basis)throw failure('PHASE7_SFS_FOLLOW_AUTHORITY_UNPROVEN');
  const metadata=object(candidate.metadata);
  if(metadata.followEffectOwnership==='OWNED'&&metadata.followEffectDeliveryId&&metadata.followEffectDeliveryId!==follow?.id)
    throw failure('PHASE7_SFS_NEWER_FOLLOW_CONFLICT');
  const base=source?baseOf(source):{cohortId:'automation_job',sourceTable:'AutomationDelivery',sourceId:d.id,
    sourceHash:sha(JSON.stringify([d.id,d.agencyId,d.creatorId,d.targetId,d.generation,d.payload]))};
  const proof=await putProof(tx,{...base,agencyId:d.agencyId,creatorId:d.creatorId,providerSubject:creator.remoteId,
    targetId:d.targetId,kind:'SFS_CLEANUP',generation:d.generation,deliveryId:d.id,
    evidence:{basis,candidateId:candidate.id,followDeliveryId:follow?.id||null}});
  await tx.automationDelivery.update({where:{id:d.id},data:{legacyCleanupProofId:proof.id}});
  d={...d,legacyCleanupProofId:proof.id};
  if(candidate.safetyUnfollowDeliveryId!==d.id)await tx.sfsTargetCandidate.update({where:{id:candidate.id},data:{safetyUnfollowDeliveryId:d.id}});
  if(contract.isSettledCleanup(d))return completeSource(tx,source,d,proof);
  return proof;
}
async function classifySource(tx,source,creator){
  const {job}=source,base=baseOf(source),result=object(job.result);
  if(job.type==='sfs_hunter'&&['sfs_used_marker','sfs_unfollow_due'].includes(job.action)){
    const targetId=targetOf(job),creatorId=job.creatorId;
    if(!creatorId||!targetId)throw failure('PHASE7_SFS_SCOPE_UNPROVEN',{sourceId:job.id});
    await lockDbAdvisoryXact({db:tx,key:`p14:sfs-target:${job.agencyId}:${creatorId}:${targetId}`});
    if(job.action==='sfs_used_marker'){
      if(job.status!=='done')throw failure('PHASE7_CONSUMPTION_STATUS_UNPROVEN');
      const proof=await putProof(tx,{...base,creatorId,targetId,providerSubject:creator?.remoteId||null,kind:'CONSUMED',
        consumptionKey:sha(JSON.stringify([job.agencyId,creatorId,targetId])),evidence:{basis:'LEGACY_SFS_USED_MARKER',completedAt:job.completedAt||null}});
      await tx.sfsTargetCandidate.updateMany({where:{agencyId:job.agencyId,creatorId,targetUserId:targetId,usedForever:false},data:{usedForever:true}});
      return proof;
    }
    const settled=await tx.phase7RetirementProof.findMany({where:{sourceTable:'AutomationJob',sourceId:job.id,sourceHash:source.sourceHash,kind:'SETTLED'},take:2});
    if(settled.length===1&&settled[0].agencyId===job.agencyId&&settled[0].creatorId===creatorId&&settled[0].targetId===targetId)return settled[0];
    if(settled.length)throw failure('PHASE7_SFS_SETTLEMENT_CONFLICT');
    const recovered=await authority.recoverSettledSource(tx,source,targetId);
    if(recovered)return recovered;
    const candidate=await authority.lockCandidate(tx,{agencyId:job.agencyId,creatorId,targetId});
    const rows=await tx.automationDelivery.findMany({where:{agencyId:job.agencyId,creatorId,moduleKey:'sfs',actionType:'SFS_UNFOLLOW_TARGET',
      payload:{path:['sourceJobId'],equals:job.id}},select:{id:true},take:2});
    if(rows.length>1)throw failure('PHASE7_SFS_DELIVERY_CONFLICT');
    const delivery=rows[0]?await authority.lockDelivery(tx,rows[0].id):null;
    return attest(tx,{source,delivery,candidate,creator});
  }
  if(job.type!=='sfs_hunter'&&job.status==='done'&&job.completedAt)return putProof(tx,{...base,kind:'SETTLED',evidence:{basis:'LEGACY_RECORDED_COMPLETION',type:job.type,action:job.action}});
  if(['canceled','expired'].includes(job.status)&&Number(job.attempts)===0&&!job.claimedAt&&!job.claimedByDeviceId
      &&!Object.keys(result).length&&/^P(14|15)_/.test(String(job.error||''))&&job.action!=='sfs_unfollow_due')
    return putProof(tx,{...base,kind:'NO_EFFECT',evidence:{basis:'NEVER_ATTEMPTED_RETIRED_JOB',type:job.type,action:job.action}});
  throw failure('PHASE7_LEGACY_OBLIGATION_RECONCILE_REQUIRED',{sourceId:job.id,action:job.action,jobStatus:job.status});
}
async function handoffLegacyJob({db,job,sourceHash}){
  return runDbTransaction(db,async tx=>{
    if(!job?.id||!job.agencyId||!sourceHash)throw failure('PHASE7_LEGACY_SOURCE_REQUIRED');
    const creator=await authority.lockScope(tx,{agencyId:job.agencyId,creatorId:job.creatorId||job.accountId});
    const source=await authority.readLegacySource(tx,{id:job.id,agencyId:job.agencyId,sourceHash});
    if(source.job.creatorId!==job.creatorId||source.job.accountId!==job.accountId)throw failure('PHASE7_LEGACY_SOURCE_CHANGED');
    return classifySource(tx,source,creator);
  },{timeout:10000});
}
async function handoffExistingCleanup({db,deliveryId}){
  return runDbTransaction(db,async tx=>{
    const hint=await tx.automationDelivery.findUnique({where:{id:deliveryId}});
    if(!contract.isLegacyCleanup(hint))throw failure('PHASE7_CLEANUP_SOURCE_INVALID');
    const creator=await authority.lockScope(tx,{agencyId:hint.agencyId,creatorId:hint.creatorId});
    const sourceId=object(hint.payload).sourceJobId;
    const source=typeof sourceId==='string'&&sourceId?await authority.readLegacySource(tx,{id:sourceId,agencyId:hint.agencyId,optional:true}):null;
    if(source){
      if(source.job.creatorId!==hint.creatorId||source.job.type!=='sfs_hunter'||source.job.action!=='sfs_unfollow_due'
          ||targetOf(source.job)!==hint.targetId)throw failure('PHASE7_CLEANUP_SOURCE_CONFLICT');
      const proof=await classifySource(tx,source,creator);
      const current=await authority.lockDelivery(tx,deliveryId);
      if(!contract.isLegacyCleanup(current)||current.agencyId!==source.job.agencyId||current.creatorId!==source.job.creatorId
          ||current.payload.sourceJobId!==source.job.id||current.targetId!==targetOf(source.job)||current.fanId!==current.targetId
          ||proof.deliveryId!==deliveryId)throw failure('PHASE7_CLEANUP_SOURCE_CONFLICT');
      if(proof.kind==='SETTLED'&&(!contract.isSettledCleanup(current)||!await authority.settlementForDelivery(tx,current)))
        throw failure('PHASE7_SFS_SETTLEMENT_CONFLICT');
      return {proofId:proof.id,kind:proof.kind,duplicate:Boolean(hint.legacyCleanupProofId),sourceReceiptId:proof.sourceReceiptId};
    }
    await lockDbAdvisoryXact({db:tx,key:`p14:sfs-target:${hint.agencyId}:${hint.creatorId}:${hint.targetId}`});
    const candidate=await authority.lockCandidate(tx,{agencyId:hint.agencyId,creatorId:hint.creatorId,targetId:hint.targetId});
    const delivery=await authority.lockDelivery(tx,deliveryId);
    const proof=await attest(tx,{delivery,candidate,creator});
    return {proofId:proof.id,kind:proof.kind,duplicate:Boolean(hint.legacyCleanupProofId)};
  },{timeout:10000});
}
async function handoffCleanupPage({db,after=null,limit=20}){
  const count=Math.max(1,Math.min(100,Math.floor(Number(limit)||20)));
  const rows=await db.$queryRawUnsafe(`SELECT "id","agencyId" FROM "AutomationDelivery"
    WHERE ${contract.LEGACY_SQL} AND ($1::text IS NULL OR ("agencyId","id")>($1,$2))
    ORDER BY "agencyId","id" LIMIT $3`,after?.agencyId||null,after?.id||null,count);
  const results=[];
  for(const row of rows){try{results.push({id:row.id,...await handoffExistingCleanup({db,deliveryId:row.id})});}
    catch(error){results.push({id:row.id,blocked:true,code:error.code||'HANDOFF_FAILED'});}}
  return {results,nextCursor:rows.length?{agencyId:rows.at(-1).agencyId,id:rows.at(-1).id}:null,hasMore:rows.length===count};
}
module.exports={handoffLegacyJob,handoffExistingCleanup,handoffCleanupPage,targetOf};
