'use strict';
// Event-driven policy replaces the previous TTL/audit scheduling contract.
const test=require('node:test'),assert=require('node:assert/strict');
const now=new Date('2026-10-16T12:00:00Z'),old=new Date('2026-08-01T00:00:00Z');
let notes,planned=[],active=[],financialState,campaignState,ledger=true,intents={},locks=[];
const cache=(name,exports)=>{const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports}};
cache('../prisma',{});
const notificationModule=require('./notification-sync-state-service');
cache('./notification-sync-state-service',{...notificationModule,loadNotificationSyncState:async()=>notes});
cache('./job-scheduler',{scheduleJobNow:async input=>{planned.push(input);const job={id:'job-'+planned.length,...input,status:'SCHEDULED'};active.push(job);return{created:true,job}}});
const api=require('./creator-analytics-sync-orchestrator');
function db(){return{
 async $transaction(work){const t={...this};delete t.$transaction;return work(t)},
 $queryRawUnsafe:async(sql,...args)=>{
   if(sql.includes('clock_timestamp()'))return[{authorityNow:now}];
   if(sql.includes('CreatorEarningsLedgerProof'))return ledger?[{creatorId:'c'}]:[];
   if(sql.includes('CreatorRecoveryIntent'))return intents[args[1]]?[intents[args[1]]]:[];
   return[];
 },
 $executeRawUnsafe:async(sql,...args)=>{locks.push([sql,args]);return 1},
 jobInstance:{findFirst:async({where})=>active.find(j=>j.jobKey===where.jobKey)||null,
   findMany:async({where})=>active.filter(j=>!where.jobKey||j.jobKey===where.jobKey),
   updateMany:async({where,data})=>{const j=active.find(j=>j.id===where.id);if(j)Object.assign(j,data);return{count:j?1:0}}},
 creatorNotificationSyncState:{findUnique:async()=>notes},
 creatorFinancialCollectionState:{findUnique:async()=>financialState},
 creatorCampaignCollectionState:{findUnique:async()=>campaignState},
};}
const input=d=>({db:d,creatorId:'c',agencyId:'a',now});
const debt=stream=>({id:'debt-'+stream,creatorId:'c',agencyId:'a',stream,reason:'OFFLINE_GAP',gapFrom:old,targetAt:now,policyVersion:2,status:'PENDING'});
test.beforeEach(()=>{
 planned=[];active=[];intents={};locks=[];ledger=true;
 notes={normalizerVersion:'notification-source-v2',status:'COMPLETE',fullBackfillVerifiedAt:old,fullBackfillObservedAt:old,knownNotificationIds:['known'],headNotificationId:'known'};
 financialState={status:'COMPLETE',baselineGeneration:'fin-base',baselineVerifiedAt:old,baselineObservedAt:old,receiptCoverageVersion:1};
 campaignState={status:'COMPLETE',baselineGeneration:'campaign-base',baselineVerifiedAt:old,baselineObservedAt:old,membershipCoverageStatus:'COMPLETE',fanValueFreshnessStatus:'COMPLETE'};
});
test('months-old collection timestamps alone schedule no source request',async()=>{
 const result=await api.ensureRecurringCreatorAnalyticsCatchups(input(db()));assert(result.ready);assert.equal(planned.length,0);
 for(const stream of ['notifications','financial','campaigns'])assert(result.skipped.includes(stream+':live_no_recovery_debt'));
});
test('one offline intent schedules one version-bound job per stream and repeats coalesce',async()=>{
 for(const stream of ['notifications','financial','campaigns'])intents[stream]=debt(stream);
 const d=db();await api.ensureRecurringCreatorAnalyticsCatchups(input(d));assert.equal(planned.length,3);
 for(const job of planned){assert.equal(job.params.syncPolicyVersion,2);assert.equal(job.params.collectionMode,'catchup');assert.equal(job.dedupeParams.recoveryIntentId,job.params.recoveryIntentId)}
 assert.equal(planned.find(j=>j.jobKey==='financial_transactions_scan').params.financialFrontierVersion,2);
 assert.equal(planned.find(j=>j.jobKey==='catchup_notifications_scan').params.notificationFrontierVersion,2);
 await api.ensureRecurringCreatorAnalyticsCatchups(input(d));assert.equal(planned.length,3);
});
for(const stream of ['notifications','financial','campaigns'])for(const failure of ['deferred','terminal'])test(`${stream} ${failure} debt stays quarantined`,async()=>{
 intents[stream]=debt(stream);const state={notifications:notes,financial:financialState,campaigns:campaignState}[stream];state.status='FAILED';state.retryAfterAt=failure==='deferred'?new Date(+now+60000):null;
 const result=await api.ensureRecurringCreatorAnalyticsCatchups(input(db()));assert.equal(planned.length,0);assert(result.skipped.includes(stream+':'+(failure==='deferred'?'deferred':'failed_terminal')));
 assert.deepEqual(result.blocked,failure==='terminal'?[{stream,reason:'failed_terminal',code:'COLLECTOR_REPAIR_REQUIRED'}]:[]);
});
test('initial history remains notifications, financial ledger, campaigns in order',async()=>{
 const d=db();notes=null;financialState=null;campaignState=null;ledger=false;
 let step=await api.ensureInitialCreatorAnalyticsSync(input(d));assert.equal(step.stage,'notifications');assert.equal(planned.at(-1).params.collectionMode,'full');
 active=[];notes={normalizerVersion:'notification-source-v2',fullBackfillVerifiedAt:old};step=await api.ensureInitialCreatorAnalyticsSync(input(d));assert.equal(step.stage,'financial');assert.equal(planned.at(-1).params.earningsLedgerVersion,1);
 active=[];financialState={baselineGeneration:'f',baselineVerifiedAt:old};ledger=true;step=await api.ensureInitialCreatorAnalyticsSync(input(d));assert.equal(step.stage,'campaigns');
 active=[];campaignState={baselineGeneration:'c',baselineVerifiedAt:old,membershipCoverageStatus:'COMPLETE'};step=await api.ensureInitialCreatorAnalyticsSync(input(d));assert.equal(step.ready,true);
});
test('cutover requires one verified ledger baseline, then never repeats it by age',async()=>{
 ledger=false;const d=db();let step=await api.ensureInitialCreatorAnalyticsSync(input(d));assert.equal(step.stage,'financial');assert.equal(planned.length,1);
 await api.ensureInitialCreatorAnalyticsSync(input(d));assert.equal(planned.length,1);active=[];ledger=true;step=await api.ensureInitialCreatorAnalyticsSync(input(d));assert(step.ready);assert.equal(planned.length,1);
});
test('future baseline is not proof',async()=>{
 notes.fullBackfillVerifiedAt=new Date(+now+3600000);const result=await api.ensureInitialCreatorAnalyticsSync(input(db()));assert.equal(result.stage,'notifications');assert(!result.ready);
});
test('forced notification full survives while redundant legacy full is cancelled',async()=>{
 active=[{id:'legacy',jobKey:'catchup_notifications_scan',status:'SCHEDULED',params:{}},{id:'forced',jobKey:'catchup_notifications_scan',status:'CLAIMED',params:{notificationMode:'full',forceNotificationFullRebuild:true}}];
 await api.ensureInitialCreatorAnalyticsSync(input(db()));assert.equal(active[0].status,'CANCELLED');assert.equal(active[1].status,'CLAIMED');
});
test('membership proof advances bootstrap even while profile-value work is pending',async()=>{
 Object.assign(campaignState,{fanValueFreshnessStatus:'QUEUED',fanValueOutstanding:12});assert((await api.ensureInitialCreatorAnalyticsSync(input(db()))).ready);assert.equal(planned.length,0);
});
test('a retry fence that changes under the collector lock wins over the pre-lock hint',async()=>{
 intents.financial=debt('financial');const d=db(),read=d.jobInstance.findFirst;
 d.jobInstance.findFirst=async args=>{if(args.where.jobKey==='financial_transactions_scan')financialState.retryAfterAt=new Date(+now+60000);return read(args)};
 const result=await api.ensureRecurringCreatorAnalyticsCatchups(input(d));assert.equal(planned.length,0);assert(result.skipped.includes('financial:deferred'));
});
test('unverified completion cannot advance the initial pipeline',async()=>{
 financialState=null;ledger=false;const result=await api.advanceCreatorAnalyticsInitialSyncAfterCompletion({...input(db()),job:{id:'n',creatorId:'c',agencyId:'a',jobKey:'catchup_notifications_scan',params:{analyticsSyncKind:'initial',analyticsSyncVersion:1,analyticsSyncStage:'notifications'}},sideEffect:{verified:false}});assert.equal(result.advanced,false);assert.equal(planned.length,0);
});
