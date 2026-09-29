"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { contributionFor, bucketDeltas, runProviderCapacityProjectionBatch } = require('./provider-capacity-projection-service');
const debt = require('./provider-capacity-debt-authority-service');
const now = new Date('2026-09-29T00:00:00.000Z');
const directory = (extra={}) => ({id:'d',baselineVerifiedAt:now,campaignDirectoryDiscoveryRequestedRevision:0,campaignDirectoryDiscoveryCompletedRevision:0,campaignDirectoryCampaignCount:100,...extra});

test('B1 exact due boundary schedules the later overdue transition',()=>{
 const c=contributionFor('directory',directory({campaignDirectoryDiscoveryDueAt:now}),now);
 assert.equal(c.itemCount,1n); assert.equal(c.overdueCount,0n); assert.equal(c.nextDueAt.getTime(),now.getTime()+1);
 const later=contributionFor('directory',directory({campaignDirectoryDiscoveryDueAt:now}),new Date(now.getTime()+1));
 assert.equal(later.overdueCount,1n); assert.equal(later.nextDueAt,null);
});
test('B1 unverified directory contributes nothing; null due and explicit demand contribute',()=>{
 assert.equal(contributionFor('directory',directory({baselineVerifiedAt:null}),now),null);
 assert.equal(contributionFor('directory',directory(),now).itemCount,1n);
 assert.equal(contributionFor('directory',directory({campaignDirectoryDiscoveryDueAt:new Date('2099-01-01'),campaignDirectoryDiscoveryRequestedRevision:1}),now).itemCount,1n);
});
test('B1 new work retracts and reapplies exactly once; bigint deltas do not lose precision',()=>{
 const before={bucket:'fan',itemCount:9007199254740993n,overdueCount:0n,requiredCalls:0n};
 assert.deepEqual(bucketDeltas([before],[before]),[]);
 assert.equal(bucketDeltas([before],[])[0].itemCount,-9007199254740993n);
 const after={...before,bucket:'job:x'};assert.equal(bucketDeltas([before],[after]).length,2);
});
test('B1 partial projection cannot produce HEALTHY or normal admission with zero counted debt',()=>{
 const s=debt.deriveProviderCapacityDebtSnapshot({now,projection:{complete:false,revision:99n}});
 assert.equal(s.status,'UNKNOWN'); assert.equal(s.controlMode,'CONSERVATIVE'); assert.equal(s.futureDebtCoverageStatus,'PARTIAL'); assert.equal(s.projectionRevision,99n);
});
test('B1 fan PAUSED is not counted as pending; other PAUSED remains unknown cardinality',()=>{
 assert.equal(contributionFor('job',{id:'j',jobKey:'fan_data_point_refresh',status:'PAUSED'},now),null);
 assert.equal(contributionFor('job',{id:'j',jobKey:'fetch_earnings',status:'PAUSED'},now).itemCount,1n);
 assert.equal(contributionFor('job',{id:'j',jobKey:'fetch_campaigns',status:'SCHEDULED'},now),null);
});
test('B1 busy transaction owner returns before reading source or invoking publication',async()=>{
 const calls=[];let published=false;
 const tx={$executeRawUnsafe:async()=>1,$queryRawUnsafe:async(sql)=>{calls.push(sql);if(/pg_try_advisory_xact_lock/.test(sql))return[{acquired:false}];throw Error('unexpected read');}};
 const db={$transaction:async(work)=>work(tx)};
 const r=await runProviderCapacityProjectionBatch({db,publish:async()=>{published=true;}});
 assert.equal(r.reason,'capacity_projection_busy'); assert.equal(r.ok,true); assert.equal(r.skipped,true); assert.equal(r.persisted,false); assert.equal(published,false);assert.equal(calls.length,1);
});
test('B1 raw client cannot publish outside the commit owner',async()=>{
 await assert.rejects(debt.persistProviderCapacityDebtSnapshot({db:{},snapshot:{}}),{code:'CAPACITY_PUBLICATION_OWNER_REQUIRED'});
});
