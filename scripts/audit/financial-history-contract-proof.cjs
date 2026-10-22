"use strict";
// Real PostgreSQL engine + Prisma owner transactions with the exact Desktop
// collector. Provider responses are synthetic; no provider semantics are inferred.
const assert = require("node:assert/strict"), path = require("node:path");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const root = path.resolve(__dirname, "../.."), checks = [];
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("FINANCIAL_HISTORY_PROOF_DEADLINE"); process.exit(2); }, 240000);
const pass = text => { checks.push(text); console.log("PASS", text); };
(async () => {
  const runtime = await createScaleSqlRuntime(); let desktop;
  try {
    const { db } = runtime;
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    desktop = await require("../test-support/desktop-financial-handler.cjs").loadDesktopFinancialHandler(process.env.ONLINOD_DESKTOP_SOURCE || path.resolve(root, "../desktop168"));
    const control = require(root + "/src/services/analytics-collector-control-service"), receipts = require(root + "/src/services/financial-receipt-authority");
    const lease = require(root + "/src/services/job-lease-service"), publication = require(root + "/src/services/analytics-publication-service");
    const gen = require(root + "/src/services/earnings-generation-service"), now = new Date(Math.floor(Date.now()/1000)*1000);
    const s = await scope(db, { agencyId: "history-agency", creatorId: "history-creator", userId: "history-user" }), deviceId = "history-device";
    await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date(+now + 86400000) } });
    await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: new Date() } });
    await db.deviceCreatorBinding.create({ data: { deviceId, agencyId: s.agencyId, creatorId: s.creatorId, sessionReadReady: true, lastSeenAt: new Date() } });
    const capabilities = { creatorEventDrivenSyncV2:true, financialWindowReceiptsV1:true, financialMoneyResolutionV1:true, financialTraversalV2:true };
    async function start({ mode = "full", gapFrom = null, recoveryIntentId = null, recoveryTargetAt = now } = {}) {
      const created = await db.jobInstance.create({ data: { agencyId:s.agencyId, creatorId:s.creatorId, scope:"creator", jobKey:"financial_transactions_scan", status:"SCHEDULED",
        params: { ...control.buildCollectionCommand({collectorType:"FINANCIAL",collectionMode:mode,reason:"MANUAL_PROOF",now:new Date()}),
          endDate:now.toISOString(), earningsLedgerVersion:1, ...(recoveryIntentId ? { recoveryIntentId, recoveryTargetAt: recoveryTargetAt.toISOString() } : {}),
          ...(mode === "catchup" ? {financialMode:mode,financialFrontierVersion:2,recoveryGapFrom:gapFrom.toISOString()} : {startDate:"2016-01-01 00:00:00"}) } } });
      if (recoveryIntentId) await db.creatorRecoveryIntent.create({ data: { id: recoveryIntentId, agencyId: s.agencyId, creatorId: s.creatorId,
        stream: "financial", reason: "OFFLINE_GAP", gapFrom: gapFrom || new Date(+now-3600000), targetAt: recoveryTargetAt, status: "RUNNING", jobId: created.id, policyVersion: 2 } });
      const claimed = await lease.claimJob({ userId:s.userId, deviceId, jobKeys:["financial_transactions_scan"], capabilities });
      assert.equal(claimed.job?.id, created.id, JSON.stringify(claimed));
      const job = await db.jobInstance.findUnique({where:{id:created.id}});
      assert.equal(job.params.financialTraversalVersion,2); assert.equal(job.params.financialWindows[0].from,null);
      assert.equal(job.params.startDate,undefined);
      return {job, checkpoint:claimed.job.continuation ?? null, credentials:{jobId:job.id,userId:s.userId,deviceId,leaseToken:claimed.job.leaseToken,leaseRevision:claimed.job.leaseRevision},calls:[]};
    }
    async function step(run, data) {
      const result = await desktop.handler.runChunk({job:run.job,creatorId:s.creatorId,continuation:run.checkpoint?.jobContinuation ?? null,signal:new AbortController().signal,
        ofApi:{request:async request=>{run.calls.push(request.endpoint.path);return {ok:true,data};}}});
      const advanced = await lease.progressJob({...run.credentials,expectedContinuation:run.checkpoint,progress:result.progress,
        continuation:result.outcome === "done" ? {driverPhase:"complete",result:result.result} : {driverPhase:"execute",jobContinuation:result.continuation},chunkResult:result.chunkResult});
      assert(!advanced.sideEffect?.staleProgress); run.checkpoint=advanced.continuation; return advanced;
    }
    async function charts(run, {gross,net,count,category="tips"}) {
      const keys = run.job.params.collectionMode === "full" ? ["total","subscribes","tips","chat_messages","post","stream"] : ["total"];
      for(const key of keys) await step(run,{[key]:{gross:["total",category].includes(key)?gross:0,total:["total",category].includes(key)?net:0,count:["total",category].includes(key)?count:0}});
    }
    async function finish(run, status="DONE") {
      assert.equal(run.checkpoint.driverPhase,"complete");
      const queued=await lease.completeJob({...run.credentials,result:run.checkpoint.result}); assert(queued.publicationId);
      let result;
      for(let i=0;i<12;i++) {
        await db.analyticsPublication.update({where:{id:queued.publicationId},data:{availableAt:new Date(0)}});
        result=await publication.runAnalyticsPublicationUnit({db,publicationId:queued.publicationId}); if(!result.publicationPending)break;
      }
      assert.equal(result.job.status,status,JSON.stringify(result));
      return db.jobInstance.findUnique({where:{id:run.job.id}});
    }
    const money=(id,at,amount=10)=>({id,amount,net:amount*.8,fee:amount*.2,status:"done",createdAt:at.toISOString(),descriptionDetails:{type:"tip"},user:{id:"42"}});
    const recent=money("recent",new Date(+now-3600000)), historic=money("before-2016",new Date("2015-02-03T04:00:00Z"),5);
    const full=await start();
    for(const bad of [{hasMore:false},{list:{},hasMore:false},{list:[],hasMore:0},{list:[]}]) {
      await assert.rejects(()=>desktop.handler.runChunk({job:full.job,creatorId:s.creatorId,continuation:full.checkpoint?.jobContinuation,signal:new AbortController().signal,ofApi:{request:async()=>({ok:true,data:bad})}}));
    }
    await step(full,{list:[recent],hasMore:true,nextMarker:"older"});
    full.checkpoint=await receipts.restoreContinuation(db,full.job);
    assert.equal(full.checkpoint.jobContinuation.page,1);
    await step(full,{list:[historic],hasMore:false});
    assert.equal(full.checkpoint.jobContinuation.historyRead,true);
    assert.equal(full.checkpoint.jobContinuation.comparisonFrom,"2015-02-03T00:00:00.000Z");
    assert(full.calls.every(url=>!url.includes("startDate"))); // transaction calls only so far
    await charts(full,{gross:15,net:12,count:2});
    const completed=await finish(full);
    assert.equal(completed.result.completionSideEffect.historyRead,true); assert.equal(completed.result.completionSideEffect.published,true);
    assert.equal(Number((await gen.activeEntry(db,s.creatorId,"before-2016")).netCents),400);
    pass("unbounded latest-first traversal: invalid list/hasMore rejected, takeover resumes, nonempty final pre-2016 page saved and chart scope derived from available history");
    const limited=await start(); await step(limited,{list:[recent],hasMore:false}); await charts(limited,{gross:10,net:8,count:1}); await finish(limited);
    assert.equal(Number((await gen.activeEntry(db,s.creatorId,"before-2016")).netCents),400);
    pass("later provider history omits an old identity without deleting its previously confirmed published money");
    const bad=await start({recoveryIntentId:"mismatch-recovery"}); await step(bad,{list:[recent],hasMore:false}); await charts(bad,{gross:20,net:16,count:2});
    const failed=await finish(bad,"FAILED"); assert.equal(failed.attempts,1); assert.equal(failed.result.completionSideEffect.historyRead,true);
    assert.equal(failed.result.completionSideEffect.verification,"MISMATCH"); assert.equal(failed.result.completionSideEffect.published,false);
    assert.equal(failed.params.collectionGeneration,bad.job.params.collectionGeneration);
    const stopped=await db.creatorRecoveryIntent.findUnique({where:{id:"mismatch-recovery"}});
    assert.equal(stopped.status,"STOPPED"); assert.equal(stopped.failedAttempts,1); assert(stopped.stoppedAt);
    assert(await db.subscriberDirectoryMaintenanceSignal.findFirst({where:{creatorId:s.creatorId,kind:"DERIVED_PLANNING"}}));
    assert.equal(Number((await gen.activeEntry(db,s.creatorId,"before-2016")).netCents),400);
    pass("completed history with mismatched count/gross/net is terminal and retained, never repaired by automatic full-generation restart");
    const gap=await start({mode:"catchup",gapFrom:new Date(+now-1800000+789),recoveryIntentId:"verified-fractional-gap",recoveryTargetAt:new Date(+now-123)});
    assert.equal(gap.job.params.financialWindows[0].comparisonFrom,new Date(+now-1800000).toISOString());
    await step(gap,{list:[money("fractional-chart-start",new Date(+now-1800000+100),4)],hasMore:true,nextMarker:"gap-boundary"});
    await step(gap,{list:[recent],hasMore:true,nextMarker:"overlap-1"});
    assert.equal(gap.checkpoint.jobContinuation.frontierPhase,"OVERLAP");
    await step(gap,{list:[money("missing-overlap-one",new Date(+now-7200000),2)],hasMore:true,nextMarker:"overlap-2"});
    assert.equal(gap.checkpoint.jobContinuation.phase,"transactions");
    gap.checkpoint=await receipts.restoreContinuation(db,gap.job);
    await step(gap,{list:[money("missing-overlap-two",new Date(+now-10800000),3)],hasMore:true,nextMarker:"unused-more"});
    assert.equal(gap.checkpoint.jobContinuation.phase,"charts"); assert.equal(gap.checkpoint.jobContinuation.overlapPages,2);
    await charts(gap,{gross:4,net:3.2,count:1}); const recovered=await finish(gap);
    assert.equal(recovered.result.completionSideEffect.sourceBoundaryReached,false);
    assert.equal(recovered.result.completionSideEffect.traversalComplete,true);
    assert.equal(recovered.result.completionSideEffect.reconciliation.proofKind,"FRONTIER_PLUS_TWO_AND_CHART");
    assert.equal(Number((await gen.activeEntry(db,s.creatorId,"missing-overlap-two")).netCents),240);
    assert.equal(Number((await gen.activeEntry(db,s.creatorId,"fractional-chart-start")).netCents),320);
    assert.equal((await db.creatorRecoveryIntent.findUnique({where:{id:"verified-fractional-gap"}})).status,"COMPLETE");
    pass("catchup crosses frozen gap then immutable known page plus TWO further pages, preserves new overlap facts, verifies only comparable gap window");
    const empty=await start(); await step(empty,{list:[],hasMore:false}); const emptyResult=await finish(empty,"FAILED");
    assert.equal(emptyResult.result.completionSideEffect.historyRead,true); assert.equal(emptyResult.result.completionSideEffect.verification,"UNAVAILABLE");
    assert.equal(Number((await gen.activeEntry(db,s.creatorId,"before-2016")).netCents),400);
    pass("empty unbounded history records source exhaustion but does not invent a chart period or replace confirmed earnings with zero");
    const stalled=await start(); await step(stalled,{list:[recent],hasMore:true,nextMarker:"next-once"});
    await assert.rejects(()=>step(stalled,{list:[historic],hasMore:true,nextMarker:stalled.job.params.financialWindows[0].initialMarker}),/FINANCIAL_RECEIPT_CURSOR_CYCLE/);
    await assert.rejects(()=>step(stalled,{list:[recent],hasMore:true,nextMarker:"changed-marker-same-page"}),/FINANCIAL_RECEIPT_PAGE_REPEATED/);
    const restored=await receipts.restoreContinuation(db,stalled.job); assert.equal(restored.jobContinuation.page,1);
    await step(stalled,{list:[historic],hasMore:false}); await charts(stalled,{gross:15,net:12,count:2}); await finish(stalled);
    pass("cursor cycles and repeated content with changed markers reject atomically without advancing saved progress");
    const message={...money("late-message-link",new Date(+now-3600000)),descriptionDetails:{type:"message"}};
    const firstSale=await start(); await step(firstSale,{list:[message],hasMore:false});
    await charts(firstSale,{gross:10,net:8,count:1,category:"chat_messages"}); await finish(firstSale);
    const sale=await db.creatorSale.findUnique({where:{creatorId_externalTransactionId:{creatorId:s.creatorId,externalTransactionId:message.id}}});
    assert.equal(sale.messageId,null);
    const {runRootCommit}=require(root+"/src/services/db-commit-kernel");
    // Persist a late exact link as an older owner could have done before the
    // reverse feed existed. The repeated payout itself does not change.
    await runRootCommit(db,async({tx})=>{
      await require(root+"/src/services/creator-fact-write-authority").lockCreatorFacts(tx,s.agencyId,s.creatorId);
      await tx.creatorSale.update({where:{id:sale.id},data:{messageId:"message-77"}});
    });
    const linkedSale=await start(); const linkedPage=await step(linkedSale,{list:[message],hasMore:false});
    assert.equal(linkedPage.sideEffect.unchanged,1); assert.equal(linkedPage.sideEffect.updated,0);
    const purchase=await db.creatorEntityCurrent.findUnique({where:{creatorId_entityType_entityId:{creatorId:s.creatorId,entityType:"MESSAGE_PURCHASE",entityId:"42:message-77"}}});
    assert.deepEqual(purchase.payload,{dialogId:"42",messageId:"message-77",opened:true,purchasedAt:message.createdAt,operationId:message.id});
    const linkedRevision=purchase.revision;
    await charts(linkedSale,{gross:10,net:8,count:1,category:"chat_messages"}); await finish(linkedSale);
    const repeatedSale=await start(); await step(repeatedSale,{list:[message],hasMore:false});
    assert.equal((await db.creatorEntityCurrent.findUnique({where:{creatorId_entityType_entityId:{creatorId:s.creatorId,entityType:"MESSAGE_PURCHASE",entityId:"42:message-77"}}})).revision,linkedRevision);
    await charts(repeatedSale,{gross:10,net:8,count:1,category:"chat_messages"}); await finish(repeatedSale);
    pass("unchanged payout re-observation publishes a late exact canonical message link, while a later identical observation emits no duplicate purchase correction");
    const finance=require(root+"/src/services/financial-transactions-service");
    const liveTip={transactionId:"live-tip-feed",transactionType:"tip",occurredAt:new Date(+now-1000),amountCents:1000,netCents:800,
      feeCents:200,currency:"USD",status:"done",fanOnlyFansUserId:"42"};
    const applyLive=money=>runRootCommit(db,({tx})=>finance.ingestExactLiveTransaction({db:tx,agencyId:s.agencyId,creatorId:s.creatorId,
      deviceId,money,observedAt:new Date(),now:new Date()}));
    await applyLive(liveTip);
    const tipRead=()=>db.creatorEntityCurrent.findUnique({where:{creatorId_entityType_entityId:{creatorId:s.creatorId,entityType:"CRM",entityId:"42"}}});
    const beforeTip=await tipRead(); assert.equal(beforeTip.sourceIdentity,"creatorTip:fan:42");
    const beforeHead=(await db.creatorEntityChangeHead.findUnique({where:{creatorId:s.creatorId}})).lastRevision;
    await applyLive(liveTip);
    assert.equal((await db.creatorEntityChangeHead.findUnique({where:{creatorId:s.creatorId}})).lastRevision,beforeHead);
    await applyLive({...liveTip,amountCents:2000,netCents:1600,feeCents:400});
    assert.notEqual((await tipRead()).payload.dataVersion,beforeTip.payload.dataVersion);
    assert.equal((await db.creatorEntityCurrent.findUnique({where:{creatorId_entityType_entityId:{creatorId:s.creatorId,entityType:"MESSAGE_PURCHASE",entityId:"42:message-77"}}})).revision,linkedRevision);
    pass("exact live tip corrections publish canonical read invalidations atomically; identical observations create no feed revision or unrelated message correction");
    console.log(JSON.stringify({ok:true,engine:runtime.native?"native PostgreSQL":"PGlite + Prisma; no native concurrency/provider verification",checks},null,2));
  } finally {desktop?.close();await runtime.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearInterval(keepAlive);clearTimeout(deadline);});
