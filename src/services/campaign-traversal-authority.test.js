"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const authority = require("./campaign-traversal-authority-service");
const now = new Date("2026-10-03T12:00:00Z");
const wrap = jobContinuation => ({ driverPhase: "execute", jobContinuation });
function fixture() {
  const job = { id: "job", agencyId: "a", creatorId: "c", jobKey: "fetch_campaigns", leaseRevision: 1, status: "CLAIMED",
    params: { campaignTraversalAuthorityVersion: 1, collectionGeneration: "g", collectionMode: "catchup",
      collectionRequestedAt: now.toISOString(), analyticsObservationStartedAt: new Date(+now-7*3600000).toISOString() } };
  job.continuation = wrap({ collectorVersion: "campaigns-v13", scanRunId: "g", scanStartedAt: now.toISOString(), phase: "claimers",
    campaignMode: "catchup", offset: 0, page: 0, campaigns: [{ id: "first", scanClaimers: true }, { id: "second", scanClaimers: true }],
    segmentCursor: "second", segmentRequestCursor: null, segmentHasMore: false, campaignIndex: 0, claimerOffset: 0, claimerPage: 0,
    claimerRejected: 0,
    directorySourceExhausted: true, campaignPagesComplete: true, truncated: false, totalCampaignCount: 4000, segmentTargetCount: 2,
    campaignBatchCount: 0, claimerBatchCount: 0, campaignScannerRejected: 0, claimerScannerRejected: 0 });
  const page = { kind: "campaign_claimers_page", externalCampaignId: "first", pageNumber: 1, sourceOffset: 0,
    sourceRowCount: 0, claimers: [], scannerRejected: 0, sourceHasMore: false, campaignComplete: true };
  const next = wrap({ ...structuredClone(job.continuation.jobContinuation), campaignIndex: 1, claimerBatchCount: 1 });
  return { job, page, next };
}
test("empty terminal page advances exactly one selected campaign", () => {
  const f=fixture();authority.assertProgress(f.job,f.page,f.next);
  assert.equal(authority.expectedMatches(f.job,structuredClone(f.job.continuation)),true);
});
for (const [label,change] of [
  ["skipped campaign",f=>f.next.jobContinuation.campaignIndex=2],
  ["offset jump",f=>f.next.jobContinuation.claimerOffset=50],
  ["lost receipt counter",f=>f.next.jobContinuation.claimerBatchCount=0],
  ["replacement segment",f=>f.next.jobContinuation.campaigns[0].id="other"],
  ["different provider page",f=>f.page.pageNumber=2],
  ["different provider offset",f=>f.page.sourceOffset=50],
  ["false row count",f=>f.page.sourceRowCount=1],
  ["false completion",f=>f.page.campaignComplete=false],
]) test("rejects "+label,()=>{const f=fixture();change(f);assert.throws(()=>authority.assertProgress(f.job,f.page,f.next),/CAMPAIGN_/);});
test("continuing a nonempty page requires exact raw offset and page number",()=>{
  const f=fixture();Object.assign(f.page,{claimers:[{userId:"1"}],sourceRowCount:2,scannerRejected:1,sourceHasMore:true,campaignComplete:false});
  Object.assign(f.next.jobContinuation,{campaignIndex:0,claimerPage:1,claimerOffset:2,claimerScannerRejected:1,claimerRejected:1});
  authority.assertProgress(f.job,f.page,f.next);
});
test("provider-free heartbeat cannot advance a claimer cursor",()=>{
  const f=fixture();assert.throws(()=>authority.assertProgress(f.job,undefined,f.next),/TRANSITION_INVALID/);
  authority.assertProgress(f.job,undefined,{...f.job.continuation,jobContinuation:{...f.job.continuation.jobContinuation,quantumRequests:20}});
});
test("a clean final page cannot erase an earlier rejected row in this campaign",()=>{
  const f=fixture();Object.assign(f.job.continuation.jobContinuation,{claimerPage:1,claimerOffset:2,claimerScannerRejected:1,claimerRejected:1,claimerBatchCount:1});
  Object.assign(f.page,{pageNumber:2,sourceOffset:2,campaignComplete:false});
  f.next=wrap({...f.job.continuation.jobContinuation,campaignIndex:1,claimerPage:0,claimerOffset:0,claimerRejected:0,claimerBatchCount:2});
  authority.assertProgress(f.job,f.page,f.next);assert.equal(authority.canCompletePage(f.job,f.page),false);
  f.page.campaignComplete=true;assert.throws(()=>authority.assertProgress(f.job,f.page,f.next),/TERMINAL_PROOF_INVALID/);
});
test("missing expected continuation fails closed; initial empty envelope is canonical",()=>{
  const f=fixture();assert.throws(()=>authority.expectedMatches(f.job,undefined),/EXPECTED_CONTINUATION_REQUIRED/);
  f.job.continuation=null;assert.equal(authority.expectedMatches(f.job,wrap(null)),true);
});
test("the jobs route reports traversal conflicts as 409 without masking unrelated errors",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../routes/jobs.js"),"utf8");
  const body=source.slice(source.indexOf("function leaseError("),source.indexOf("const deviceSchema"));
  const respond=new Function("JobLeaseError","CampaignTraversalError","FinancialReceiptError","return ("+body+")")(
    class JobLeaseError extends Error {},authority.CampaignTraversalError,require("./financial-receipt-authority").FinancialReceiptError);
  const response={statusCode:null,body:null,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  let conflict;try{authority.expectedMatches(fixture().job,undefined);}catch(error){conflict=error;}
  respond(response,conflict);
  assert.equal(response.statusCode,409);assert.equal(response.body.code,"CAMPAIGN_EXPECTED_CONTINUATION_REQUIRED");
  const other=new Error("database disconnected");assert.throws(()=>respond(response,other),error=>error===other);
});
test("publication requires the exact durably committed completion payload",()=>{
  const f=fixture();assert.throws(()=>authority.assertCompletion(f.job,{}),/DURABLE_COMPLETION_REQUIRED/);
  f.job.continuation={driverPhase:"complete",result:{scanRunId:"g",campaignCount:4000},progress:null};
  authority.assertCompletion(f.job,{scanRunId:"g",campaignCount:4000});
  assert.throws(()=>authority.assertCompletion(f.job,{scanRunId:"g",campaignCount:1}),/DURABLE_COMPLETION_REQUIRED/);
});
test("per-campaign observation excludes queue delay and survives retry/reclaim",async()=>{
  const f=fixture(),row={id:"campaign",agencyId:"a",claimerRevision:3};let writes=0;
  const db={creatorCampaign:{findUnique:async()=>({...row}),update:async({data})=>{writes++;Object.assign(row,data);}}};
  await authority.beginRead({db,job:f.job,campaignPage:authority.currentPage(f.job),acquiredAt:now});
  row.claimersTraversalRejectedRows=3;
  f.job.leaseRevision=2;await authority.beginRead({db,job:f.job,campaignPage:authority.currentPage(f.job),acquiredAt:new Date(+now+3600000)});
  assert.equal(writes,1);assert.equal(+authority.observation(f.job,row).observedAt,+now);
  assert.equal(row.claimersTraversalRejectedRows,3);
  row.claimerRevision=4;assert.equal(authority.observation(f.job,row).revision,3);
});
test("legacy mid-campaign adoption retains the older source bound",async()=>{
  const f=fixture(),row={id:"campaign",agencyId:"a",claimerRevision:1};f.job.continuation.jobContinuation.claimerPage=2;
  f.job.continuation.jobContinuation.claimerOffset=100;
  const db={creatorCampaign:{findUnique:async()=>row,update:async({data})=>Object.assign(row,data)}};
  await authority.beginRead({db,job:f.job,campaignPage:authority.currentPage(f.job),acquiredAt:now});
  assert.equal(+row.claimersTraversalStartedAt,Date.parse(f.job.params.analyticsObservationStartedAt));
});
test("a different creator/agency and an unstarted traversal cannot publish a new source age",async()=>{
  const f=fixture();assert.throws(()=>authority.observation(f.job,{}),/READ_OBSERVATION_MISSING/);
  await assert.rejects(authority.beginRead({db:{creatorCampaign:{findUnique:async()=>({agencyId:"other"})}},job:f.job,
    campaignPage:authority.currentPage(f.job),acquiredAt:now}),/READ_SCOPE_INVALID/);
});

// Execute the actual progress transaction body with explicit access/repository
// doubles. PostgreSQL lock ordering and rollback have a separate native suite.
function progressFixture(job, apply) {
  const text=fs.readFileSync(path.join(__dirname,"job-lease-service.js"),"utf8");
  const code=text.slice(text.indexOf("async function progressJob("),text.indexOf("async function completeJob("));
  let writes=0;
  const tx={jobInstance:{updateMany:async({data})=>{writes++;Object.assign(job,structuredClone(data));return{count:1};},
    update:async({data})=>{writes++;Object.assign(job,structuredClone(data));return structuredClone(job);}}};
  const deps={require,campaignTraversal:authority,leaseCommit:async(_,work)=>work(tx,{job:structuredClone(job),now}),
    enterCampaignBoundedExecution:async()=>{},hashToken:()=>"hash",leaseDuration:()=>60000,safeProgress:x=>x,
    normalizeLeaseContinuation:x=>x,clean:x=>x,applyJobChunk:apply,publishNotificationConsequences:async()=>{},
    campaignServerBoundaryContinuation:()=>null,campaignDirectorySegmentContinuation:()=>null,JobLeaseError:Error};
  return {run:new Function(...Object.keys(deps),"return ("+code+")")(...Object.values(deps)),get writes(){return writes;}};
}
test("late duplicate progress preserves newer durable cursor without re-ingesting",async()=>{
  const f=fixture(),expected=structuredClone(f.job.continuation);f.job.continuation=f.next;let applied=0;
  const p=progressFixture(f.job,async()=>{applied++;return{};});
  const r=await p.run({expectedContinuation:expected,continuation:expected,chunkResult:f.page});
  assert.equal(r.sideEffect.staleProgress,true);assert.equal(r.continuation.jobContinuation.campaignIndex,1);
  assert.equal(p.writes,0);assert.equal(applied,0);
});
test("two equivalent checkpoint submissions apply the page once",async()=>{
  const f=fixture(),before=structuredClone(f.job.continuation);let applied=0;
  const p=progressFixture(f.job,async()=>{applied++;return{};});
  const request={expectedContinuation:before,continuation:f.next,chunkResult:f.page};
  await p.run(request);await p.run(request);assert.equal(applied,1);assert.equal(f.job.continuation.jobContinuation.claimerBatchCount,1);
});
test("legacy receipt replay cannot rewind an advanced cursor",async()=>{
  const f=fixture();delete f.job.params.campaignTraversalAuthorityVersion;f.job.continuation=f.next;
  const p=progressFixture(f.job,async()=>({replay:true}));
  const r=await p.run({continuation:wrap({...f.next.jobContinuation,campaignIndex:0}),chunkResult:f.page});
  assert.equal(r.continuation.jobContinuation.campaignIndex,1);
});
