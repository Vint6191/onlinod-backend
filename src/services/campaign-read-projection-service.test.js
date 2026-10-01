'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {windowMembership,valueMetrics,financialMetrics,deltas}=require('./campaign-read-projection-service');
const {metricsDto,safeInteger,decodeCursor,encodeCursor}=require('./campaign-read-repository');
const {CAMPAIGN_FAN_VALUE_FRESHNESS_MS:TTL}=require('./analytics-freshness-policy');
test('UTC seven-day window expires at midnight including leap day, without rolling-hour drift',()=>{
 const at=new Date('2024-02-23T23:59:59.999Z');
 assert(windowMembership(at,new Date('2024-02-29T23:59:59.999Z')).ranges.includes('7d'));
 assert(!windowMembership(at,new Date('2024-03-01T00:00:00Z')).ranges.includes('7d'));
 assert.equal(windowMembership(at,new Date('2024-02-29T12:00:00Z')).due.toISOString(),'2024-03-01T00:00:00.000Z');
});
test('future payment is scheduled for its actual event time, never counted before it exists',()=>{
 const now=new Date('2026-10-01T12:00:00Z'),at=new Date(+now+123456);
 assert.deepEqual(windowMembership(at,now),{ranges:[],due:at});
 assert(windowMembership(at,at).ranges.includes('all'));
});
test('FanData TTL, unavailable state, future clock ceiling, unknown and known zero stay distinct',()=>{
 const now=new Date('2026-10-01T12:00:00Z'),v={availability:'AVAILABLE',fetchedAt:new Date(+now-TTL+1),totalNetCents:0n};
 assert.equal(valueMetrics(v,now).metrics.ofValueKnownFans,'1');assert.equal(valueMetrics(v,new Date(+now+1)).metrics.ofValueKnownFans,'0');
 assert.equal(valueMetrics({...v,totalNetCents:null},now).metrics.ofValueUnknownFans,'1');
 assert.equal(valueMetrics({...v,availability:'UNAVAILABLE'},now).metrics.ofValueKnownFans,'0');
 assert.equal(valueMetrics({...v,fetchedAt:new Date(+now+300001)},now).metrics.ofValueKnownFans,'0');
});
test('unknown NET cannot be normalized to zero; a known zero stays zero',()=>{
 const base={amountCents:100,transactionType:'tip',transactionStatus:'done'};
 const unknown=metricsDto(financialMetrics({...base,netCents:null}));assert.equal(unknown.netCents,null);assert.equal(unknown.settledNetCents,null);assert.equal(unknown.tipsRevenueCents,null);
 const zero=metricsDto(financialMetrics({...base,netCents:0}));assert.equal(zero.netCents,0);assert.equal(zero.unknownNetTransactions,0);
 assert.equal(metricsDto(financialMetrics({...base,netCents:80}),false).netCents,null);
 assert.deepEqual(financialMetrics({...base,transactionStatus:'undo',netCents:80}),{});
});
test('receipt replay is empty; moving an amount preserves exact cents across identities',()=>{
 const a=[{campaignId:'one',fanId:'fan',rangeKey:'30d',metrics:{knownNetCents:'9007199254740999',transactionsCount:'1'}}];
 assert.deepEqual(deltas(a,a),[]);
 const diff=deltas(a,[{...a[0],campaignId:'two'}]);assert.equal(diff.length,2);assert.equal(diff.reduce((s,r)=>s+BigInt(r.metrics.knownNetCents),0n),0n);
 assert.throws(()=>safeInteger('9007199254740999'),/SAFE_RANGE/);assert.equal(safeInteger('0'),0);
});
test('cursor is bound to creator, range, campaign and filter',()=>{
 const scope=[1,'fans','creator-a','campaign-a','7d','PAYING'],cursor=encodeCursor(scope,'fan-50');
 assert.equal(decodeCursor(cursor,scope),'fan-50');
 for(const index of [2,3,4,5]){const changed=[...scope];changed[index]='other';assert.throws(()=>decodeCursor(cursor,changed),/SCOPE/);}
 assert.throws(()=>decodeCursor('x'.repeat(5000),scope),/INVALID/);
});
