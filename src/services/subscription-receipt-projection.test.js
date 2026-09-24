"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { projectCanonicalSubscriptionReceipt: projectImpl } = require("./subscription-receipt-projection-service");
const fetch = globalThis.fetch;
const { runDbTransaction } = require("./db-transaction-service");
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");
const project = args => runDbTransaction(commitDatabaseFixture(args.db), tx => projectImpl({ ...args, db: tx }));
const job = {agencyId:"agency",creatorId:"creator"};
const fact = {fanId:"123",eventType:"paid_subscribed",amountCents:100,eventHash:"receipt",occurredAt:new Date("2026-09-24")};
function fixture(existing = null) {
  let row = existing, effects = 0;
  const db = {creatorSubscriptionLedger:{
    createMany: async ({data,skipDuplicates}) => {assert.equal(skipDuplicates,true);if(row)return {count:0};row=data[0];return {count:1};},
    findUnique: async () => row,
  },trafficSourceMember:{findFirst:async()=>({sourceId:"source"}),updateMany:async()=>{effects++;return {count:1};}}};
  return {db,row:()=>row,effects:()=>effects};
}
for(const field of ["creatorId","fanId"]) test(`receipt collision in ${field} cannot dirty another scope`,async()=>{
  const fx=fixture({...job,...fact,[field]:"foreign",id:"old",sourceId:"source"});
  await assert.rejects(project({db:fx.db,job,fact}),{code:"NOTIFICATION_FACT_SCOPE_MISMATCH"});
  assert.equal(fx.effects(),0); assert.equal(fx.row().id,"old");
});
for(const eventType of ["paid_subscribed","subscription_renewed","subscription_resubscribed"]) test(`${eventType} projects through the same canonical receipt path`,async()=>{
  const fx=fixture(),result=await project({db:fx.db,job,fact:{...fact,eventType}});
  assert.equal(result.ignored,false);assert.equal(fx.row().source,"canonical_subscription_fact");assert.equal(fx.row().eventType,eventType);
});
test("member mutation failure propagates to the owning transaction",async()=>{
  const fx=fixture();fx.db.trafficSourceMember.updateMany=async()=>{throw new Error("required effect failed");};
  await assert.rejects(project({db:fx.db,job,fact}),/required effect failed/);
});
test("missing fingerprint cannot silently create a receipt with a synthetic identity",async()=>{
  const fx=fixture();await assert.rejects(project({db:fx.db,job,fact:{...fact,eventHash:null}}),{code:"NOTIFICATION_FACT_IDENTITY_REQUIRED"});
  assert.equal(fx.row(),null);
});
test("retired raw subscription HTTP ingress returns 410 for both old valid and malformed payloads",async()=>{
  const express=require("express"),app=express();app.use(express.json());app.use("/api/traffic",require("../routes/traffic"));
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  try {
    for(const body of [{},{deviceId:"old",creatorId:"creator",event:{fanId:"123",amountCents:100,eventType:"paid_subscribed"}}]) {
      const response=await fetch(`http://127.0.0.1:${server.address().port}/api/traffic/subscriptions/ingest`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      assert.equal(response.status,410);assert.equal((await response.json()).code,"TRAFFIC_SUBSCRIPTION_INGEST_RETIRED");
    }
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test("receipt projection rejects an unissued transaction client", async () => {
  const fx = fixture();
  await assert.rejects(projectImpl({ db: fx.db, job, fact }), { code: "DB_COMMIT_CONTEXT_REQUIRED" });
  assert.equal(fx.row(), null);
});
