'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const authority=require('./financial-receipt-authority');
const now=new Date('2026-10-04T12:00:00Z');
const params={financialReceiptVersion:1,collectionType:'FINANCIAL',collectionMode:'catchup',collectionGeneration:'generation',financialWindowGeneration:'generation',endDate:now.toISOString()};
function job(){const j={id:'job',jobKey:'financial_transactions_scan',agencyId:'a',creatorId:'c',status:'CLAIMED',leaseRevision:1,params:{...params}};j.params.financialWindows=authority.planWindows(j.params,{baselineRangeTo:new Date(+now-86400000)});j.continuation=authority.envelope(j,authority.initialCursor(j));return j;}
test('known transaction IDs are never a window frontier; gap and historical audit have explicit calendar bounds',()=>{const j=job();assert.deepEqual(j.params.financialWindows.map(w=>w.kind),['HEAD','AUDIT']);const gap=authority.planWindows(params,{coverageThrough:new Date('2020-01-01')});assert.equal(gap[1].kind,'GAP');for(const w of gap)assert(Date.parse(w.to)-Date.parse(w.from)<=30*86400000);assert.equal(authority.windowsFor(j).length,2);j.params.financialWindowGeneration='older';assert.throws(()=>authority.windowsFor(j),/WINDOWS_REQUIRED/);});
test('history freshness reflects the beginning of the audit cycle, never its last publication',()=>{const j=job(),old=new Date(+now-10*86400000);const row={windows:[j.params.financialWindows[0],{kind:'AUDIT',from:new Date(+now-40*86400000).toISOString(),to:j.params.financialWindows[0].from}]};const updated=authority.coverageUpdate(j,{baselineRangeTo:now,historyAuditCycleStartedAt:old},row,now,now);assert.equal(+updated.historyAuditObservedAt,+old);assert.equal(authority.coverageView(updated,now).historyFresh,false);assert.equal(authority.coverageView(updated,now).continuous,true);});
test('unproven legacy completion cannot acquire current proof merely from the job status',async()=>{const legacy={...job(),params:{...params,financialReceiptVersion:0}};assert.deepEqual(await authority.completionProof({},legacy),{complete:false,protocolCurrent:false});});
function fixture(j,apply){const source=fs.readFileSync(path.join(__dirname,'job-lease-service.js'),'utf8'),code=source.slice(source.indexOf('async function progressJob('),source.indexOf('async function completeJob('));let writes=0;const tx={jobInstance:{updateMany:async({data})=>{writes++;Object.assign(j,structuredClone(data));return{count:1}},update:async({data})=>{writes++;Object.assign(j,structuredClone(data));return structuredClone(j)}}};const deps={require,liveSync:require("./creator-live-sync-service"),campaignTraversal:{enabled:()=>false},leaseCommit:async(_,fn)=>fn(tx,{job:structuredClone(j),now}),enterCampaignBoundedExecution:async()=>{},hashToken:()=>'',leaseDuration:()=>60000,safeProgress:x=>x,normalizeLeaseContinuation:x=>x,clean:x=>x,applyJobChunk:apply,publishNotificationConsequences:async()=>{},campaignServerBoundaryContinuation:()=>null,campaignDirectorySegmentContinuation:()=>null,JobLeaseError:authority.FinancialReceiptError};return{run:new Function(...Object.keys(deps),'return ('+code+')')(...Object.values(deps)),get writes(){return writes}};}
test('real progress body persists server receipt cursor, ignores forged client completion, then rejects the stale duplicate',async()=>{const j=job(),before=structuredClone(j.continuation),server=authority.envelope(j,{...j.continuation.jobContinuation,page:1,marker:'next'});let applies=0;const f=fixture(j,async()=>{applies++;return{financialContinuation:server}});const input={expectedContinuation:before,continuation:{driverPhase:'complete',result:{sourceBoundaryReached:true}},chunkResult:{kind:'financial_transactions_page'}};const first=await f.run(input);assert.deepEqual(first.continuation,server);const replay=await f.run(input);assert.equal(replay.sideEffect.staleProgress,true);assert.equal(applies,1);assert.equal(f.writes,2);});
test('financial progress without a page or without expected cursor cannot advance state',async()=>{const j=job(),f=fixture(j,async()=>{throw Error('must not ingest')});await assert.rejects(()=>f.run({expectedContinuation:j.continuation,continuation:{driverPhase:'complete'}}),/RECEIPT_REQUIRED/);const stale=await f.run({chunkResult:{kind:'financial_transactions_page'}});assert(stale.sideEffect.staleProgress);assert.equal(f.writes,0);});
test('financial receipt conflicts are HTTP 409; unrelated failures are not swallowed',()=>{const source=fs.readFileSync(path.join(__dirname,'../routes/jobs.js'),'utf8'),code=source.slice(source.indexOf('function leaseError('),source.indexOf('const deviceSchema'));const respond=new Function('JobLeaseError','CampaignTraversalError','FinancialReceiptError','FanDataObservationBoundaryError','observeLeaseRejection','return ('+code+')')(class extends Error{},class extends Error{},authority.FinancialReceiptError,require('./fan-data-authority-service').FanDataObservationBoundaryError,()=>{});const res={status(n){this.code=n;return this},json(x){this.body=x;return this}};respond(res,new authority.FinancialReceiptError('FINANCIAL_RECEIPT_CURSOR_MISMATCH'));assert.equal(res.code,409);assert.throws(()=>respond(res,new Error('database failed')),/database failed/);});
test('invalid money resolution commands fail as typed admission errors without weakening the one-hour contract', async()=>{
  const p={...params,moneyResolutionVersion:1,moneyResolutionObservationId:'observation',startDate:new Date(+now-3600000).toISOString()};
  for(const patch of [{startDate:null},{startDate:'invalid'},{startDate:new Date(+now+1).toISOString()},
    {startDate:new Date(+now-3600001).toISOString()},{moneyResolutionObservationId:''},{collectionMode:'full'}]){
    const j={...job(),params:{...p,...patch}};
    delete j.params.financialWindowGeneration;
    await assert.rejects(()=>authority.claimParams({creatorFinancialCollectionState:{findUnique:async()=>null}},j),error=>{
      assert.equal(error.code,'FINANCIAL_RESOLUTION_BINDING_INVALID');assert.equal(authority.invalidClaim(error),true);return true;
    });
  }
  assert.equal(authority.invalidClaim(Object.assign(Error('database failed'),{code:'FINANCIAL_RESOLUTION_BINDING_INVALID'})),false);
  assert.equal(authority.invalidClaim(new authority.FinancialReceiptError('FINANCIAL_FRONTIER_BASELINE_REQUIRED')),false);
  assert.equal(authority.invalidClaim(new authority.FinancialReceiptError('FINANCIAL_RECEIPT_PAYLOAD_CONFLICT')),false);
});
test('fresh head cannot label stale history fresh; read evaluation preserves immutable state and retry quarantine',()=>{const state={status:'COMPLETE',receiptCoverageVersion:1,baselineVerifiedAt:now,baselineObservedAt:now,lastCatchupCompletedAt:now,lastCatchupObservedAt:now,recentRangeTo:now,coverageThrough:now,historyAuditObservedAt:new Date(+now-8*86400000)};const read=authority.evaluateCollection(state,now,3600000);assert.equal(read.fresh,false);assert.equal(read.stale,true);assert.equal(read.due,true);assert(Object.isFrozen(read));const deferred=authority.evaluateCollection({...state,retryAfterAt:new Date(+now+60000)},now,3600000);assert.equal(deferred.due,false);assert.equal(deferred.deferred,true);const failed=authority.evaluateCollection({...state,status:'FAILED'},now,3600000);assert.equal(failed.due,false);const fresh=authority.evaluateCollection({...state,historyAuditObservedAt:now},now,3600000);assert.equal(fresh.fresh,true);});

test('legacy date-filtered full receipt cannot certify all available history; retained receipt remains inspectable', async () => {
  const j = job(); j.params.collectionMode = 'full'; j.params.financialWindows = authority.planWindows(j.params, null);
  const row = { id: authority.runId(j), jobId:j.id, agencyId:j.agencyId, creatorId:j.creatorId, generation:j.params.collectionGeneration,
    windows:j.params.financialWindows, cursor:{phase:'done'}, proof:{complete:true,windows:[{exhausted:true}]} };
  const result = await authority.completionProof({financialReceiptRun:{findUnique:async()=>row}},j);
  assert.equal(result.complete,false); assert.equal(result.filteredHistory,true); assert.equal(authority.historyRead(row),false); assert.equal(result.row,row);
});
test('full traversal has no lower filter; comparison scope is derived separately from source receipts', () => {
  const p = {...params, collectionMode:'full',financialTraversalVersion:2,startDate:'2016-01-01'};
  const windows = authority.planWindows(p,null); assert.equal(windows[0].from,null);
  const j = {...job(),params:{...p,financialWindows:windows}}; assert.deepEqual(authority.windowsFor(j),windows);
  assert.equal(authority.initialCursor(j).comparisonFrom,null);
  const row={windows,proof:{windows:[{oldestAt:'2015-02-03T04:00:00.000Z',comparisonFrom:'2015-02-03T00:00:00.000Z',exhausted:true}]}};
  assert.equal(authority.historyRead(row),true); assert.equal(authority.comparisonRange(row).from,'2015-02-03T00:00:00.000Z');
});

test('financial gap comparison uses the same second-precision lower coordinate as the provider chart', () => {
  const gap='2026-10-04T11:00:00.987Z';
  const windows=authority.planWindows({...params,financialTraversalVersion:2,financialFrontierVersion:2,recoveryGapFrom:gap},null);
  assert.equal(windows[0].from,null); assert.equal(windows[0].comparisonFrom,'2026-10-04T11:00:00.000Z');
  assert.equal(windows[0].to,now.toISOString());
});
