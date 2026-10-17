"use strict";
const assert=require("node:assert/strict"),path=require("node:path"),crypto=require("node:crypto"),fs=require("node:fs");
const root=path.resolve(__dirname,"../.."),{scope}=require("./analytics-traffic/fixture.cjs");
const {createScaleSqlRuntime}=require("../test-support/scale-sql-runtime.cjs");
const {runRootCommit}=require(root+"/src/services/db-commit-kernel");
const gen=require(root+"/src/services/earnings-generation-service"),sync=require(root+"/src/services/creator-live-sync-service");
const checks=[],metrics={engine:"PGlite/Prisma; single connection, not native PostgreSQL capacity"};
function pass(name){checks.push(name);console.log("PASS",name);}
(async()=>{
 const f=await createScaleSqlRuntime();
 metrics.engine=f.native?"Native PostgreSQL with Prisma pool (8 connections)":metrics.engine;
 try {
  const {db}=f,s=await scope(db),member=await db.agencyMember.findUnique({where:{id:"member-"+s.agencyId}});
  const tx=fn=>runRootCommit(db,({tx})=>fn(tx)),now=new Date(),today=new Date(now.toISOString().slice(0,10)),from=new Date(+today-179*86400000);
  require.cache[require.resolve(root+"/src/prisma")]={exports:db};
  const home=require(root+"/src/services/home-read-repository");
  const input={db,...s,member,money:true,manage:true,range:{startDay:today,endDay:today},previous:{startDay:new Date(+today-86400000),endDay:new Date(+today-86400000)},now};
  await db.workerDevice.create({data:{id:"device",userId:s.userId,agencyId:s.agencyId,lastSeenAt:now}});
  const o={version:1,moneyRevisionVersion:1,sessionId:crypto.randomUUID(),capturedThroughAt:now.toISOString(),capturedThroughSeq:0,captureFromAt:now.toISOString()};
  const bindings=[{creatorId:s.creatorId,account:{creatorId:s.creatorId,accessEpoch:member.accessEpoch,status:"READY",realtimeHealthy:true,sessionReadReady:true,lastWsFrameAt:now.toISOString(),observation:o}}];
  const heartbeat=require(root+"/src/services/device-heartbeat-batch-service");
  const caps=()=>tx(t=>heartbeat.syncBindings({db:t,...s,deviceId:"device",accounts:bindings.map(x=>x.account),currentAccessEpoch:member.accessEpoch,now}));
  assert.equal((await caps()).accepted,1);
  const sample=(at=now)=>tx(t=>sync.recordCaptureSamples({db:t,...s,deviceId:"device",memberId:member.id,accessEpoch:member.accessEpoch,bindings,now:at}));
  await sample();f.queries.length=0;await sample();metrics.steadyCaptureRoundtrips=f.queries.length;
  await tx(t=>heartbeat.recordTeamObservations({db:t,...s,bindings,now,preserve:()=>false}));
  assert.equal((await db.teamObservationState.findUnique({where:{agencyId_creatorId:{agencyId:s.agencyId,creatorId:s.creatorId}}})).lastRealtimeEventAt.toISOString(),now.toISOString());
  await tx(t=>sync.recordCaptureSamples({db:t,...s,deviceId:"device",memberId:member.id,accessEpoch:member.accessEpoch,bindings,now:new Date(+now+30000)}));
  assert.equal((await db.creatorRealtimeSession.findFirst({where:{creatorId:s.creatorId}})).updatedAt.toISOString(),now.toISOString());
  pass("batched binding/team/capture writes preserve current epoch; stable samples coalesce without advancing invented time");
  const old=new Date(+now-10000),row=(id,net=100,status="done",at=old)=>({transactionId:id,occurredAt:today,category:"tips",netCents:net,status,observedAt:at});
  await tx(async t=>{
    await gen.lock(t,s.creatorId);await gen.writeLive(t,s,row("old-only",300));await gen.writeLive(t,s,row("tx-000001",100));
    await t.creatorEarningsLedgerProof.create({data:{...{agencyId:s.agencyId,creatorId:s.creatorId},fromAt:from,throughAt:now,generation:"legacy"}});
  });
  assert.equal((await home.readHomeTotals(input)).totalCents,400);
  const count=Number(process.env.ONLINOD_SCALE_ROWS||10000);
  const run={id:"bounded-run",...s,jobId:"fixture-job",generation:"bounded-generation",windows:[{kind:"FULL",from:from.toISOString(),to:now.toISOString()}],cursor:{phase:"done"},proof:{complete:true,windows:[{count}]}},job={...s,params:{collectionRequestedAt:now.toISOString()}};
  await tx(async t=>{
    await require(root+"/src/services/financial-receipt-authority").enter(t);
    await t.financialReceiptRun.create({data:{id:run.id,agencyId:s.agencyId,creatorId:s.creatorId,jobId:run.jobId,generation:run.generation,windows:run.windows,cursor:run.cursor,proof:run.proof}});
    await t.$executeRawUnsafe(`INSERT INTO "FinancialObservedFact"("runId","windowIndex","externalId","occurredAt",value)
      SELECT $1,0,'tx-'||lpad(i::text,6,'0'),$2,jsonb_build_object('netCents',100,'currency','USD','transactionStatus','done','factType','TIP')
      FROM generate_series(1,$3::int) i`,run.id,today,count);
    await gen.lock(t,s.creatorId);
    await t.creatorMoneyObservation.create({data:{id:"pending-observation",agencyId:s.agencyId,creatorId:s.creatorId,occurredAt:today,capturedAt:old,status:"PENDING"}});
  });
  let result=await tx(t=>gen.preparePage(t,job,run));assert(!result.ready);
  await assert.rejects(()=>tx(t=>t.$executeRawUnsafe(`UPDATE "CreatorEarningsLedgerEntry" SET "netCents"=999 WHERE "creatorId"=$1`,s.creatorId)),/EARNINGS_WRITER_UPGRADE_REQUIRED/);
  await assert.rejects(()=>tx(t=>t.creatorEarningsLedgerProof.update({where:{creatorId:s.creatorId},data:{generation:"old-writer"}})),/EARNINGS_WRITER_UPGRADE_REQUIRED/);
  pass("rolling deployment fence rejects legacy-only writers once a new generation starts, before they can ACK an unpublished monetary change");
  await assert.rejects(()=>tx(async t=>{await gen.preparePage(t,job,run);throw Error("CRASH");}),/CRASH/);
  assert.equal((await db.creatorEarningsGeneration.findUnique({where:{id:run.id}})).observedCount,0n);
  assert.equal((await home.readHomeTotals(input)).totalCents,400);
  await tx(async t=>{await gen.lock(t,s.creatorId);await gen.writeLive(t,s,row("tx-000001",100,"undo",new Date(+now+1)));await gen.writeLive(t,s,row("live-only",700,"done",new Date(+now+1)));});
  const durations=[];let maximumVisited=0,steps=0;
  while(!result.ready && steps++<1000) {
    const began=performance.now();result=await tx(t=>gen.preparePage(t,job,run));durations.push(performance.now()-began);maximumVisited=Math.max(maximumVisited,result.visited||0);
    assert.equal((await home.readHomeTotals(input)).totalCents,1000);
  }
  assert(result.ready);assert(maximumVisited<=gen.PAGE);
  await assert.rejects(()=>tx(async t=>{assert(await gen.publish(t,job,run));throw Error("FINALIZE_CRASH");}),/FINALIZE_CRASH/);
  assert.equal((await home.readHomeTotals(input)).totalCents,1000);
  const switchStart=performance.now();await tx(t=>gen.publish(t,job,run));const finalizeMs=Math.round(performance.now()-switchStart);
  const total=await home.readHomeTotals(input);assert.equal(total.totalCents,(count-1)*100+700);assert.equal(total.points.reduce((n,x)=>n+x.valueCents,0),total.totalCents);
  assert.equal((await gen.activeEntry(db,s.creatorId,"tx-000001")).status,"undo");assert.equal(await gen.activeEntry(db,s.creatorId,"old-only"),null);
  assert.equal((await require(root+"/src/services/earnings-live-read-sql").readLiveEarningsCoverage(db,s.creatorId,now)).fresh,true);
  pass("chunk crash and pointer-swap crash roll back; previous Home remains stable; newer refund/new payment survive full replacement; totals equal hourly curve");
  const finStart=performance.now();await tx(t=>gen.publish(t,job,run));
  metrics.publication={rows:count,finalizeMs,pages:steps,maximumVisited,maxPageMs:Math.round(Math.max(...durations)),medianPageMs:Math.round(durations.sort((a,b)=>a-b)[Math.floor(durations.length/2)]),replayFinalizeMs:Math.round(performance.now()-finStart)};
  // Completion visibility is atomic even when cleanup has not caught up.
  const retention=require(root+"/src/services/live-sync-retention-service");await retention.page(db,"covered");
  assert.equal((await db.creatorMoneyObservation.findUnique({where:{id:"pending-observation"}})).status,"COVERED");
  await retention.page(db,"generations");assert(await gen.activeEntry(db,s.creatorId,"live-only"));
  // Retiring transport detail never erases the contiguous replay authority.
  await tx(t=>t.creatorRealtimeSession.updateMany({where:{creatorId:s.creatorId},data:{updatedAt:new Date(+now-31*86400000)}}));
  await retention.page(db,"sessions");await sample();assert.equal((await db.creatorRealtimeSession.findFirst({where:{creatorId:s.creatorId}})).retiredAt,null);
  pass("background cleanup resolves only published money, protects active generation, and a dormant device can resume with its ACK authority intact");
  await require("./bounded-retention-proof.cjs")({db,scope:s,now,pass});
  await require("./dialog-recovery-queue-proof.cjs")({db,scope:s,now,pass});
  await require("./creator-planning-wake-proof.cjs")({db,scope:s,now,pass});
  if(f.native) {
    const other=await scope(db,{agencyId:"concurrent-agency",creatorId:"concurrent-creator",userId:"concurrent-user"});
    let release, acquired;
    const gate=new Promise(resolve=>{release=resolve;}),locked=new Promise(resolve=>{acquired=resolve;});
    const held=tx(async t=>{await gen.lock(t,s.creatorId);acquired();await gate;});
    await locked;
    let secondCommitted=false;
    const independent=tx(async t=>{await gen.lock(t,other.creatorId);await gen.writeLive(t,other,row("parallel",111));}).then(()=>{secondCommitted=true;});
    let timeout;
    try { await Promise.race([independent,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("UNRELATED_CREATOR_BLOCKED")),2000);})]);
      assert(secondCommitted);
    } finally {clearTimeout(timeout);release();await held;await independent;}
    await Promise.all(Array.from({length:8},(_,i)=>tx(async t=>{
      await gen.lock(t,s.creatorId);await gen.writeLive(t,s,row("concurrent-revision",100+i,"done",new Date(+now+100+i)));
    })));
    assert.equal(Number((await gen.activeEntry(db,s.creatorId,"concurrent-revision")).netCents),107);
    pass("native concurrent clients: unrelated creator commits while another is locked; eight competing revisions converge to the newest exact value");
  }
  // Fair cost comparison with V19: 1000 creators, 180 calendar days, sparse data.
  const bench=await scope(db,{agencyId:"scale-agency",creatorId:"scale-0000",userId:"scale-user"});
  const benchMember=await db.agencyMember.findUnique({where:{id:"member-"+bench.agencyId}});
  for(let first=1;first<1000;first+=100) await tx(async t=>{
    await t.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
    await t.creatorAccount.createMany({data:Array.from({length:Math.min(100,1000-first)},(_,i)=>({id:"scale-"+String(first+i).padStart(4,"0"),agencyId:bench.agencyId,remoteId:"scale-"+(first+i),displayName:"Scale",status:"READY"}))});
  });
  await tx(async t=>{
    await t.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
    await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGeneration"(id,"agencyId","creatorId","runId",state,phase,"fromAt","throughAt","snapshotAt","fullScan","publishedAt")
      SELECT 'g-'||id,"agencyId",id,'fixture','ACTIVE','READY',$2,$3,$3,true,$3 FROM "CreatorAccount" WHERE "agencyId"=$1`,bench.agencyId,from,now);
    await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerProof"("creatorId","agencyId","fromAt","throughAt",generation,"activeGeneration")
      SELECT id,"agencyId",$2,$3,'fixture','g-'||id FROM "CreatorAccount" WHERE "agencyId"=$1`,bench.agencyId,from,now);
    await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGenerationDay"(generation,date,category,"netCents","observedAt")
      SELECT 'g-'||id,($2::date-d),'tips',100,$3 FROM "CreatorAccount" CROSS JOIN generate_series(0,179) d WHERE "agencyId"=$1`,bench.agencyId,today,now);
  });
  await db.$executeRawUnsafe("ANALYZE");
  const timings=[],benchmarkInput={...input,...bench,member:benchMember,range:{startDay:new Date(+today-89*86400000),endDay:today},previous:{startDay:from,endDay:new Date(+today-90*86400000)}};
  for(let i=0;i<3;i++){const start=performance.now(),v=await home.readHomeTotals(benchmarkInput);timings.push(Math.round(performance.now()-start));assert.equal(v.totalCents,9000000);assert.equal(v.points.length,90);}
  metrics.home={creators:1000,currentDays:90,comparisonDays:90,dayCategoryRows:180000,analyzed:true,timingsMs:timings};
  const catalog=await db.creatorAccount.findMany({where:{agencyId:bench.agencyId},select:{id:true},orderBy:{id:'asc'}});
  const fleet=catalog.map(c=>({creatorId:c.id,account:{realtimeHealthy:true,lastWsFrameAt:now.toISOString(),observation:{...o,sessionId:crypto.randomUUID()}}}));
  await db.workerDevice.create({data:{id:"fleet-device",userId:bench.userId,agencyId:bench.agencyId,lastSeenAt:now}});
  const fleetAccounts=fleet.map(x=>({...x.account,creatorId:x.creatorId,accountId:x.creatorId,accessEpoch:benchMember.accessEpoch,sessionReadReady:true}));
  const bindingStart=performance.now();
  const fleetBindings=await tx(t=>heartbeat.syncBindings({db:t,...bench,deviceId:"fleet-device",accounts:fleetAccounts,currentAccessEpoch:benchMember.accessEpoch,now}));
  assert.equal(fleetBindings.accepted,1000);const bindingsMs=Math.round(performance.now()-bindingStart);
  const queued=await tx(t=>require(root+"/src/services/dialog-recovery-queue-service").enqueue({db:t,...bench,candidates:fleetBindings.recoveryCandidates,bindings:fleetBindings.resolvedAccounts,now}));
  assert.equal(queued.queued,1000);
  const replayQueue=await tx(t=>require(root+"/src/services/dialog-recovery-queue-service").enqueue({db:t,...bench,candidates:fleetBindings.recoveryCandidates,bindings:fleetBindings.resolvedAccounts,now}));
  assert.equal(replayQueue.queued,0);
  await tx(t=>heartbeat.recordTeamObservations({db:t,...bench,bindings:fleetBindings.resolvedAccounts,now,preserve:()=>true}));
  const fleetSample=(rows,at)=>tx(t=>sync.recordCaptureSamples({db:t,...bench,deviceId:'fleet-device',memberId:benchMember.id,accessEpoch:benchMember.accessEpoch,bindings:rows,now:at}));
  let mark=performance.now();await fleetSample(fleet,now);const coldMs=Math.round(performance.now()-mark);
  f.queries.length=0;mark=performance.now();await fleetSample(fleet,new Date(+now+30000));
  const steadyMs=Math.round(performance.now()-mark),steadySql=f.queries.length;
  const returned=new Date(+now+61*60000),offline=fleet.map(x=>({...x,account:{...x.account,lastWsFrameAt:returned.toISOString(),observation:{...x.account.observation,capturedThroughAt:returned.toISOString(),captureFromAt:returned.toISOString()}}}));
  mark=performance.now();await fleetSample(offline,returned);const recoveryMs=Math.round(performance.now()-mark);
  assert.equal(await db.creatorRecoveryIntent.count({where:{agencyId:bench.agencyId,status:'PENDING'}}),4000);
  await fleetSample(offline,returned);assert.equal(await db.creatorRecoveryIntent.count({where:{agencyId:bench.agencyId,status:'PENDING'}}),4000);
  metrics.heartbeat={creators:1000,bindingsMs,coldMs,steadyMs,steadySql,recoveryMs,recoveryIntents:4000};
  pass('1000 creator cold/steady/reconnect heartbeat batches: exactly four recovery streams per creator, replay creates no duplicate work');

  pass("1000 creator / 180 day aggregate returns exact 90-day totals and 90 graph points");
  const cache=require(root+"/src/services/home-read-cache");let calls=0;
  const a=()=>cache.readHomeCached(benchmarkInput,"proof",async()=>{calls++;return{total:123};});
  assert.deepEqual(await Promise.all(Array.from({length:100},a)),Array.from({length:100},()=>({total:123})));assert.equal(calls,1);
  await cache.readHomeCached({...benchmarkInput,member:{...benchMember,accessEpoch:benchMember.accessEpoch+1}},"proof",async()=>{calls++;return null;});assert.equal(calls,2);
  pass("100 simultaneous Home reads coalesce; membership epoch separates cache entries");
  const report={ok:true,checks,metrics};console.log(JSON.stringify(report));
  if(process.env.ONLINOD_SCALE_REPORT)fs.writeFileSync(process.env.ONLINOD_SCALE_REPORT,JSON.stringify(report,null,2));
 }finally{await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
