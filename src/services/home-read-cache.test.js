"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {readHomeCached,TTL_MS}=require("./home-read-cache");
const scope=()=>({db:{},agencyId:"a",member:{id:"m",userId:"u",accessEpoch:1,broad:false},money:true,manage:true,billing:true,
 range:{startDay:new Date("2026-10-01Z"),endDay:new Date("2026-10-16Z")},previous:{startDay:new Date("2026-09-01Z"),endDay:new Date("2026-09-30Z")}});
test("Home cache shares a broad agency read but keeps restricted scopes, agencies, epochs and billing separate",async()=>{
 const ctx=scope();let calls=0;const read=async()=>++calls;
 const broad={...ctx,member:{...ctx.member,broad:true}};
 assert.equal(await readHomeCached(broad,"totals",read),1);
 assert.equal(await readHomeCached({...broad,member:{...broad.member,id:"another-owner",userId:"other",accessEpoch:8}},"totals",read),1);
 assert.equal(await readHomeCached(ctx,"totals",read),2);
 assert.equal(await readHomeCached({...ctx,member:{...ctx.member,accessEpoch:2}},"totals",read),3);
 assert.equal(await readHomeCached({...ctx,agencyId:"b"},"totals",read),4);
 assert.equal(await readHomeCached({...ctx,billing:false},"totals",read),5);
});
test("parallel Home readers share work; an error is evicted; cache expiry re-reads",async()=>{
 const ctx=scope();let calls=0;
 const read=async()=>{calls++;return 123;};
 await Promise.all(Array.from({length:100},()=>readHomeCached(ctx,"totals",read)));assert.equal(calls,1);
 await assert.rejects(readHomeCached(ctx,"fault",()=>Promise.reject(Error("failed"))),/failed/);
 assert.equal(await readHomeCached(ctx,"fault",read),123);assert.equal(calls,2);
 await new Promise(resolve=>setTimeout(resolve,TTL_MS+20));
 await readHomeCached(ctx,"totals",read);assert.equal(calls,3);
});

test("committed invalidation prevents a late old read from repopulating cache and keeps other agencies cached",async()=>{
 const {invalidateAgency}=require("./home-read-cache"),ctx=scope();let release;
 const old=readHomeCached(ctx,"totals",()=>new Promise(r=>{release=r;}));
 await Promise.resolve();
 const other={...ctx,agencyId:"b"};assert.equal(await readHomeCached(other,"totals",async()=>7),7);
 invalidateAgency(ctx.agencyId,ctx.db);assert.equal(await readHomeCached(ctx,"totals",async()=>20),20);
 release(10);assert.equal(await old,10);assert.equal(await readHomeCached(ctx,"totals",async()=>99),20);
 assert.equal(await readHomeCached(other,"totals",async()=>99),7);
});


test('creator directory cache separates global search/trend and optional chart payloads',async()=>{
 const context=scope();let calls=0;const read=async()=>++calls;
 const page={after:'',limit:20,search:'',trend:'all',includeRevenuePoints:false};
 assert.equal(await readHomeCached(context,'creators',read,page),1);
 assert.equal(await readHomeCached(context,'creators',read,{...page,search:'Anna'}),2);
 assert.equal(await readHomeCached(context,'creators',read,{...page,trend:'increasing'}),3);
 assert.equal(await readHomeCached(context,'creators',read,{...page,trend:'declining'}),4);
 assert.equal(await readHomeCached(context,'creators',read,{...page,includeRevenuePoints:true}),5);
 assert.equal(await readHomeCached(context,'creators',read,page),1);
});
