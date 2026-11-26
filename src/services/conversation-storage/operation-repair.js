'use strict';
const c=require('./common');
const POLICY_VERSION=1;
const PAGE=64;
// A lost checkpoint is recoverable only while its original defer/cancel/request
// receipts prove causality. Neither an ERROR label nor a retry-looking string
// alone authorizes restoring a cancelled operation.
async function candidate(db,scopeId,fanId){
 const work=await c.one(db,'SELECT * FROM crm_analysis_work WHERE scope_id=$1 AND fan_id=$2',scopeId,fanId);
 if(!work)return null;
 const persona=await c.one(db,'SELECT persona_revision FROM crm_scope WHERE scope_id=$1',scopeId);
 const run=await c.one(db,"SELECT * FROM crm_analysis_run WHERE scope_id=$1 AND fan_id=$2 ORDER BY created_at DESC,run_id DESC LIMIT 1",scopeId,fanId);
 const settlement=run?await c.one(db,"SELECT command_id,result,expires_at FROM crm_command_receipt WHERE scope_id=$1 AND result->>'runId'=$2 AND result->>'status' IN ('deferred','cancelled') ORDER BY expires_at DESC,command_id DESC LIMIT 1",scopeId,run.run_id):null;
 const requestHashes=run?[true,false].map(force=>c.hash([run.lease_actor,run.lease_device,{kind:'analysis.request',fanId,config:work.config,force}])):[];
 const request=await c.one(db,"SELECT command_id,request_hash,result,expires_at FROM crm_command_receipt WHERE scope_id=$1 AND result->>'generation'=$2 AND result->>'runId' IS NULL AND request_hash=ANY($3::text[]) ORDER BY expires_at DESC,command_id DESC LIMIT 1",scopeId,String(work.generation),requestHashes);
 const currentRun=await c.one(db,'SELECT run_id FROM crm_analysis_run WHERE scope_id=$1 AND fan_id=$2 AND generation=$3 LIMIT 1',scopeId,fanId,work.generation);
 let action='MANUAL_REVIEW',reason='No surviving receipt proves a safe state repair';
 if(work.active_run_id==null && run?.state==='CANCELLED' && work.state==='READY' && work.failures>0 && work.failures<4
   && Number(run.generation)===Number(work.generation) && c.hash(run.config)===c.hash(work.config)
   && Number(run.persona_revision)===Number(persona?.persona_revision) && settlement?.result?.status==='deferred'){
  action='RESTORE_CHECKPOINT';reason='Accepted nonterminal defer retained the same generation and compatible checkpoint';
 }else if(work.active_run_id==null && work.state==='ERROR' && work.failures===1 && run?.state==='CANCELLED'
   && Number(run.generation)<Number(work.generation) && !currentRun && settlement?.result?.status==='cancelled'
   && request && new Date(request.expires_at)<=new Date(settlement.expires_at)){
  action='RELEASE_NEW_GENERATION';reason='An older cancellation followed the request for an unattempted newer generation';
 }
 const snapshot={work,run,persona,settlement,request,currentRun};
 return {fanId,action,reason,expectedHash:c.hash(snapshot),runId:run?.run_id||null,generation:Number(work.generation),snapshot};
}
async function planCrmOperationRepair(analysis,ctx,{runId=c.randomUUID(),targetAt=new Date().toISOString(),after='',limit=PAGE}={}){
 c.check(Number.isFinite(Date.parse(targetAt)),'REPAIR_TARGET_INVALID',400);
 const rows=await c.rows(analysis.db,"SELECT fan_id FROM crm_analysis_work WHERE scope_id=$1 AND fan_id>$2 AND active_run_id IS NULL AND state IN ('READY','ERROR') AND failures>0 ORDER BY fan_id LIMIT $3",ctx.scopeId,after,Math.max(1,Math.min(PAGE,limit)));
 const items=[];
 for(const row of rows){const p=await candidate(analysis.db,ctx.scopeId,row.fan_id);if(!p)continue;
  if(new Date(p.snapshot.run?.updated_at||0).getTime()>Date.parse(targetAt)
    ||new Date(p.snapshot.settlement?.expires_at||0).getTime()-2*86400000>Date.parse(targetAt)){
   p.action='MANUAL_REVIEW';p.reason='State was observed after the fixed repair target';
  }
  if(p.action==='RESTORE_CHECKPOINT')try{await analysis.history.validateInput(ctx,p.snapshot.run.input)}catch(error){p.action='MANUAL_REVIEW';p.reason=String(error.code||'Checkpoint history cannot be proved current')}
  const {snapshot,...item}=p;items.push(item);
 }
 return {runId,policyVersion:POLICY_VERSION,mode:'dry-run',scope:{agencyId:ctx.agencyId,creatorId:ctx.creatorId,platformCreatorId:ctx.platformCreatorId,scopeId:ctx.scopeId},targetAt,cursor:rows.at(-1)?.fan_id||after,hasMore:rows.length===Math.min(PAGE,limit),items,
  counts:{examined:items.length,repairable:items.filter(x=>x.action!=='MANUAL_REVIEW').length,manualReview:items.filter(x=>x.action==='MANUAL_REVIEW').length}};
}
async function applyCrmOperationRepair(analysis,ctx,manifest){
 c.check(manifest?.policyVersion===POLICY_VERSION && manifest.scope?.scopeId===ctx.scopeId
  && manifest.scope?.agencyId===ctx.agencyId && manifest.scope?.creatorId===ctx.creatorId,'REPAIR_SCOPE_INVALID',400);
 c.check(typeof manifest.runId==='string' && manifest.runId.length<=80 && Number.isFinite(Date.parse(manifest.targetAt))
  && Array.isArray(manifest.items) && manifest.items.length<=PAGE,'REPAIR_MANIFEST_INVALID',400);
 const results=[];
 for(const item of manifest.items){
  if(item.action==='MANUAL_REVIEW'){results.push({fanId:item.fanId,status:'MANUAL_REVIEW'});continue}
  c.platformId(item.fanId);
  const observed=await candidate(analysis.db,ctx.scopeId,item.fanId);
  if(observed?.action==='RESTORE_CHECKPOINT')try{await analysis.history.validateInput(ctx,observed.snapshot.run.input)}catch{results.push({fanId:item.fanId,status:'MANUAL_REVIEW'});continue}
  const result=await c.transaction(analysis.db,async tx=>{
   await c.one(tx,'SELECT scope_id FROM crm_scope WHERE scope_id=$1 FOR UPDATE',ctx.scopeId);
   const id=`r03:${manifest.runId}:${item.fanId}`;
   const old=await c.one(tx,"SELECT fields FROM crm_audit WHERE id=$1 AND scope_id=$2 AND kind='operation_repair'",id,ctx.scopeId);
   if(old){c.check(old.fields.expectedHash===item.expectedHash,'REPAIR_RECEIPT_CONFLICT');return {...old.fields.result,replayed:true}}
   const current=await candidate(tx,ctx.scopeId,item.fanId);
   if(!current || current.expectedHash!==item.expectedHash || current.action!==item.action || current.action==='MANUAL_REVIEW')return {fanId:item.fanId,status:'STALE'};
   if(item.action==='RESTORE_CHECKPOINT'){
    await c.exec(tx,"UPDATE crm_analysis_run SET state='RUNNING',lease_until=now(),updated_at=now() WHERE run_id=$1 AND state='CANCELLED'",current.runId);
    await c.exec(tx,"UPDATE crm_analysis_work SET active_run_id=$3,next_run_at=now() WHERE scope_id=$1 AND fan_id=$2 AND generation=$4 AND active_run_id IS NULL AND state='READY'",ctx.scopeId,item.fanId,current.runId,current.generation);
   }else{
    await c.exec(tx,"UPDATE crm_analysis_run SET state='SUPERSEDED',updated_at=now() WHERE run_id=$1 AND state='CANCELLED'",current.runId);
    await c.exec(tx,"UPDATE crm_analysis_work SET state='READY',last_error='',failures=0,next_run_at=now() WHERE scope_id=$1 AND fan_id=$2 AND generation=$3 AND active_run_id IS NULL AND state='ERROR'",ctx.scopeId,item.fanId,current.generation);
   }
   await analysis.publish(ctx,item.fanId,tx);
   const result={fanId:item.fanId,status:'REPAIRED',action:item.action,runId:current.runId,generation:current.generation};
   await c.exec(tx,"INSERT INTO crm_audit(id,scope_id,fan_id,actor_id,kind,revision,fields) SELECT $1,$2,$3,$4,'operation_repair',revision,$5::jsonb FROM crm_scope WHERE scope_id=$2",id,ctx.scopeId,item.fanId,ctx.actorId,JSON.stringify({policyVersion:POLICY_VERSION,runId:manifest.runId,targetAt:manifest.targetAt,expectedHash:item.expectedHash,result}));
   return result;
  });results.push(result);
 }
 return {runId:manifest.runId,policyVersion:POLICY_VERSION,mode:'apply',scope:manifest.scope,targetAt:manifest.targetAt,cursor:manifest.cursor,status:'COMPLETE',results,
  counts:{repaired:results.filter(x=>x.status==='REPAIRED'&&!x.replayed).length,replayed:results.filter(x=>x.replayed).length,stale:results.filter(x=>x.status==='STALE').length,manualReview:results.filter(x=>x.status==='MANUAL_REVIEW').length}};
}
async function inventoryAmbiguousDialogWaits(db,ctx,{after='',limit=PAGE}={}){
 let cursor=[String(after||''),'\uffff'];
 if(String(after).startsWith('r03:')){try{cursor=JSON.parse(Buffer.from(String(after).slice(4),'base64url').toString('utf8'));}catch{c.check(false,'REPAIR_CURSOR_INVALID',400)}}
 c.check(Array.isArray(cursor)&&cursor.length===2&&cursor.every(value=>typeof value==='string'),'REPAIR_CURSOR_INVALID',400);
 const take=Math.max(1,Math.min(PAGE,Math.floor(Number(limit)||PAGE)));
 const rows=await c.rows(db,"SELECT dialog_id,owner,desired,completed,attempts,reason,status,next_at FROM dialog_archive_debt WHERE scope_id=$1 AND (dialog_id,owner)>($2,$3) AND desired>completed AND status='STOPPED' AND attempts<12 ORDER BY dialog_id,owner LIMIT $4",ctx.scopeId,...cursor,take);
 const last=rows.at(-1),next=last?'r03:'+Buffer.from(JSON.stringify([last.dialog_id,last.owner])).toString('base64url'):after;
 return {policyVersion:POLICY_VERSION,mode:'dry-run',scopeId:ctx.scopeId,cursor:next,hasMore:rows.length===take,items:rows.map(row=>({...row,action:'MANUAL_REVIEW',expectedHash:c.hash(row),explanation:'Old debt has no durable settlement kind; reason text alone cannot distinguish an intentional stop from the legacy wait bug'}))};
}
module.exports={POLICY_VERSION,planCrmOperationRepair,applyCrmOperationRepair,inventoryAmbiguousDialogWaits};
