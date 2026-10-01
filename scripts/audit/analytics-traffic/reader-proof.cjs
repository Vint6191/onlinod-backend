"use strict";
const { fixture,scope }=require('./fixture.cjs');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const checks=[],alive=setInterval(()=>{},1000),deadline=setTimeout(()=>{console.error('LOCAL_PROOF_DEADLINE');process.exit(2)},180000);
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS',name)};
async function main(){
 const f=await fixture({newMigrations:false}),{db,pg,root}=f;
 try{
  const s=await scope(db),now=new Date(),today=new Date(now.toISOString().slice(0,10)),start=new Date(+today-30*86400000);
  // Old installed rows are created before the real publication migration. No
  // trigger is disabled and the production commit guard is never bypassed.
  await db.$executeRawUnsafe(`INSERT INTO "AnalyticsScanProof"("id","agencyId","creatorId","dataType","scanRunId","sourceTimezone","scanFrom","scanTo","requestedAt","serverReceivedAt","committedAt","status","collectorVersion","schemaVersion","scanGeneration","collectionReason","payloadChecksum","updatedAt")
   VALUES('legacy-proof',$1,$2,'EARNINGS','legacy-run','UTC',$3,$4,$5,$5,$5,'COMMITTED','earnings-v4',4,'legacy-generation','TEST','legacy-hash',$5)`,s.agencyId,s.creatorId,start,today,now);
  const days=Array.from({length:31},(_,i)=>new Date(+start+i*86400000));
  await db.creatorEarningsDaily.createMany({data:days.map((date,i)=>({id:'legacy-day-'+i,agencyId:s.agencyId,creatorId:s.creatorId,date,sourceTimezone:'UTC',sourceScanRunId:'legacy-run',scanProofId:'legacy-proof',totalCents:100,collectedAt:now}))});
  await db.analyticsCoverage.createMany({data:days.map((coverageDate,i)=>({id:'legacy-coverage-'+i,agencyId:s.agencyId,creatorId:s.creatorId,dataType:'EARNINGS',coverageDate,sourceTimezone:'UTC',status:'COMPLETE',scanProofId:'legacy-proof',lastVerifiedAt:now}))});
  await db.$disconnect();await pg.exec('DISCARD ALL');
  for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).filter(n=>n.startsWith('20261001')).sort())await pg.exec(fs.readFileSync(path.join(root,'prisma/migrations',name,'migration.sql'),'utf8'));
  await require(path.join(root,'scripts/database/analytics-traffic-indexes')).ensureIndexes(db,{create:true});
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

  const billing=require(path.join(root,'src/services/billing-wallet-service'));
  const home=require(path.join(root,'src/services/home-read-repository'));
  const ranges=require(path.join(root,'src/services/analytics-range-contract'));
  const reader=require(path.join(root,'src/services/published-earnings-read-repository'));
  const access=require(path.join(root,'src/services/analytics-viewer-read-service'));
  const traffic=require(path.join(root,'src/services/traffic-service'));
  async function reads(){
   const member=await db.agencyMember.findUnique({where:{id:'member-'+s.agencyId}});
   return {
    billing:await billing.readRolling30dRevenue({db,creatorId:s.creatorId}),
    batch:(await billing.readRolling30dRevenueBatch({db,creatorIds:[s.creatorId]})).get(s.creatorId),
    home:await home.readHomeTotals({db,agencyId:s.agencyId,member,money:true,billing:false,now,
      range:ranges.displayRangeBounds('30d',now),previous:ranges.previousDisplayRange('30d',now)}),
    ledger:await ledger.readCreatorLedgerOverview({db,creatorId:s.creatorId,rangeKey:'7d',includeMessages:false,includeCoveragePage:false}),
   };
  }
  await check('installed V1 proof is not billable, visible earnings or a Home total',async()=>{
   const r=await reads();assert.equal(r.billing.revenue30dCents,null);assert.deepEqual(r.billing,r.batch);
   assert.equal(r.home.totalCents,null);assert.equal(r.ledger.daily.earnings.length,0);assert.equal(r.ledger.totals.totalCents,null);
  });
  const current=await job({days:31,start:start.toISOString().slice(0,10)});await pages(current);
  const receipt=await lease.completeJob({...current.input,result:current.result});
  await check('every intermediate publication stage withholds uncommitted amounts in all earnings readers',async()=>{
   let steps=0;
   while((await db.analyticsPublication.findUnique({where:{id:receipt.publicationId}})).state==='PENDING'){
    const r=await reads();assert.equal(r.billing.revenue30dCents,null);assert.equal(r.home.totalCents,null);
    assert.equal(r.ledger.daily.earnings.length,0);assert.equal(r.ledger.verification.officialEarnings,false);
    await unit(receipt.publicationId);assert(++steps<20);
   }
  });
  await check('committed V2 days become readable together; billing closes UTC days and Home includes today',async()=>{
   const r=await reads();assert.equal(r.billing.revenue30dCents,3000);assert.deepEqual(r.billing,r.batch);
   assert.equal(r.home.totalCents,3000);assert.equal(r.home.reportingCreators,1);
   assert.equal(r.ledger.daily.earnings.length,7);assert.equal(r.ledger.totals.totalCents,700);assert.equal(r.ledger.verification.officialEarnings,true);
   assert.equal(r.ledger.totals.subscriptionsCents,null);
  });
  await check('an unproven correction cannot borrow complete coverage or publish a partial range total',async()=>{
   const row=await db.creatorEarningsDaily.findUnique({where:{id:'legacy-day-29'}});
   await db.creatorEarningsDaily.update({where:{id:row.id},data:{scanProofId:null,totalCents:999999}});
   const r=await reads();assert.equal(r.billing.revenue30dCents,null);assert.equal(r.home.totalCents,null);
   assert.equal(r.ledger.daily.earnings.some(x=>x.totalCents===999999),false);assert.equal(r.ledger.totals.totalCents,null);
   await db.creatorEarningsDaily.update({where:{id:row.id},data:{scanProofId:row.scanProofId,totalCents:row.totalCents}});
  });
  await check('unpublished days retain retry/backoff hints without certifying money',async()=>{
   const row=await db.creatorEarningsDaily.findUnique({where:{id:'legacy-day-29'}});
   const coverage=await db.analyticsCoverage.findUnique({where:{id:'legacy-coverage-29'}});
   await db.creatorEarningsDaily.update({where:{id:row.id},data:{scanProofId:null}});
   await db.analyticsCoverage.update({where:{id:coverage.id},data:{status:'PARTIAL',retryAfterAt:new Date(Date.now()+600000)}});
   const r=await reads();assert.equal(r.billing.revenue30dCents,null);assert.equal(r.ledger.verification.earningsDeferred,true);assert.equal(r.ledger.verification.officialEarnings,false);
   await db.creatorEarningsDaily.update({where:{id:row.id},data:{scanProofId:row.scanProofId}});
   await db.analyticsCoverage.update({where:{id:coverage.id},data:{status:coverage.status,retryAfterAt:coverage.retryAfterAt}});
  });
  const firstProof=(await db.analyticsScanProof.findFirst({where:{sourceJobId:current.row.id}})).id;
  const next=await job({days:1,start:days[29].toISOString().slice(0,10)});await pages(next);
  const nextReceipt=await lease.completeJob({...next.input,result:next.result});await drain(nextReceipt.publicationId);
  await check('two individually COMMITTED V2 proofs cannot be combined across different scan identities',async()=>{
   const coverage=await db.analyticsCoverage.findUnique({where:{id:'legacy-coverage-29'}});
   assert.notEqual(coverage.scanProofId,firstProof);
   await db.analyticsCoverage.update({where:{id:coverage.id},data:{scanProofId:firstProof}});
   const r=await reads();assert.equal(r.billing.revenue30dCents,null);assert.equal(r.home.totalCents,null);assert.equal(r.ledger.verification.officialEarnings,false);
   await db.analyticsCoverage.update({where:{id:coverage.id},data:{scanProofId:coverage.scanProofId}});
  });
  await check('retention of jobs and ingest pages cannot erase referenced durable revenue proof',async()=>{
   await db.analyticsIngestBatch.deleteMany({where:{sourceJobId:{in:[current.row.id,next.row.id]}}});
   await kernel.runRootCommit(db,({tx})=>tx.jobInstance.deleteMany({where:{id:{in:[current.row.id,next.row.id]}}}));
   const r=await reads();assert.equal(r.billing.revenue30dCents,3000);assert.equal(r.home.totalCents,3000);assert.equal(r.ledger.verification.officialEarnings,true);
  });
  await check('single pricing read uses one joined statement; 501 creators use bounded 250/250/1 aggregate batches',async()=>{
   const calls=[];const observed=new Proxy(db,{get(target,key){if(key==='$queryRawUnsafe')return async(sql,...args)=>{if(sql.includes('published_earnings_aggregate'))calls.push({sql,size:args[0].length,from:args[1],to:args[2]});return target.$queryRawUnsafe(sql,...args)};const value=target[key];return typeof value==='function'?value.bind(target):value}});
   assert.equal((await billing.readRolling30dRevenue({db:observed,creatorId:s.creatorId})).revenue30dCents,3000);assert.equal(calls.length,1);calls.length=0;
   const ids=[s.creatorId,...Array.from({length:500},(_,i)=>'empty-'+i)];const result=await billing.readRolling30dRevenueBatch({db:observed,creatorIds:ids});
   assert.equal(result.size,501);assert.deepEqual(calls.map(c=>c.size),[250,250,1]);assert.equal(result.get('empty-499').revenue30dCents,null);
   assert.equal((calls[0].to-calls[0].from)/86400000,29);
  });
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true)");
   await tx.user.create({data:{id:'reader',email:'reader@example.test',passwordHash:'fixture'}});
   await tx.agencyMember.create({data:{id:'reader-member',agencyId:s.agencyId,userId:'reader',role:'MANAGER',roleKey:'manager',assignedCreators:'all',permissions:{'money.view_earnings':true,'traffic.view':true}}});
  });
  const accessInput={db,userId:'reader',creatorId:s.creatorId,permission:'money.view_earnings'};
  await check('current authorized Analytics viewer reads a consistent snapshot',async()=>{
   const r=await access.readWithAnalyticsViewer(accessInput,({db:tx})=>ledger.readCreatorLedgerOverview({db:tx,creatorId:s.creatorId,rangeKey:'7d',includeMessages:false,includeCoveragePage:false}));assert.equal(r.totals.totalCents,700);
  });
  async function revoke(){await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true)");
   await tx.agencyMember.update({where:{id:'reader-member'},data:{accessEpoch:{increment:1}}});
  });}
  function afterSnapshot(hook){let once=false;return new Proxy(db,{get(target,key){if(key==='$transaction')return async(fn,options)=>{const result=await target.$transaction(fn,options);if(!once){once=true;await hook();}return result};const value=target[key];return typeof value==='function'?value.bind(target):value}});}
  await check('epoch change after the snapshot commits discards Analytics payload before response',async()=>{
   await assert.rejects(()=>access.readWithAnalyticsViewer({...accessInput,db:afterSnapshot(revoke)},async()=>({privateRevenue:123})),e=>e.code==='ANALYTICS_ACCESS_CHANGED');
  });
  await check('Traffic uses the same post-snapshot revocation boundary',async()=>{
   await assert.rejects(()=>traffic.getTrafficOverview({db:afterSnapshot(revoke),userId:'reader',creatorId:s.creatorId}),e=>e.code==='ANALYTICS_ACCESS_CHANGED');
  });
  await check('user disable after the snapshot is observed outside RepeatableRead',async()=>{
   await assert.rejects(()=>access.readWithAnalyticsViewer({...accessInput,db:afterSnapshot(()=>db.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true)");
    return tx.user.update({where:{id:'reader'},data:{disabledAt:new Date()}});
   }))},async()=>({privateRevenue:123})),e=>e.code==='ANALYTICS_ACCESS_CHANGED');
  });
  await check('disabled user and foreign agency are denied before reading domain facts',async()=>{
   let touched=false;await assert.rejects(()=>access.readWithAnalyticsViewer(accessInput,async()=>{touched=true}),e=>e.status===403);assert.equal(touched,false);
   const other=await scope(db,{agencyId:'foreign-agency',creatorId:'foreign-creator',userId:'foreign-user'});
   await assert.rejects(()=>access.readWithAnalyticsViewer({...accessInput,userId:s.userId,creatorId:other.creatorId},async()=>{touched=true}),e=>e.status===403);assert.equal(touched,false);
  });
  await check('database itself rejects a non-UTC duplicate; no historical timezone double counting',async()=>{
   await db.$disconnect();await pg.exec('DISCARD ALL');
   await assert.rejects(()=>pg.query(`INSERT INTO "CreatorEarningsDaily"("id","agencyId","creatorId","date","sourceTimezone","totalCents","updatedAt") VALUES('non-utc',$1,$2,$3,'Europe/Berlin',777777,CURRENT_TIMESTAMP)`,[s.agencyId,s.creatorId,today]),/CreatorEarningsDaily_timezone_check/);
  });
  console.log(JSON.stringify({runtime:process.version,postgres:'PGlite, real schema and SQL; controlled interleavings, not native multi-session contention',checks},null,2));
 }catch(e){console.error("PROOF_ERROR",e?.message,e?.stack);throw e;}finally{await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{clearInterval(alive);clearTimeout(deadline)});
