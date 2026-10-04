'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const fair=require('./campaign-fair-pages-service'),authority=require('./campaign-traversal-authority-service');
const object=x=>x&&typeof x==='object'?x:{},clean=x=>x==null?null:String(x);
const source=fs.readFileSync(path.join(__dirname,'job-lease-service.js'),'utf8');
const segmentCode=source.slice(source.indexOf('function campaignDirectorySegmentContinuation('),source.indexOf('\n}',source.indexOf('function campaignDirectorySegmentContinuation('))+2);
const segmentContinuation=new Function('object','clean','return ('+segmentCode+')')(object,clean);
const now=new Date('2026-10-04T12:00:00Z');
function fixture(){
 const state={collectorVersion:'campaigns-v13',fairPagesVersion:1,scanRunId:'run',scanStartedAt:now.toISOString(),phase:'claimers',campaignMode:'full',offset:50,page:1,
  campaigns:[{id:'long',scanClaimers:true,page:19,offset:950,rejected:0},{id:'short',scanClaimers:true,page:0,offset:0,rejected:0}],
  segmentCursor:'3',segmentRequestCursor:'2',segmentHasMore:true,campaignIndex:0,claimerOffset:950,claimerPage:19,claimerRejected:0,
  directorySourceExhausted:true,campaignPagesComplete:true,truncated:false,totalCampaignCount:4000,campaignBatchCount:1,claimerBatchCount:19,campaignScannerRejected:0,claimerScannerRejected:0};
 return {job:{jobKey:'fetch_campaigns',params:{campaignFairPagesVersion:1,campaignTraversalAuthorityVersion:1,collectionGeneration:'run',collectionRequestedAt:now.toISOString(),collectionMode:'full'},continuation:{driverPhase:'execute',jobContinuation:state}},state};
}
test('a nonterminal long-history page yields to the next campaign, with server cursor validation',()=>{
 const {job,state}=fixture(),chunk={kind:'campaign_claimers_page',externalCampaignId:'long',pageNumber:20,sourceOffset:950,sourceRowCount:1,scannerRejected:0,claimers:[{}],sourceHasMore:true,campaignComplete:false};
 const next={driverPhase:'execute',jobContinuation:{...state,campaignIndex:1,claimerOffset:0,claimerPage:0,claimerBatchCount:20}};
 authority.assertProgress(job,chunk,next);
 assert.throws(()=>authority.assertProgress(job,chunk,{driverPhase:'execute',jobContinuation:{...state,claimerPage:20,claimerOffset:951,claimerBatchCount:20}}),/TRANSITION_INVALID/);
 assert.throws(()=>authority.assertProgress(job,chunk,{driverPhase:'execute',jobContinuation:{...next.jobContinuation,claimerOffset:950}}),/TRANSITION_INVALID/);
});
test('server-issued pages survive segments; empty queue requires an explicit terminal checkpoint',()=>{
 const {state}=fixture();state.phase='segment';state.campaigns=[];state.campaignIndex=0;
 const next=segmentContinuation({driverPhase:'execute',jobContinuation:state},{requestCursor:'3',cursor:'4',hasMore:true,totalCampaignCount:4000,campaigns:[{id:'long',scanClaimers:true,page:20,offset:951,rejected:2}]});
 assert.equal(next.claimerPage,20);assert.equal(next.claimerOffset,951);assert.equal(next.claimerRejected,2);assert.equal(next.totalCampaignCount,4000);
 const empty=segmentContinuation({driverPhase:'execute',jobContinuation:state},{requestCursor:'3',cursor:'4',hasMore:false,totalCampaignCount:4000,campaigns:[]});assert.equal(empty.segmentHasMore,false);assert.deepEqual(empty.campaigns,[]);
});
test('legacy later segments retain the total instead of converting absent count to zero',()=>{
 const {state}=fixture();delete state.fairPagesVersion;Object.assign(state,{phase:'segment',segmentCursor:'c0050'});
 const next=segmentContinuation({driverPhase:'execute',jobContinuation:state},{requestCursor:'c0050',cursor:'c0100',hasMore:true,totalCampaignCount:null,campaigns:[{id:'c0100',scanClaimers:true}]});assert.equal(next.totalCampaignCount,4000);
});
test('long traversal cooldown preserves the original source deadline',()=>{
 const staleDue=new Date(+now-3600000),copy=+staleDue;
 assert.equal(+fair.eligibleAt(staleDue,now),+now+3600000);assert.equal(+staleDue,copy);
 assert.equal(+fair.eligibleAt(new Date(+now+6*3600000),now),+now+6*3600000);
});
test('unknown schedules and due schedules share one bounded selection budget',async()=>{
 const seen=[];const db={creatorCampaign:{findMany:async q=>{seen.push(q);return q.where.claimersEligibleAt===null?[{id:'old',externalCampaignId:'old'}]:Array.from({length:q.take},(_,i)=>({id:'due'+i,externalCampaignId:'due'+i}));}}};
 const result=await fair.selectTargets(db,{creatorId:'c',sourceScanRunId:'g'},now,50);assert.equal(result.targets.length,50);assert.equal(result.countExact,false);assert.equal(result.dueCount,51);assert.equal(seen[1].take,50);assert(seen.every(q=>q.where.creatorId==='c'&&q.where.sourceScanRunId==='g'));
});
test('cursor CAS excludes completed/foreign generation and cannot advance twice',async()=>{
 let pending=true;const db={creatorCampaign:{updateMany:async q=>{assert.equal(q.where.claimersCursorPage,8);assert.equal(q.where.claimersCursorOffset,400);assert.equal(q.where.claimersCursorRunId,'run');if(!pending)return{count:0};pending=q.data.claimersCursorPending;return{count:1};}}};
 const job={agencyId:'a',creatorId:'c',params:{campaignFairPagesVersion:1,collectionGeneration:'run'}},page={externalCampaignId:'x',pageNumber:9,sourceOffset:400,sourceRowCount:0,sourceHasMore:false};
 await fair.commitPage(db,job,page,false);await assert.rejects(fair.commitPage(db,job,page,false),/CURSOR_STALE/);
});
test('freshness stays stale while source retry admission is deferred',()=>{
 const fresh=require('./campaign-freshness-service'),state={campaignFrontierScheduleVersion:1,campaignFrontierNextEligibleAt:new Date(+now+3600000),campaignFrontierNextDueAt:new Date(+now-3600000),campaignFrontierObservationVersion:1,activeGeneration:'g',campaignFrontierPlanRunId:'g',campaignFrontierFreshnessStatus:'COMPLETE',membershipCoverageStatus:'COMPLETE',campaignFrontierTargetCount:1,campaignFrontierCompletedCount:1,campaignFrontierDeferredCount:0};
 assert.equal(fresh.frontierDue(state,now),true);assert.equal(fresh.frontierAdmissionDue(state,now),false);assert.equal(fresh.frontierAdmissionDue(state,new Date(+now+3600001)),true);
});
