"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{randomUUID}=require("node:crypto");
const {createContentDb}=require("../../scripts/test-support/message-library-memory-db");
const {withMessageLibraryMutation,changeMessageLibraryLifecycle,cleanupMessageLibraryScript,runMessageLibraryTrashMaintenance}=require("./message-library-lifecycle-service");
const {changeAdminContentLifecycle}=require("./admin-content-lifecycle-command-service");
function request(m,action="trash",extra={}){return {db:m.db,agencyId:"agency-a",creatorId:"creator-a",actorMember:{id:"member-a",userId:"user-a",accessEpoch:1},userId:"user-a",scriptId:"script-a",action,work:ctx=>changeMessageLibraryLifecycle({...ctx,userId:"user-a",action,...extra})};}
function admin(m,action="trash"){return {db:m.db,actor:{adminId:"admin-a",sessionId:"session-a",accessEpoch:1},commandId:randomUUID(),targetId:"collection-a",payload:{agencyId:"agency-a",creatorId:"creator-a",expectedUpdatedAt:m.state.collections[0].updatedAt.toISOString(),action,reason:"reviewed"}};}
const cleanup=m=>cleanupMessageLibraryScript({db:m.db,agencyId:"agency-a",creatorId:"creator-a",scriptId:"script-a"});
test("trash/restoration keeps all lifecycle fields coherent and preserves existing deadline on retry",async()=>{
 const m=createContentDb();await withMessageLibraryMutation(request(m));const first=structuredClone(m.state.collections[0]);await withMessageLibraryMutation(request(m));assert.equal(m.state.collections[0].purgeAfter.getTime(),first.purgeAfter.getTime());
 assert.equal(first.deletedAt.getTime(),m.clock.getTime());assert.equal(first.purgeAfter-first.deletedAt,14*86400000);
 await withMessageLibraryMutation(request(m,"restore"));assert.equal(m.state.collections[0].deletedAt,null);assert.equal(m.state.collections[0].purgeAfter,null);assert.equal(m.state.collections[0].status,"active");
});
for(const scenario of ["epoch","revoked","scope","user","creator","agency","permission"])test(`commit rejects ${scenario} changes before effects`,async()=>{
 const m=createContentDb({disabledUser:scenario==="user"});
 if(scenario==="epoch")m.state.member.accessEpoch=2;if(scenario==="revoked")m.state.member.deletedAt=m.clock;
 if(scenario==="scope")Object.assign(m.state.member,{role:"OPERATOR",roleKey:"chatter",assignedCreators:["creator-b"],permissions:{"message_library.manage":true}});if(scenario==="creator")m.state.creators[0].deletedAt=m.clock;if(scenario==="agency")m.state.agencies[0].deletedAt=m.clock;
 if(scenario==="permission")Object.assign(m.state.member,{role:"OPERATOR",roleKey:"chatter",permissions:{"message_library.manage":false}});
 await assert.rejects(withMessageLibraryMutation(request(m)));assert.equal(m.state.collections[0].status,"active");assert.equal(m.state.contentAudit.length,0);
});
test("audit failure rolls back the mutation",async()=>{const m=createContentDb({failContentAudit:true});await assert.rejects(withMessageLibraryMutation(request(m)));assert.equal(m.state.collections[0].status,"active");});
test("active script cannot be permanently deleted",async()=>{const m=createContentDb();await assert.rejects(withMessageLibraryMutation(request(m,"permanent")),{code:"MESSAGE_LIBRARY_SCRIPT_NOT_TRASHED"});assert.equal(m.state.collections.length,1);});
test("permanent intent survives restart and drains large history in bounded portions",async()=>{
 const m=createContentDb();m.state.blocks=Array.from({length:450},(_,i)=>({id:`b${i}`,collectionId:"collection-a",status:"active"}));await withMessageLibraryMutation(request(m));await withMessageLibraryMutation(request(m,"permanent"));
 await assert.rejects(withMessageLibraryMutation(request(m,"restore")),{code:"MESSAGE_LIBRARY_DELETE_COMMITTED"});
 let r=await cleanup(m);assert.equal(r.blocksDeleted,200);assert.equal(r.scriptsDeleted,0);assert.equal(m.state.blocks.length,250);
 r=await cleanup(m);assert.equal(r.blocksDeleted,200);r=await cleanup(m);assert.equal(r.blocksDeleted,50);assert.equal(r.scriptsDeleted,1);assert.equal((await cleanup(m)).scriptsDeleted,0);
});
test("restored script wins over stale expiry selection",async()=>{const m=createContentDb();Object.assign(m.state.collections[0],{status:"trash",deletedAt:new Date("2025-01-01"),purgeAfter:new Date("2025-01-15")});await withMessageLibraryMutation(request(m,"restore"));const r=await cleanup(m);assert.equal(r.scriptsDeleted,0);assert.equal(r.blocksDeleted,0);assert.equal(m.state.blocks.length,1);});
test("restored block survives expiry cleanup; expired sibling can be removed",async()=>{const m=createContentDb();Object.assign(m.state.blocks[0],{status:"trash",deletedAt:new Date("2025-01-01"),purgeAfter:new Date("2025-01-15")});await withMessageLibraryMutation(request(m,"restore",{messageId:"message-a"}));assert.equal((await cleanup(m)).blocksDeleted,0);m.state.blocks.push({id:"expired",collectionId:"collection-a",status:"trash",deletedAt:new Date("2025-01-01"),purgeAfter:new Date("2025-01-15")});assert.equal((await cleanup(m)).blocksDeleted,1);assert.equal(m.state.blocks[0].status,"active");});
test("block mutation updates parent revision; stale editor loses",async()=>{const m=createContentDb(),stamp=m.state.collections[0].updatedAt.toISOString();await withMessageLibraryMutation(request(m,"trash",{messageId:"message-a"}));await assert.rejects(withMessageLibraryMutation({...request(m),expectedUpdatedAt:stamp}),{code:"MESSAGE_LIBRARY_REVISION_CONFLICT"});});
test("cleanup audit failure rolls back both parent and children",async()=>{const m=createContentDb({failContentAudit:true});Object.assign(m.state.collections[0],{status:"deleting",deletedAt:m.clock,purgeAfter:m.clock});await assert.rejects(cleanup(m));assert.equal(m.state.collections.length,1);assert.equal(m.state.blocks.length,1);});
test("typed admin command replays, rejects stale scope and requires SUPER_ADMIN",async()=>{
 const m=createContentDb(),req=admin(m);const first=await changeAdminContentLifecycle(req);assert.equal(first.statusCode,200);assert.equal((await changeAdminContentLifecycle(req)).replayed,true);assert.equal(m.state.audit.length,1);
 const stale={...req,commandId:randomUUID()};assert.equal((await changeAdminContentLifecycle(stale)).statusCode,409);
 const foreign=admin(m);foreign.payload.creatorId="foreign";assert.equal((await changeAdminContentLifecycle(foreign)).statusCode,404);
 m.state.admins[0].role="SUPPORT";await assert.rejects(changeAdminContentLifecycle(admin(m,"restore")));
});
test("admin audit failure leaves content untouched",async()=>{const m=createContentDb({failAudit:true});await assert.rejects(changeAdminContentLifecycle(admin(m)));assert.equal(m.state.collections[0].status,"active");assert.equal(m.state.commands.length,0);});
test("scheduler drains durable expired trash without a customer GET",async()=>{const m=createContentDb();Object.assign(m.state.collections[0],{status:"trash",deletedAt:new Date("2025-01-01"),purgeAfter:new Date("2025-01-15")});const r=await runMessageLibraryTrashMaintenance({db:m.db});assert.equal(r.ok,true);assert.equal(r.scriptsDeleted,1);assert.equal(r.blocksDeleted,1);});

test("500 incoming blocks use one set-based statement and retain exact text",async()=>{
 const {upsertMessageLibraryBlocks}=require("./message-library-lifecycle-service");const calls=[];
 await upsertMessageLibraryBlocks({tx:{$executeRawUnsafe:async(sql,payload)=>calls.push({sql,rows:JSON.parse(payload)})},collectionId:"c",now:new Date("2026-01-01"),blocks:Array.from({length:500},(_,i)=>({clientId:`b${i}`,order:i,text:"  line\nnext  ",media:[],metadata:{}}))});
 assert.equal(calls.length,1);assert.equal(calls[0].rows.length,500);assert.equal(calls[0].rows[0].text,"  line\nnext  ");assert.match(calls[0].sql,/ON CONFLICT/);
});
test("bounded cleanup never deletes another creator's block",async()=>{const m=createContentDb();Object.assign(m.state.collections[0],{status:"deleting",deletedAt:m.clock,purgeAfter:m.clock});m.state.blocks.push({id:"other",collectionId:"other-script",status:"trash",purgeAfter:new Date("2025-01-01")});await cleanup(m);assert.equal(m.state.blocks.length,1);assert.equal(m.state.blocks[0].id,"other");});
