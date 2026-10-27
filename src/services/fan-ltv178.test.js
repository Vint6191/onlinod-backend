"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {contribution,prefixes,rangeDto,fanId}=require('./fan-ltv-model');
const now=new Date('2026-10-26T12:00:00Z');
const row={occurredAt:new Date('2026-10-20T12:00:00Z'),netCents:1200,status:'done',category:'messages',fanOnlyFansUserId:'42'};
test('LTV has independent all-time and UTC rolling windows with precise expiration',()=>{
 const first=contribution(row,now);assert(first.ranges.includes('7d'));assert.equal(first.nextDueAt,'2026-10-27T00:00:00.000Z');
 const next=contribution(row,new Date('2026-10-27'));assert(!next.ranges.includes('7d'));assert(next.ranges.includes('all'));assert(next.ranges.includes('30d'));
 assert.deepEqual(contribution({...row,status:'undo'},now).ranges,[]);
 assert.deepEqual(contribution({...row,netCents:0},now).ranges,[]);
 assert.equal(contribution({...row,fanOnlyFansUserId:null},now).fanId,null);
});
test('future accepted clock skew is scheduled for its actual occurrence',()=>{
 const value=contribution({...row,occurredAt:new Date(+now+1000)},now);assert.deepEqual(value.ranges,[]);assert.equal(value.nextDueAt,'2026-10-26T12:00:01.000Z');
});
test('empty denominator is undefined; rounding and attribution remain explicit',()=>{
 assert.equal(rangeDto().averageCents,null);
 const partial=rangeDto({netCents:1600,knownNetCents:1001,payingFans:2,knownPayments:3,unknownPayments:1});
 assert.equal(partial.averageCents,501);assert.equal(partial.attributionComplete,false);
 assert.throws(()=>rangeDto({knownNetCents:NaN}));assert.equal(fanId({id:42}),null);
});
test('median paths preserve order and all supported cent values without a fan sort',()=>{
 const values=[0,1,255,256,65535,65536,2147483648,Number.MAX_SAFE_INTEGER];
 for(const value of values){const paths=prefixes(value);assert.equal(paths.length,7);assert.equal(Number(BigInt('0x'+paths.at(-1))),value);}
 assert.deepEqual(values.map(value=>prefixes(value).at(-1)).sort(),values.map(value=>prefixes(value).at(-1)));
});
