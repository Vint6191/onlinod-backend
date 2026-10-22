"use strict";
// Current schema + Prisma + real lifecycle/source services. Only provider rows
// and the read-token issuer are synthetic; no production service is contacted.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const keep = setInterval(() => {}, 1000);
(async () => {
  const f = await fixture();
  try {
    const { db } = f;
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const sync = require("../../src/services/creator-live-sync-service");
    const subscribers = require("../../src/services/subscriber-directory-service");
    const frontier = require("../../src/services/notification-frontier-authority");
    const source = require("../../src/services/notification-source-ledger-service");
    const collection = require("../../src/services/analytics-collector-control-service");
    const tx = fn => runRootCommit(db, ({tx}) => fn(tx), {profile:"JOB_CHUNK"});
    const s = await scope(db), now = new Date(), old = new Date(+now - 2 * 3600000);
    const member = await db.agencyMember.findUnique({where:{id:"member-"+s.agencyId}});
    for (const id of ["receiver-a","receiver-b"]) await db.workerDevice.create({data:{id,agencyId:s.agencyId,userId:s.userId,lastSeenAt:now}});
    await db.creatorLiveSync.create({data:{agencyId:s.agencyId,creatorId:s.creatorId,lastCapturedAt:old}});
    const ready = {sessionReadReady:true,realtimeHealthy:false};
    const sample = (deviceId,account,at=now) => tx(db=>sync.recordCaptureSamples({db,agencyId:s.agencyId,memberId:member.id,
      accessEpoch:member.accessEpoch,deviceId,now:at,bindings:[{creatorId:s.creatorId,account}]}));
    await sample("receiver-a",ready);
    let intents=await db.creatorRecoveryIntent.findMany({where:{creatorId:s.creatorId}});
    assert.equal(intents.length,4);
    const frozen=intents.map(i=>[i.id,+i.targetAt]);
    await sample("receiver-b",ready,new Date(+now+1800000));
    assert.deepEqual((await db.creatorRecoveryIntent.findMany({where:{creatorId:s.creatorId},orderBy:{id:"asc"}})).map(i=>[i.id,+i.targetAt]),frozen.sort((a,b)=>a[0].localeCompare(b[0])));
    const notificationIntent=intents.find(i=>i.stream==="notifications");
    const failedJob=await db.jobInstance.create({data:{id:"exhausted-episode",agencyId:s.agencyId,creatorId:s.creatorId,
      jobKey:"catchup_notifications_scan",scope:"creator",status:"FAILED",attempts:5,lastError:"provider unavailable",
      params:{...sync.recoveryParams(notificationIntent)}}});
    await tx(db=>sync.bindRecovery(db,notificationIntent,failedJob.id));
    await assert.rejects(tx(db=>sync.completeRecovery(db,failedJob,true,{coveredThrough:new Date(+notificationIntent.targetAt-1)})),
      {code:"LIVE_RECOVERY_COVERAGE_INCOMPLETE"});
    assert.equal((await db.creatorRecoveryIntent.findUnique({where:{id:notificationIntent.id}})).status,"RUNNING");
    assert.equal(await tx(db=>sync.pendingRecovery(db,s.creatorId,"notifications")),null);
    await sample("receiver-a",ready,new Date(+now+7200000));
    assert.equal(await db.creatorRecoveryIntent.count({where:{creatorId:s.creatorId}}),4);
    const stopped=await db.creatorRecoveryIntent.findUnique({where:{id:notificationIntent.id}});
    assert.equal(stopped.status,"STOPPED");assert.equal(stopped.failedAttempts,5);
    const privateFailure="provider unavailable private-test-message-do-not-publish";
    await db.creatorRecoveryIntent.update({where:{id:notificationIntent.id},data:{lastError:privateFailure}});
    await db.jobInstance.update({where:{id:failedJob.id},data:{lastError:privateFailure}});
    const diagnostics=await tx(db=>require("../../src/services/recovery-runtime-observer").inspectRecoveryRuntime(db,
      {agencyId:s.agencyId,creatorId:s.creatorId}));
    const visible=diagnostics.recoveryIntents.find(row=>row.id===notificationIntent.id);
    assert.equal(visible.status,"STOPPED");assert.equal(visible.failedAttempts,5);assert.ok(visible.stoppedAt);assert.ok(visible.error);
    assert.equal(Object.hasOwn(visible,"lastError"),false);
    assert.equal(JSON.stringify(diagnostics).includes("private-test-message-do-not-publish"),false);
    await assert.rejects(tx(db=>sync.bindRecovery(db,notificationIntent,"replacement")),/LIVE_RECOVERY_EPISODE_ALREADY_OWNED/);
    console.log("PASS API-ready without acquisition creates one frozen debt per source; exhaustion survives reconnect and cannot rebind");

    for(const [jobKey,stream] of Object.entries(sync.JOB_STREAM)) await tx(db=>sync.completeRecovery(db,
      {id:"manual-"+stream,agencyId:s.agencyId,creatorId:s.creatorId,jobKey,
        params:{collectionMode:"full",collectionRequestedAt:now.toISOString()}},true,{deferPlanningWake:true,coveredThrough:now}));
    assert.equal(await db.creatorRecoveryIntent.count({where:{creatorId:s.creatorId,status:"COMPLETE"}}),4);
    assert.equal(+(await db.creatorLiveSync.findUnique({where:{creatorId:s.creatorId}})).lastCapturedAt,+old);
    const observation=(sessionId,from,at,lossRevision=0)=>({sessionReadReady:true,realtimeHealthy:true,lastWsFrameAt:at.toISOString(),
      observation:{version:1,moneyRevisionVersion:1,sessionId,captureFromAt:from.toISOString(),capturedThroughAt:at.toISOString(),capturedThroughSeq:0,lossRevision}});
    await sample("receiver-a",observation(crypto.randomUUID(),old,now));
    await sample("receiver-b",observation(crypto.randomUUID(),now,now,1));
    assert.equal(await db.creatorRecoveryIntent.count({where:{creatorId:s.creatorId}}),4);
    assert.equal((await db.creatorRealtimeSession.findFirst({where:{deviceId:"receiver-b"}})).loss,false);
    await db.creatorLiveSync.update({where:{creatorId:s.creatorId},data:{shortGapFrom:old,shortGapTo:new Date(+old+300000)}});
    await sample("receiver-a",ready,new Date(+now+30000));
    assert.equal(await db.creatorRecoveryIntent.count({where:{creatorId:s.creatorId}}),4,"age of a five-minute interruption must not create a new one-hour outage");
    console.log("PASS all-source completed scans settle covered debt without inventing live capture; one receiver loss is covered by another continuous receiver");

    const n=await scope(db,{agencyId:"notification-agency",creatorId:"notification-creator",userId:"notification-user"});
    const command=collection.buildCollectionCommand({collectorType:"NOTIFICATIONS",collectionMode:"catchup",now});
    const job=await db.jobInstance.create({data:{id:"notification-episode",agencyId:n.agencyId,creatorId:n.creatorId,
      jobKey:"catchup_notifications_scan",scope:"creator",status:"CLAIMED",params:{...command,notificationMode:"catchup",
        notificationFrontierVersion:3,from:"2016-01-01T00:00:00.000Z",to:now.toISOString(),recoveryGapFrom:old.toISOString(),
        recoveryTargetAt:now.toISOString()}}});
    await db.creatorNotificationSyncState.create({data:{agencyId:n.agencyId,creatorId:n.creatorId,normalizerVersion:source.VERSION,
      fullBackfillVerifiedAt:old,fullBackfillObservedAt:old,status:"COMPLETE"}});
    const row=(id)=>({identityKey:"notification:"+id,notificationId:id,normalizerVersion:source.VERSION,
      sourceType:"price_changed",eventType:"PRICE_CHANGED",disposition:"INFORMATION",targetState:"NOT_APPLICABLE",
      occurredAt:new Date(+old-86400000).toISOString(),sourceEvidence:{id,type:"price_changed"}});
    for(let page=1;page<=6;page++) {
      if(page===3)continue; // missing row resets the first pair of unchanged pages
      await db.creatorNotificationEvent.create({data:{id:"event-"+page,agencyId:n.agencyId,creatorId:n.creatorId,
        ...source.normalizeObservation(row("n-"+page)),scanRunId:"historical-baseline",persistenceStatus:"EVENT_STORED",firstObservedAt:old,lastObservedAt:old}});
    }
    let last;
    for(let page=1;page<=6;page++) {
      const chunk={schemaVersion:6,normalizerVersion:source.VERSION,collectorVersion:source.COLLECTOR,
        scanRunId:command.collectionGeneration,page,processedRows:1,observations:[row("n-"+page)],batches:[],
        notificationMode:"catchup",sourcePhase:"all",sourceHasMore:true,sourceExhausted:false,providerPageComplete:true,
        cursorStart:page===1?null:"n-"+(page-1),cursorEnd:"n-"+page,headNotificationId:"n-1",tailNotificationId:"n-"+page};
      last=await source.ingestNotificationSourcePage({db,job,chunk});
      assert.equal(frontier.completed(job,last.notificationFrontier),page===6);
      if(page===3) {
        const replay=await source.ingestNotificationSourcePage({db,job,chunk});assert.equal(replay.replayed,true);
        assert.equal(await db.creatorNotificationEvent.count({where:{creatorId:n.creatorId}}),6);
      }
    }
    assert.equal(last.notificationFrontier.boundaryPage,4);assert.equal(last.notificationFrontier.overlapPage,6);
    assert.equal(await db.creatorNotificationFrontierPage.count({where:{creatorId:n.creatorId}}),6);
    console.log("PASS actual notification persistence detects a missing row, replay is idempotent, and exactly three later unchanged pages close the fixed episode");

    const sub=await scope(db,{agencyId:"subscriber-agency",creatorId:"subscriber-creator",userId:"subscriber-user"});
    const input={db,agencyId:sub.agencyId,creatorId:sub.creatorId};
    const scheduled=await subscribers.scheduleSubscriberScan(input), sj=scheduled.job;
    await tx(db=>subscribers.applySubscriberScanChunk({db,job:sj,chunkResult:{kind:"subscriber_directory_page",
      scanRunId:sj.params.scanRunId,offset:0,items:[],hasMore:true,observationToken:"synthetic",
      pagination:{contract:"of_subscribers_offset_v2",limit:20}},consumeObservationToken:async()=>({observedAt:now})}));
    await db.jobInstance.update({where:{id:sj.id},data:{status:"PUBLISHING"}});
    await subscribers.recoverSubscriberPublicationDebt(input);
    const resumed=await db.jobInstance.findUnique({where:{id:sj.id}});
    assert.equal(resumed.status,"SCHEDULED");assert.equal(resumed.continuation.jobContinuation.offset,20);
    assert.equal(await db.subscriberScanRun.count({where:{creatorId:sub.creatorId}}),1);
    await db.jobInstance.update({where:{id:sj.id},data:{status:"FAILED",attempts:5,lastError:"source failed"}});
    await subscribers.recordSubscriberScanFailure({db,job:sj,error:"source failed",terminal:true});
    for(let count=0;count<3;count++)assert.equal((await subscribers.ensureSubscriberScanDue(input)).reason,"failed_terminal");
    assert.equal(await db.subscriberScanRun.count({where:{creatorId:sub.creatorId}}),1);
    console.log("PASS premature subscriber publication resumes the same page cursor; terminal initial scan is preserved across planner restarts");

    const complete=await scope(db,{agencyId:"subscriber-complete-agency",creatorId:"subscriber-complete-creator",userId:"subscriber-complete-user"});
    const completeInput={db,agencyId:complete.agencyId,creatorId:complete.creatorId};
    const initial=await subscribers.scheduleSubscriberScan(completeInput), full=initial.job;
    await db.creatorRecoveryIntent.create({data:{id:"covered-during-initial",agencyId:complete.agencyId,creatorId:complete.creatorId,
      stream:"subscribers",reason:"OFFLINE_GAP",gapFrom:old,targetAt:new Date(+now-3600000),policyVersion:2}});
    await tx(db=>subscribers.applySubscriberScanChunk({db,job:full,chunkResult:{kind:"subscriber_directory_page",
      scanRunId:full.params.scanRunId,offset:0,items:[],hasMore:false,observationToken:"synthetic-final",
      pagination:{contract:"of_subscribers_offset_v2",limit:20}},consumeObservationToken:async()=>({observedAt:now})}));
    await subscribers.applySubscriberScanCompletion({db,job:full,result:{}});
    await subscribers.recoverSubscriberPublicationDebt(completeInput);
    assert.equal((await db.creatorRecoveryIntent.findUnique({where:{id:"covered-during-initial"}})).status,"COMPLETE");
    for(let count=0;count<3;count++)assert.equal((await subscribers.ensureSubscriberScanDue(completeInput)).created,false);
    assert.equal(await db.subscriberScanRun.count({where:{creatorId:complete.creatorId}}),1);
    console.log("PASS complete subscriber initial publication settles unlinked covered intent and repeated planning schedules no duplicate scan");

    const priorTarget=new Date(+now-3600000),resumedAt=new Date(+now+60000),laterOutage=new Date(+resumedAt+7200000);
    await db.creatorLiveSync.create({data:{agencyId:complete.agencyId,creatorId:complete.creatorId,lastCapturedAt:old}});
    await db.workerDevice.create({data:{id:"episode-receiver",agencyId:complete.agencyId,userId:complete.userId,lastSeenAt:now}});
    const episodeMember=await db.agencyMember.findUnique({where:{id:"member-"+complete.agencyId}});
    const previous=await db.creatorRecoveryIntent.create({data:{id:"stopped-subscriber-episode",agencyId:complete.agencyId,creatorId:complete.creatorId,
      stream:"subscribers",reason:"OFFLINE_GAP",gapFrom:old,targetAt:priorTarget,policyVersion:2}});
    const previousRun=await subscribers.scheduleSubscriberScan({...completeInput,recoveryIntent:previous});
    await db.jobInstance.update({where:{id:previousRun.job.id},data:{status:"FAILED",attempts:5,lastError:"provider exhausted"}});
    await subscribers.recordSubscriberScanFailure({db,job:previousRun.job,error:"provider exhausted",terminal:true});
    await tx(db=>sync.pendingRecovery(db,complete.creatorId,"subscribers"));
    const episodeSample=(account,at)=>tx(db=>sync.recordCaptureSample({db,agencyId:complete.agencyId,creatorId:complete.creatorId,
      memberId:episodeMember.id,accessEpoch:episodeMember.accessEpoch,deviceId:"episode-receiver",account,now:at}));
    await episodeSample(observation(crypto.randomUUID(),resumedAt,resumedAt),resumedAt);
    assert.equal(await db.creatorRecoveryIntent.count({where:{creatorId:complete.creatorId,stream:"subscribers",status:{not:"COMPLETE"}}}),1,
      "ordinary reconnect cannot create a new target behind the stopped episode");
    await episodeSample(ready,laterOutage);
    const independent=await tx(db=>sync.pendingRecovery(db,complete.creatorId,"subscribers"));
    assert.ok(independent);assert.notEqual(independent.id,previous.id);assert.equal(+independent.gapFrom,+resumedAt);
    assert.equal(await tx(db=>sync.independentRecoveryAfterStop(db,{creatorId:complete.creatorId,stream:"subscribers",
      intentId:independent.id,sourceJobId:previousRun.job.id})),true);
    await episodeSample(ready,new Date(+laterOutage+7200000));
    assert.equal(await db.creatorRecoveryIntent.count({where:{creatorId:complete.creatorId,stream:"subscribers",status:{not:"COMPLETE"}}}),2);
    const independentScan=await subscribers.ensureSubscriberScanDue(completeInput);
    assert.equal(independentScan.created,true);assert.equal(independentScan.job.params.recoveryIntentId,independent.id);
    assert.equal((await db.creatorRecoveryIntent.findUnique({where:{id:previous.id}})).status,"STOPPED");
    console.log("PASS same-outage reconnect retains STOPPED target; durable resumed capture permits one distinct later outage episode and Subscriber job");

    const late=await scope(db,{agencyId:"late-publication-agency",creatorId:"late-publication-creator",userId:"late-publication-user"});
    const lateInput={db,agencyId:late.agencyId,creatorId:late.creatorId};
    const lateIntent=await db.creatorRecoveryIntent.create({data:{id:"late-publication-episode",agencyId:late.agencyId,creatorId:late.creatorId,
      stream:"subscribers",reason:"OFFLINE_GAP",gapFrom:old,targetAt:priorTarget,policyVersion:2}});
    const lateJob=(await subscribers.scheduleSubscriberScan({...lateInput,recoveryIntent:lateIntent})).job;
    await tx(db=>subscribers.applySubscriberScanChunk({db,job:lateJob,chunkResult:{kind:"subscriber_directory_page",
      scanRunId:lateJob.params.scanRunId,offset:0,items:[],hasMore:false,observationToken:"late-final",
      pagination:{contract:"of_subscribers_offset_v2",limit:20}},consumeObservationToken:async()=>({observedAt:now})}));
    await db.jobInstance.update({where:{id:lateJob.id},data:{status:"FAILED",attempts:5,lastError:"lost final acknowledgement"}});
    const lateFailure=await subscribers.recordSubscriberScanFailure({db,job:lateJob,error:"lost final acknowledgement",terminal:true});
    assert.equal(lateFailure.publicationRecoveryPending,true);
    assert.equal((await tx(db=>sync.pendingRecovery(db,late.creatorId,"subscribers"))).status,"RUNNING");
    // An older server may already have stopped it; persisted final-page proof
    // can still finish publication without admitting any new provider request.
    await tx(db=>sync.stopRecovery(db,lateJob,"legacy stop after final page"));
    await subscribers.recoverSubscriberPublicationDebt(lateInput);
    assert.equal((await db.creatorRecoveryIntent.findUnique({where:{id:lateIntent.id}})).status,"COMPLETE");
    assert.equal((await db.jobInstance.findUnique({where:{id:lateJob.id}})).status,"DONE");
    assert.equal(await db.subscriberScanRun.count({where:{creatorId:late.creatorId}}),1);
    console.log("PASS final-page publication survives terminal transport acknowledgement loss and legacy stopped intent without another scan");
    const retry=await scope(db,{agencyId:"retry-budget-agency",creatorId:"retry-budget-creator",userId:"retry-budget-user"});
    await db.agency.update({where:{id:retry.agencyId},data:{trialEndsAt:new Date(Date.now()+86400000)}});
    const retryMember=await db.agencyMember.findUnique({where:{id:"member-"+retry.agencyId}});
    for(const id of ["retry-receiver-a","retry-receiver-b"]) await db.workerDevice.create({data:{id,
      agencyId:retry.agencyId,userId:retry.userId,lastSeenAt:new Date()}});
    const retryJob=(await subscribers.scheduleSubscriberScan({db,agencyId:retry.agencyId,creatorId:retry.creatorId})).job;
    let lease,leaseInput,reclaims=0;
    const retryState=()=>db.jobInstance.findUnique({where:{id:retryJob.id}});
    // Fixture lease grants skip wall-clock backoff. Every real mutation below
    // still validates the current persisted member/device/token/revision fence.
    // Reload the owner and alternate receivers to exercise restart/handoff.
    const reclaim=async()=>{
      const previous=await retryState(),token=crypto.randomBytes(32).toString("base64url");
      const deviceId=++reclaims%2?"retry-receiver-a":"retry-receiver-b";
      const row=await db.jobInstance.update({where:{id:retryJob.id},data:{status:"CLAIMED",
        claimedAt:new Date(),claimedByDeviceId:deviceId,leaseRevision:{increment:1},
        leaseTokenHash:crypto.createHash("sha256").update(token).digest("hex"),leaseUntil:new Date(Date.now()+60000),
        leaseMemberId:retryMember.id,leaseAccessEpoch:retryMember.accessEpoch}});
      assert.equal(row.attempts,previous.attempts);
      assert.deepEqual(row.continuation,previous.continuation);
      delete require.cache[require.resolve("../../src/services/job-lease-service")];
      lease=require("../../src/services/job-lease-service");
      leaseInput={jobId:row.id,userId:retry.userId,deviceId,leaseToken:token,leaseRevision:row.leaseRevision};
    };
    const provider429=()=>lease.failJob({...leaseInput,error:"provider 429",retryable:true,
      result:{failureContext:{category:"rate_limit",status:429,operation:"subscribers.all"}}});
    let latestPage,previousContinuation;
    await reclaim();
    for(let page=0;page<6;page++) {
      assert.equal((await provider429()).status,"SCHEDULED");
      assert.equal((await retryState()).attempts,1);
      await reclaim();
      previousContinuation=(await retryState()).continuation;
      latestPage={kind:"subscriber_directory_page",scanRunId:retryJob.params.scanRunId,offset:page*20,
        items:[],hasMore:true,pagination:{contract:"of_subscribers_offset_v2",limit:20}};
      const committed=await lease.progressJob({...leaseInput,expectedContinuation:previousContinuation,chunkResult:latestPage});
      assert.equal(committed.sideEffect.duplicate,false);
      const advanced=await retryState();
      assert.equal(advanced.attempts,0,"a new committed source frontier owns a fresh retry budget");
      assert.equal(advanced.continuation.jobContinuation.offset,(page+1)*20);
    }
    await provider429();await reclaim();
    assert.equal((await retryState()).attempts,1);
    const checkpoint=(await retryState()).continuation;
    const stale=await lease.progressJob({...leaseInput,expectedContinuation:previousContinuation,chunkResult:latestPage});
    assert.equal(stale.sideEffect.staleProgress,true);
    const replay=await lease.progressJob({...leaseInput,expectedContinuation:checkpoint,chunkResult:latestPage});
    assert.equal(replay.sideEffect.duplicate,true);
    await lease.progressJob({...leaseInput,expectedContinuation:checkpoint,continuation:checkpoint,progress:{current:0},chunkResult:null});
    await lease.renewLease({...leaseInput,continuation:checkpoint,progress:{current:0}});
    assert.equal((await retryState()).attempts,1,"replay, cosmetic progress and heartbeat cannot replenish retries");
    assert.equal((await lease.releaseJob({...leaseInput,reason:"request gate cooldown",runAfterMs:1000})).attempts,1);
    await reclaim();
    for(let attempt=2;attempt<=5;attempt++) {
      const failed=await provider429(),persisted=await retryState();
      assert.equal(persisted.attempts,attempt);
      assert.deepEqual(persisted.continuation,checkpoint);
      assert.equal(failed.status,attempt===5?"FAILED":"SCHEDULED");
      if(attempt<5)await reclaim();
    }
    assert.equal(await db.subscriberScanRun.count({where:{creatorId:retry.creatorId}}),1);
    assert.equal(await db.subscriberScanPage.count({where:{runId:retryJob.params.scanRunId}}),6);
    assert.equal((await subscribers.ensureSubscriberScanDue({db,agencyId:retry.agencyId,creatorId:retry.creatorId})).reason,"failed_terminal");
    console.log("PASS six advancing source segments survive isolated failures; replay/yield/restart preserve five failures on one stalled segment and stop the same scan");
    const evidenceScope=await scope(db,{agencyId:"coverage-evidence-agency",creatorId:"coverage-evidence-creator",userId:"coverage-evidence-user"});
    for(const [jobKey,stream] of Object.entries(sync.JOB_STREAM)) {
      const intent=await db.creatorRecoveryIntent.create({data:{id:"evidence-"+stream,agencyId:evidenceScope.agencyId,
        creatorId:evidenceScope.creatorId,stream,reason:"OFFLINE_GAP",gapFrom:old,targetAt:now,policyVersion:2}});
      const nextIntent=await db.creatorRecoveryIntent.create({data:{id:"evidence-future-"+stream,agencyId:evidenceScope.agencyId,
        creatorId:evidenceScope.creatorId,stream,reason:"OFFLINE_GAP",gapFrom:now,targetAt:new Date(+now+1),policyVersion:2}});
      const stored=await db.jobInstance.create({data:{id:"evidence-job-"+stream,agencyId:evidenceScope.agencyId,
        creatorId:evidenceScope.creatorId,jobKey,scope:"creator",status:"CLAIMED",params:sync.recoveryParams(intent)}});
      await tx(db=>sync.bindRecovery(db,intent,stored.id));
      const owner={id:stored.id,agencyId:stored.agencyId,creatorId:stored.creatorId,jobKey};
      const before=await db.creatorRecoveryIntent.findUnique({where:{id:intent.id}});
      const sourceParams=stream==="financial"?{endDate:now.toISOString()}:stream==="notifications"?{to:now.toISOString()}
        :{collectionRequestedAt:now.toISOString()};
      const absent=[
        {params:{recoveryIntentId:intent.id}},
        {params:sync.recoveryParams(intent)},
        {params:{...sync.recoveryParams(intent),...sourceParams},coveredThrough:null},
        {params:{...sync.recoveryParams(intent),...sourceParams},coveredThrough:"invalid-source-bound"},
        ...(["financial","notifications"].includes(stream)?[{params:{...sync.recoveryParams(intent),collectionRequestedAt:now.toISOString()},
          createdAt:now,scheduledAt:now}]:[]),
      ];
      for(const fixture of absent) {
        await assert.rejects(tx(async db=>{
          await db.jobInstance.update({where:{id:stored.id},data:{status:"DONE"}});
          await sync.completeRecovery(db,{...owner,...fixture},true,{deferPlanningWake:true,coveredThrough:fixture.coveredThrough});
        }),{code:"LIVE_RECOVERY_COVERAGE_REQUIRED"});
        assert.equal((await db.jobInstance.findUnique({where:{id:stored.id}})).status,"CLAIMED","coverage failure must roll back a preceding completion flag");
        assert.deepEqual(await db.creatorRecoveryIntent.findUnique({where:{id:intent.id}}),before);
        assert.equal(await db.creatorRecoveryWatermark.count({where:{creatorId:evidenceScope.creatorId,stream}}),0);
      }
      await tx(db=>sync.completeRecovery(db,{...owner,params:{...sync.recoveryParams(intent),...sourceParams}},true,{deferPlanningWake:true}));
      assert.equal((await db.creatorRecoveryIntent.findUnique({where:{id:intent.id}})).status,"COMPLETE");
      assert.equal((await db.creatorRecoveryIntent.findUnique({where:{id:nextIntent.id}})).status,"PENDING");
      assert.equal(+(await db.creatorRecoveryWatermark.findUnique({where:{creatorId_stream:{creatorId:evidenceScope.creatorId,stream}}})).throughAt,+now);
    }
    console.log("PASS all four sources reject missing, target-only and malformed coverage without committing DONE; explicit source evidence settles only the fixed covered interval");
    for(const bound of [false,true]) {
      const reused=await scope(db,{agencyId:"reuse-boundary-agency-"+bound,creatorId:"reuse-boundary-creator-"+bound,userId:"reuse-boundary-user-"+bound});
      const intent=await db.creatorRecoveryIntent.create({data:{id:"reuse-intent-"+bound,agencyId:reused.agencyId,
        creatorId:reused.creatorId,stream:"campaigns",reason:"OFFLINE_GAP",gapFrom:old,targetAt:now,policyVersion:2}});
      const params={...collection.buildCollectionCommand({collectorType:"CAMPAIGNS",collectionMode:"catchup",now}),
        analyticsObservationStartedAt:now.toISOString(),campaignDirectoryReuseGeneration:"old-directory",
        ...(bound?sync.recoveryParams(intent):{})};
      const reusedJob=await db.jobInstance.create({data:{id:"reuse-job-"+bound,agencyId:reused.agencyId,creatorId:reused.creatorId,
        jobKey:"fetch_campaigns",scope:"creator",status:"PUBLISHING",params}});
      if(bound)await tx(db=>sync.bindRecovery(db,intent,reusedJob.id));
      // Seed the real publication authority for this source-owner boundary;
      // the database trigger remains active and validates the matching job.
      await db.analyticsPublication.create({data:{id:"reuse-publication-"+bound,jobId:reusedJob.id,
        agencyId:reused.agencyId,creatorId:reused.creatorId,userId:reused.userId,deviceId:"fixture",
        leaseRevision:1,leaseTokenHash:"fixture",payloadHash:"fixture",payload:{scanRunId:params.collectionGeneration},stage:"FINALIZE"}});
      await db.creatorCampaignCollectionState.create({data:{agencyId:reused.agencyId,creatorId:reused.creatorId,status:"SCANNING",mode:"catchup",
        activeGeneration:params.collectionGeneration,activeRequestedAt:now,baselineGeneration:"old-baseline",
        baselineVerifiedAt:old,baselineObservedAt:old,campaignDirectoryGeneration:"old-directory",campaignDirectoryRequestedAt:old,
        campaignDirectoryVerifiedAt:old,campaignDirectoryCampaignCount:0,campaignFrontierPlanRunId:params.collectionGeneration,campaignFrontierTargetCount:0,sourceJobId:reusedJob.id}});
      const before=await db.creatorCampaignCollectionState.findUnique({where:{creatorId:reused.creatorId}});
      const finish=()=>collection.completeCampaignCollection({db,job:reusedJob,complete:true,membershipComplete:true,scanRunId:params.collectionGeneration});
      if(bound) {
        await assert.rejects(finish(),{code:"LIVE_RECOVERY_COVERAGE_INCOMPLETE"});
        assert.deepEqual(await db.creatorCampaignCollectionState.findUnique({where:{creatorId:reused.creatorId}}),before,
          "a rejected bound completion rolls back the preceding collector COMPLETE flag");
      } else {
        await finish();
        assert.equal(+(await db.creatorCampaignCollectionState.findUnique({where:{creatorId:reused.creatorId}})).membershipObservedAt,+old);
      }
      assert.equal((await db.creatorRecoveryIntent.findUnique({where:{id:intent.id}})).status,bound?"RUNNING":"PENDING");
      assert.equal((await db.jobInstance.findUnique({where:{id:reusedJob.id}})).status,"PUBLISHING");
    }
    console.log("PASS reused Campaign observation cannot settle newer linked or unlinked recovery debt; failed ownership completion rolls back collector success");
    console.log(JSON.stringify({ok:true,provider:"synthetic",sql:"current migration chain + Prisma/PGlite",checks:10}));
  } finally { await f.close(); }
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>clearInterval(keep));
