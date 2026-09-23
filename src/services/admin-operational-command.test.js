"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),bcrypt=require("bcryptjs");
const {createOperationalDb}=require("../../scripts/test-support/admin-operational-memory-db");
const {executeAdminOperation}=require("./admin-operational-command-service");
const actor={adminId:"admin-a",sessionId:"session-a",accessEpoch:1};
const revision="2026-01-01T00:00:00.000Z";
const call=(m,action,targetId,payload,commandId=crypto.randomUUID())=>executeAdminOperation({db:m.db,actor,commandId,action,targetId,payload:{reason:"Operator correction",...payload}});
test("user logout commits authority, outbox, audit and receipt once across agencies",async()=>{
 const m=createOperationalDb(),id=crypto.randomUUID();const first=await call(m,"user.logout","user-a",{},id);
 assert.equal(first.statusCode,200);assert.equal(first.body.revokedSessions,2);assert.equal(m.state.deviceCommands.length,2);assert.ok(m.state.users[0].sessionsRevokedAt);
 assert.deepEqual((await call(m,"user.logout","user-a",{},id)).body,first.body);assert.equal(m.state.deviceCommands.length,2);assert.equal(m.state.audit.length,1);assert.doesNotMatch(JSON.stringify(first),/do-not-return|passwordHash/);
});
for(const failure of["failAudit","failOutbox"])test(`${failure} rolls user revoke, outbox and command back together`,async()=>{
 const m=createOperationalDb({[failure]:true});await assert.rejects(()=>call(m,"user.logout","user-a",{}));assert.equal(m.state.users[0].sessionsRevokedAt,null);assert.ok(m.state.refresh.every(r=>!r.revokedAt));assert.equal(m.state.deviceCommands.length,0);assert.equal(m.state.commands.length,0);
});
test("device kick affects selected device only and replays without a second outbox row",async()=>{
 const m=createOperationalDb(),id=crypto.randomUUID(),payload={agencyId:"agency-a",userId:"user-a"};await call(m,"device.kick","device-a",payload,id);await call(m,"device.kick","device-a",payload,id);
 assert.ok(m.state.refresh[0].revokedAt);assert.equal(m.state.refresh[1].revokedAt,null);assert.equal(m.state.deviceCommands.length,1);
});
test("device identity cannot be moved across agency by submitted scope",async()=>{
 const m=createOperationalDb();const r=await call(m,"device.kick","device-a",{agencyId:"agency-b",userId:"user-a"});assert.equal(r.statusCode,409);assert.equal(m.state.deviceCommands.length,0);assert.ok(m.state.refresh.every(r=>!r.revokedAt));
});
test("password reset has replayable receipt without plaintext or hash and revokes every session",async()=>{
 const m=createOperationalDb(),id=crypto.randomUUID(),password="replacement-password-42",payload={password,expectedUpdatedAt:revision};
 const result=await call(m,"user.password.reset","user-a",payload,id);assert.equal(result.statusCode,200);assert.equal(await bcrypt.compare(password,m.state.users[0].passwordHash),true);assert.ok(m.state.refresh.every(r=>r.revokedAt));assert.equal(m.state.deviceCommands.length,2);
 assert.deepEqual((await call(m,"user.password.reset","user-a",payload,id)).body,result.body);assert.doesNotMatch(JSON.stringify({result,audit:m.state.audit,commands:m.state.commands}),/replacement-password|passwordHash|\$2[aby]\$/);
});
test("user edit requires the shown revision and keeps credential DTO private",async()=>{
 const m=createOperationalDb();const updated=await call(m,"user.update","user-a",{name:"Changed",expectedUpdatedAt:revision});assert.equal(updated.statusCode,200);assert.doesNotMatch(JSON.stringify(updated),/passwordHash|do-not-return/);
 const stale=await call(m,"user.update","user-a",{name:"Stale",expectedUpdatedAt:revision});assert.equal(stale.statusCode,409);assert.equal(m.state.users[0].name,"Changed");
});
test("sole operational OWNER cannot be disabled; rejection is audited and replayable",async()=>{
 const m=createOperationalDb();Object.assign(m.state.members[0],{role:"OWNER",roleKey:"owner"});const id=crypto.randomUUID(),payload={disabled:true,expectedUpdatedAt:revision};const r=await call(m,"user.update","user-a",payload,id);assert.equal(r.body.code,"LAST_OWNER");assert.equal(m.state.users[0].disabledAt,null);assert.equal(m.state.deviceCommands.length,0);assert.deepEqual((await call(m,"user.update","user-a",payload,id)).body,r.body);
});
test("disable and enable increment live membership epochs without resurrecting sessions",async()=>{
 const m=createOperationalDb();let r=await call(m,"user.update","user-a",{disabled:true,expectedUpdatedAt:revision});assert.equal(r.statusCode,200);assert.equal(m.state.members[0].accessEpoch,2);
 r=await call(m,"user.update","user-a",{disabled:false,expectedUpdatedAt:m.clock.toISOString()});assert.equal(r.statusCode,200);assert.equal(m.state.members[0].accessEpoch,3);assert.ok(m.state.refresh.every(x=>x.revokedAt));
});
test("member role uses the actual Team owner inside the command transaction and rejects stale epoch",async()=>{
 const m=createOperationalDb(),payload={agencyId:"agency-a",expectedAccessEpoch:1,role:"MANAGER"};const r=await call(m,"member.role.set","member-a",payload);assert.equal(r.statusCode,200);assert.equal(m.state.members[0].roleKey,"manager");assert.equal(m.state.members[0].accessEpoch,2);assert.equal(m.state.deviceCommands.length,1);
 const stale=await call(m,"member.role.set","member-a",payload);assert.equal(stale.body.code,"MEMBER_REVISION_CONFLICT");assert.equal(m.state.deviceCommands.length,1);
});
test("member audit failure rolls canonical Team mutation back with command and outbox",async()=>{
 const m=createOperationalDb({failAudit:true});await assert.rejects(()=>call(m,"member.permissions.set","member-a",{agencyId:"agency-a",expectedAccessEpoch:1,permissions:{"message_library.manage":true}}));assert.equal(m.state.members[0].accessEpoch,1);assert.deepEqual(m.state.members[0].permissions,{});assert.equal(m.state.deviceCommands.length,0);
});
test("member removal preserves history and last OWNER remains protected",async()=>{
 const m=createOperationalDb();const r=await call(m,"member.remove","member-a",{agencyId:"agency-a",expectedAccessEpoch:1});assert.equal(r.statusCode,200);assert.equal(m.state.members.length,1);assert.ok(m.state.members[0].deletedAt);
 const owner=createOperationalDb();Object.assign(owner.state.members[0],{role:"OWNER",roleKey:"owner"});const denied=await call(owner,"member.remove","member-a",{agencyId:"agency-a",expectedAccessEpoch:1});assert.equal(denied.body.code,"LAST_OWNER");assert.equal(owner.state.members[0].deletedAt,null);
});
test("agency rename uses CAS and never includes member or creator materialization",async()=>{
 const m=createOperationalDb();m.state.agencies[0].updatedAt=new Date(revision);const r=await call(m,"agency.update","agency-a",{name:"Renamed",expectedUpdatedAt:revision});assert.equal(r.statusCode,200);assert.equal(m.state.agencies[0].name,"Renamed");assert.equal(r.body.agency.members,undefined);
});
for(const revoke of["session","admin","epoch","role"])test(`fresh admin authority rejects ${revoke} changes before mutation`,async()=>{
 const m=createOperationalDb();if(revoke==="session")m.state.sessions[0].revokedAt=m.clock;if(revoke==="admin")m.state.admins[0].active=false;if(revoke==="epoch")m.state.admins[0].accessEpoch=2;if(revoke==="role")m.state.admins[0].role="SUPPORT";
 await assert.rejects(()=>call(m,"user.logout","user-a",{}));assert.equal(m.state.deviceCommands.length,0);assert.equal(m.state.users[0].sessionsRevokedAt,null);
});
test("release DRAINING refuses member mutation and no effects escape",async()=>{
 const m=createOperationalDb({draining:true});await assert.rejects(()=>call(m,"member.role.set","member-a",{agencyId:"agency-a",expectedAccessEpoch:1,role:"MANAGER"}));assert.equal(m.state.members[0].accessEpoch,1);assert.equal(m.state.commands.length,0);
});
test("signal requeue validates scope and repeats only the stored result",async()=>{
 const m=createOperationalDb(),id=crypto.randomUUID(),payload={agencyId:"agency-a",creatorId:"creator-a"};const r=await call(m,"maintenance.subscriber.requeue","signal-a",payload,id);assert.equal(r.statusCode,200);assert.equal(m.state.signals[0].revision,2n);await call(m,"maintenance.subscriber.requeue","signal-a",payload,id);assert.equal(m.state.signals[0].revision,2n);
});

test("agency restore derives current billing access and preserves an explicit support hold",async()=>{
 for(const hold of[false,true]){
  const m=createOperationalDb();Object.assign(m.state.agencies[0],{updatedAt:new Date(revision),deletedAt:new Date(revision),status:"LOCKED",billingSupportHold:hold});Object.assign(m.state.members[0],{role:"OWNER",roleKey:"owner"});
  const r=await call(m,"agency.restore","agency-a",{expectedUpdatedAt:revision});assert.equal(r.statusCode,200);assert.equal(m.state.agencies[0].deletedAt,null);assert.equal(m.state.agencies[0].status,hold?"LOCKED":"PAST_DUE");
 }
});
test("agency restore rejects committed hard deletion and lack of operational owner",async()=>{
 for(const hard of[false,true]){
  const m=createOperationalDb();Object.assign(m.state.agencies[0],{updatedAt:new Date(revision),deletedAt:new Date(revision)});
  if(hard)m.state.workItems.push({id:"destructive",agencyId:"agency-a",workClass:"DESTRUCTIVE_AGENCY_CLEANUP",objectType:"Phase2AgencyDestructiveCleanup",objectId:"agency-a"});
  const r=await call(m,"agency.restore","agency-a",{expectedUpdatedAt:revision});assert.equal(r.statusCode,409);assert.equal(r.body.code,hard?"AGENCY_DESTRUCTIVE_DELETE_IRREVERSIBLE":"AGENCY_OPERATIONAL_OWNER_REQUIRED");assert.ok(m.state.agencies[0].deletedAt);
 }
});
