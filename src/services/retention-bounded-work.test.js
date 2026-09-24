"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {deleteByIdsInBatches,RETENTION_BATCH_BUDGET}=require("./retention-service");
const {withRetentionWork,runRetentionMutation}=require("./retention-work-context-service");
const {purgeExpiredTipLedger}=require("./team-tip-ledger-service");
test("generic cleanup remains finite even under a continuously full backlog",async()=>{
 let reads=0,deletes=0;const predicate={status:"DONE"};const model={findMany:async()=>{reads++;return [{id:"a"},{id:"b"}];},deleteMany:async input=>{assert.deepEqual(input.where.AND[0],predicate);deletes++;return {count:2};}};
 const result=await deleteByIdsInBatches({model,db:{},where:predicate,batchSize:2,maxBatches:999999,label:"test"});assert.equal(reads,RETENTION_BATCH_BUDGET);assert.equal(deletes,4);assert.equal(result.hasMore,true);assert.equal(result.deleted,8);
});
test("zero deletions are not reported as successful deletion of selected rows",async()=>{
 const model={findMany:async()=>[{id:"a"}],deleteMany:async()=>({count:0})};const r=await deleteByIdsInBatches({model,db:{},where:{terminal:true},batchSize:2,label:"test"});assert.equal(r.deleted,0);
});
test("expired owner and revoked actor both prevent batch work from starting",async()=>{
 let mutations=0;const db={$queryRawUnsafe:async sql=>sql.includes('clock_timestamp')?[{authorityNow:new Date()}]:[{ownerToken:"old",leaseUntil:new Date(0),completedAt:null}]};
 await assert.rejects(()=>withRetentionWork("old",()=>runRetentionMutation(async()=>{mutations++;},db)),/Retention ownership lost/);
 await assert.rejects(()=>withRetentionWork("new",()=>runRetentionMutation(async()=>{mutations++;},db),async()=>{throw Error("ADMIN_AUTH_INVALID");}),/ADMIN_AUTH_INVALID/);assert.equal(mutations,0);
});
test("parallel work contexts cannot borrow another pass's owner token",async()=>{
 const makeDb=owner=>({$queryRawUnsafe:async sql=>sql.includes("clock_timestamp")?[{authorityNow:new Date()}]:[{ownerToken:owner,leaseUntil:new Date(Date.now()+60000),completedAt:null}]});
 const result=await Promise.allSettled([withRetentionWork("one",()=>runRetentionMutation(async()=>1,makeDb("one"))),withRetentionWork("two",()=>runRetentionMutation(async()=>2,makeDb("one")))]);assert.equal(result[0].status,"fulfilled");assert.equal(result[1].status,"rejected");
});
test("tip compaction stops revisiting compacted rows and advances across pages",async()=>{
 const rows=[{id:"a",compactedAt:null},{id:"b",compactedAt:null}];const db={teamTipLedger:{findMany:async input=>{assert.equal(input.where.compactedAt,null);return rows.filter(x=>!x.compactedAt).slice(0,input.take);},updateMany:async input=>{assert.equal(input.where.compactedAt,null);let count=0;for(const row of rows)if(input.where.id.in.includes(row.id)&&!row.compactedAt){row.compactedAt=new Date();count++;}return {count};}}};
 assert.equal((await purgeExpiredTipLedger({db,limit:1})).compacted,1);assert.equal((await purgeExpiredTipLedger({db,limit:1})).compacted,1);const last=await purgeExpiredTipLedger({db,limit:1});assert.equal(last.matched,0);assert.equal(last.hasMore,false);
});

test("lease renewal samples authority time after a contended row lock",async()=>{
 const {renewRetentionSweepLease}=require("./retention-service");
 const until=new Date("2030-01-01T00:01:00Z");let now=new Date("2030-01-01T00:00:59Z");let sequence=[];
 const db={$transaction:async work=>work(db),$queryRawUnsafe:async sql=>{
   if(sql.includes("FOR UPDATE")){sequence.push("lock");now=new Date("2030-01-01T00:01:01Z");return [{key:"global_retention_v1"}];}
   sequence.push("clock");return [{authorityNow:now}];
 },retentionSweepLease:{updateMany:async({where})=>({count:until>where.leaseUntil.gt?1:0})}};
 await assert.rejects(()=>renewRetentionSweepLease({db,ownerToken:"old"}),e=>e.code==="RETENTION_COORDINATION_OWNERSHIP_LOST");assert.deepEqual(sequence,["lock","clock"]);
});
