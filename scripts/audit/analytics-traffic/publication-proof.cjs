'use strict';
const proofAlive=setInterval(()=>{},1000);
const proofDeadline=setTimeout(()=>{console.error('LOCAL_PROOF_DEADLINE');process.exit(2)},180000);
const {fixture,scope}=require('./fixture.cjs');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const checks=[];
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS',name);};
async function main(){
 const f=await fixture(); const {db,root}=f;
 try{
  const s=await scope(db);
  require.cache[require.resolve(path.join(root,'src/prisma'))]={exports:db};
  const lease=require(path.join(root,'src/services/job-lease-service'));
  const pub=require(path.join(root,'src/services/analytics-publication-service'));
  const kernel=require(path.join(root,'src/services/db-commit-kernel'));
  const ledger=require(path.join(root,'src/services/creator-analytics-ledger-service'));
  const planning=require(path.join(root,'src/services/job-planning-repository'));
  await db.workerDevice.create({data:{id:'qa-device',agencyId:s.agencyId,userId:s.userId,lastSeenAt:new Date()}});
  let seq=0;
  async function job({days=3,start='2026-01-01',jobKey='fetch_earnings',params={}}={}){
   const id='publication-'+(++seq), run='run-'+id, requestedAt=new Date().toISOString(), token='local-'+id;
   const end=new Date(new Date(start).getTime()+(days-1)*86400000).toISOString().slice(0,10);
   const epoch=(await db.agencyMember.findUnique({where:{id:'member-'+s.agencyId}})).accessEpoch;
   const row=await kernel.runRootCommit(db,async({tx})=>tx.jobInstance.create({data:{id,agencyId:s.agencyId,creatorId:s.creatorId,jobKey,scope:'creator',status:'CLAIMED',
    claimedByDeviceId:'qa-device',leaseTokenHash:crypto.createHash('sha256').update(token).digest('hex'),leaseRevision:1,
    leaseMemberId:'member-'+s.agencyId,leaseAccessEpoch:epoch,leaseUntil:new Date(Date.now()+600000),
    params:{analyticsContractVersion:1,scanFrom:start,scanTo:end,sourceTimezone:'UTC',requestedAt,scanGeneration:run,collectionReason:'TEST',...(jobKey!=='fetch_earnings'?{collectionContractVersion:1,collectionType:jobKey==='fetch_campaigns'?'CAMPAIGNS':'FINANCIAL',collectionMode:'catchup',collectionGeneration:run,collectionRequestedAt:requestedAt}:{}),...params}}}));
   const input={jobId:id,userId:s.userId,deviceId:'qa-device',leaseToken:token,leaseRevision:1};
   const result={schemaVersion:4,collectorVersion:'earnings-v4',scanRunId:run,observedAt:requestedAt,
    range:{startDate:start,endDate:end},dailyBatchCount:Math.ceil(days/50),dailyCount:days,scannerRejected:0,chartComplete:true,dailyComplete:true};
   return{row,input,result,run,start,days};
  }
  async function pages(j,{missingLast=false,duplicate=false}={}){
   for(let begin=0;begin<j.days;begin+=50){
    const rows=Array.from({length:Math.min(50,j.days-begin)},(_,i)=>({date:new Date(new Date(j.start).getTime()+(begin+i)*86400000).toISOString().slice(0,10),sourceTimezone:'UTC',totalCents:100,currency:'USD'}));
    if(missingLast&&begin+rows.length===j.days)rows.pop();
    if(duplicate&&begin>0&&rows.length)rows[0].date=j.start;
    await lease.progressJob({...j.input,chunkResult:{kind:'earnings_daily_page',schemaVersion:4,collectorVersion:'earnings-v4',scanRunId:j.run,observedAt:j.result.observedAt,batchKey:'run:'+j.run+':daily:page-'+begin,scannerRejected:0,rows}});
   }
  }
  async function unit(id){await db.analyticsPublication.update({where:{id},data:{availableAt:new Date(0)}});return pub.runAnalyticsPublicationUnit({db,publicationId:id});}
  async function drain(id){for(let i=0;i<50;i++){const p=await db.analyticsPublication.findUnique({where:{id}});if(p.state!=='PENDING')return p;await unit(id);}throw Error('publication did not terminate');}
  let first,receipt;
  await check('actual leased pages -> atomic PUBLISHING receipt; no prematurely committed proof',async()=>{
   first=await job();await pages(first);receipt=await lease.completeJob({...first.input,result:first.result});
   assert.equal(receipt.accepted,true);assert.equal(receipt.job.status,'PUBLISHING');
   assert.equal(await db.analyticsScanProof.count({where:{sourceJobId:first.row.id,status:'COMMITTED'}}),0);
   assert.equal((await db.jobInstance.findUnique({where:{id:first.row.id}})).leaseTokenHash,null);
  });
  await check('lost-response replay binds identity and canonical payload; conflicting payload rejected',async()=>{
   const replay=await lease.completeJob({...first.input,result:{...first.result}});assert.equal(replay.publicationId,receipt.publicationId);
   await assert.rejects(()=>lease.completeJob({...first.input,result:{...first.result,dailyCount:99}}),e=>e.code==='ANALYTICS_PUBLICATION_PAYLOAD_CONFLICT');
   await assert.rejects(()=>lease.completeJob({...first.input,leaseToken:'wrong',result:first.result}),e=>e.code==='ANALYTICS_PUBLICATION_IDENTITY_MISMATCH');
   assert.equal(await db.analyticsPublication.count({where:{jobId:first.row.id}}),1);
  });
  await check('planner cannot mutate the parameters of accepted publication',async()=>{
   const row=await db.jobInstance.findUnique({where:{id:first.row.id}});
   const updated=await planning.updatePlannedJobDemand({db,job:row,params:{broken:true},publish:false});assert.equal(updated.updated,false);
   assert.deepEqual((await db.jobInstance.findUnique({where:{id:row.id}})).params,row.params);
  });
  await check('revocation after acceptance does not orphan publication; scope remains server-owned',async()=>{
   await db.$transaction(async tx=>{await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true)");
    await tx.agencyMember.update({where:{id:'member-'+s.agencyId},data:{accessEpoch:{increment:1}}});});
   const final=await drain(receipt.publicationId);assert.equal(final.state,'COMMITTED');
   const proof=await db.analyticsScanProof.findFirst({where:{sourceJobId:first.row.id}});assert.equal(proof.status,'COMMITTED');assert.equal(proof.proofVersion,2);
   assert.equal((await db.jobInstance.findUnique({where:{id:first.row.id}})).status,'DONE');
   assert.equal(await db.creatorEarningsDaily.count({where:{scanProofId:proof.id}}),3);
   await assert.rejects(()=>lease.completeJob({...first.input,result:first.result}),e=>e.code==='EXECUTION_ACCESS_EPOCH_STALE');
  });
  await check('missing current-run day cannot borrow retained history from an earlier run',async()=>{
   const j=await job();await pages(j,{missingLast:true});const accepted=await lease.completeJob({...j.input,result:j.result});const final=await drain(accepted.publicationId);
   assert.equal(final.state,'REJECTED');assert.equal((await db.analyticsScanProof.findFirst({where:{sourceJobId:j.row.id}})).status,'PARTIAL');
  });
  await check('cross-page duplicate cannot replace a missing date in unique-day proof',async()=>{
   const j=await job({days:101});await pages(j,{duplicate:true});const accepted=await lease.completeJob({...j.input,result:j.result});const final=await drain(accepted.publicationId);
   assert.equal(final.state,'REJECTED');
  });
  await check('201 days resume through bounded publication pages and link only this run',async()=>{
   const j=await job({days:201});await pages(j);const accepted=await lease.completeJob({...j.input,result:j.result});
   let largest=0,units=0;
   while((await db.analyticsPublication.findUnique({where:{id:accepted.publicationId}})).state==='PENDING'){
    const before=await db.creatorEarningsDaily.count({where:{creatorId:s.creatorId,sourceJobId:j.row.id,scanProofId:{not:null}}});
    await unit(accepted.publicationId);units++;
    const after=await db.creatorEarningsDaily.count({where:{creatorId:s.creatorId,sourceJobId:j.row.id,scanProofId:{not:null}}});largest=Math.max(largest,after-before);assert(units<30);
   }
   assert(largest<=200);assert(units>=8);assert.equal((await db.analyticsPublication.findUnique({where:{id:accepted.publicationId}})).state,'COMMITTED');
  });
  await check('changing a superseded input day between phases resets proof traversal',async()=>{
   const j=await job();await pages(j);const accepted=await lease.completeJob({...j.input,result:j.result});await unit(accepted.publicationId);await unit(accepted.publicationId);
   const newer=await job();await pages(newer,{missingLast:true});
   const reset=await unit(accepted.publicationId);assert.equal(reset.inputChanged,true);
   const final=await drain(accepted.publicationId);assert.equal(final.state,'REJECTED');
  });
  await check('post-acceptance progress cannot inject more rows',async()=>{
   await assert.rejects(()=>lease.progressJob({...first.input,chunkResult:{kind:'earnings_daily_page'}}),e=>['JOB_NOT_CLAIMED','EXECUTION_ACCESS_EPOCH_STALE'].includes(e.code));
  });
  async function collector(key,{partial=false,version='campaigns-v13',attempts=0}={}){
   const j=await job({jobKey:key});
   if(attempts)await kernel.runRootCommit(db,({tx})=>tx.jobInstance.update({where:{id:j.row.id},data:{attempts}}));
   let result;
   if(key==='fetch_campaigns'){
    await lease.progressJob({...j.input,chunkResult:{kind:'campaigns_page',schemaVersion:4,collectorVersion:version,scanRunId:j.run,batchKey:'run:'+j.run+':'+version+':campaigns:1',scannerRejected:0,campaigns:[]}});
    result={schemaVersion:4,collectorVersion:version,scanRunId:j.run,campaignPagesComplete:!partial,claimersComplete:true,truncated:false,campaignCount:0,campaignBatchCount:1,claimerBatchCount:0,fanValuesRequested:0,fanValuesFetched:0,fanValuesUnavailable:0,fanValuesComplete:true};
   }else{
    await lease.progressJob({...j.input,chunkResult:{kind:'financial_transactions_page',scanRunId:j.run,pageNumber:1,transactions:[]}});
    result={scanRunId:j.run,sourceBoundaryReached:!partial,scannerRejected:0};
   }
   const receipt=await lease.completeJob({...j.input,result});return{j,result,receipt,final:await drain(receipt.publicationId)};
  }
  for(const key of ['fetch_campaigns','financial_transactions_scan']){
   await check(key+' server publication commits exact current-generation proof',async()=>{
    const x=await collector(key);assert.equal(x.final.state,'COMMITTED',JSON.stringify(x.final.response));
    assert.equal(x.final.response.job.status,'DONE');
    const state=await (key==='fetch_campaigns'?db.creatorCampaignCollectionState:db.creatorFinancialCollectionState).findUnique({where:{creatorId:s.creatorId}});
    assert(state.lastCatchupCompletedAt instanceof Date);assert.equal(state.activeGeneration,x.j.run);
   });
   await check(key+' partial proof schedules a fresh generation and preserves the retry boundary',async()=>{
    const x=await collector(key,{partial:true});assert.equal(x.final.state,'REJECTED');
    const next=await db.jobInstance.findUnique({where:{id:x.j.row.id}});assert.equal(next.status,'SCHEDULED');assert.equal(next.attempts,1);
    assert.notEqual(next.params.collectionGeneration,x.j.run);assert(new Date(next.params.collectionAuthorityRequestedAt)>new Date(x.j.row.params.collectionRequestedAt));
    assert.equal(next.nextRunAt.toISOString(),x.final.response.job.retryAt);assert.equal(next.continuation,null);
    const replay=await lease.completeJob({...x.j.input,result:x.result});assert.equal(replay.publicationId,x.receipt.publicationId);assert.equal(replay.job.status,'SCHEDULED');
   });
  }
  await check('older compatible Campaign protocol is requeued without consuming quarantine attempts',async()=>{
   const x=await collector('fetch_campaigns',{version:'campaigns-v11',attempts:4});const next=await db.jobInstance.findUnique({where:{id:x.j.row.id}});
   assert.equal(next.status,'SCHEDULED');assert.equal(next.attempts,4);assert.equal(next.lastError,'fetch_campaigns_protocol_superseded');assert.equal(x.final.response.protocolSuperseded,true);
  });
  await check('fifth partial Financial traversal becomes terminal and retains replay receipt',async()=>{
   const x=await collector('financial_transactions_scan',{partial:true,attempts:4});const next=await db.jobInstance.findUnique({where:{id:x.j.row.id}});
   assert.equal(next.status,'FAILED');assert.equal(next.attempts,5);assert.equal(x.final.response.job.status,'FAILED');
  });
  await check('malformed Campaign completion fails before releasing the device lease',async()=>{
   const j=await job({jobKey:'fetch_campaigns'});
   await assert.rejects(()=>lease.completeJob({...j.input,result:{scanRunId:j.run}}),/Invalid campaign completion contract/);
   assert.equal(await db.analyticsPublication.count({where:{jobId:j.row.id}}),0);assert.equal((await db.jobInstance.findUnique({where:{id:j.row.id}})).status,'CLAIMED');
  });
  await check('fault after publication checkpoint rolls back both links and cursor; replay resumes once',async()=>{
   const j=await job({days:3,start:'2025-02-01'});await pages(j);const receipt=await lease.completeJob({...j.input,result:j.result});
   while((await db.analyticsPublication.findUnique({where:{id:receipt.publicationId}})).stage!=='EARNINGS_LINK_DAYS')await unit(receipt.publicationId);
   await db.analyticsPublication.update({where:{id:receipt.publicationId},data:{availableAt:new Date(0)}});
   const before=await db.analyticsPublication.findUnique({where:{id:receipt.publicationId}});
   const faulty=new Proxy(db,{get(target,key){if(key==='$transaction')return (fn,opts)=>target.$transaction(tx=>fn(new Proxy(tx,{get(t,k){if(k==='analyticsPublication')return{...t[k],update:async args=>{await t[k].update(args);throw Error('CONTROLLED_CHECKPOINT_FAULT')}};return t[k]}})),opts);const v=target[key];return typeof v==='function'?v.bind(target):v}});
   await assert.rejects(()=>pub.runAnalyticsPublicationUnit({db:faulty,publicationId:receipt.publicationId}),/CONTROLLED_CHECKPOINT_FAULT/);
   assert.equal(await db.creatorEarningsDaily.count({where:{sourceJobId:j.row.id,scanProofId:{not:null}}}),0);
   const after=await db.analyticsPublication.findUnique({where:{id:receipt.publicationId}});assert.equal(after.stage,before.stage);assert.deepEqual(after.cursor,before.cursor);
   assert.equal((await drain(receipt.publicationId)).state,'COMMITTED');
  });
  await check('maintenance catalog contains both new lanes and preserves the full old catalog',async()=>{
   const m=require(path.join(root,'src/services/phase2-maintenance-admission-service'));const state=await m.readMaintenanceAdmissionProgress({db});assert.equal(state.totalLanes,24);
   assert(state.lanes.some(x=>x.name==='analyticsPublication'));assert(state.lanes.some(x=>x.name==='trafficProjection'));
  });
  await check('database freezes receipt payload and accepted job parameters against older binaries',async()=>{
   const j=await job({days:1,start:'2025-01-01'});await pages(j);const receipt=await lease.completeJob({...j.input,result:j.result});
   await db.$disconnect();await f.pg.exec('DISCARD ALL');
   await assert.rejects(()=>f.pg.query('UPDATE "AnalyticsPublication" SET "payload"=$2::jsonb WHERE "id"=$1',[receipt.publicationId,'{}']),/ANALYTICS_PUBLICATION_IMMUTABLE/);
   await assert.rejects(()=>f.pg.query('UPDATE "JobInstance" SET "params"=$2::jsonb WHERE "id"=$1',[j.row.id,'{}']),/ANALYTICS_ACCEPTED_JOB_IMMUTABLE/);
  });
  console.log(JSON.stringify({runtime:process.version,postgres:'PGlite single connection; not native concurrent PostgreSQL',checks},null,2));
 }finally{await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{clearInterval(proofAlive);clearTimeout(proofDeadline)});
