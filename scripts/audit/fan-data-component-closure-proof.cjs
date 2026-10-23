'use strict';
// Production bulk writer + current SQL + real derived owners/readers. The only
// fixtures are the isolated accounts and provider observations.
const assert=require('node:assert/strict');
const {createScaleSqlRuntime}=require('../test-support/scale-sql-runtime.cjs');
const alive=setInterval(()=>{},1000),deadline=setTimeout(()=>{console.error('FAN_COMPONENT_PROOF_DEADLINE');process.exit(2);},300000);
(async()=>{
 const f=await createScaleSqlRuntime();
 try {
  const {db}=f;process.env.DATABASE_URL=f.url;process.env.DIRECT_URL=f.url;
  require.cache[require.resolve('../../src/prisma')]={exports:db};
  const s=await require('./analytics-traffic/fixture.cjs').scope(db);
  const {runRootCommit}=require('../../src/services/db-commit-kernel');
  const authority=require('../../src/services/fan-data-authority-service');
  const campaign=require('../../src/services/campaign-read-projection-service');
  const traffic=require('../../src/services/traffic-projection-service');
  const work=require('../../src/services/domain-work-authority-service');
  const read=require('../../src/services/campaign-read-repository');
  const now=new Date(),old=new Date(+now-2*86400000),newer=new Date(+now-1000);
  const write=fn=>runRootCommit(db,async({tx})=>{
   await require('../../src/services/campaign-causal-activation-service').enterCampaignWriterGeneration({db:tx});
   return fn(tx);
  },{profile:'JOB_CHUNK'});
  const project=(id,value,at)=>write(tx=>authority.projectFanObservationBatch(tx,{agencyId:s.agencyId,creatorId:s.creatorId,
   items:[{onlyFansUserId:id,identity:{username:'fan'+id,source:'USER_PROFILE',observedAt:at},value:{...value,source:'USER_PROFILE',observedAt:at}}],
   allowedSources:['USER_PROFILE'],observedAtPolicy:'TRUSTED_INPUT',receivedAt:now}));
  await project('100',{availability:'UNAVAILABLE',messagesSpentCents:1200,tipsSpentCents:300},old);
  let fan=await db.creatorFan.findUnique({where:{creatorId_onlyFansUserId:{creatorId:s.creatorId,onlyFansUserId:'100'}},include:{valueCurrent:true}});
  assert.equal(fan.valueCurrent.messagesSpentCents,1200n);assert.equal(fan.valueCurrent.tipsSpentCents,300n);assert.equal(fan.valueCurrent.platformReportedTotalSpendCents,null);
  const originalClock=fan.valueCurrent.messagesSpentCentsAuthorityVersion;
  await project('100',{availability:'AVAILABLE',totalSpentCents:2000,messagesSpentCents:[],tipsSpentCents:'   '},newer);
  fan=await db.creatorFan.findUnique({where:{id:fan.id},include:{valueCurrent:true}});
  assert.equal(fan.valueCurrent.messagesSpentCents,1200n);assert.equal(fan.valueCurrent.messagesSpentCentsAuthorityVersion,originalClock);
  const dto=read.fanValueDto(fan.valueCurrent,now,3600000);
  assert.equal(dto.available,true);assert.equal(dto.platformReportedTotalSpendCents,2000);assert.equal(dto.messagesSpentCents,null);
  assert.equal(dto.fieldFreshness.messagesSpentCents.fresh,false);assert.equal(dto.fieldAuthority.messagesSpentCents.observedAt,old.toISOString());
  const current=await authority.readFanCurrent(db,{agencyId:s.agencyId,creatorId:s.creatorId,onlyFansUserIds:['100']});
  assert.equal(current[0].value.messagesSpentCents,1200);assert.equal(current[0].value.fieldAuthority.messagesSpentCents.observedAt,old.toISOString());
  assert.equal(current[0].platformIdentity.fieldAuthority.username.observedAt.toISOString(),newer.toISOString());
  console.log('PASS independent field preservation and truthful freshness');
  await project('101',{availability:'MALFORMED',totalSpentCents:null,messagesSpentCents:500},newer);
  const second=await db.creatorFan.findUnique({where:{creatorId_onlyFansUserId:{creatorId:s.creatorId,onlyFansUserId:'101'}},include:{valueCurrent:true}});
  assert.equal(second.valueCurrent.messagesSpentCents,500n);assert.equal(second.valueCurrent.platformReportedTotalSpendCents,null);
  await write(async tx=>{
   await tx.creatorCampaign.create({data:{id:'component-campaign',agencyId:s.agencyId,creatorId:s.creatorId,externalCampaignId:'component-campaign',name:'Components'}});
   await tx.creatorCampaignFan.createMany({data:[fan,second].map((row,i)=>({id:'component-member-'+i,agencyId:s.agencyId,creatorId:s.creatorId,campaignId:'component-campaign',fanRecordId:row.id,attributedAt:old}))});
  });
  async function drain(){
   for(let i=0;i<100;i++){
    const a=await campaign.runCampaignProjectionSweep({db});assert(a.ok,JSON.stringify(a));
    const b=await traffic.runTrafficProjectionSweep({db,maxRuntimeMs:1000});assert(b.ok,JSON.stringify(b));
    const pending=await db.domainWorkItem.count({where:{creatorId:s.creatorId,isOutstanding:true,workClass:{in:[...campaign.CLASSES.filter(x=>x!=='CAMPAIGN_CLOCK'),'TRAFFIC_FACT','TRAFFIC_FAN','TRAFFIC_BACKFILL']}}});
    if(!pending)return i+1;
   }
   throw Error('Derived projections did not converge');
  }
  const turns=await drain();
  const source=await db.trafficSource.findFirst({where:{creatorId:s.creatorId,canonicalCampaignId:'component-campaign'}});assert(source);
  const result=await require('../../src/services/traffic-read-service').getTrafficSourceMembers({db,userId:s.userId,agencyId:s.agencyId,creatorId:s.creatorId,sourceId:source.id,rangeKey:'all'});
  assert.equal(result.members.find(x=>x.fanId==='100').messagesSummCents,null,'stale component is not made fresh by recent total');
  assert.equal(result.members.find(x=>x.fanId==='101').messagesSummCents,500,'valid component survives malformed total');
  assert.equal(result.members.find(x=>x.fanId==='101').totalSummCents,null);
  assert.equal(result.totals.messagesSummCents,1700,'aggregate independently known saved values');
  assert.equal(result.totals.tipsSummCents,null,'missing component is not zero');
  assert.equal(result.totals.knownTipsSummCents,300);assert.equal(result.totals.tipsUnknownMembers,1);
  const changes=await db.creatorEntityChange.findMany({where:{creatorId:s.creatorId}});
  assert(changes.some(row=>row.entityType==='CAMPAIGN'&&row.payload.reason==='CAMPAIGN_PROJECTION_PUBLISHED'));
  assert(changes.some(row=>row.entityType==='TRAFFIC'&&row.payload.reason==='TRAFFIC_PROJECTION_PUBLISHED'));
  console.log('PASS current saved reads, partial sums and owner completion publication',JSON.stringify({turns}));
  // Upgrade quarantines old raw financial evidence. The existing capture and
  // receipt delta must retract it from campaign money, not turn it into pending
  // gross or a falsely proven zero; platform lifetime value remains separate.
  await write(tx=>tx.creatorFinancialTransaction.create({data:{id:'legacy-unverified-proof',agencyId:s.agencyId,creatorId:s.creatorId,
    fanRecordId:fan.id,externalTransactionId:'legacy-unverified-proof',transactionType:'tip',transactionStatus:'done',
    amountCents:1000,netCents:800,occurredAt:newer}}));
  await drain();
  const savedMetrics=async()=>{
    const [row]=await db.$queryRawUnsafe('SELECT metrics FROM "CampaignReadMetric" WHERE "creatorId"=$1 AND "campaignId"=$2 AND "rangeKey"=\'all\' AND "fanId"=\'\'',s.creatorId,'component-campaign');
    return read.metricsDto(row?.metrics||{});
  };
  assert.equal((await savedMetrics()).netCents,800);
  await write(tx=>tx.creatorFinancialTransaction.update({where:{id:'legacy-unverified-proof'},data:{transactionStatus:'unverified',netCents:null,
    projectionStatus:'STORED_ONLY',reasonCode:'LEGACY_FINANCIAL_UNVERIFIED'}}));
  await drain();
  const quarantined=await savedMetrics();
  assert.equal(quarantined.unverifiedTransactions,1);assert.equal(quarantined.knownNetCents,0);
  assert.equal(quarantined.netCents,null);assert.equal(quarantined.grossCents,null);assert.equal(quarantined.pendingGrossCents,null);
  assert.equal(quarantined.pendingTransactionsCount,0);assert.equal(quarantined.transactionsCount,0);
  assert.equal((await authority.readFanCurrent(db,{agencyId:s.agencyId,creatorId:s.creatorId,onlyFansUserIds:['100']}))[0].value.platformReportedTotalSpendCents,2000);
  await write(tx=>tx.creatorFinancialTransaction.update({where:{id:'legacy-unverified-proof'},data:{transactionStatus:'done',netCents:800,
    projectionStatus:'PROJECTED',reasonCode:null}}));
  await drain();assert.equal((await savedMetrics()).netCents,800);assert.equal((await savedMetrics()).unverifiedTransactions,0);
  console.log('PASS unverified legacy financial retraction and verified recovery without altering fan lifetime value');
  await write(tx=>tx.creatorFinancialTransaction.update({where:{id:'legacy-unverified-proof'},data:{transactionStatus:'superseded',amountCents:null,netCents:null}}));
  await drain();assert.equal((await savedMetrics()).knownNetCents,0);assert.equal((await savedMetrics()).unverifiedTransactions,0);
  assert.equal((await savedMetrics()).transactionsCount,0,'superseded projection is ceased, not pending money');
  await write(tx=>tx.creatorFinancialTransaction.update({where:{id:'legacy-unverified-proof'},data:{transactionStatus:'done',amountCents:1000,netCents:800}}));
  await drain();assert.equal((await savedMetrics()).netCents,800);
  console.log('PASS superseded canonical contribution retraction without fake unknown or duplicate transaction');
  const revision=(await db.creatorEntityChangeHead.findUnique({where:{creatorId:s.creatorId}})).lastRevision;
  assert.equal(typeof revision,'bigint');assert(revision>0n);
  await drain();
  assert.equal((await db.creatorEntityChangeHead.findUnique({where:{creatorId:s.creatorId}})).lastRevision,revision,'idle projection replay must not emit churn');
  // Loss of a domain-work claim rolls back both saved projection and feed.
  await write(tx=>work.publishDomainWork({db:tx,agencyId:s.agencyId,creatorId:s.creatorId,partitionKey:s.creatorId,workClass:'CAMPAIGN_VALUE',objectType:'CreatorFanValueCurrent',objectId:fan.id}));
  const claim=await work.claimDomainWorkBatch({db,workClass:'CAMPAIGN_VALUE',limit:1});assert(claim.items[0]);
  await assert.rejects(campaign.runCampaignProjectionUnit({db,item:claim.items[0],ownerToken:'lost-claim'}),/CLAIM_LOST/);
  assert.equal((await db.creatorEntityChangeHead.findUnique({where:{creatorId:s.creatorId}})).lastRevision,revision);
  console.log('PASS idle replay and failed owner rollback preserve reverse-feed revision');
  await campaign.runCampaignProjectionUnit({db,item:claim.items[0],ownerToken:claim.ownerToken});
  await write(async tx=>{
    await tx.creatorFan.createMany({data:Array.from({length:101},(_,i)=>({id:'seed-fan-record-'+i,
      agencyId:s.agencyId,creatorId:s.creatorId,onlyFansUserId:String(20000+i)}))});
    await tx.creatorCampaignFan.createMany({data:Array.from({length:101},(_,i)=>({id:'seed-member-'+String(i).padStart(4,'0'),
      agencyId:s.agencyId,creatorId:s.creatorId,campaignId:'component-campaign',fanRecordId:'seed-fan-record-'+i,attributedAt:old}))});
  });
  await drain();
  assert.equal(await db.trafficSourceMember.count({where:{creatorId:s.creatorId}}),103);
  const jobsBeforeSeed=await db.jobInstance.count({where:{creatorId:s.creatorId}});
  await runRootCommit(db,async({tx})=>{
    await require('../../src/services/traffic-projection-authority').enterTrafficProjection(tx,s.creatorId);
    // Simulate the newly installed one-time component seed over existing rows.
    await tx.$executeRawUnsafe('UPDATE "TrafficProjectionSeed" SET "cursor"=\'\',complete=false WHERE id=\'fan-components-v1\'');
  },{profile:'JOB_CHUNK'});
  const seedOne=await traffic.runTrafficProjectionSweep({db,limit:1,maxRuntimeMs:1});assert(seedOne.ok);
  assert.equal(seedOne.seed.components.visited,100);
  const seedTwo=await traffic.runTrafficProjectionSweep({db,limit:1,maxRuntimeMs:1});assert(seedTwo.ok);
  assert.equal(seedTwo.seed.components.visited,3);
  const seedThree=await traffic.runTrafficProjectionSweep({db,limit:1,maxRuntimeMs:1});assert(seedThree.ok);
  assert.equal(seedThree.seed.components.seeded,0);
  assert.equal(await db.jobInstance.count({where:{creatorId:s.creatorId}}),jobsBeforeSeed,'component backfill must not schedule provider scans');
  console.log('PASS existing component migration seed uses finite 100-row pages and no provider work');
  console.log('FAN_DATA_COMPONENT_CLOSURE_PROOF_PASS',JSON.stringify({native:f.native,partialComponents:true,fieldFreshness:true,unknownNotZero:true,derivedPublication:true}));
 }finally{await f.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{clearInterval(alive);clearTimeout(deadline);});
