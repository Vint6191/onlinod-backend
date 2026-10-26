"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {createScaleSqlRuntime}=require("../test-support/scale-sql-runtime.cjs");
const {scope}=require("./analytics-traffic/fixture.cjs");
const {runRootCommit}=require("../../src/services/db-commit-kernel");
const campaign=require("../../src/services/campaign-read-projection-service");
const repository=require("../../src/services/campaign-read-repository");
const traffic=require("../../src/services/traffic-projection-service");
const reads=require("../../src/services/traffic-read-service");
const {publishDomainWork}=require("../../src/services/domain-work-authority-service");
const {enterCampaignProjection}=require("../../src/services/campaign-projection-policy");
const {financialProjectionState}=require("../../src/services/media-financial-projection-service");
const pass=name=>console.log("PASS",name);
const keepAlive=setInterval(()=>{},1000),deadline=setTimeout(()=>{console.error("PROOF_DEADLINE");process.exit(2)},300000);
(async()=>{
 const f=await createScaleSqlRuntime();
 try{
  const {db}=f,s=await scope(db,{agencyId:"saved177",creatorId:"saved177",userId:"saved177"});
  const other=await scope(db,{agencyId:"foreign177",creatorId:"foreign177",userId:"foreign177"});
  const own={agencyId:s.agencyId,creatorId:s.creatorId},now=new Date(),old=new Date(+now-31*86400000);
  const write=fn=>runRootCommit(db,async({tx})=>{
   await require("../../src/services/campaign-causal-activation-service").enterCampaignWriterGeneration({db:tx});return fn(tx);
  },{profile:"JOB_CHUNK"});
  const overview=()=>reads.getTrafficOverview({db,userId:s.userId,creatorId:s.creatorId,rangeKey:"all"});
  const page=()=>repository.readCampaignPage({db,creatorId:s.creatorId,rangeKey:"all"});
  async function drain(){for(let turn=0;turn<160;turn++){
   const a=await campaign.runCampaignProjectionSweep({db}),b=await traffic.runTrafficProjectionSweep({db});
   assert.equal(a.ok,true,JSON.stringify(a));assert.equal(b.ok,true,JSON.stringify(b));
   if((await repository.readiness(db,s.creatorId,new Date())).ready&&(await overview()).projection.ready)return turn+1;
  }throw Error("PROJECTION_NOT_DRAINED");}
  await write(async tx=>{
   await tx.creatorCampaign.create({data:{...own,id:"campaign177",externalCampaignId:"campaign177",name:"Saved campaign"}});
   await tx.creatorFan.createMany({data:Array.from({length:31},(_,i)=>({...own,id:"fan177-"+String(i).padStart(2,"0"),onlyFansUserId:"external177-"+i}))});
   await tx.creatorFanValueCurrent.createMany({data:Array.from({length:31},(_,i)=>({...own,id:"value177-"+String(i).padStart(2,"0"),fanRecordId:"fan177-"+String(i).padStart(2,"0"),
    platformReportedTotalSpendCents:1200n,messagesSpentCents:0n,messagesSpentCentsAuthorityVersion:old.toISOString()+"|30|USER_PROFILE|digest",valueObservedAt:old,source:"USER_PROFILE"}))});
   await tx.creatorCampaignFan.createMany({data:Array.from({length:31},(_,i)=>({...own,id:"member177-"+String(i).padStart(2,"0"),fanRecordId:"fan177-"+String(i).padStart(2,"0"),campaignId:"campaign177",attributedAt:old}))});
   await require("../test-support/campaign-read-coverage-fixture.cjs").seedCoverage(tx,s,{kind:"CAMPAIGNS",now});
  });
  assert.equal((await overview()).projection.available,false);assert.equal((await page()).totals,null);
  pass("initial collection cannot claim a complete zero");
  console.log("DRAIN",await drain());
  let t=await overview(),c=await page();assert.equal(t.totals.fanValueCents,37200);assert.equal(c.totals.knownPlatformReportedFanSpendCents,37200);
  const sourceId=t.sources[0].id;
  let fans=await reads.getTrafficSourceMembers({db,userId:s.userId,creatorId:s.creatorId,sourceId});
  assert.equal(fans.members[0].totalSummCents,1200);assert.equal(fans.members[0].messagesSummCents,0);assert.equal(fans.members[0].tipsSummCents,null);assert.equal(fans.members[0].valueFresh,false);
  pass("31 stale values: Traffic totals, members and Campaigns agree without recollection; unknown and zero differ");
  const jobs=await db.jobInstance.count(),demands=await db.creatorFanRefreshDemand.count();
  await write(async tx=>{
   await publishDomainWork({db:tx,...own,partitionKey:s.creatorId,workClass:"TRAFFIC_FAN",objectType:"CreatorFan",objectId:"external177-0"});
   await publishDomainWork({db:tx,...own,partitionKey:s.creatorId,workClass:"CAMPAIGN_VALUE",objectType:"CreatorFanValueCurrent",objectId:"fan177-00"});
  });
  t=await overview();c=await page();assert.equal(t.projection.ready,false);assert.equal(t.projection.available,true);assert.equal(t.totals.fanValueCents,37200);
  assert.equal(c.projection.ready,false);assert.equal(c.projection.available,true);assert.equal(c.totals.knownPlatformReportedFanSpendCents,37200);
  const queryStart=f.queries.length;
  for(let i=0;i<3;i++){await overview();await page();await reads.getTrafficSourceMembers({db,userId:s.userId,creatorId:s.creatorId,sourceId});}
  assert.equal(await db.jobInstance.count(),jobs);assert.equal(await db.creatorFanRefreshDemand.count(),demands);
  assert(!f.queries.slice(queryStart).some(q=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.query)),"display reads must not schedule provider work or mutate facts");
  pass("pending projections preserve saved totals; repeated GETs issue no writes or provider jobs");
  await assert.rejects(reads.getTrafficOverview({db,userId:other.userId,creatorId:s.creatorId}),/ACCESS_CHANGED|FORBIDDEN/);
  pass("saved-value availability does not bypass agency permissions");
  await drain();
  // Recreate the previous expired receipt semantics without touching canonical
  // facts. This exercises automatic upgrade repair on a nonempty database.
  await write(async tx=>{
   await enterCampaignProjection(tx);
   const rows=await tx.$queryRawUnsafe('SELECT kind,"sourceId",contributions FROM "CampaignReadReceipt" WHERE "creatorId"=$1 AND kind IN (\'VALUE\',\'MEMBER\')',s.creatorId);
   for(const r of rows){const expired=r.contributions.map(x=>x.metrics.ofValueKnownFans?{...x,metrics:{...x.metrics,ofValueKnownFans:"0",ofValueUnknownFans:"1",ofValuePayingFans:"0",knownPlatformReportedFanSpendCents:"0"}}:x);
    const delta=campaign.deltas(r.contributions,expired);
    if(delta.length)await tx.$executeRawUnsafe(`SELECT "onlinod_campaign_read_add_v1"($1,$2,x."campaignId",x."rangeKey",x."fanId",x.metrics) FROM jsonb_to_recordset($3::jsonb) x("campaignId" text,"rangeKey" text,"fanId" text,metrics jsonb)`,s.agencyId,s.creatorId,JSON.stringify(delta));
    await tx.$executeRawUnsafe('UPDATE "CampaignReadReceipt" SET contributions=$4::jsonb,"windowVersion"=0 WHERE "creatorId"=$1 AND kind=$2 AND "sourceId"=$3',s.creatorId,r.kind,r.sourceId,JSON.stringify(expired));
   }
   await tx.maintenanceLaneState.delete({where:{key:campaign.SAVED_VALUE_REPAIR}});
  });
  assert.equal((await page()).totals,null);
  const first=await campaign.seedCampaignProjection({db});assert.equal(first.repair.visited,25);assert.equal(first.repair.completed,false);
  // Another owner resumes the persisted cursor rather than restarting it.
  const second=await campaign.seedCampaignProjection({db});assert.equal(second.repair.visited,6);assert.equal(second.repair.completed,true);
  assert.equal((await campaign.seedCampaignProjection({db})).repair.visited,0);
  await drain();assert.equal((await page()).totals.knownPlatformReportedFanSpendCents,37200);
  assert.equal(await db.jobInstance.count(),jobs);assert.equal(await db.creatorFanRefreshDemand.count(),demands);
  pass("nonempty upgrade: bounded 25+6 repair resumes, terminates, restores expired sums and creates no provider work");
  await write(tx=>tx.creatorFanValueCurrent.update({where:{id:"value177-00"},data:{platformReportedTotalSpendCents:2400n,valueObservedAt:now}}));
  assert.equal((await overview()).totals.fanValueCents,37200);await drain();
  assert.equal((await overview()).totals.fanValueCents,38400);assert.equal((await page()).totals.knownPlatformReportedFanSpendCents,38400);
  pass("a live canonical correction updates both saved projections automatically, without Refresh data");
  const media=await financialProjectionState(db,s.creatorId);assert.equal(media.available,true);assert.equal(media.ready,true);
  await write(tx=>tx.$executeRawUnsafe(`INSERT INTO "CreatorMediaMessageFinancialState"("creatorId","agencyId","sourceKey","messageId","dialogId","version",dirty,"updatedAt") VALUES($1,$2,'source177','message177','dialog177','v177',true,CURRENT_TIMESTAMP)`,s.creatorId,s.agencyId));
  const updating=await financialProjectionState(db,s.creatorId);assert.equal(updating.available,true);assert.equal(updating.ready,false);assert.equal(updating.pending,true);
  await write(tx=>tx.$executeRawUnsafe(`INSERT INTO "CreatorMediaFinancialAdoptionState"("creatorId","agencyId","upperSaleId") VALUES($1,$2,'') ON CONFLICT("creatorId") DO UPDATE SET "completedAt"=NULL`,s.creatorId,s.agencyId));
  assert.equal((await financialProjectionState(db,s.creatorId)).available,false);
  pass("Vault distinguishes saved revenue with a pending correction from incomplete initial adoption");
  await write(async tx=>{
   await enterCampaignProjection(tx);
   await tx.$executeRawUnsafe(`INSERT INTO "CampaignReadReceipt"("agencyId","creatorId",kind,"sourceId","nextDueAt","windowVersion")
     SELECT $1,$2,'VALUE','expired-fixture-'||i,CURRENT_TIMESTAMP-interval '1 day',1 FROM generate_series(1,5000) i`,s.agencyId,s.creatorId);
   await tx.$executeRawUnsafe('ANALYZE "CampaignReadReceipt"');
  });
  let statement,args;
  const state=await repository.readiness({$queryRawUnsafe:async(sql,...values)=>{statement=sql;args=values;return db.$queryRawUnsafe(sql,...values);}},s.creatorId,new Date());
  assert.equal(state.available,true);assert.equal(state.ready,false);
  const plan=await db.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+statement,...args),serialized=JSON.stringify(plan);
  for(const index of ['CampaignReadReceipt_kind_due177_idx','CampaignReadReceipt_window_due177_idx','CampaignReadReceipt_window_repair177_idx'])assert(serialized.includes(index),index);
  pass("5000 expired VALUE receipts cannot hide period values or force the period checks to scan expired fan history");
  if(process.env.ONLINOD_SAVED_READ_EVIDENCE){const dir=path.resolve(process.env.ONLINOD_SAVED_READ_EVIDENCE);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"saved-read177.json"),JSON.stringify({traffic:t,campaign:c,fans},null,2));}
  console.log("SAVED_READ177_PROOF_OK",f.native?"native PostgreSQL":"PGlite PostgreSQL engine");
 }finally{await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearInterval(keepAlive);clearTimeout(deadline);});
