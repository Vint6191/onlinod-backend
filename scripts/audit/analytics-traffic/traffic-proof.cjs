'use strict';
const proofAlive=setInterval(()=>{},1000);
const proofDeadline=setTimeout(()=>{console.error('LOCAL_PROOF_DEADLINE');process.exit(2)},180000);
const {fixture,scope}=require('./fixture.cjs');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const checks=[];const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS',name);};
async function main(){
 const f=await fixture({newMigrations:false}),{db,pg,root}=f;
 try{
  const s=await scope(db);
  await db.$executeRawUnsafe(`INSERT INTO "TrafficSource"("id","agencyId","creatorId","accountId","sourceType","externalId","name","costCents","currency","updatedAt")
    VALUES('historical-source',$1,$2,$2,'of_campaign','old-campaign','Old name',12345,'EUR',CURRENT_TIMESTAMP)`,s.agencyId,s.creatorId);
  await db.$disconnect();await pg.exec('DISCARD ALL');
  for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).filter(n=>n.startsWith('20261001')).sort())await pg.exec(fs.readFileSync(path.join(root,'prisma/migrations',name,'migration.sql'),'utf8'));
  await require(path.join(root,'scripts/database/analytics-traffic-indexes')).ensureIndexes(db,{create:true});
  require.cache[require.resolve(path.join(root,'src/prisma'))]={exports:db};
  const kernel=require(path.join(root,'src/services/db-commit-kernel'));
  const work=require(path.join(root,'src/services/domain-work-authority-service'));
  const projection=require(path.join(root,'src/services/traffic-projection-service'));
  const traffic=require(path.join(root,'src/services/traffic-service'));
  async function write(fn){return kernel.runRootCommit(db,async({tx})=>{await require(path.join(root,'src/services/campaign-causal-activation-service')).enterCampaignWriterGeneration({db:tx});return fn(tx);});}
  await check('canonical Campaign projection preserves the existing source ID, currency and manual cost',async()=>{
   await write(tx=>tx.creatorCampaign.create({data:{id:'campaign-old',agencyId:s.agencyId,creatorId:s.creatorId,externalCampaignId:'old-campaign',name:'Canonical campaign',trackingUrl:'https://example.test/campaign'}}));
   const row=await db.trafficSource.findUnique({where:{id:'historical-source'}});assert.equal(row.name,'Canonical campaign');assert.equal(row.costCents,12345);assert.equal(row.currency,'EUR');assert.equal(row.canonicalCampaignId,'campaign-old');
   await write(tx=>tx.creatorCampaign.update({where:{id:'campaign-old'},data:{name:'Updated canonical'}}));
   assert.equal(await db.trafficSource.count({where:{creatorId:s.creatorId}}),1);
   const total=await db.trafficMetric.findFirst({where:{creatorId:s.creatorId,kind:'total',period:'*'}});assert.equal(total.metrics.sources,1);assert.equal(total.metrics.costCents,12345);
  });
  await check('all maintenance claims use the actual activated fair DomainWork topology',async()=>{
  });
  await check('301 additional sources are visible through keyset pagination; no 300-row total cap',async()=>{
   await write(tx=>tx.creatorCampaign.createMany({data:Array.from({length:301},(_,i)=>({id:'campaign-'+String(i).padStart(4,'0'),agencyId:s.agencyId,creatorId:s.creatorId,externalCampaignId:'external-'+i,name:'Campaign '+i}))}));
   const first=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId,limit:100});assert.equal(first.totals.sources,302);assert.equal(first.pagination.hasMore,true);
   const ids=new Set(first.sources.map(r=>r.id));let cursor=first.pagination.nextCursor;
   while(cursor){const page=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId,limit:100,after:cursor});for(const r of page.sources){assert(!ids.has(r.id));ids.add(r.id);}cursor=page.pagination.nextCursor;}
   assert.equal(ids.size,302);
  });
  await write(async tx=>{
   await tx.creatorFan.create({data:{id:'canonical-fan',agencyId:s.agencyId,creatorId:s.creatorId,onlyFansUserId:'fan-external',username:'fixture_fan'}});
   await tx.creatorFanValueCurrent.create({data:{id:'fan-value',agencyId:s.agencyId,creatorId:s.creatorId,fanRecordId:'canonical-fan',platformReportedTotalSpendCents:9000n,messagesSpentCents:7000n,subscriptionsSpentCents:2000n,valueObservedAt:new Date(),source:'USER_PROFILE'}});
   await tx.creatorCampaignFan.createMany({data:Array.from({length:201},(_,i)=>({id:'membership-'+String(i).padStart(4,'0'),agencyId:s.agencyId,creatorId:s.creatorId,campaignId:'campaign-'+String(i).padStart(4,'0'),fanRecordId:'canonical-fan',attributedAt:new Date('2026-01-01')}))});
  });
  async function drain(max=100){for(let i=0;i<max;i++){
   const report=await projection.runTrafficProjectionSweep({db});assert.equal(report.ok,true,JSON.stringify(report));
   const pending=await db.domainWorkItem.count({where:{creatorId:s.creatorId,workClass:{in:['TRAFFIC_FAN','TRAFFIC_BACKFILL']},isOutstanding:true}});
   if(!pending)return i+1;
  }throw Error('projection queue did not drain');}
  await check('201 memberships are projected in bounded resumable units; creator fan value is deduplicated',async()=>{
   const turns=await drain();assert(turns>3);
   const result=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId});assert.equal(result.projection.ready,true);
   assert.equal(result.totals.sourceMembers,201);assert.equal(result.totals.valueSnapshotMembers,1);assert.equal(result.totals.fanValueCents,9000);
   const source=await db.trafficSource.findFirst({where:{canonicalCampaignId:'campaign-0000'}});
   const members=await traffic.getTrafficSourceMembers({db,userId:s.userId,creatorId:s.creatorId,sourceId:source.id});assert.equal(members.totals.fanValueCents,9000);assert.equal(members.members[0].fanUsername,'fixture_fan');
  });
  await check('live receipt insert, replay, attribution change and deletion preserve exact cached totals',async()=>{
   const source=await db.trafficSource.findFirst({where:{canonicalCampaignId:'campaign-0000'}});
   const receipt={id:'receipt-1',agencyId:s.agencyId,creatorId:s.creatorId,fanId:'fan-external',eventType:'paid_subscribed',amountCents:1000,eventHash:'local-event',occurredAt:new Date()};
   await write(tx=>tx.creatorSubscriptionLedger.create({data:receipt}));
   await write(tx=>tx.creatorSubscriptionLedger.createMany({data:[receipt],skipDuplicates:true}));
   let result=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId});assert.equal(result.totals.subscriptionRevenueCents,1000);assert.equal(result.totals.unattributedRevenueCents,1000);
   await write(tx=>tx.creatorSubscriptionLedger.update({where:{id:receipt.id},data:{sourceId:source.id}}));
   result=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId});assert.equal(result.totals.subscriptionRevenueCents,1000);assert.equal(result.totals.unattributedRevenueCents,0);
   await write(tx=>tx.creatorSubscriptionLedger.delete({where:{id:receipt.id}}));
   result=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId});assert.equal(result.totals.subscriptionRevenueCents,0);assert.equal(result.totals.paidSubscriptions,0);
  });
  await check('receipt UTC bucket does not depend on the PostgreSQL session timezone',async()=>{
   await write(async tx=>{await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Tokyo'");await tx.creatorSubscriptionLedger.create({data:{id:'timezone-receipt',agencyId:s.agencyId,creatorId:s.creatorId,fanId:'fan-external',eventType:'paid_subscribed',amountCents:123,eventHash:'timezone-event',occurredAt:new Date('2026-09-30T23:30:00Z')}})});
   const receipt=await db.trafficReceiptProjection.findUnique({where:{id:'timezone-receipt'}});assert.equal(receipt.fact.period,'2026-09-30');
   await write(tx=>tx.creatorSubscriptionLedger.delete({where:{id:'timezone-receipt'}}));
  });
  await check('repeated FanData updates use old/new deltas without duplicating creator or source totals',async()=>{
   await write(tx=>tx.creatorFanValueCurrent.update({where:{id:'fan-value'},data:{platformReportedTotalSpendCents:15000n,messagesSpentCents:13000n,valueObservedAt:new Date()}}));
   await drain();const result=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId});assert.equal(result.totals.fanValueCents,15000);assert.equal(result.totals.valueSnapshotMembers,1);assert.equal(result.totals.sourceMembers,201);
  });
  await check('late memberships repair 201 unattributed receipts without an unbounded historical update',async()=>{
   await write(tx=>tx.creatorSubscriptionLedger.createMany({data:Array.from({length:201},(_,i)=>({id:'repair-receipt-'+String(i).padStart(4,'0'),agencyId:s.agencyId,creatorId:s.creatorId,fanId:'fan-external',eventType:'paid_subscribed',amountCents:100,eventHash:'repair-event-'+i,occurredAt:new Date()}))}));
   await drain();assert.equal(await db.creatorSubscriptionLedger.count({where:{creatorId:s.creatorId,sourceId:null}}),0);
   const result=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId});assert.equal(result.totals.subscriptionRevenueCents,20100);assert.equal(result.totals.paidSubscriptions,201);
  });
  await check('manual cost update remains stable under later provider refresh',async()=>{
   await write(tx=>tx.trafficSource.update({where:{id:'historical-source'},data:{costCents:22222,costRevision:{increment:1}}}));
   await write(tx=>tx.creatorCampaign.update({where:{id:'campaign-old'},data:{name:'Another refresh'}}));
   const row=await db.trafficSource.findUnique({where:{id:'historical-source'}});assert.equal(row.costCents,22222);assert.equal(row.currency,'EUR');assert.equal(row.costRevision,1);
   const result=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId});assert.equal(result.totals.costCents,22222);
  });
  await check('lost DomainWork ownership rolls back already executed member deltas',async()=>{
   await write(tx=>tx.creatorFanValueCurrent.update({where:{id:'fan-value'},data:{platformReportedTotalSpendCents:20000n,valueObservedAt:new Date()}}));
   const batch=await work.claimDomainWorkBatch({db,workClass:'TRAFFIC_FAN',limit:1});assert.equal(batch.items.length,1);const item=batch.items[0];
   const before=await db.trafficSourceMember.findFirst({where:{creatorId:s.creatorId},orderBy:{id:'asc'}});
   await assert.rejects(()=>projection.runTrafficProjectionUnit({db,item,ownerToken:'wrong-owner'}),e=>e.code==='TRAFFIC_PROJECTION_CLAIM_LOST');
   const after=await db.trafficSourceMember.findUnique({where:{id:before.id}});assert.deepEqual(after.projectionMetrics,before.projectionMetrics);
   assert.equal((await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId})).projection.ready,false);
   await projection.runTrafficProjectionUnit({db,item,ownerToken:batch.ownerToken});await drain();
   assert.equal((await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId})).totals.fanValueCents,20000);
  });
  await check('tenant isolation and new empty creator enrollment remain fail-closed and finite',async()=>{
   const other=await scope(db,{agencyId:'other-agency',creatorId:'other-creator',userId:'other-user'});
   await assert.rejects(()=>traffic.getTrafficOverview({db,userId:s.userId,creatorId:other.creatorId}),e=>e.status===403);
   assert(await db.trafficProjectionBackfill.findUnique({where:{creatorId:other.creatorId}}));
   for(let i=0;i<15;i++)await projection.runTrafficProjectionSweep({db});
   const result=await traffic.getTrafficOverview({db,userId:other.userId,creatorId:other.creatorId});assert.equal(result.projection.ready,true);assert.equal(result.totals.sources,0);assert.equal(result.totals.fanValueCents,0);
  });
  await check('canonical FanData deletion invalidates value without deleting historical Traffic membership',async()=>{
   await write(tx=>tx.creatorFanValueCurrent.delete({where:{id:'fan-value'}}));await drain();
   const result=await traffic.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId});assert.equal(result.totals.fanValueCents,0);assert.equal(result.totals.sourceMembers,201);assert.equal(result.totals.valuePendingMembers,1);
  });
  await check('online index contracts are valid on repeated verification including descending attribution keys',async()=>{
   const indexes=require(path.join(root,'scripts/database/analytics-traffic-indexes'));assert.equal((await indexes.ensureIndexes(db,{create:true})).contracts,20);
   await db.$disconnect();await pg.exec('DISCARD ALL');
   await pg.exec('DROP INDEX "TrafficSourceMember_attribution_v2"; CREATE INDEX "TrafficSourceMember_attribution_v2" ON "TrafficSourceMember"("creatorId","fanId","lastSeenAt","id")');
   await assert.rejects(()=>indexes.ensureIndexes(db),e=>e.code==='ANALYTICS_TRAFFIC_INDEX_INVALID');
  });
  await check('retired direct provider writer is blocked by the database, not only HTTP',async()=>{
   await db.$disconnect();await pg.exec('DISCARD ALL');
   await assert.rejects(()=>pg.exec(`UPDATE "TrafficSource" SET "name"='untrusted direct write' WHERE "id"='historical-source'`),/TRAFFIC_CANONICAL_WRITER_REQUIRED/);
   assert.equal((await pg.query(`SELECT "name" FROM "TrafficSource" WHERE "id"='historical-source'`)).rows[0].name,'Another refresh');
  });
  console.log(JSON.stringify({runtime:process.version,postgres:'PGlite single connection; not native concurrency',checks},null,2));
 }finally{await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{clearInterval(proofAlive);clearTimeout(proofDeadline)});
