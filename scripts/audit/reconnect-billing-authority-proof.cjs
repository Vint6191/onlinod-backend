"use strict";
// Production SQL/services against a disposable, fully migrated PGlite + Prisma
// database. Source facts are controlled fixtures; this is not a live-provider
// or multi-replica PostgreSQL capacity test.
const assert=require("node:assert/strict"),crypto=require("node:crypto"),path=require("node:path");
const {createAdminSqlRuntime}=require("../test-support/admin-sql-runtime.cjs");
const {scope}=require("./analytics-traffic/fixture.cjs");
const root=path.resolve(__dirname,"../.."),DAY=86400000;
const keepAlive=setInterval(()=>{},1000),deadline=setTimeout(()=>{console.error("RECONNECT_BILLING_PROOF_DEADLINE");process.exit(2);},240000);
const checks=[],pass=name=>{checks.push(name);console.log("PASS",name);};
(async()=>{
  const f=await createAdminSqlRuntime({runtimePath:process.env.ONLINOD_SQL_PROOF_RUNTIME});
  try {
    const {db}=f,now=new Date(),old=new Date(+now-3*DAY),today=new Date(now.toISOString().slice(0,10)),from=new Date(+today-30*DAY),to=new Date(+today-DAY);
    require.cache[require.resolve(root+"/src/prisma")]={exports:db};
    let sync=require(root+"/src/services/creator-live-sync-service");
    const heartbeat=require(root+"/src/services/device-heartbeat-batch-service"),{runRootCommit}=require(root+"/src/services/db-commit-kernel");
    const gen=require(root+"/src/services/earnings-generation-service"),repository=require(root+"/src/services/published-earnings-read-repository");
    const commit=fn=>runRootCommit(db,({tx})=>fn(tx));
    async function account(name) {
      const s=await scope(db,{agencyId:"agency-"+name,creatorId:"creator-"+name,userId:"user-"+name});
      s.member=await db.agencyMember.findUnique({where:{id:"member-"+s.agencyId}});
      await db.workerDevice.create({data:{id:"device-"+name,agencyId:s.agencyId,userId:s.userId,lastSeenAt:now}});
      s.deviceId="device-"+name;return s;
    }
    const narrow=s=>({agencyId:s.agencyId,creatorId:s.creatorId});
    const apiAccount=s=>({creatorId:s.creatorId,accessEpoch:s.member.accessEpoch,sessionReadReady:true,realtimeHealthy:false});
    async function receive(s,at=now,a=apiAccount(s),tx=null) {
      const work=async t=>{
        const normalized=await heartbeat.syncBindings({db:t,...narrow(s),deviceId:s.deviceId,accounts:[a],allowedCreatorIds:new Set([s.creatorId]),currentAccessEpoch:s.member.accessEpoch,now:at});
        return sync.recordCaptureSamples({db:t,...narrow(s),deviceId:s.deviceId,memberId:s.member.id,accessEpoch:s.member.accessEpoch,bindings:normalized.resolvedAccounts,now:at});
      };
      return tx?work(tx):commit(work);
    }
    async function seedLive(s,at=old) {await db.creatorLiveSync.create({data:{...narrow(s),lastCapturedAt:at,lastDeliveredAt:at}});}
    const debts=s=>db.creatorRecoveryIntent.findMany({where:{creatorId:s.creatorId},orderBy:{stream:"asc"}});
    const reconnect=await account("reconnect");await seedLive(reconnect);
    await receive(reconnect);
    let intents=await debts(reconnect);assert.equal(intents.length,4);assert(intents.every(i=>i.status==="PENDING"&&+i.gapFrom===+old&&+i.targetAt===+now));
    const state=await db.creatorLiveSync.findUnique({where:{creatorId:reconnect.creatorId}});
    assert.equal(+state.lastCapturedAt,+old);assert.equal(+state.lastDeliveredAt,+old);
    assert.equal(await db.creatorRealtimeSession.count({where:{creatorId:reconnect.creatorId}}),0);
    assert.equal(await db.domainWorkItem.count({where:{creatorId:reconnect.creatorId,workClass:"CREATOR_RECURRING_PLANNING"}}),1);
    pass("API-ready reconnect without any websocket creates four durable stream debts and a planning wake, without certifying capture or delivery");

    for(let i=1;i<=5;i++)await receive(reconnect,new Date(+now+i*60000));
    delete require.cache[require.resolve(root+"/src/services/creator-live-sync-service")];sync=require(root+"/src/services/creator-live-sync-service");
    await receive(reconnect,new Date(+now+6*60000));
    assert.deepEqual((await debts(reconnect)).map(i=>i.id),intents.map(i=>i.id));
    pass("repeated heartbeat and process-module restart preserve the same fixed recovery targets");

    // Read-side baseline fixtures include real publication provenance and keep
    // database writer/authority guards enabled.
    await commit(async t=>{
      const s=narrow(reconnect),generation="notifications-baseline",jobId="notifications-baseline";
      await t.jobInstance.create({data:{id:jobId,...s,scope:"CREATOR",jobKey:"catchup_notifications_scan",status:"PUBLISHING",params:{collectionGeneration:generation}}});
      await t.analyticsPublication.create({data:{id:jobId+":1",jobId,...s,userId:reconnect.userId,deviceId:reconnect.deviceId,leaseRevision:1,leaseTokenHash:"fixture",payloadHash:"fixture",payload:{scanRunId:generation},stage:"FINALIZE"}});
      await t.creatorNotificationSyncState.create({data:{...s,status:"COMPLETE",normalizerVersion:"notification-source-v2",fullBackfillVerifiedAt:old,fullBackfillObservedAt:old,sourceJobId:jobId}});
      await t.analyticsPublication.update({where:{id:jobId+":1"},data:{state:"COMMITTED",completedAt:old}});
      await t.jobInstance.update({where:{id:jobId},data:{status:"DONE"}});
      const seed=require("../test-support/campaign-read-coverage-fixture.cjs").seedCoverage;
      await seed(t,reconnect,{kind:"FINANCIAL",now:old,state:{baselineGeneration:"fixture-FINANCIAL-"+reconnect.creatorId,receiptCoverageVersion:1}});
      await seed(t,reconnect,{kind:"CAMPAIGNS",now:old,state:{baselineGeneration:"fixture-CAMPAIGNS-"+reconnect.creatorId,membershipCoverageStatus:"COMPLETE",fanValueFreshnessStatus:"COMPLETE"}});
      await gen.lock(t,reconnect.creatorId);
      await t.creatorEarningsLedgerProof.create({data:{...s,fromAt:from,throughAt:old,generation:"baseline"}});
    });
    const planner=require(root+"/src/services/creator-analytics-sync-orchestrator");
    const planned=await planner.ensureRecurringCreatorAnalyticsCatchups({db,...narrow(reconnect),now});
    assert.deepEqual(planned.created.sort(),["campaigns_offline_recovery","financial_offline_recovery","notifications_offline_recovery"]);
    const jobs=await db.jobInstance.findMany({where:{creatorId:reconnect.creatorId,status:"SCHEDULED"}});
    assert.equal(jobs.length,3);assert(jobs.every(j=>j.params.recoveryIntentId&&j.params.syncPolicyVersion===2));
    assert.equal((await planner.ensureRecurringCreatorAnalyticsCatchups({db,...narrow(reconnect),now})).created.length,0);
    await receive(reconnect,new Date(+now+7*60000));assert.equal((await debts(reconnect)).length,4);
    pass("production recurring planner consumes API-only debt into one financial, notification and campaign job; active jobs coalesce");

    const rollback=await account("rollback");await seedLive(rollback);
    const beforeRollbackWork=await db.domainWorkItem.findMany({where:{creatorId:rollback.creatorId},orderBy:{id:"asc"}});
    await assert.rejects(()=>commit(async t=>{await receive(rollback,now,apiAccount(rollback),t);throw Error("AFTER_RECOVERY_WRITE");}),/AFTER_RECOVERY_WRITE/);
    assert.equal((await debts(rollback)).length,0);
    assert.deepEqual(await db.domainWorkItem.findMany({where:{creatorId:rollback.creatorId},orderBy:{id:"asc"}}),beforeRollbackWork);
    await receive(rollback);assert.equal((await debts(rollback)).length,4);
    pass("root-commit failure rolls debt and planning wake back together; next authorized heartbeat recovers");

    for(const i of await debts(rollback))await commit(async t=>{
      const job={...narrow(rollback),id:"done-"+i.stream,jobKey:Object.keys(sync.JOB_STREAM).find(k=>sync.JOB_STREAM[k]===i.stream),params:sync.recoveryParams(i)};
      await sync.bindRecovery(t,i,job.id);await sync.completeRecovery(t,job,true,{coveredThrough:now});
    });
    await db.creatorRecoveryIntent.deleteMany({where:{creatorId:rollback.creatorId,status:"COMPLETE"}});
    await receive(rollback,new Date(+now+60000),{...apiAccount(rollback),realtimeHealthy:true,lastWsFrameAt:new Date(+now+60000).toISOString(),
      observation:{version:1,moneyRevisionVersion:1,sessionId:crypto.randomUUID(),capturedThroughAt:new Date(+now+60000).toISOString(),capturedThroughSeq:0,
        captureFromAt:new Date(+now+60000).toISOString()}});
    assert.equal((await debts(rollback)).length,0,"late healthy websocket must not reopen the already recovered three-day interval");
    await receive(rollback,new Date(+now+59*60000));assert.equal((await debts(rollback)).length,0);
    await receive(rollback,new Date(+now+61*60000));
    assert((await debts(rollback)).every(i=>+i.gapFrom===+now+60000));
    assert.equal((await debts(rollback)).length,4);
    pass("completed durable watermarks survive intent retention and only the next uncovered interval can schedule new debt");

    const receiver=await account("receiver");await seedLive(receiver,new Date(+now-60000));await receive(receiver);assert.equal((await debts(receiver)).length,0);
    const bridge=await account("bridge");await seedLive(bridge);
    await receive(bridge,now,{...apiAccount(bridge),realtimeHealthy:true,lastWsFrameAt:now.toISOString(),observation:{version:1,moneyRevisionVersion:1,
      sessionId:crypto.randomUUID(),capturedThroughAt:now.toISOString(),capturedThroughSeq:0,captureFromAt:old.toISOString()}});
    assert.equal((await debts(bridge)).length,0);
    const revoked=await account("revoked");await seedLive(revoked);await receive(revoked,now,{...apiAccount(revoked),accessEpoch:null});
    assert.equal((await debts(revoked)).length,0);
    const fresh=await account("new");await receive(fresh);assert.equal((await debts(fresh)).length,0);
    pass("current second receiver, durable journal bridge, stale membership epoch and no-baseline bootstrap do not create spurious recovery scans");

    const short=await account("short-gap"),shortBase=new Date(+now-3*3600000),shortEnd=new Date(+shortBase+30*60000),shortSession=crypto.randomUUID();
    await seedLive(short,shortBase);
    const liveAt=at=>({...apiAccount(short),realtimeHealthy:true,lastWsFrameAt:at.toISOString(),observation:{version:1,moneyRevisionVersion:1,
      sessionId:shortSession,capturedThroughAt:at.toISOString(),capturedThroughSeq:0,captureFromAt:shortEnd.toISOString()}});
    await receive(short,shortEnd,liveAt(shortEnd));
    assert.equal((await debts(short)).length,0);
    for(let min=31;min<=180;min++)await receive(short,new Date(+shortBase+min*60000),liveAt(new Date(+shortBase+min*60000)));
    const shortDebts=await debts(short);assert.equal(shortDebts.length,4);
    assert(shortDebts.every(i=>+i.gapFrom===+shortBase&&+i.targetAt===+shortEnd));
    assert.equal(+(await db.creatorLiveSync.findUnique({where:{creatorId:short.creatorId}})).shortGapTo,+shortEnd);
    for(const [index,i] of shortDebts.entries()) {
      await commit(async t=>{const job={...narrow(short),id:"short-done-"+i.stream,jobKey:Object.keys(sync.JOB_STREAM).find(k=>sync.JOB_STREAM[k]===i.stream),params:sync.recoveryParams(i)};
        await sync.bindRecovery(t,i,job.id);await sync.completeRecovery(t,job,true,{coveredThrough:shortEnd});});
      const at=new Date(+now+(index+1)*60000);await receive(short,at,liveAt(at));
      const l=await db.creatorLiveSync.findUnique({where:{creatorId:short.creatorId}});
      assert.equal(l.shortGapFrom===null,index===shortDebts.length-1,"capture/delivery cannot erase unresolved gap before every stream has proof");
    }
    assert.equal((await debts(short)).filter(i=>i.status!=="COMPLETE").length,0);
    pass("a 30-minute gap ages into one exact repair interval despite hours of healthy capture; only all-stream recovery clears the gap");
    const apiThenWs=await account("api-then-ws");await seedLive(apiThenWs);await receive(apiThenWs);
    const initialApiDebts=await debts(apiThenWs),tailEnd=new Date(+now+30*60000),tailSession=crypto.randomUUID();
    const tailLive=at=>({...apiAccount(apiThenWs),realtimeHealthy:true,lastWsFrameAt:at.toISOString(),observation:{version:1,moneyRevisionVersion:1,
      sessionId:tailSession,capturedThroughAt:at.toISOString(),capturedThroughSeq:0,captureFromAt:tailEnd.toISOString()}});
    await receive(apiThenWs,tailEnd,tailLive(tailEnd));
    assert.deepEqual((await debts(apiThenWs)).map(i=>i.id),initialApiDebts.map(i=>i.id));
    let tailState=await db.creatorLiveSync.findUnique({where:{creatorId:apiThenWs.creatorId}});
    assert.equal(+tailState.shortGapFrom,+now);assert.equal(+tailState.shortGapTo,+tailEnd);
    for(const i of initialApiDebts)await commit(async t=>{
      const job={...narrow(apiThenWs),id:"api-ws-done-"+i.stream,jobKey:Object.keys(sync.JOB_STREAM).find(k=>sync.JOB_STREAM[k]===i.stream),params:sync.recoveryParams(i)};
      await sync.bindRecovery(t,i,job.id);await sync.completeRecovery(t,job,true,{coveredThrough:now});
    });
    const tailCheck=new Date(+now+61*60000);await receive(apiThenWs,tailCheck,tailLive(tailCheck));
    const tailDebts=(await debts(apiThenWs)).filter(i=>i.status!=="COMPLETE");
    assert.equal(tailDebts.length,4);assert(tailDebts.every(i=>+i.gapFrom===+now&&+i.targetAt===+tailEnd));
    pass("API-first then late websocket preserves frozen repair targets, avoids overlapping duplicate jobs and retains the uncovered tail for exact follow-up recovery");

    async function ledger(s,{start=from,end=now,cents=2000}={}) {
      await commit(async t=>{
        await gen.lock(t,s.creatorId);const id="generation-"+s.creatorId;
        await t.creatorEarningsGeneration.create({data:{id,...narrow(s),runId:"fixture-"+s.creatorId,state:"ACTIVE",phase:"READY",fromAt:start,throughAt:end,snapshotAt:end,fullScan:true,publishedAt:end}});
        await t.creatorEarningsLedgerProof.create({data:{...narrow(s),fromAt:start,throughAt:end,generation:id,activeGeneration:id}});
        if(cents)await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGenerationDay"(generation,date,category,"netCents","observedAt")
          SELECT $1,d::date,'tips',$4,$5 FROM generate_series($2::date,$3::date,interval '1 day') d`,id,from,to,cents,end);
      });
    }
    async function published(s,cents=10000) {
      const proof="proof-"+s.creatorId,jobId=proof+"-job";
      await commit(async t=>{
        await t.jobInstance.create({data:{id:jobId,...narrow(s),scope:"CREATOR",jobKey:"fetch_earnings",status:"PUBLISHING",params:{scanRunId:proof}}});
        await t.analyticsPublication.create({data:{id:jobId+":1",jobId,...narrow(s),userId:s.userId,deviceId:s.deviceId,leaseRevision:1,leaseTokenHash:"fixture",payloadHash:"fixture",payload:{scanRunId:proof},stage:"FINALIZE"}});
        await t.analyticsScanProof.create({data:{id:proof,...narrow(s),dataType:"EARNINGS",scanRunId:proof,sourceTimezone:"UTC",scanFrom:from,scanTo:to,
          requestedAt:now,observationStartedAt:now,serverReceivedAt:now,committedAt:now,status:"COMMITTED",collectorVersion:"earnings-v7",schemaVersion:1,
          scanGeneration:proof,collectionReason:"fixture",payloadChecksum:"fixture",proofVersion:2,sourceJobId:jobId}});
        await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsPublishedDay"(id,"agencyId","creatorId",date,"totalCents","sourceScanRunId","scanProofId","collectedAt","coverageStatus","lastVerifiedAt","updatedAt")
          SELECT $1||':'||d::date,$2,$3,d::date,$4,$1,$1,$5,'COMPLETE',$5,$5 FROM generate_series($6::date,$7::date,interval '1 day') d`,proof,s.agencyId,s.creatorId,cents,now,from,to);
        await t.analyticsPublication.update({where:{id:jobId+":1"},data:{state:"COMMITTED",completedAt:now}});
        await t.jobInstance.update({where:{id:jobId},data:{status:"DONE"}});
      });
    }
    const current=await account("ledger"),zero=await account("zero"),legacy=await account("legacy"),partial=await account("partial"),mixed=await account("mixed");
    await ledger(current);await published(current);await ledger(zero,{cents:0});await published(legacy,3000);
    await ledger(partial,{start:new Date(+from+12*3600000)});await published(partial,9000);
    await ledger(mixed,{start:new Date(+from+15*DAY)});await published(mixed,3000);
    const read=(ids,at=now)=>repository.readPublishedEarningsAggregates({db,creatorIds:ids,from,to,now:at,freshnessMs:48*3600000});
    let aggregates=await read([current.creatorId,zero.creatorId,legacy.creatorId,partial.creatorId,mixed.creatorId]);
    assert.equal(aggregates.get(current.creatorId).cents,60000);assert.equal(aggregates.get(current.creatorId).days,30);assert.equal(aggregates.get(current.creatorId).fresh,30);
    assert.equal(aggregates.get(zero.creatorId).cents,0);assert.equal(aggregates.get(zero.creatorId).days,30);
    assert.equal(aggregates.get(legacy.creatorId).cents,90000);assert.equal(aggregates.get(partial.creatorId).days,29);
    assert.equal(aggregates.get(mixed.creatorId).cents,75000);assert.equal(aggregates.get(mixed.creatorId).days,30);
    const billing=require(root+"/src/services/billing-wallet-service");
    const revenue=await billing.readRolling30dRevenue({db,creatorId:current.creatorId,now,authorityResolved:true});
    assert.equal(revenue.revenue30dCents,60000);assert.equal(revenue.fresh,true);
    assert.equal((await billing.readRolling30dRevenue({db,creatorId:partial.creatorId,now,authorityResolved:true})).revenue30dCents,null);
    await db.creatorRecoveryIntent.create({data:{id:"partial-debt",...narrow(partial),stream:"financial",reason:"OFFLINE_GAP",gapFrom:old,targetAt:now,policyVersion:2}});
    assert.equal((await read([partial.creatorId])).get(partial.creatorId).days,29);
    assert.equal((await read([partial.creatorId])).get(partial.creatorId).fresh,0);
    assert.equal((await billing.readRolling30dRevenue({db,creatorId:partial.creatorId,now,authorityResolved:true})).revenue30dCents,null);
    assert.equal((await read([current.creatorId],new Date(+now+10*60000))).get(current.creatorId).fresh,30);
    pass("real Billing reads canonical ledger cents, complete known zero and mixed historical fallback once per day; incomplete boundary day stays unavailable; billing freshness policy is preserved");

    await db.creatorRecoveryIntent.create({data:{id:"billing-debt",...narrow(current),stream:"financial",reason:"OFFLINE_GAP",gapFrom:old,targetAt:now,policyVersion:2}});
    assert.equal((await read([current.creatorId])).get(current.creatorId).fresh,0);
    assert.equal((await read([current.creatorId])).get(current.creatorId).cents,60000,"recovery must not fall back to stale competing amounts");
    await db.creatorRecoveryIntent.update({where:{id:"billing-debt"},data:{status:"COMPLETE"}});
    await commit(async t=>{await gen.lock(t,current.creatorId);await t.creatorMoneyObservation.create({data:{id:"money-pending",...narrow(current),occurredAt:to,capturedAt:now,status:"PENDING"}});});
    assert.equal((await read([current.creatorId])).get(current.creatorId).fresh,0);
    await commit(async t=>{await gen.lock(t,current.creatorId);await t.creatorMoneyObservation.update({where:{id:"money-pending"},data:{coveredGeneration:"generation-"+current.creatorId}});});
    assert.equal((await read([current.creatorId])).get(current.creatorId).fresh,30);
    await db.creatorLiveSync.create({data:{...narrow(current),shortGapFrom:now,shortGapTo:new Date(+now+60000)}});
    assert.equal((await read([current.creatorId])).get(current.creatorId).fresh,0);
    const outside=await account("outside-ledger");await ledger(outside,{start:new Date(+from-30*DAY),end:new Date(+from-DAY),cents:0});await published(outside,3000);
    assert.equal((await read([outside.creatorId])).get(outside.creatorId).fresh,30);
    await db.creatorRecoveryIntent.create({data:{id:"outside-debt",...narrow(outside),stream:"financial",reason:"OFFLINE_GAP",gapFrom:old,targetAt:now,policyVersion:2}});
    const fencedFallback=(await read([outside.creatorId])).get(outside.creatorId);
    assert.equal(fencedFallback.days,30);assert.equal(fencedFallback.cents,90000);assert.equal(fencedFallback.fresh,0);
    pass("financial recovery, unresolved money and short capture gaps fence billing freshness; published-generation resolution restores it without legacy substitution");

    f.queries.length=0;
    const bounded=await read([zero.creatorId,...Array.from({length:250},(_,i)=>"absent-"+i)]);
    assert.equal(bounded.size,1);assert.equal(f.queries.filter(q=>q.query.includes("published_earnings_aggregate_v1")).length,2);
    pass("aggregate reader preserves 250-creator query batches and returns aggregates only");
    for(const zone of ["UTC","America/Los_Angeles","Asia/Kolkata"]) {
      await db.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
      const rows=await read([zero.creatorId,legacy.creatorId,mixed.creatorId]);
      assert.equal(rows.get(zero.creatorId).days,30);assert.equal(rows.get(legacy.creatorId).cents,90000);
      assert.equal(rows.get(mixed.creatorId).cents,75000);assert.equal(rows.get(mixed.creatorId).fresh,30);
      const timed=await account("timezone-"+zone.replaceAll("/","-"));await seedLive(timed);await receive(timed);
      assert((await debts(timed)).every(i=>+i.targetAt===+now&&+i.gapFrom===+old));
      assert.equal((await debts(timed)).length,4);
    }
    pass("closed UTC day coverage, sums, freshness and recovery intervals are invariant under UTC, Los Angeles and Kolkata database timezones");
    await db.$executeRawUnsafe("SET TIME ZONE 'UTC'");
    const bulk=await account("bulk"),bulkIds=Array.from({length:501},(_,i)=>"bulk-creator-"+String(i).padStart(4,"0"));
    await commit(async t=>{
      await t.$executeRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true),set_config('onlinod.earnings_writer_generation','v7',true)");
      await t.$executeRawUnsafe(`INSERT INTO "CreatorAccount"(id,"agencyId","displayName","remoteId",status,"createdAt","updatedAt")
        SELECT id,$1,id,id,'READY',$3,$3 FROM unnest($2::text[]) id`,bulk.agencyId,bulkIds,now);
      await t.$executeRawUnsafe(`INSERT INTO "CreatorLiveSync"("creatorId","agencyId","lastCapturedAt","lastDeliveredAt") SELECT id,$1,$3,$3 FROM unnest($2::text[]) id`,bulk.agencyId,bulkIds,old);
    });
    const bulkHeartbeat=()=>commit(async t=>{
      const normalized=await heartbeat.syncBindings({db:t,agencyId:bulk.agencyId,deviceId:bulk.deviceId,accounts:bulkIds.map(creatorId=>({...apiAccount(bulk),creatorId})),
        currentAccessEpoch:bulk.member.accessEpoch,now});
      assert.equal(normalized.accepted,501);
      await sync.recordCaptureSamples({db:t,agencyId:bulk.agencyId,deviceId:bulk.deviceId,memberId:bulk.member.id,accessEpoch:bulk.member.accessEpoch,bindings:normalized.resolvedAccounts,now});
    });
    f.queries.length=0;await bulkHeartbeat();
    assert.equal(f.queries.filter(q=>q.query.includes("api_ready_recovery_debt_v1")).length,2);
    assert.equal(await db.creatorRecoveryIntent.count({where:{agencyId:bulk.agencyId}}),2004);
    await bulkHeartbeat();assert.equal(await db.creatorRecoveryIntent.count({where:{agencyId:bulk.agencyId}}),2004);
    await commit(async t=>{
      await t.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
      await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerProof"("creatorId","agencyId","fromAt","throughAt",generation)
        SELECT id,$1,$3,$4,'bulk-fixture' FROM unnest($2::text[]) id`,bulk.agencyId,bulkIds,from,now);
    });
    f.queries.length=0;const bulkTotals=await read(bulkIds);
    assert.equal(bulkTotals.size,501);assert.equal(f.queries.filter(q=>q.query.includes("published_earnings_aggregate_v1")).length,3);
    assert([...bulkTotals.values()].every(row=>row.days===30&&row.cents===0&&row.fresh===0));
    pass("501 actual creators produce two bounded recovery batches without duplicate debt; three bounded billing queries preserve complete zero and recovery fences");
    console.log(JSON.stringify({ok:true,checks:checks.length,runtime:process.version,sql:"PGlite + Prisma",provider:"controlled fixture"}));
  } finally {await f.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{clearInterval(keepAlive);clearTimeout(deadline);});
