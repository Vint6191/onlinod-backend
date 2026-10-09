'use strict';
const {fixture,scope}=require('../analytics-traffic/fixture.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=process.env.ONLINOD_CAMPAIGN_EVIDENCE||path.resolve('campaign-execution-evidence');fs.mkdirSync(out,{recursive:true});
const zone=process.env.ONLINOD_PROOF_TIMEZONE||'UTC';assert(['UTC','Etc/GMT-5','Etc/GMT+7'].includes(zone));
const checks=[],alive=setInterval(()=>{},1000),deadline=setTimeout(()=>{console.error('DEADLINE');process.exit(2)},300000);
async function check(name,fn){const result=await fn();checks.push({name,result});console.log('PASS',name,JSON.stringify(result||{}));}
(async()=>{const f=await fixture();try{
 const {db,root}=f;await db.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
 const s=await scope(db),now=new Date(),ago=d=>new Date(+now-d*86400000);
 require.cache[require.resolve(path.join(root,'src/prisma'))]={exports:db};
 const kernel=require(path.join(root,'src/services/db-commit-kernel')),work=require(path.join(root,'src/services/domain-work-authority-service')),
  projection=require(path.join(root,'src/services/campaign-read-projection-service')),read=require(path.join(root,'src/services/campaign-read-repository')),
  policy=require(path.join(root,'src/services/campaign-projection-policy'));
 async function write(fn){return kernel.runRootCommit(db,async({tx})=>{await require(path.join(root,'src/services/campaign-causal-activation-service')).enterCampaignWriterGeneration({db:tx});return fn(tx);},{profile:'JOB_CHUNK'});}
 const page=()=>read.readCampaignPage({db,creatorId:s.creatorId,rangeKey:'30d'});
 async function drain(){for(let i=0;i<160;i++){
  const r=await projection.runCampaignProjectionSweep({db});assert(r.ok,JSON.stringify(r));
  const pending=await db.domainWorkItem.count({where:{creatorId:s.creatorId,isOutstanding:true,workClass:{in:projection.CLASSES.filter(c=>c!=='CAMPAIGN_CLOCK')}}});
  if(!pending&&(await page()).projection.ready)return i+1;
 }console.error('STUCK',JSON.stringify({state:await db.campaignReadState.findMany(),ready:await page(),queue:await db.domainWorkItem.findMany({where:{creatorId:s.creatorId,isOutstanding:true,workClass:{in:projection.CLASSES}}}),zone:await db.$queryRawUnsafe('SHOW TimeZone')},(_,v)=>typeof v==='bigint'?String(v):v));throw Error('queue failed to converge');}
 await check('empty scope has correct zero totals and no projection bootstrap work',async()=>{
  const p=await page();assert(p.projection.ready);assert.equal(p.totals.campaigns,0);
  assert.equal(await db.campaignReadState.count(),0);
  assert.equal(await db.domainWorkItem.count({where:{workClass:'CAMPAIGN_BACKFILL'}}),0);
  return {projectionStates:0,backfillUnits:0,ready:true};
 });
 await check('trigger publication and dependency wake preserve UTC outside application transactions',async()=>{
  // scope() deliberately uses a plain transaction in the requested timezone.
  // This exercises the DB publisher used by old replicas and creator triggers.
  const initial=await db.domainWorkItem.findFirst({where:{creatorId:s.creatorId,workClass:'TRAFFIC_BACKFILL'}});
  assert(initial);assert(+initial.availableAt<=Date.now());assert(Date.now()-initial.availableAt<60000);
  const claim=await work.claimDomainWorkBatch({db,workClass:'TRAFFIC_BACKFILL',limit:1});assert(claim.items[0]);
  assert(+claim.items[0].leaseUntil>Date.now()+20000);
  const blocked=await work.blockDomainWorkClaim({db,item:claim.items[0],ownerToken:claim.ownerToken,
   dependencyKind:'QA_LIFECYCLE',dependencyKey:s.creatorId,dependencyRevision:0n});assert(blocked.blocked);
  const wake=await work.wakeDomainDependencyBatch({db,item:{agencyId:s.agencyId,dependencyKind:'QA_LIFECYCLE',dependencyKey:s.creatorId,dependencyRevision:1n},limit:1});
  assert.equal(wake.woken,1);
  const row=await db.domainWorkItem.findUnique({where:{id:initial.id}});
  assert.equal(row.state,'READY');assert(+row.availableAt<=Date.now());assert(Date.now()-row.availableAt<60000);
  assert.equal((await db.$queryRawUnsafe('SHOW TimeZone'))[0].TimeZone,zone);
  return {zone,publishedImmediately:true,leaseValid:true,wokenImmediately:true,callerTimezoneUnchanged:true};
 });
 await write(async tx=>{
  await tx.creatorCampaign.createMany({data:['a','b','c'].map(id=>({id:'campaign-'+id,agencyId:s.agencyId,creatorId:s.creatorId,externalCampaignId:id,name:id}))});
  await tx.creatorFan.create({data:{id:'fan',agencyId:s.agencyId,creatorId:s.creatorId,onlyFansUserId:'fan-external'}});
  await tx.creatorCampaignFan.createMany({data:['a','b','c'].map((id,i)=>({id:'member-'+id,agencyId:s.agencyId,creatorId:s.creatorId,campaignId:'campaign-'+id,fanRecordId:'fan',attributedAt:ago([10,5,2][i])}))});
  await tx.creatorFanValueCurrent.create({data:{id:'value',agencyId:s.agencyId,creatorId:s.creatorId,fanRecordId:'fan',availability:'AVAILABLE',source:'USER_PROFILE',valueObservedAt:ago(7/24),platformReportedTotalSpendCents:9000n}});
 });
 for(let begin=0;begin<1000;begin+=100)await write(tx=>tx.creatorFinancialTransaction.createMany({data:Array.from({length:100},(_,i)=>({id:'money-'+String(begin+i).padStart(5,'0'),agencyId:s.agencyId,creatorId:s.creatorId,fanRecordId:'fan',externalTransactionId:'ext-'+(begin+i),transactionType:'tip',transactionStatus:'done',amountCents:1,netCents:1,occurredAt:ago(1)}))}));
 await check('first campaign capture and rebuild converge to canonical money',async()=>{
  assert.equal((await page()).totals,null);const turns=await drain();const p=await page();assert.equal(p.totals.netCents,1000);assert.equal(p.rows.find(r=>r.id==='campaign-c').netCents,1000);
  return {turns,netCents:1000};
 });
 await check('old reader and old writer fail closed after forward cutover',async()=>{
  const [old]=await db.$queryRawUnsafe('SELECT "completedAt" FROM "CampaignReadState" WHERE "creatorId"=$1',s.creatorId);assert.equal(old.completedAt,null);
  await assert.rejects(()=>f.pg.exec('UPDATE "CampaignReadReceipt" SET "nextDueAt"=NULL'),/WRITER_RETIRED_OR_POLICY_CHANGED/);
  await assert.rejects(()=>f.pg.exec('UPDATE "CampaignReadSeed" SET "valueFreshnessMs"=43200000'),/WRITER_RETIRED_OR_POLICY_CHANGED/);
  return {legacyReadyBlocked:true,legacyCacheWriteBlocked:true,legacySeedSwitchBlocked:true};
 });
 await check('policy transition rebuilds and a claim from the old policy uses current authority',async()=>{
  await policy.changeCampaignProjectionPolicy({db,expectedGeneration:1,valueFreshnessMs:43200000});
  assert.equal((await page()).totals,null);await drain();assert.equal((await page()).totals.platformReportedFanSpendCents,9000);
  await write(tx=>tx.creatorFanValueCurrent.update({where:{id:'value'},data:{tipsSpentCents:1n}}));
  const claim=await work.claimDomainWorkBatch({db,workClass:'CAMPAIGN_VALUE',limit:1});assert(claim.items[0]);
  await assert.rejects(()=>f.pg.query('UPDATE "DomainWorkItem" SET "state"=\'READY\',"ownerToken"=NULL WHERE "id"=$1',[claim.items[0].id]),/WRITER_RETIRED_OR_POLICY_CHANGED/);
  await policy.changeCampaignProjectionPolicy({db,expectedGeneration:2,valueFreshnessMs:21600000});
  await assert.rejects(()=>f.pg.exec('SELECT "onlinod_campaign_projection_policy_v2"(2,43200000)'),/GENERATION_CONFLICT/);
  await assert.rejects(()=>f.pg.query('UPDATE "DomainWorkItem" SET "completedRevision"="claimedRevision" WHERE "id"=$1',[claim.items[0].id]),/WRITER_RETIRED_OR_POLICY_CHANGED/);
  await projection.runCampaignProjectionUnit({db,item:claim.items[0],ownerToken:claim.ownerToken});await drain();
  const p=await page(),fans=await read.readCampaignFanPage({db,creatorId:s.creatorId,campaignId:'campaign-c',rangeKey:'30d'});
  assert(p.projection.ready);assert.equal(p.projection.valueFreshnessMs,21600000);assert.equal(p.totals.ofValueKnownFans,0);assert.equal(fans.fans[0].fanValue.available,false);
  return {generation:p.projection.generation,ttl:p.projection.valueFreshnessMs,knownFans:0,oldNoopAckBlocked:true};
 });
 const counters={reads:0,writes:0,units:0};const repairPlans=[];
 const observe=tx=>new Proxy(tx,{get(t,k){
  if(k==='$queryRawUnsafe')return async(sql,...args)=>{const rows=await t.$queryRawUnsafe(sql,...args);if(sql.startsWith('SELECT "id","occurredAt" FROM "CreatorFinancialTransaction"')){counters.reads+=rows.length;repairPlans.push(await t.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,...args));}return rows;};
  if(k==='$executeRawUnsafe')return async(sql,...args)=>{if(sql.startsWith('INSERT INTO "CampaignReadReceipt"'))counters.writes++;return t.$executeRawUnsafe(sql,...args);};
  const v=t[k];return typeof v==='function'?v.bind(t):v;
 }});
 const watched=new Proxy(db,{get(t,k){if(k==='$transaction')return(fn,opts)=>t.$transaction(tx=>fn(observe(tx)),opts);const v=t[k];return typeof v==='function'?v.bind(t):v;}});
 async function repair(one=false){for(let i=0;i<100;i++){
  const c=await work.claimDomainWorkBatch({db,workClass:'CAMPAIGN_ATTRIBUTION',limit:1});if(!c.items.length)return;
  const r=await projection.runCampaignProjectionUnit({db:watched,item:c.items[0],ownerToken:c.ownerToken});counters.units++;
  if(one||r.done)return;
 }throw Error('repair failed to complete');}
 await check('unaffected history is neither read nor rewritten',async()=>{
  await write(tx=>tx.creatorCampaignFan.update({where:{id:'member-a'},data:{attributedAt:ago(11)}}));
  await repair();assert.equal(counters.reads,0);assert.equal(counters.writes,0);await drain();return {...counters};
 });
 await check('all 1000 payments cross a multi-page temporal cursor correctly',async()=>{
  Object.assign(counters,{reads:0,writes:0,units:0});await write(tx=>tx.creatorCampaignFan.update({where:{id:'member-c'},data:{attributedAt:ago(-1)}}));
  await repair();await drain();const p=await page();assert(p.projection.ready);assert.equal(p.rows.find(r=>r.id==='campaign-b').netCents,1000);assert.equal(p.rows.find(r=>r.id==='campaign-c').netCents,0);
  assert.equal(counters.reads,1000);return {zone,...counters,campaignB:1000,campaignC:0};
 });
 await check('unchanged receipt replay performs no physical receipt write',async()=>{
  Object.assign(counters,{reads:0,writes:0,units:0});await kernel.runRootCommit(watched,async({tx})=>{
   const p=await policy.enterCampaignProjection(tx);await projection.projectSource(tx,{...s,policy:p},'FINANCIAL','money-00000',new Date());
  },{profile:'JOB_CHUNK'});assert.equal(counters.writes,0);return {receiptWrites:0};
 });
 await check('new membership revision during repair does not lose an already traversed prefix',async()=>{
  await write(tx=>tx.creatorCampaignFan.update({where:{id:'member-c'},data:{attributedAt:ago(0.5)}}));
  await repair(true); // This edit is after all transactions; no money should move.
  await write(tx=>tx.creatorCampaignFan.update({where:{id:'member-c'},data:{attributedAt:ago(1.5)}}));
  await repair(true); // First money page moved to C.
  await write(tx=>tx.creatorCampaignFan.update({where:{id:'member-c'},data:{attributedAt:ago(0.25)}}));
  await drain();const p=await page();assert.equal(p.rows.find(r=>r.id==='campaign-b').netCents,1000);assert.equal(p.rows.find(r=>r.id==='campaign-c').netCents,0);
  return {canonicalWinner:'campaign-b',allPayments:1000};
 });
 await check('membership delete and same-time tie winner converge without duplicate money',async()=>{
  await write(tx=>tx.creatorCampaignFan.delete({where:{id:'member-b'}}));await drain();let p=await page();assert.equal(p.rows.find(r=>r.id==='campaign-a').netCents,1000);
  await write(tx=>tx.creatorCampaignFan.create({data:{id:'member-z',agencyId:s.agencyId,creatorId:s.creatorId,campaignId:'campaign-b',fanRecordId:'fan',attributedAt:ago(11)}}));await drain();p=await page();assert.equal(p.rows.find(r=>r.id==='campaign-b').netCents,1000);assert.equal(p.totals.netCents,1000);
  return {tieWinner:'member-z',netCents:1000};
 });
 fs.writeFileSync(path.join(out,'repair-plans-'+zone.replace(/[^A-Za-z0-9]/g,'_')+'.json'),JSON.stringify(repairPlans,null,2));
 fs.writeFileSync(path.join(out,'execution-v2-'+zone.replace(/[^A-Za-z0-9]/g,'_')+'.json'),JSON.stringify({runtime:process.version,zone,checks},null,2));
}finally{await f.close()}})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(()=>{clearInterval(alive);clearTimeout(deadline)});
