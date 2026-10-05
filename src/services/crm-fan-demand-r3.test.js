"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {boundedFanIds,exactFanId}=require('./fan-data-input');
const {readFanCurrent,scheduleDurableFanDataRefreshDebt,scheduleFanDataPointRefresh}=require('./fan-data-authority-service');
const {normalizeSubjects}=require('./fan-observation-token-service');
const {readFanCurrentMap}=require('./fan-current-consumer-service');
function hostile(){const ids=Array(501);Object.defineProperty(ids,0,{get(){throw Error('visited before admission');}});return ids;}
test('R3 raw cardinality applies before dedupe/iteration in service and token boundaries',async()=>{
 assert.throws(()=>boundedFanIds(hostile()),/REQUEST_TOO_LARGE/);
 assert.throws(()=>normalizeSubjects(hostile()),/SCOPE_TOO_LARGE/);
 await assert.rejects(scheduleFanDataPointRefresh({agencyId:'a',creatorId:'c',onlyFansUserIds:hostile()}),/POINT_REFRESH_TOO_LARGE/);
 await assert.rejects(readFanCurrent({},{agencyId:'a',creatorId:'c',onlyFansUserIds:hostile()}),/CURRENT_REQUEST_TOO_LARGE/);
 await assert.rejects(readFanCurrentMap({},{agencyId:'a',creatorId:'c',fanIds:hostile()}),/CURRENT_REQUEST_TOO_LARGE/);
});
test('R3 oversized durable debt is rejected whole, never acknowledged for the first 500',async()=>{
 let called=0;const result=await scheduleDurableFanDataRefreshDebt({agencyId:'a',creatorId:'c',fanIds:hostile(),scheduleFanRefresh:async()=>{called++;return{created:true,jobId:'j'};}});
 assert.equal(result.durable,false);assert.equal(result.requested,501);assert.equal(called,0);assert.deepEqual(result.fanIds,[]);
});
test('R3 exact opaque IDs never alias by truncation, unsafe numeric coercion or newline hashing',()=>{
 assert.equal(exactFanId('12345678901234567890'),'12345678901234567890');
 for(const bad of ['x'.repeat(181),'a\nb','a\u0000b',{},9007199254740992]){assert.equal(exactFanId(bad),null);assert.throws(()=>boundedFanIds([bad]),/ID_INVALID/);}
 assert.deepEqual(boundedFanIds([' 12 ','12','0012']),['12','0012']);
});
test('R3 complete debt reports durable reuse, preserves denial and does not conflate terminal buckets',async()=>{
 for(const [decision,durable] of [[{created:true,jobId:'j'},true],[{created:false,reason:'already_in_flight',jobId:'j'},true],[{created:false,reason:'already_in_flight'},false],[{created:false,reason:'same_bucket_failed',jobId:'j'},false]]){
  const result=await scheduleDurableFanDataRefreshDebt({agencyId:'a',creatorId:'c',fanIds:['1','2'],scheduleFanRefresh:async()=>decision});assert.equal(result.durable,durable);assert.equal(result.requested,2);
 }
});

test('R3 fan planning rejects a transaction-shaped object outside the root kernel',async()=>{
 const {createPlannedJob}=require('./job-planning-repository');
 await assert.rejects(createPlannedJob({db:{jobInstance:{}},jobKey:'fan_data_point_refresh',creatorId:'c',agencyId:'a',params:{fanIds:['1']}}),{code:'DB_COMMIT_CONTEXT_REQUIRED'});
});
