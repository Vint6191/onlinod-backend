"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { percentChange, revenueComparison } = require("./analytics-comparison");
const { financeComparison } = require("./creator-overview-comparison");
const { pageInput } = require("./home-read-repository");
const now = new Date("2026-10-26T12:00:00Z");
function input() {
  return { current: { ready:true,generation:"published",finance:{netCents:200,transactions:2} },
    previous: { ready:true,generation:"published",finance:{netCents:100,transactions:4} },
    coverage: {fresh:true,fromAt:new Date("2026-01-01Z"),throughAt:now},range:"7d",now };
}
test("signed NET comparison handles zero/negative bases without invented percentages", () => {
  assert.equal(percentChange(100,0),null); assert.equal(percentChange(0,0),0);
  assert.equal(percentChange(-20,-100),80); assert.equal(percentChange(-150,-100),-50);
  assert.equal(percentChange(null,100),null);
  assert.deepEqual(revenueComparison(100,0,true),{comparisonReady:true,previousRevenueCents:0,revenueDeltaCents:100,revenueDeltaPct:null});
  assert.deepEqual(revenueComparison(100,100,false),{comparisonReady:false,previousRevenueCents:null,revenueDeltaCents:null,revenueDeltaPct:null});
});
test("profile comparison uses actual prior equal UTC calendar period and transaction averages", () => {
  const result=financeComparison(input());
  assert.deepEqual(result.range,{startAt:"2026-10-13T00:00:00.000Z",endAt:"2026-10-19T23:59:59.999Z"});
  assert.equal(result.ready,true);assert.equal(result.netDeltaCents,100);assert.equal(result.netDeltaPct,100);
  assert.equal(result.averageSaleCents,25);assert.equal(result.averageSaleDeltaPct,300);
});
test("uncovered prior days, stale delivery and mixed generations cannot certify comparison", () => {
  for(const mutate of [x=>{x.coverage.fromAt=new Date("2026-10-14Z");},x=>{x.coverage.throughAt=new Date("2026-10-19Z");},
    x=>{x.coverage.fresh=false;},x=>{x.previous.generation="superseded";},x=>{x.current.ready=false;},x=>{x.previous.finance.netCents=null;}]) {
    const value=input();mutate(value);const result=financeComparison(value);assert.equal(result.ready,false);
    for(const key of ["netCents","transactions","averageSaleCents","netDeltaCents","netDeltaPct","averageSaleDeltaPct"])assert.equal(result[key],null,key);
  }
});
test("no transactions means unknown average; leap-year calendar comparison remains contiguous", () => {
  const value=input();value.current.finance.transactions=0;value.previous.finance.transactions=0;
  const result=financeComparison(value);assert.equal(result.ready,true);assert.equal(result.averageSaleCents,null);assert.equal(result.averageSaleDeltaPct,null);
  const leap=financeComparison({...input(),now:new Date("2024-03-01T10:00Z"),range:"7d"});
  assert.deepEqual(leap.range,{startAt:"2024-02-17T00:00:00.000Z",endAt:"2024-02-23T23:59:59.999Z"});
});
test("directory input validation happens before SQL and keeps metadata search literal", () => {
  for(const filter of [{search:"x".repeat(101)},{search:"bad\nquery"},{trend:"growing"},{includeRevenuePoints:"true"}])assert.throws(()=>pageInput(filter),/HOME_CREATOR_FILTER_INVALID/);
  const {literalSearch}=require("./home-creator-trend-read");
  assert.equal(literalSearch("100%_x\\"),"%100\\%\\_x\\\\%");
  assert.deepEqual(pageInput({search:"  Anna  ",trend:"increasing"}),{after:"",limit:50,search:"Anna",trend:"increasing",includeRevenuePoints:false});
});


test('selected financial range proof is independent of baseline completion and retains stale published snapshot',()=>{
 const {financialRangeCoverage}=require('./creator-overview-comparison');
 const value=input();assert.equal(financialRangeCoverage(value).ready,true);
 value.coverage.fresh=false;let result=financialRangeCoverage(value);assert.equal(result.ready,true);assert.equal(result.fresh,false);
 value.coverage.fromAt=new Date('2026-10-21Z');result=financialRangeCoverage(value);assert.equal(result.ready,false);
 value.coverage.fromAt=new Date('2026-01-01Z');value.coverage.throughAt=new Date('2026-10-25T23:59:59Z');assert.equal(financialRangeCoverage(value).ready,false);
});

test('JSON-packed trend timestamps retain UTC authority in page and subscriber metadata',async()=>{
  const {readHomeCreatorPage}=require('./home-read-repository');
  const {displayRangeBounds,previousDisplayRange}=require('./analytics-range-contract');
  const base={agencyId:'agency',member:{agencyId:'agency',id:'member',userId:'user',accessEpoch:1,broad:true},
    money:true,now,range:displayRangeBounds('7d',now),previous:previousDisplayRange('7d',now),trend:'increasing'};
  const row={id:'model',usable:true,fresh:false,cents:200,previous_usable:true,previous_fresh:true,previous_cents:100,
    captured:'2026-10-26T11:59:00',observed:'2026-10-26 11:58:00.000000',
    subscriber_count:0,subscribers_updated_at:'2026-10-26T11:57:00',subscribers_stale:false};
  for(const fallback of [false,true]) {
    let calls=0;
    const page=await readHomeCreatorPage({...base,db:{$queryRawUnsafe:async()=>{
      calls++;return fallback&&calls===1?[{fastReady:false,rows:[]}]:[{fastReady:true,rows:[row]}];
    }}});
    assert.equal(page.creators[0].capturedAt,'2026-10-26T11:59:00.000Z');
    assert.equal(page.creators[0].subscribersUpdatedAt,'2026-10-26T11:57:00.000Z');
    assert.equal(page.creators[0].staleSeconds,120);
  }
});
