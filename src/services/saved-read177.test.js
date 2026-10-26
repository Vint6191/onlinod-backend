"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {valueFieldState}=require("./fan-value-field-authority");
const {valueMetrics}=require("./campaign-read-projection-service");
const {fanValueDto,readiness}=require("./campaign-read-repository");
const {readPublishedDays}=require("./analytics-fact-publication-service");
const now=new Date("2026-10-26T12:00:00Z"),old=new Date("2026-10-01T12:00:00Z");
const version=old.toISOString()+"|30|USER_PROFILE|digest";
const value={availability:"AVAILABLE",valueObservedAt:old,platformReportedTotalSpendCents:1200n,
  messagesSpentCents:0n,messagesSpentCentsAuthorityVersion:version,tipsSpentCents:200n,source:"USER_PROFILE"};
test("saved fan amount and independently proven zero survive TTL; unknown components do not",()=>{
  const state=valueFieldState(value,now);
  assert.equal(state.known,true);assert.equal(state.available,false);
  assert.equal(state.fields.messagesSpentCents.known,true);assert.equal(state.fields.tipsSpentCents.known,false);
  const dto=fanValueDto(value,now);assert.equal(dto.platformReportedTotalSpendCents,1200);
  assert.equal(dto.messagesSpentCents,0);assert.equal(dto.tipsSpentCents,null);assert.equal(dto.fresh,false);
  const aggregate=valueMetrics({availability:"AVAILABLE",fetchedAt:old,totalNetCents:1200n},now);
  assert.equal(aggregate.metrics.knownPlatformReportedFanSpendCents,"1200");assert.equal(aggregate.metrics.ofValueKnownFans,"1");
  assert.equal(aggregate.metrics.ofValueStaleFans,"1");assert.equal(aggregate.due,null);
  const unrelated=valueMetrics({availability:"AVAILABLE",fetchedAt:now,totalNetCents:1200n,platformReportedTotalSpendCentsAuthorityVersion:version},now);
  assert.equal(unrelated.fresh,false,"an unrelated recent field cannot freshen an older spend observation");
});
test("missing, malformed, future and unavailable observations never become saved known values",()=>{
  for(const timestamp of [null,"bad",new Date(+now+3600000)]){
    const item={...value,valueObservedAt:timestamp};assert.equal(valueFieldState(item,now).known,false);
    assert.equal(fanValueDto(item,now).platformReportedTotalSpendCents,null);
    const metric=valueMetrics({availability:"AVAILABLE",fetchedAt:timestamp,totalNetCents:100n},now);
    assert.equal(metric.metrics.ofValueKnownFans,"0");
    if(timestamp!==null&&timestamp==="bad")assert.equal(metric.due,null);
  }
  assert.equal(valueFieldState({...value,availability:"UNAVAILABLE"},now).known,false);
});
test("incremental campaign work preserves availability but never certifies drained or a wrong generation/window",async()=>{
  const base={generation:1,activeGeneration:1,completedAt:old,empty:false,pending:true,expired:true,periodExpired:false,valueFreshnessMs:21600000};
  const read=changes=>readiness({$queryRawUnsafe:async()=>[{...base,...changes}]},"c",now);
  const updating=await read({});assert.equal(updating.available,true);assert.equal(updating.ready,false);
  for(const changes of [{generation:0},{completedAt:null},{periodExpired:true}])assert.equal((await read(changes)).available,false);
});
test("published activity survives later dirty work while first empty adoption stays unknown",async()=>{
  const read=(initialized,values)=>readPublishedDays({db:{$queryRawUnsafe:async()=>[{initialized,pending:{all:true,activity:true,financial:false},days:values?[{date:old,values}]:[]}]},creatorId:"c",from:old,to:now});
  let result=await read(true,{likes:4});assert.equal(result.scopes.activity.available,true);assert.equal(result.scopes.activity.ready,false);assert.equal(result.totals.likes,4);
  result=await read(false,{likes:4});assert.equal(result.scopes.activity.available,false);
  result=await read(true,null);assert.equal(result.scopes.activity.available,false);
});
