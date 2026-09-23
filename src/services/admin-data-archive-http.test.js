"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),express=require("express");
const {createMemoryDb}=require("../../scripts/test-support/admin-command-memory-db");
test("actual Data router retires wildcard purge and generic deletes; archive authenticates and replays",async t=>{
 const m=createMemoryDb();m.state.sessions[0].tokenHash=crypto.createHash("sha256").update("test-token").digest("hex");
 const at=new Date("2025-01-01T00:00:00Z");m.state.deliveries.push({id:"d",agencyId:"agency-a",creatorId:"creator-a",originKind:"AUTOMATION",moduleKey:"likes",actionType:"LIKE_POST",status:"COMPLETED",updatedAt:at,createdAt:at,finishedAt:at});
 const p=require.resolve("../prisma"),old=require.cache[p];require.cache[p]={id:p,filename:p,loaded:true,exports:m.db};t.after(()=>{if(old)require.cache[p]=old;else delete require.cache[p];});
 const app=express();app.use(express.json());app.use("/api/admin/data",require("../routes/admin-data"));
 const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${server.address().port}/api/admin/data`,commandId=crypto.randomUUID();
 const send=(url,body,method="POST",key=commandId)=>fetch(origin+url,{method,headers:{"Content-Type":"application/json",Authorization:"Bearer test-token",...(key?{"Idempotency-Key":key}:{})},body:JSON.stringify(body)});
 for(const [url,body,method]of [["/purge-deliveries",{statuses:["pending_reply","checking_reply"],olderThanDays:3},"POST"],["/bulk-delete",{model:"contentCollection",ids:["all"]},"POST"],["/record/moneyAttribution/id",{},"DELETE"]]){const r=await send(url,body,method);assert.equal(r.status,410);assert.equal((await r.json()).code,"ADMIN_DATA_MUTATION_RETIRED");}assert.equal(m.state.deliveries.length,1);
 const payload={agencyId:"agency-a",reason:"reviewed",olderThan:"2026-01-01T00:00:00Z",items:[{id:"d",expectedUpdatedAt:at.toISOString()}]},url="/creators/creator-a/archive-deliveries";
 const missing=await send(url,payload,"POST",null);assert.equal(missing.status,428);await missing.json();
 const first=await send(url,payload);assert.equal(first.status,200);const receipt=await first.json();assert.equal(receipt.archived,1);
 const replay=await send(url,payload);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),receipt);assert.equal(m.state.aggregates[0].total,1);
 m.state.sessions[0].revokedAt=at;const revoked=await send(url,payload);assert.equal(revoked.status,401);await revoked.json();
});
