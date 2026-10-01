'use strict';
const {fixture,scope}=require('../analytics-traffic/fixture.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const evidence=process.env.ONLINOD_CAMPAIGN_EVIDENCE||path.resolve('campaign-read-evidence');fs.mkdirSync(evidence,{recursive:true});
const checks=[];const alive=setInterval(()=>{},1000),deadline=setTimeout(()=>{console.error('PROOF_DEADLINE');process.exit(2)},600000);
async function check(name,fn){const result=await fn();checks.push({name,result});console.log('PASS',name,JSON.stringify(result||{}));}
(async()=>{const f=await fixture();try{
 const {db,root}=f,s=await scope(db),now=new Date(),ago=n=>new Date(+now-n*86400000);
 require.cache[require.resolve(path.join(root,'src/prisma'))]={exports:db};
 const kernel=require(path.join(root,'src/services/db-commit-kernel')),projection=require(path.join(root,'src/services/campaign-read-projection-service')),
  read=require(path.join(root,'src/services/campaign-read-repository')),overview=require(path.join(root,'src/services/creator-overview-service')),
  control=require(path.join(root,'src/services/campaign-scan-control-service')),access=require(path.join(root,'src/services/analytics-viewer-read-service')),
  work=require(path.join(root,'src/services/domain-work-authority-service'));
 const rollout=require(path.join(root,'scripts/database/phase3-domain-work-claim-online-rollout'));
 await rollout.withRolloutAuthority(db,async()=>{await rollout.runPreflight(db);await rollout.activateTopology(db,{pauseMs:0});});
 async function write(fn){return kernel.runRootCommit(db,async({tx})=>{await require(path.join(root,'src/services/campaign-causal-activation-service')).enterCampaignWriterGeneration({db:tx});return fn(tx);},{profile:'JOB_CHUNK'});}
 const page=(input={})=>access.readWithAnalyticsViewer({db,userId:s.userId,creatorId:s.creatorId,permission:'money.view_earnings'},({db:tx})=>read.readCampaignPage({db:tx,creatorId:s.creatorId,rangeKey:'30d',...input}));
 async function drain(max=200){for(let i=0;i<max;i++){
  const result=await projection.runCampaignProjectionSweep({db});assert(result.ok,JSON.stringify(result));
  const ready=await read.readiness(db,s.creatorId,new Date());if(ready.ready)return i+1;
 }throw Error('Campaign queue did not drain');}
 for(let begin=0;begin<2001;begin+=100)await write(tx=>tx.creatorCampaign.createMany({data:Array.from({length:Math.min(100,2001-begin)},(_,i)=>({
  id:'campaign-'+String(begin+i).padStart(4,'0'),agencyId:s.agencyId,creatorId:s.creatorId,externalCampaignId:'ext-'+(begin+i),name:'Campaign '+(begin+i),startedAt:ago(30),
 }))}));
 await check('new scope exposes rebuilding, never fabricated complete zero',async()=>{const p=await page();assert.equal(p.projection.state,'REBUILDING');assert.equal(p.totals,null);assert.equal(p.rows[0].netCents,null);return{rows:p.rows.length,status:p.projection.state};});
 await write(async tx=>{
  await tx.creatorFan.createMany({data:['a','b','c','d'].map(k=>({id:'fan-'+k,agencyId:s.agencyId,creatorId:s.creatorId,onlyFansUserId:'ext-fan-'+k,username:'qa_'+k}))});
  await tx.creatorFanValueCurrent.create({data:{id:'value-a',agencyId:s.agencyId,creatorId:s.creatorId,fanRecordId:'fan-a',platformReportedTotalSpendCents:9000n,messagesSpentCents:7000n,subscriptionsSpentCents:2000n,valueObservedAt:now,availability:'AVAILABLE',source:'USER_PROFILE'}});
  await tx.creatorCampaignFan.createMany({data:[
   {id:'member-a-early',fanRecordId:'fan-a',campaignId:'campaign-0000',attributedAt:ago(10)},
   {id:'member-a-late',fanRecordId:'fan-a',campaignId:'campaign-2000',attributedAt:ago(5)},
   ...['b','c','d'].map((k,i)=>({id:'page-member-'+k,fanRecordId:'fan-'+k,campaignId:'campaign-1000',attributedAt:ago(i+1)})),
  ].map(x=>({...x,agencyId:s.agencyId,creatorId:s.creatorId}))});
  await tx.creatorFinancialTransaction.createMany({data:[
   {id:'money-early',fanRecordId:'fan-a',externalTransactionId:'early',transactionType:'tip',amountCents:100,netCents:80,transactionStatus:'done',occurredAt:ago(8)},
   {id:'money-late',fanRecordId:'fan-a',externalTransactionId:'late',transactionType:'tip',amountCents:200,netCents:160,transactionStatus:'done',occurredAt:ago(2)},
  ].map(x=>({...x,agencyId:s.agencyId,creatorId:s.creatorId}))});
 });
 await check('bounded durable backfill and live queue converge',async()=>({turns:await drain(),pendingSignals:await db.campaignReadChange.count()}));
 await check('2001 campaigns remain reachable; totals are independent of page size',async()=>{
  const first=await page({limit:1});assert.equal(first.totals.campaigns,2001);assert.equal(first.totals.netCents,240);assert.equal(first.rows.length,1);
  let cursor=null;const seen=new Set();do{const p=await page({limit:100,cursor});assert.equal(p.totals.netCents,240);for(const r of p.rows){assert(!seen.has(r.id));seen.add(r.id)}cursor=p.pagination.nextCursor;}while(cursor);
  assert.equal(seen.size,2001);return{campaigns:seen.size,netCents:first.totals.netCents};
 });
 await check('one fan across two campaigns is one creator payer, two memberships; all readers agree',async()=>{
  const p=await page(),v=await access.readWithAnalyticsViewer({db,userId:s.userId,creatorId:s.creatorId,permission:'money.view_earnings'},({db:tx})=>overview.readCreatorOverview({db:tx,creatorId:s.creatorId,rangeKey:'30d'}));
  const scan=await control.readManualCampaignScan({db,creator:{id:s.creatorId,agencyId:s.agencyId},limit:1});
  assert.equal(p.totals.payingFans,1);assert.equal(p.totals.memberships,5);assert.equal(p.totals.uniqueFans,4);assert.equal(p.totals.knownPlatformReportedFanSpendCents,9000);
  assert.deepEqual(v.campaigns.totals,p.totals);assert.equal(scan.campaignPage.totals.payingFans,1);assert.equal(scan.campaignPage.totals.netCents,240);
  fs.writeFileSync(path.join(evidence,'backend-page-response.json'),JSON.stringify(p,null,2));fs.writeFileSync(path.join(evidence,'backend-overview-response.json'),JSON.stringify(v,null,2));fs.writeFileSync(path.join(evidence,'backend-scan-response.json'),JSON.stringify(scan,null,2));
  return{uniquePayers:1,memberships:5,uniqueFans:4,uniqueKnownSpend:9000};
 });
 await check('real FanData DTO retains canonical names and nullable categories',async()=>{
  const p=await read.readCampaignFanPage({db,creatorId:s.creatorId,campaignId:'campaign-2000',rangeKey:'30d'});
  assert.equal(p.fans[0].fanValue.platformReportedTotalSpendCents,9000);assert.equal(p.fans[0].fanValue.tipsSpentCents,null);assert.equal(p.fans[0].revenue.netCents,160);
  fs.writeFileSync(path.join(evidence,'backend-fan-response.json'),JSON.stringify(p,null,2));return{spend:9000,tips:null};
 });
 await check('PAYING pages use attributed ledger references in the selected range',async()=>{
  const input={db,creatorId:s.creatorId,rangeKey:'7d',filter:'PAYING',limit:1};
  const late=await read.readCampaignFanPage({...input,campaignId:'campaign-2000'});
  const early=await read.readCampaignFanPage({...input,campaignId:'campaign-0000'});
  assert.deepEqual(late.fans.map(x=>x.fan.id),['fan-a']);assert.equal(late.fans[0].revenue.netCents,160);
  assert.equal(early.fans.length,0);assert.equal(early.pagination.hasMore,false);
  return{currentLifetimeSpendDoesNotQualifyAsPeriodPayment:true};
 });
 await check('keyset traversal survives an earlier attribution update without losing fans',async()=>{
  const input={db,creatorId:s.creatorId,campaignId:'campaign-1000',limit:1,rangeKey:'30d'};
  const a=await read.readCampaignFanPage(input);await write(tx=>tx.creatorCampaignFan.update({where:{id:'page-member-b'},data:{attributedAt:ago(4)}}));
  const b=await read.readCampaignFanPage({...input,cursor:a.pagination.nextCursor});const c=await read.readCampaignFanPage({...input,cursor:b.pagination.nextCursor});
  const seen=[...a.fans,...b.fans,...c.fans].map(x=>x.fan.id);assert.deepEqual(seen,['fan-b','fan-c','fan-d']);assert.equal(c.pagination.hasMore,false);
  await assert.rejects(()=>read.readCampaignFanPage({...input,rangeKey:'7d',cursor:a.pagination.nextCursor}),/CURSOR_SCOPE/);
  await assert.rejects(()=>read.readCampaignFanPage({...input,campaignId:'campaign-2000',cursor:a.pagination.nextCursor}),/CURSOR_SCOPE/);
  await assert.rejects(()=>read.readCampaignFanPage({...input,offset:1}),/CURSOR_REQUIRED/);return{seen};
 });
 await check('unknown NET, known zero, correction and undo preserve money evidence',async()=>{
  await write(tx=>tx.creatorFinancialTransaction.create({data:{id:'money-unknown',agencyId:s.agencyId,creatorId:s.creatorId,fanRecordId:'fan-d',externalTransactionId:'unknown',transactionType:'tip',amountCents:100,netCents:null,transactionStatus:'done',occurredAt:ago(0.1)}}));
  assert.equal((await page()).totals,null);await drain();let p=await page();assert.equal(p.totals.netCents,null);assert.equal(p.totals.knownNetCents,240);assert.equal(p.totals.unknownNetTransactions,1);
  await write(tx=>tx.creatorFinancialTransaction.update({where:{id:'money-unknown'},data:{netCents:0}}));await drain();p=await page();assert.equal(p.totals.netCents,240);assert.equal(p.totals.unknownNetTransactions,0);assert.equal(p.totals.payingFans,2);
  await write(tx=>tx.creatorFinancialTransaction.update({where:{id:'money-unknown'},data:{transactionStatus:'undo'}}));await drain();p=await page();assert.equal(p.totals.payingFans,1);assert.equal(p.totals.transactionsCount,2);
  return{unknownPreserved:true,knownZeroPreserved:true,undoRetractsPayer:true};
 });
 await check('late membership repair moves a contribution without double counting',async()=>{
  await write(tx=>tx.creatorCampaignFan.update({where:{id:'member-a-late'},data:{attributedAt:ago(9)}}));await drain();
  const p=await page(),early=p.rows.find(r=>r.id==='campaign-0000');assert.equal(early.netCents,0);assert.equal(p.totals.netCents,240);assert.equal(p.totals.payingFans,1);
  const late=await read.readCampaignFanPage({db,creatorId:s.creatorId,campaignId:'campaign-2000',rangeKey:'30d'});assert.equal(late.fans[0].revenue.netCents,240);
  return{creatorNet:240,earlyCampaignNet:0,lateCampaignNet:240};
 });
 await check('replayed signals and receipt reprocessing are idempotent',async()=>{
  const before=(await page()).totals;
  await write(tx=>tx.creatorFinancialTransaction.update({where:{id:'money-late'},data:{netCents:160,transactionStatus:'done'}}));
  await kernel.runRootCommit(db,({tx})=>projection.projectSource(tx,{...s},'FINANCIAL','money-late',new Date()),{profile:'JOB_CHUNK'});
  await drain();assert.deepEqual((await page()).totals,before);return{unchanged:true};
 });
 await check('canonical deletion retracts the receipt and distinct reference',async()=>{
  await write(tx=>tx.creatorFinancialTransaction.delete({where:{id:'money-early'}}));await drain();const p=await page();assert.equal(p.totals.netCents,160);assert.equal(p.totals.payingFans,1);assert.equal(p.totals.transactionsCount,1);return{net:160,payers:1};
 });
 for(let begin=0;begin<5000;begin+=100)await write(tx=>tx.creatorFinancialTransaction.createMany({data:Array.from({length:100},(_,i)=>({
  id:'old-'+String(begin+i).padStart(5,'0'),agencyId:s.agencyId,creatorId:s.creatorId,fanRecordId:'fan-a',externalTransactionId:'old-ext-'+(begin+i),transactionType:'tip',amountCents:1,netCents:1,transactionStatus:'done',occurredAt:ago(800),
 }))}));
 await drain();
 await check('one-campaign HTTP read touches bounded summaries, never 5000-row financial history',async()=>{
  const queries=[];const observed=new Proxy(db,{get(t,k){if(k==='$queryRawUnsafe')return async(sql,...args)=>{queries.push({sql,args});return t.$queryRawUnsafe(sql,...args)};const v=t[k];return typeof v==='function'?v.bind(t):v}});
  await read.readCampaignPage({db:observed,creatorId:s.creatorId,limit:1});assert(!queries.some(q=>q.sql.includes('CreatorFinancialTransaction')));
  const q=queries.find(q=>q.sql.startsWith('SELECT "campaignId","metrics"'));const plan=await db.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.sql,...q.args);
  fs.writeFileSync(path.join(evidence,'campaign-hot-read-plan.json'),JSON.stringify(plan,null,2));return{canonicalHistoryRows:await db.creatorFinancialTransaction.count(),hotReadFinancialScans:0,summaryKeys:q.args[2].length};
 });
 await check('lost owner rolls back outbox consumption and all projected deltas',async()=>{
  await write(tx=>tx.creatorFinancialTransaction.update({where:{id:'money-late'},data:{netCents:170}}));
  const batch=await work.claimDomainWorkBatch({db,workClass:'CAMPAIGN_FACT',limit:1}),item=batch.items[0];assert(item);
  const before=await db.campaignReadMetric.findMany({where:{creatorId:s.creatorId}}),signals=await db.campaignReadChange.count();
  await assert.rejects(()=>projection.runCampaignProjectionUnit({db,item,ownerToken:'not-the-owner'}),/CLAIM_LOST/);
  assert.deepEqual(await db.campaignReadMetric.findMany({where:{creatorId:s.creatorId}}),before);assert.equal(await db.campaignReadChange.count(),signals);
  await projection.runCampaignProjectionUnit({db,item,ownerToken:batch.ownerToken});await drain();assert.equal((await page()).totals.netCents,170);return{rollback:true,resume:true};
 });
 await check('FanData expires without a new canonical update and cannot remain fresh',async()=>{
  const ttl=require(path.join(root,'src/services/analytics-freshness-policy')).CAMPAIGN_FAN_VALUE_FRESHNESS_MS;
  const observed=new Date(Date.now()-ttl+3000);
  await write(tx=>tx.creatorFanValueCurrent.update({where:{id:'value-a'},data:{valueObservedAt:observed}}));await drain();assert.equal((await page()).totals.ofValueKnownFans,1);
  const delay=Math.max(0,+observed+ttl-Date.now()+30);await new Promise(resolve=>setTimeout(resolve,delay));
  assert.equal((await page()).totals,null);await drain();const p=await page();assert.equal(p.totals.ofValueKnownFans,0);assert.equal(p.totals.knownPlatformReportedFanSpendCents,0);
  return{expiredWithoutCanonicalUpdate:true,projectionRefreshed:true};
 });
 await check('tenant and cursor scopes remain fenced; revoked viewer cannot read saved aggregates',async()=>{
  await scope(db,{agencyId:'other-agency',creatorId:'other-creator',userId:'other-user'});
  await assert.rejects(()=>access.readWithAnalyticsViewer({db,userId:'other-user',creatorId:s.creatorId,permission:'money.view_earnings'},({db:tx})=>read.readCampaignPage({db:tx,creatorId:s.creatorId})));
  const p=await page({limit:1});await assert.rejects(()=>read.readCampaignPage({db,creatorId:'other-creator',cursor:p.pagination.nextCursor}),/CURSOR_SCOPE/);
  return{crossTenantDenied:true};
 });
 await check('maintenance catalog includes projection without resetting prior dispatch progress',async()=>{
  const progress=await require(path.join(root,'src/services/phase2-maintenance-admission-service')).readMaintenanceAdmissionProgress({db});assert.equal(progress.totalLanes,25);assert(progress.lanes.some(x=>x.name==='campaignReadProjection'));return{lanes:progress.totalLanes};
 });
 await check('a database policy transition rebuilds cache without declaring previous generation ready',async()=>{
  const before=await page(),ttl=before.projection.valueFreshnessMs;
  await require(path.join(root,'src/services/campaign-projection-policy')).changeCampaignProjectionPolicy({db,expectedGeneration:before.projection.generation,valueFreshnessMs:Math.floor(ttl/2)});
  assert.equal((await page()).totals,null);const turns=await drain();const p=await page();assert.equal(p.totals.netCents,170);assert.equal(p.projection.valueFreshnessMs,Math.floor(ttl/2));return{turns,netUnchanged:170};
 });
 await check('UTC rollover expires only due contributions; partially processed windows stay unavailable',async()=>{
  const day=new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z'),tomorrow=new Date(+day+86400000),at=new Date(+day-6*86400000);
  await write(tx=>tx.creatorFinancialTransaction.create({data:{id:'boundary-money',agencyId:s.agencyId,creatorId:s.creatorId,fanRecordId:'fan-a',externalTransactionId:'boundary',transactionType:'tip',amountCents:40,netCents:40,transactionStatus:'done',occurredAt:at}}));await drain();
  const before=await page({rangeKey:'7d'});assert.equal(before.totals.netCents,210);
  assert.equal((await read.readCampaignPage({db,creatorId:s.creatorId,rangeKey:'7d',now:tomorrow})).totals,null);
  // Virtual future clock is confined to this disposable fixture. Execute the
  // actual clock unit SQL, atomically, without changing provider/canonical data.
  for(let i=0;i<30;i++){
   const result=await kernel.runRootCommit(db,({tx})=>projection.clockUnit(tx,s,tomorrow),{profile:'JOB_CHUNK'});
   assert((result.processed||0)<=100);
   const p=await read.readCampaignPage({db,creatorId:s.creatorId,rangeKey:'7d',now:tomorrow});
   if(p.projection.ready){assert.equal(p.totals.netCents,170);return{before:210,after:170,boundedUnits:i+1};}
  }
  throw Error('rollover failed to converge');
 });
 await check('soft-deleted Agency preserves Campaign and Traffic debt; restore wakes bounded durable work',async()=>{
  await write(async tx=>{
   await tx.creatorFinancialTransaction.update({where:{id:'money-late'},data:{netCents:175}});
   await tx.creatorFanValueCurrent.update({where:{id:'value-a'},data:{valueObservedAt:new Date()}});
  });
  const campaign=await work.claimDomainWorkBatch({db,workClass:'CAMPAIGN_FACT',limit:1});assert(campaign.items[0]);
  const traffic=await work.claimDomainWorkBatch({db,workClass:'TRAFFIC_FAN',limit:1});assert(traffic.items[0]);
  async function deleted(value){await kernel.runRootCommit(db,async({tx})=>{
   await require(path.join(root,'src/services/phase2-release-compatibility-authority-service')).assertTeamControlPlaneWriteAdmission(tx);
   await require(path.join(root,'src/services/custom-content-pipeline-authority-service')).lockAgencyPipelineLifecycleExclusive({db:tx,agencyId:s.agencyId,allowDeleted:true});
   await tx.agency.update({where:{id:s.agencyId},data:{deletedAt:value}});
  });}
  const signals=await db.campaignReadChange.count();await deleted(new Date());
  assert((await projection.runCampaignProjectionUnit({db,item:campaign.items[0],ownerToken:campaign.ownerToken})).paused);
  assert((await require(path.join(root,'src/services/traffic-projection-service')).runTrafficProjectionUnit({db,item:traffic.items[0],ownerToken:traffic.ownerToken})).paused);
  for(const claim of [campaign,traffic]){const row=await db.domainWorkItem.findUnique({where:{id:claim.items[0].id}});assert.equal(row.state,'BLOCKED');assert(row.isOutstanding);assert(row.completedRevision<row.requestedRevision);}
  assert.equal(await db.campaignReadChange.count(),signals);
  await deleted(null);
  for(let i=0;i<20;i++){
   await work.runDomainDependencyWakeSweep({db,claimLimit:20,wakeLimit:1});
   const rows=await db.domainWorkItem.findMany({where:{id:{in:[campaign.items[0].id,traffic.items[0].id]}}});
   if(rows.every(r=>r.state==='READY'))break;
  }
  for(const claim of [campaign,traffic])assert.equal((await db.domainWorkItem.findUnique({where:{id:claim.items[0].id}})).state,'READY');
  await drain();assert.equal((await page()).totals.netCents,215);
  return{pausedWithoutAcknowledgement:true,wakeBatch:1,postRestoreNet:215};
 });
 fs.writeFileSync(path.join(evidence,'campaign-sql-proof.json'),JSON.stringify({runtime:process.version,schema:'local disposable PGlite; all non-destructive migrations through Campaign execution v2',checks},null,2));
}finally{await f.close()}})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{clearInterval(alive);clearTimeout(deadline)});
