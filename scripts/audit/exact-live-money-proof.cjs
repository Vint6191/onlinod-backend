"use strict";
const assert=require("node:assert/strict"),path=require("node:path"),fs=require("node:fs"),crypto=require("node:crypto");
const root=path.resolve(__dirname,"../.."),results=[],metrics={};
const {createScaleSqlRuntime}=require("../test-support/scale-sql-runtime.cjs");
const {scope}=require("./analytics-traffic/fixture.cjs");
const {runRootCommit}=require(root+"/src/services/db-commit-kernel");
const gen=require(root+"/src/services/earnings-generation-service");
function pass(name){results.push(name);console.log("PASS",name);}
(async()=>{
 const f=await createScaleSqlRuntime();
 try{
  const {db}=f,s=await scope(db),tx=fn=>runRootCommit(db,async({tx})=>{await tx.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");return fn(tx);});
  require.cache[require.resolve(root+"/src/prisma")]={exports:db};
  const receipts=require(root+"/src/services/financial-receipt-authority"),money=require(root+"/src/services/live-earnings-projection-service"),retention=require(root+"/src/services/live-sync-retention-service");
  const home=require(root+"/src/services/home-read-repository"),coverage=require(root+"/src/services/earnings-live-read-sql"),resolver=require(root+"/src/services/money-resolution-service"),work=require(root+"/src/services/domain-work-authority-service");
  assert((await require(root+"/src/services/database-contract-service").readDatabaseContract(db)).ready);pass("fresh schema and complete catalog agree");
  const now=new Date(),today=new Date(now.toISOString().slice(0,10)),yesterday=new Date(+today-86400000),end=new Date(+today-1),from=new Date(+today-90*86400000);
  const member=await db.agencyMember.findUnique({where:{id:"member-"+s.agencyId}});
  const input={db,...s,member,money:true,manage:true,range:{startDay:today,endDay:today},previous:{startDay:yesterday,endDay:yesterday},now};
  async function seedRun(id,through,kind="FULL",values=[{id:"old",at:yesterday,net:100}],sc=s,lower=from) {
    const run={id,agencyId:sc.agencyId,creatorId:sc.creatorId,jobId:"fixture-"+id,generation:id,windows:[{kind,from:lower.toISOString(),to:through.toISOString()}],cursor:{phase:"done"},proof:{complete:true,...(kind==="FRONTIER"?{kind:"FRONTIER_PLUS_ONE"}:{}),windows:[{count:values.length}]}};
    const job={...sc,params:{...require(root+"/src/services/analytics-collector-control-service").buildCollectionCommand({collectorType:"FINANCIAL",collectionMode:kind==="FULL"?"full":"catchup",now:through}),collectionGeneration:id}};
    await tx(async t=>{await receipts.enter(t);await t.financialReceiptRun.create({data:run});
      for(const v of values)await t.$executeRawUnsafe(`INSERT INTO "FinancialObservedFact"("runId","windowIndex","externalId","occurredAt",value) VALUES($1,0,$2,$3,$4::jsonb)`,id,v.id,v.at,JSON.stringify({externalTransactionId:v.id,transactionType:"tip",occurredAt:v.at,amountCents:1000,netCents:v.net,currency:"USD",transactionStatus:v.status||"done",factType:"TIP"}));});
    return{run,job};
  }
  async function prepare(r){let page,units=0,copy=0;do{page=await tx(t=>gen.preparePage(t,r.job,r.run));units++;copy+=page.phase==="COPY"?page.visited:0;assert(units<1000);}while(!page.ready);return{units,copy};}
  await tx(t=>t.creatorMoneyObservation.create({data:{id:"old-pending",agencyId:s.agencyId,creatorId:s.creatorId,occurredAt:yesterday,capturedAt:yesterday,status:"PENDING"}}));
  const first=await seedRun("baseline",end);await prepare(first);await tx(t=>gen.publish(t,first.job,first.run));
  await tx(async t=>{await gen.lock(t,s.creatorId);await gen.writeLive(t,s,{transactionId:"today-live",occurredAt:today,category:"tips",netCents:700,status:"done",observedAt:now});await t.creatorLiveSync.create({data:{agencyId:s.agencyId,creatorId:s.creatorId,lastCapturedAt:now,lastDeliveredAt:now}});await require(root+"/src/services/earnings-coverage-service").advanceDelivered(t,[s.creatorId]);});
  assert.equal((await home.readHomeTotals(input)).totalCents,700);
  const second=await seedRun("replacement",now);await prepare(second);
  assert.equal((await db.creatorMoneyObservation.findUnique({where:{id:"old-pending"}})).coveredGeneration,"baseline");
  assert.equal((await home.readHomeTotals(input)).totalCents,700);assert((await coverage.readLiveEarningsCoverage(db,s.creatorId,now)).fresh);
  await assert.rejects(()=>tx(t=>t.creatorMoneyObservation.update({where:{id:"old-pending"},data:{coveredGeneration:"replacement"}})),/MONEY_COVERAGE_REGRESSION/);
  await tx(t=>t.creatorEarningsGeneration.update({where:{id:"replacement"},data:{state:"RETIRED",retiredAt:now}}));
  for(let i=0;i<5;i++)await retention.page(db,"generations");await retention.page(db,"covered");
  assert.equal((await home.readHomeTotals(input)).totalCents,700);assert.equal((await db.creatorMoneyObservation.findUnique({where:{id:"old-pending"}})).status,"COVERED");
  pass("replacement preparation, cancellation and compaction preserve prior coverage; database rejects coverage regression");
  const event={eventType:"tip_received",eventKey:"pending-tip",notificationObservation:{category:"tips",identityKey:"pending-tip",occurredAt:new Date(+now-10000).toISOString(),amountCents:1000},moneyObservation:{version:1,transactionId:"resolved-tip",occurredAt:new Date(+now-10000).toISOString(),netCents:null}};
  const ingest=()=>tx(t=>money.ingestLive({db:t,...s,deviceId:null,events:[event],capturedAt:new Date(+now-10000),now}));
  await ingest();const revision=await db.domainWorkItem.findFirst({where:{creatorId:s.creatorId,workClass:"MONEY_RESOLUTION"}});assert(revision);
  await ingest();assert.equal((await db.domainWorkItem.findUnique({where:{id:revision.id}})).requestedRevision,revision.requestedRevision);
  assert.equal((await home.readHomeTotals(input)).totalCents,700);assert.equal((await coverage.readLiveEarningsCoverage(db,s.creatorId,now)).fresh,false);
  pass("missing NET creates one durable coalesced resolution; unverified money does not erase confirmed Home");
  await tx(async t=>{await receipts.enter(t);
    await t.jobInstance.create({data:{id:"fixture-baseline",agencyId:s.agencyId,creatorId:s.creatorId,jobKey:"financial_transactions_scan",scope:"creator",status:"PUBLISHING"}});
    await t.analyticsPublication.create({data:{id:"baseline-publication",jobId:"fixture-baseline",agencyId:s.agencyId,creatorId:s.creatorId,userId:s.userId,deviceId:"fixture",leaseRevision:1,leaseTokenHash:"fixture",payloadHash:"fixture",payload:{scanRunId:"baseline"},stage:"FINALIZE"}});
    await t.creatorFinancialCollectionState.create({data:{agencyId:s.agencyId,creatorId:s.creatorId,status:"COMPLETE",mode:"full",sourceJobId:"fixture-baseline",baselineVerifiedAt:now,baselineObservedAt:end,baselineGeneration:"baseline",baselineRangeFrom:from,baselineRangeTo:end,activeGeneration:"baseline",activeRequestedAt:end,receiptCoverageVersion:1,coverageThrough:end}});});
  await db.analyticsPublication.update({where:{id:"baseline-publication"},data:{state:"COMMITTED"}});
  await db.jobInstance.update({where:{id:"fixture-baseline"},data:{status:"DONE"}});
  async function claim(){await tx(t=>t.domainWorkItem.updateMany({where:{workClass:"MONEY_RESOLUTION",state:"READY"},data:{availableAt:new Date(0)}}));const batch=await work.claimDomainWorkBatch({db,workClass:"MONEY_RESOLUTION",limit:1});assert.equal(batch.items.length,1);return{db,item:batch.items[0],ownerToken:batch.ownerToken};}
  const planned=await resolver.processRequest(await claim());assert(planned.created);
  let job=await db.jobInstance.findUnique({where:{id:planned.jobId}});assert.equal(job.params.moneyResolutionVersion,1);
  const blocked=await resolver.processRequest(await claim());assert.equal(blocked.reason,"FINANCIAL_SCHEDULED");assert.equal(await db.jobInstance.count({where:{creatorId:s.creatorId,jobKey:"financial_transactions_scan",status:"SCHEDULED"}}),1);
  const plannedEnd=receipts.date(job.params.endDate).toISOString();
  const mainCollectorBefore=await db.creatorFinancialCollectionState.findUnique({where:{creatorId:s.creatorId}});
  await db.workerDevice.create({data:{id:"resolution-device",agencyId:s.agencyId,userId:s.userId,lastSeenAt:new Date()}});
  await db.deviceCreatorBinding.create({data:{deviceId:"resolution-device",agencyId:s.agencyId,creatorId:s.creatorId,sessionReadReady:true,lastSeenAt:new Date()}});
  await db.agency.update({where:{id:s.agencyId},data:{trialEndsAt:new Date(Date.now()+86400000)}});
  const lease=require(root+"/src/services/job-lease-service");
  const oldDesktop=await lease.claimJob({userId:s.userId,deviceId:"resolution-device",jobKeys:["financial_transactions_scan"],
    capabilities:{creatorEventDrivenSyncV2:true,financialWindowReceiptsV1:true,financialMoneyResolutionV1:true}});
  assert.equal(oldDesktop.job,null,"legacy traversal capability cannot claim financial source work");
  const leased=await lease.claimJob({userId:s.userId,deviceId:"resolution-device",jobKeys:["financial_transactions_scan"],
    capabilities:{creatorEventDrivenSyncV2:true,financialWindowReceiptsV1:true,financialMoneyResolutionV1:true,financialTraversalV2:true}});
  assert.equal(leased.job?.id,job.id,JSON.stringify(leased));
  const token=leased.job.leaseToken;
  job=await db.jobInstance.findUnique({where:{id:job.id}});
  assert.equal(job.params.financialWindows[0].kind,"RESOLUTION");assert.equal(job.params.financialWindows[0].to,plannedEnd);
  assert(Date.parse(job.params.financialWindows[0].to)-Date.parse(job.params.financialWindows[0].from)<=3600000);
  pass("resolution schedules and actually claims one bounded window, preserving its target interval and respecting active work");
  const w=job.params.financialWindows[0],fin=require(root+"/src/services/financial-transactions-service");
  const existing=await db.$queryRawUnsafe(`SELECT * FROM "CreatorEarningsGenerationEntry" WHERE generation='baseline' AND "occurredAt" BETWEEN $1 AND $2`,new Date(w.from),new Date(w.to));
  const transactions=[...existing.map(e=>({externalTransactionId:e.transactionId,occurredAt:e.occurredAt.toISOString(),netCents:Number(e.netCents),transactionStatus:e.status})),{externalTransactionId:"resolved-tip",occurredAt:event.notificationObservation.occurredAt,netCents:800,transactionStatus:"done"}].map(e=>({...e,fanOnlyFansUserId:"42",transactionType:"tip",amountCents:1000,feeCents:1000-e.netCents,currency:"USD"}));
  await tx(t=>fin.ingestFinancialTransactionsChunk({db:t,job,deviceId:null,chunk:{collectorVersion:receipts.COLLECTOR,scanRunId:job.params.collectionGeneration,windowIndex:0,pageNumber:1,markerStart:w.initialMarker,markerEnd:null,rawReceived:transactions.length,scannerRejected:0,duplicateRows:0,sourceHasMore:false,transactions}}));
  assert.deepEqual(await db.creatorFinancialCollectionState.findUnique({where:{creatorId:s.creatorId}}),mainCollectorBefore,'targeted resolution must preserve the main collector while ingesting its bounded window');
  await tx(t=>fin.ingestFinancialChartChunk({db:t,job,deviceId:null,chunk:{collectorVersion:receipts.COLLECTOR,scanRunId:job.params.collectionGeneration,windowIndex:0,category:"total",rangeFrom:w.from,rangeTo:w.to,grossCents:1000*transactions.length,netCents:transactions.reduce((n,e)=>n+e.netCents,0),transactionsCount:transactions.length}}));
  const receipt=await receipts.completionProof(db,job);assert(receipt.complete);
  const prep=await prepare({job,run:receipt.row});assert.equal(prep.copy,0);
  const publisher=require(root+"/src/services/analytics-publication-service");
  const completion={jobId:job.id,userId:s.userId,deviceId:"resolution-device",leaseToken:token,leaseRevision:leased.job.leaseRevision,result:{scanRunId:job.params.collectionGeneration}};
  const accepted=await lease.completeJob(completion);assert(accepted.publicationId);
  let completed;
  for(let i=0;i<5;i++){
    await db.analyticsPublication.update({where:{id:accepted.publicationId},data:{availableAt:new Date(0)}});
    completed=await publisher.runAnalyticsPublicationUnit({db,publicationId:accepted.publicationId});
    if(!completed.publicationPending)break;
  }
  assert.equal(completed.job.status,"DONE");
  const state=await db.creatorFinancialCollectionState.findUnique({where:{creatorId:s.creatorId}}),proof=await db.creatorEarningsLedgerProof.findUnique({where:{creatorId:s.creatorId}});
  assert.deepEqual(state,mainCollectorBefore,'targeted publication must not change main status, coverage, freshness, active generation or retry');
  assert.equal(+proof.fromAt,+from);assert.equal(+proof.throughAt,+end);assert.equal(proof.activeGeneration,"baseline");
  await tx(async t=>{await receipts.enter(t);await t.jobInstance.update({where:{id:job.id},data:{status:"DONE"}});});
  assert((await resolver.processRequest(await claim())).idle);
  assert.equal((await home.readHomeTotals(input)).totalCents,1500);assert((await coverage.readLiveEarningsCoverage(db,s.creatorId,now)).fresh);
  const replay=await lease.completeJob(completion);assert.equal(replay.job.status,"DONE");assert.equal((await home.readHomeTotals(input)).totalCents,1500);
  pass("actual financial page + chart resolve exact NET, preserve global baseline/frontier, publish and replay without duplicate money");
  await retention.page(db,"covered");for(let i=0;i<5;i++)await retention.page(db,"generations");assert.equal((await home.readHomeTotals(input)).totalCents,1500);
  pass("retired delta manifest can be compacted without deleting active money or coverage");
  const staleCapture=await tx(t=>require(root+"/src/services/creator-live-sync-service").recordCaptureSample({db:t,...s,memberId:member.id,accessEpoch:member.accessEpoch,deviceId:"old-device",now:new Date(+now+60000),account:{realtimeHealthy:true,lastWsFrameAt:new Date(+now+60000).toISOString(),observation:{version:1,sessionId:crypto.randomUUID(),capturedThroughSeq:0,capturedThroughAt:new Date(+now+60000).toISOString(),captureFromAt:now.toISOString()}}}));
  assert.equal(staleCapture.recorded,false);assert.equal(staleCapture.reason,"money_revision_protocol_required");assert.equal(+(await db.creatorLiveSync.findUnique({where:{creatorId:s.creatorId}})).lastCapturedAt,+now);
  pass("old Desktop capture cannot certify a lossless interval after monetary revision protocol cutover");
  // Queue crash/retry/authorization edges use the same SQL ownership fences.
  const failedEvent={...event,eventKey:"rollback-money",notificationObservation:{...event.notificationObservation,identityKey:"rollback-money"},moneyObservation:{...event.moneyObservation,transactionId:"rollback-money"}};
  const countBefore=await db.creatorMoneyObservation.count({where:{creatorId:s.creatorId}});
  await assert.rejects(()=>tx(async t=>{await money.ingestLive({db:t,...s,events:[failedEvent],capturedAt:new Date(+now-10000),now});throw Error("DELIVERY_CRASH");}),/DELIVERY_CRASH/);
  assert.equal(await db.creatorMoneyObservation.count({where:{creatorId:s.creatorId}}),countBefore);
  assert.equal((await db.creatorMoneyResolutionRequest.findUnique({where:{creatorId:s.creatorId}})).queued,false);
  await tx(t=>money.ingestLive({db:t,...s,events:[failedEvent],capturedAt:new Date(+now-10000),now}));
  const paused=await db.jobInstance.create({data:{agencyId:s.agencyId,creatorId:s.creatorId,jobKey:"financial_transactions_scan",scope:"creator",status:"PAUSED"}});
  assert.equal((await resolver.processRequest(await claim())).reason,"FINANCIAL_PAUSED");
  await db.jobInstance.update({where:{id:paused.id},data:{status:"CANCELLED"}});
  const next=await resolver.processRequest(await claim());assert(next.created);
  // Capability predicate runs in SQL, including absent JSON keys on ordinary jobs.
  const ordinary=await db.jobInstance.create({data:{agencyId:s.agencyId,creatorId:s.creatorId,jobKey:"financial_transactions_scan",scope:"creator",params:{},nextRunAt:new Date(0)}});
  const whereOld=lease.claimCandidateWhere({allowedJobKeys:["financial_transactions_scan"],eligibleCreatorIds:[s.creatorId],now:new Date(Date.now()+1000),moneyResolutionSupported:false});
  const candidates=await db.jobInstance.findMany({where:whereOld,select:{id:true}});
  assert(candidates.some(x=>x.id===ordinary.id));assert(!candidates.some(x=>x.id===next.jobId));
  await db.jobInstance.updateMany({where:{id:{in:[ordinary.id,next.jobId]}},data:{status:"CANCELLED"}});
  assert.equal((await resolver.processRequest(await claim())).reason,"RESOLUTION_REVIEW_REQUIRED");
  const blockedMoney=await db.creatorMoneyObservation.findFirst({where:{creatorId:s.creatorId,transactionId:"rollback-money"}});assert(blockedMoney.resolutionBlockedAt);assert.equal(blockedMoney.resolutionError,"RESOLUTION_CANCELLED");
  assert((await resolver.processRequest(await claim())).idle);
  pass("delivery rollback leaves no queue debt; paused and cancelled work is respected; old Desktop cannot claim resolution windows");
  const unknownReversal={eventType:"refund_received",eventKey:"unidentifiable-refund",notificationObservation:{sourceType:"refund",identityKey:"unidentifiable-refund",occurredAt:now.toISOString()}};
  await tx(t=>money.ingestLive({db:t,...s,events:[unknownReversal],capturedAt:now,now}));
  const reversal=await db.creatorMoneyObservation.findFirst({where:{creatorId:s.creatorId,reason:"TRANSACTION_ID_REQUIRED_FOR_REVERSAL"}});assert(reversal?.resolutionBlockedAt);
  assert((await resolver.processRequest(await claim())).idle);
  assert.equal((await coverage.readLiveEarningsCoverage(db,s.creatorId,now)).fresh,false);assert.equal((await home.readHomeTotals(input)).totalCents,1500);
  pass("unidentifiable old reversal cannot be marked resolved by an empty current-hour scan or erase verified Home");
  const debt={...failedEvent,eventKey:"claim-fence",notificationObservation:{...failedEvent.notificationObservation,identityKey:"claim-fence"},moneyObservation:{...failedEvent.moneyObservation,transactionId:"claim-fence"}};
  await tx(t=>money.ingestLive({db:t,...s,events:[debt],capturedAt:new Date(+now-10000),now}));
  const stale=await claim();await work.yieldDomainWorkClaim(stale);
  const jobCount=await db.jobInstance.count({where:{creatorId:s.creatorId}});
  await assert.rejects(()=>resolver.processRequest(stale),/MONEY_RESOLUTION_CLAIM_LOST/);
  assert.equal(await db.jobInstance.count({where:{creatorId:s.creatorId}}),jobCount);
  pass("expired/released resolution ownership cannot create a source job");
  // Real history size, exact one-row delta. No historical-entry enumeration.
  const fleet=await scope(db,{agencyId:"scale-agency",creatorId:"scale-creator",userId:"scale-user"});
  await tx(async t=>{await gen.lock(t,fleet.creatorId);await t.creatorEarningsGeneration.create({data:{id:"large-base",agencyId:fleet.agencyId,creatorId:fleet.creatorId,runId:"base",state:"ACTIVE",phase:"READY",fromAt:from,throughAt:end,snapshotAt:end,fullScan:true,publishedAt:end}});await t.creatorEarningsLedgerProof.create({data:{agencyId:fleet.agencyId,creatorId:fleet.creatorId,generation:"base",activeGeneration:"large-base",fromAt:from,throughAt:end}});});
  const count=Number(process.env.ONLINOD_SCALE_ROWS||50000);
  for(let at=0;at<count;at+=500)await tx(t=>t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGenerationEntry"(generation,"transactionId","occurredAt",category,"netCents",status,"observedAt") SELECT 'large-base','old-'||i,$1,'tips',100,'done',$2 FROM generate_series($3::int,$4::int) i`,yesterday,end,at,Math.min(count-1,at+499)));
  const delta=await seedRun("small-delta",now,"FRONTIER",[{id:"one-new",at:now,net:123}],fleet,new Date("2016-01-01T00:00:00Z"));
  const mark=performance.now();f.queries.length=0;const cost=await prepare(delta);await tx(t=>gen.publish(t,delta.job,delta.run));
  assert.equal(cost.copy,0);assert.equal(cost.units,2);assert(!f.queries.some(q=>/FROM "CreatorEarningsGenerationEntry" WHERE generation=\$1 AND "transactionId">/.test(q.query)));
  assert.equal(+((await db.creatorEarningsLedgerProof.findUnique({where:{creatorId:fleet.creatorId}})).fromAt),+from);
  assert.equal(await db.creatorEarningsGenerationEntry.count({where:{generation:"large-base"}}),count+1);
  metrics.delta={historyRows:count,changedRows:1,copiedRows:cost.copy,preparationTransactions:cost.units,finalizeTransactions:1,elapsedMs:Math.round(performance.now()-mark)};
  pass("50k-history delta takes two preparation commits plus finalize; no history copy and no invented 2016 coverage");
  await assert.rejects(()=>runRootCommit(db,({tx})=>tx.$executeRawUnsafe(`SELECT set_config('onlinod.earnings_writer_generation','v6',true)`).then(()=>tx.creatorEarningsGenerationEntry.update({where:{generation_transactionId:{generation:"large-base",transactionId:"one-new"}},data:{netCents:999}}))),/EARNINGS_WRITER_UPGRADE_REQUIRED/);
  pass("rolling V6 writer is rejected before corrupting the V7 active ledger");
  if(f.native){
    let acquired,release;const locked=new Promise(r=>acquired=r),held=new Promise(r=>release=r);
    const a=tx(async t=>{await gen.lock(t,s.creatorId);acquired();await held;});await locked;
    let timeout;try{await Promise.race([tx(async t=>{await gen.lock(t,fleet.creatorId);await gen.writeLive(t,fleet,{transactionId:"parallel",occurredAt:now,category:"tips",netCents:5,status:"done",observedAt:now});}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("OTHER_CREATOR_BLOCKED")),2000);})]);}finally{clearTimeout(timeout);release();await a;}
    await Promise.all(Array.from({length:8},(_,i)=>tx(async t=>{await gen.lock(t,fleet.creatorId);await gen.writeLive(t,fleet,{transactionId:"race",occurredAt:now,category:"tips",netCents:i,status:"done",observedAt:new Date(+now+i)});})));assert.equal(Number((await gen.activeEntry(db,fleet.creatorId,"race")).netCents),7);
    pass("native concurrent creator independence and eight competing financial revisions");
  }
  const report={ok:true,engine:f.native?"native PostgreSQL":"PGlite + Prisma single connection; native concurrency not executed",results,metrics};
  if(process.env.ONLINOD_EXACT_MONEY_REPORT)fs.writeFileSync(process.env.ONLINOD_EXACT_MONEY_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }finally{await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
