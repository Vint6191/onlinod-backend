'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {lockCreatorFacts,mergeNotificationMoney,transactionIdentityConflict,retainKnownFan}=require('./creator-fact-write-authority');
const prismaId=require.resolve('../prisma');require.cache[prismaId]={exports:{}};
const {normalizeTransaction}=require('./financial-transactions-service');

test('both fact writers use the exact creator-scoped lock identity of the existing notification writer',async()=>{
 const calls=[];const db={$executeRawUnsafe:async(...args)=>calls.push(args)};
 await lockCreatorFacts(db,'agency','creator');await lockCreatorFacts(db,'agency','other');
 const digest=crypto.createHash('sha256').update('notification-facts:agency:creator').digest('hex').slice(0,16);
 let expected=BigInt('0x'+digest);if(expected>0x7fffffffffffffffn)expected-=0x10000000000000000n;
 assert.deepEqual(calls[0],['SELECT pg_advisory_xact_lock($1::bigint)',expected.toString()]);assert.notEqual(calls[0][1],calls[1][1]);
});
for(const model of ['creatorSale','creatorTip'])test(`${model}: late notification enriches ownership without rewriting payout money or losing notification consequence ownership`,()=>{
 const paidAt=new Date('2025-02-03');
 const existing={source:'ONLYFANS_API',externalTransactionId:'tx',externalNotificationId:null,fanRecordId:'fan',amountCents:2300,currency:'EUR',saleType:'MESSAGE',purchasedAt:paidAt,tippedAt:paidAt,sourceJobId:'financial-job',sourceDeviceId:'financial-device',collectedAt:paidAt,sourceUpdatedAt:null,messageId:null,postId:null};
 const incoming={source:'NOTIFICATION',externalTransactionId:null,externalNotificationId:'notification',fanRecordId:null,amountCents:1000,currency:'USD',purchasedAt:new Date('2026-01-01'),tippedAt:new Date('2026-01-01'),sourceJobId:'notification-job',messageId:'message'};
 const merged=mergeNotificationMoney(model,existing,incoming);
 for(const key of ['source','externalTransactionId','amountCents','currency','fanRecordId'])assert.deepEqual(merged[key],existing[key]);
 assert.equal(merged.sourceJobId,'notification-job');
 assert.equal(merged.messageId,'message');assert.equal(merged.externalNotificationId,'notification');
 const replay=mergeNotificationMoney(model,merged,{...incoming,messageId:null});assert.equal(replay.messageId,'message');
 assert(transactionIdentityConflict(existing,{externalTransactionId:'other-tx'}));assert(!transactionIdentityConflict(existing,{externalTransactionId:null}));
});
test('financial source distinguishes unknown money from exact zero and never coerces a missing amount to zero',()=>{
 const base={externalTransactionId:'tx',transactionType:'message',occurredAt:'2026-01-01',amountCents:100,currency:'USD'};
 const row=normalizeTransaction({...base,feeCents:null,netCents:0,taxCents:null},0,1);
 assert.equal(row.rejected,false);assert.equal(row.feeCents,null);assert.equal(row.netCents,0);assert.equal(row.taxCents,null);
 for(const amountCents of [null,undefined,false,'100','',NaN])assert.equal(normalizeTransaction({...base,amountCents},0,1).reasonCode,'amount_invalid');
 assert.equal(normalizeTransaction({...base,amountCents:-100},0,1).amountCents,-100);
 assert.equal(normalizeTransaction({...base,amountCents:undefined,amount:1.25},0,1).amountCents,125);
});
test('a user-less payout does not erase an already proven fan, while a different proven fan keeps its own metadata',()=>{
 const prior={fanRecordId:'fan-a',fanOnlyFansUserId:'a',fanUsernameAtEvent:'alice',amountCents:100};
 const input={fanRecordId:null,fanOnlyFansUserId:null,fanUsernameAtEvent:null,amountCents:200};
 assert.deepEqual(retainKnownFan(prior,input),{...prior,amountCents:200});
 const changed={...input,fanRecordId:'fan-b',fanOnlyFansUserId:'b'};assert.deepEqual(retainKnownFan(prior,changed),changed);
});
