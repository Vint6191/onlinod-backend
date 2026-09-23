"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),express=require("express"),fs=require("node:fs"),vm=require("node:vm");
const {createOperationalDb}=require("../../scripts/test-support/admin-operational-memory-db");
const {redactAdminRead}=require("../middleware/admin-read-boundary");
test("admin read boundary removes nested credential material without corrupting lifecycle dates or counts",()=>{
 const date=new Date("2026-01-01");const value={members:[{user:{id:"u",email:"e",passwordHash:"bad"}}],sessions:[{id:"s",tokenHash:"bad",createdAt:date}],before:{privateKey:"bad",ciphertext:"bad"},count:42n};
 const dto=redactAdminRead(value);assert.doesNotMatch(JSON.stringify(dto),/bad|passwordHash|tokenHash|privateKey|ciphertext/);assert.equal(dto.sessions[0].createdAt,date);assert.equal(dto.count,"42");assert.equal(value.members[0].user.passwordHash,"bad");
});
test("async admin router forwards rejected reads to the error handler",async t=>{
 const app=express();const router=require("../routes/admin-router").createAdminRouter();router.get("/failure",async()=>{throw Error("controlled");});app.use(router);app.use((err,req,res,next)=>res.status(503).json({ok:false,error:err.message}));
 const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const r=await fetch(`http://127.0.0.1:${server.address().port}/failure`);assert.equal(r.status,503);assert.equal((await r.json()).error,"controlled");
});
test("mounted admin routes enforce stable identity, body-only destructive intent and fresh actor replay",async t=>{
 const m=createOperationalDb();m.state.sessions[0].tokenHash=crypto.createHash("sha256").update("test-token").digest("hex");
 const prismaPath=require.resolve("../prisma"),prior=require.cache[prismaPath];require.cache[prismaPath]={id:prismaPath,filename:prismaPath,loaded:true,exports:m.db};t.after(()=>{if(prior)require.cache[prismaPath]=prior;else delete require.cache[prismaPath];});
 const app=express();app.use(express.json());app.use("/api/admin",require("../routes/admin"));app.use((err,req,res,next)=>res.status(500).json({ok:false,error:err.message}));
 const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));const origin=`http://127.0.0.1:${server.address().port}`;
 const send=(method,path,body,id)=>fetch(origin+"/api/admin"+path,{method,headers:{"Content-Type":"application/json",Authorization:"Bearer test-token",...(id?{"Idempotency-Key":id}:{})},body:JSON.stringify(body)});
 let response=await send("POST","/users/user-a/force-logout",{reason:"test"});assert.equal(response.status,428);await response.json();assert.equal(m.state.deviceCommands.length,0);
 const id=crypto.randomUUID();response=await send("POST","/users/user-a/force-logout",{reason:"test"},id);assert.equal(response.status,200);const receipt=await response.json();response=await send("POST","/users/user-a/force-logout",{reason:"test"},id);assert.equal(response.headers.get("Idempotency-Replayed"),"true");assert.deepEqual(await response.json(),receipt);
 response=await send("DELETE","/members/member-a?reason=old-query",{},crypto.randomUUID());assert.equal(response.status,400);await response.json();assert.equal(m.state.members[0].deletedAt,null);
 response=await send("PATCH","/members/member-a/role",{agencyId:"agency-a",expectedAccessEpoch:1,role:"MANAGER",reason:"role correction"},crypto.randomUUID());assert.equal(response.status,200);await response.json();assert.equal(m.state.members[0].roleKey,"manager");
 m.state.sessions[0].revokedAt=m.clock;response=await send("POST","/users/user-a/force-logout",{reason:"test"},id);assert.equal(response.status,401);await response.json();
});
test("agency UI forwards shown revisions, typed hard flag and explicit reasons without fetching a newer snapshot",async()=>{
 const calls=[],answers=["restore reason","role reason","remove reason","creator reason"];
 const agency={id:"agency-a",updatedAt:"2026-01-01T00:00:00.000Z",members:[{id:"member-a",accessEpoch:7}],creators:[{id:"creator-a",updatedAt:"2026-02-01T00:00:00.000Z"}]};
 const api=new Proxy({}, {get:(_,name)=>async(id,body)=>{calls.push({name,id,body});return {ok:true};}});
 const window={OnlinodAdminApi:api,OnlinodAdminRouter:{toast:()=>{}},OnlinodAdminState:{sectionParam:"agency-a"},OnlinodAdminStateApi:{ensureAgencyDetail:()=>({data:{agency}})},OnlinodAdminAgencyDetail:{load:async()=>{}}};
 vm.runInNewContext(fs.readFileSync(require.resolve("../../public/admin/modules/admin-agency-detail/admin-agency-detail-actions.js"),"utf8"),{window,prompt:()=>answers.shift(),confirm:()=>true,setTimeout:()=>{}});
 const ui=window.OnlinodAdminAgencyDetailActions;await ui.doRestore("agency-a");await ui.changeMemberRole("member-a","MANAGER");await ui.kickMember("member-a");await ui.deleteCreator("creator-a");
 assert.equal(calls[0].body.expectedUpdatedAt,agency.updatedAt);assert.equal(calls[1].body.expectedAccessEpoch,7);assert.equal(calls[2].body.agencyId,"agency-a");assert.equal(calls[3].body.hard,false);assert.equal(calls[3].body.expectedUpdatedAt,agency.creators[0].updatedAt);assert.ok(calls.every(c=>c.body.reason));
 const count=calls.length;await ui.doRestore("agency-a");assert.equal(calls.length,count);
});
