'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const {enqueueUniqueCampaignFanRefreshes:enqueue,campaignFanRefreshIsFresh}=require('./campaign-fan-refresh-queue-service');
const {valueMetrics}=require('./campaign-read-projection-service');
const {requestExpiredCampaignValues}=require('./campaign-value-refresh-service');
const {CAMPAIGN_FAN_VALUE_FRESHNESS_MS:TTL}=require('./analytics-freshness-policy');
// Reuse the established semantic repository fixture without registering its tests.
const file=path.join(__dirname,'phase3-campaign-server-refresh-queue-int5-8a-4.test.js');
const context={module:{exports:{}},require:createRequire(file),__dirname,Date,Buffer,console,process};
vm.runInNewContext(fs.readFileSync(file,'utf8').split('\ntest("')[0]+'\nmodule.exports=queueHarness;',context);
const harness=context.module.exports,start=new Date('2026-10-03T00:00:00Z');
const input=h=>({db:h.db,planner:h.planner,job:{id:'campaign-job',agencyId:'agency-1',creatorId:'creator-1'},scanRunId:'run-1',scanStartedAt:start,now:start});
test('long traversal does not accept a newly encountered thirteen-hour-old value',async()=>{
 const h=harness(),r=await enqueue({...input(h),now:new Date(+start+8*3600000),candidates:[{onlyFansUserId:'fan',valueObservedAt:new Date(+start-5*3600000)}]});
 assert.equal(r.alreadyFresh,0);assert.equal(r.queued,1);assert.equal(h.jobsByKey.size,1);
});
test('embedded source flag cannot turn an aged canonical observation into fresh evidence',async()=>{
 const h=harness(),r=await enqueue({...input(h),candidates:[{onlyFansUserId:'fan',embeddedValueAvailable:true,valueObservedAt:new Date(+start-TTL-1)}]});
 assert.equal(r.queued,1);assert.equal(r.alreadyFresh,0);
});
test('exact live expiry requires refresh, a one-millisecond-younger known zero remains fresh',async()=>{
 const h=harness(),r=await enqueue({...input(h),candidates:[{onlyFansUserId:'expired',valueObservedAt:new Date(+start-TTL)},{onlyFansUserId:'young',valueObservedAt:new Date(+start-TTL+1)}]});
 assert.equal(r.queued,1);assert.equal(r.alreadyFresh,1);
 assert.equal(valueMetrics({fetchedAt:new Date(+start-TTL+1),availability:'AVAILABLE',totalNetCents:0},start).metrics.ofValueKnownFans,'1');
});
test('a new traversal preserves failed demand quarantine and accounts failed work without scheduling',async()=>{
 const h=harness();h.demands.set('creator-1|fan',{id:'demand',creatorId:'creator-1',agencyId:'agency-1',onlyFansUserId:'fan',status:'FAILED',requestedFreshnessCutoffAt:new Date(+start-TTL),requestedRevision:2,retryAttempts:5,quarantinedAt:start,lastError:'provider refused'});
 await enqueue({...input(h),candidates:[{onlyFansUserId:'fan'}]});
 assert.equal(h.jobsByKey.size,0);assert.equal(h.demands.get('creator-1|fan').status,'FAILED');assert.equal(h.demands.get('creator-1|fan').retryAttempts,5);
 assert.equal([...h.work.values()][0].status,'FAILED');assert.equal(h.coverage.fanValueFailed,1);assert.equal(h.coverage.fanValueOutstanding,0);assert.equal(h.coverage.fanValueFreshnessStatus,'PARTIAL');
});
test('unavailable value is fresh evidence with unknown money and a real expiration clock',()=>{
 const result=valueMetrics({fetchedAt:start,availability:'UNAVAILABLE',totalNetCents:999},start);
 assert.equal(result.fresh,true);assert.equal(result.metrics.ofValueKnownFans,'0');assert.equal(result.metrics.ofValueFreshFans,'1');assert.equal(+result.due,+start+TTL);
 const expired=valueMetrics({fetchedAt:start,availability:'UNAVAILABLE'},new Date(+start+TTL));assert.equal(expired.fresh,false);assert.equal(expired.metrics.ofValueStaleFans,'1');
});
test('future observation does not satisfy a present demand; invalid run fails before dereference',async()=>{
 assert.equal(campaignFanRefreshIsFresh(new Date(+start+300001),start,start),false);
 await assert.rejects(()=>enqueue({...input(harness()),scanStartedAt:null}),/QUEUE_SCOPE_INVALID/);
});
test('expiry batch bound rejects oversize work before any database operation',async()=>{
 await assert.rejects(()=>requestExpiredCampaignValues({tx:{$queryRawUnsafe(){throw Error('unexpected database call');}},agencyId:'a',creatorId:'c',fanIds:Array.from({length:101},(_,i)=>String(i)),now:start,freshnessMs:TTL}),/REFRESH_SCOPE_INVALID/);
});
