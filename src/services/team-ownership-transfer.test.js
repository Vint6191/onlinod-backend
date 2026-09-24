"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {makeOwnershipDb,proof,envelope}=require("../../scripts/test-support/team-ownership-memory-db");
const {transferOwnership,ownershipTransferPlan}=require("./team-ownership-transfer-service");
const {executeAdminOperation}=require("./admin-operational-command-service");
const {createOperationalDb}=require("../../scripts/test-support/admin-operational-memory-db");
const input=(encrypted=false)=>({commandId:crypto.randomUUID(),memberId:"m2",expectedOwnerEpoch:1,expectedTargetEpoch:1,expectedRootVersion:encrypted?1:null,...(encrypted?{targetDeviceId:"d2",targetFingerprint:"fp2",actorProof:proof,ownerWrap:envelope}:{})});
const call=(m,command=input(),extra={})=>transferOwnership({db:m.db,agencyId:"a",userId:"u1",actorDeviceId:"d1",authorizationSessionId:"lineage1",input:command,...extra});

test("direct owner session expiring during topology locks cannot authorize handover",async()=>{
 const m=makeOwnershipDb(),before=globalThis.structuredClone(m.state);
 let clockReads=0;
 const db={$transaction:(work,options)=>m.db.$transaction(tx=>{
  const query=tx.$queryRawUnsafe;
  tx.$queryRawUnsafe=async(sql,...args)=>{
   if(sql.includes("clock_timestamp()"))return [{authorityNow:++clockReads===1?m.now:new Date("2028-01-01")}];
   return query(sql,...args);
  };
  return work(tx);
 },options)};
 await assert.rejects(()=>call(m,input(),{db}),e=>e.code==="OWNERSHIP_DIRECT_SESSION_REQUIRED");
 assert.ok(clockReads>=3);assert.deepEqual(m.state,before);
});
test("atomic transfer leaves one owner, preserves unrelated overlapping scope, bumps both epochs and revokes only participants",async()=>{
 const m=makeOwnershipDb(),r=await call(m);assert.equal(r.ownerMemberId,"m2");assert.deepEqual(m.state.members.map(x=>x.roleKey),["chatter","owner","chatter"]);assert.deepEqual(m.state.members.map(x=>x.accessEpoch),[2,2,1]);assert.deepEqual(m.state.members[0].assignedCreators,[]);assert.equal(m.state.members[1].assignedCreators,"all");assert.deepEqual(m.state.members[2].assignedCreators,["c1"]);assert.ok(m.state.refresh[0].revokedAt&&m.state.refresh[1].revokedAt);assert.equal(m.state.refresh[2].revokedAt,null);assert.equal(m.state.outbox.length,2);assert.equal(m.state.audit.length,1);
});
test("handover grants recipient AMK envelope and revokes former-owner wraps in same commit",async()=>{
 const m=makeOwnershipDb({crypto:true});await call(m,input(true));assert.ok(m.state.wraps.find(w=>w.deviceId==="d1").revokedAt);assert.equal(m.state.wraps.find(w=>w.deviceId==="d2").ciphertext,envelope.ciphertext);assert.doesNotMatch(JSON.stringify(m.state.audit),/actorProof|ciphertext|ephemeralPublicKey/);
});
for(const failure of["failAudit","failOutbox","failPromotion"])test(`${failure}: ownership, key handover, sessions, epoch, receipt and outbox all roll back`,async()=>{
 const m=makeOwnershipDb({crypto:true,[failure]:true}),before=globalThis.structuredClone(m.state);await assert.rejects(()=>call(m,input(true)));assert.deepEqual(m.state,before);
});
for(const[change,code]of[
 [c=>{delete c.actorProof;},"CRYPTO_ACTOR_PROOF_REQUIRED"],
 [c=>{c.actorProof=Buffer.alloc(32,8).toString("base64");},"CRYPTO_ACTOR_PROOF_MISMATCH"],
 [c=>{delete c.ownerWrap;},"CRYPTO_WRAP_ALGORITHM_UNSUPPORTED"],
 [c=>{c.targetFingerprint="stale";},"OWNERSHIP_TARGET_DEVICE_CHANGED"],
 [c=>{c.targetDeviceId="d1";},"OWNERSHIP_TARGET_DEVICE_CHANGED"],
 [c=>{c.expectedRootVersion=2;},"CRYPTO_APPROVAL_ROOT_VERSION_CONFLICT"],
 [c=>{c.expectedOwnerEpoch=2;},"OWNERSHIP_REVISION_CONFLICT"],
 [c=>{c.expectedTargetEpoch=2;},"OWNERSHIP_REVISION_CONFLICT"],
 ])test(`encrypted handover rejects ${code} without effects`,async()=>{
 const m=makeOwnershipDb({crypto:true}),before=globalThis.structuredClone(m.state),c=input(true);change(c);await assert.rejects(()=>call(m,c),e=>e.code===code);assert.deepEqual(m.state,before);
 });
for(const mutation of["disabled","deactivated","deleted","foreign","deviceRevoked","secondOwner"])test(`fresh recipient and topology validation rejects ${mutation}`,async()=>{
 const m=makeOwnershipDb({crypto:true});if(mutation==="disabled")m.state.users[1].disabledAt=m.now;if(mutation==="deactivated")m.state.members[1].deactivatedAt=m.now;if(mutation==="deleted")m.state.members[1].deletedAt=m.now;if(mutation==="foreign")m.state.members[1].agencyId="b";if(mutation==="deviceRevoked")m.state.identities[1].revokedAt=m.now;if(mutation==="secondOwner")Object.assign(m.state.members[2],{role:"OWNER",roleKey:"owner"});const before=globalThis.structuredClone(m.state);await assert.rejects(()=>call(m,input(true)));assert.deepEqual(m.state,before);
});
test("same command returns receipt after former owner is demoted; changed intent cannot reuse it",async()=>{
 const m=makeOwnershipDb(),c=input(),first=await call(m,c);m.state.refresh.push({...m.state.refresh[0],id:"new-login",revokedAt:null});const again=await call(m,c);assert.equal(again.replayed,true);assert.equal(again.ownerMemberId,first.ownerMemberId);assert.equal(m.state.outbox.length,2);await assert.rejects(()=>call(m,{...c,memberId:"m3"}),e=>e.code==="OWNERSHIP_COMMAND_CONFLICT");await assert.rejects(()=>call(m,c,{userId:"u3"}),e=>e.code==="OWNERSHIP_DIRECT_SESSION_REQUIRED");
});
test("different command with old owner authority cannot execute a second transfer",async()=>{
 const m=makeOwnershipDb();await call(m);m.state.refresh.push({...m.state.refresh[0],id:"new-login",revokedAt:null});await assert.rejects(()=>call(m,{...input(),memberId:"m3"}),e=>e.code==="OWNER_REQUIRED");assert.equal(m.state.audit.length,1);
});
test("plan requires current owner and approved recipient device; empty-root agency needs no key material",async()=>{
 const plain=makeOwnershipDb(),encrypted=makeOwnershipDb({crypto:true});const p=await ownershipTransferPlan({db:plain.db,agencyId:"a",userId:"u1",memberId:"m2",actorDeviceId:"d1",authorizationSessionId:"lineage1"});assert.equal(p.targetDevice,null);const q=await ownershipTransferPlan({db:encrypted.db,agencyId:"a",userId:"u1",memberId:"m2",actorDeviceId:"d1",authorizationSessionId:"lineage1"});assert.equal(q.targetDevice.deviceId,"d2");assert.equal(q.expectedRootVersion,1);await assert.rejects(()=>ownershipTransferPlan({db:plain.db,agencyId:"a",userId:"u3",memberId:"m2"}));
});
test("release drain and serialization failure leave ownership unchanged",async()=>{
 for(const opt of["draining","serializationConflict"]){const m=makeOwnershipDb({[opt]:true}),before=globalThis.structuredClone(m.state);await assert.rejects(()=>call(m),e=>opt==="draining"||e.status===409);assert.deepEqual(m.state,before);}
});
test("platform SUPER_ADMIN cannot add a second OWNER through ordinary role command",async()=>{
 const m=createOperationalDb();const r=await executeAdminOperation({db:m.db,actor:{adminId:"admin-a",sessionId:"session-a",accessEpoch:1},commandId:crypto.randomUUID(),action:"member.role.set",targetId:"member-a",payload:{agencyId:"agency-a",expectedAccessEpoch:1,role:"OWNER",reason:"role edit"}});assert.equal(r.statusCode,409);assert.equal(r.body.code,"OWNERSHIP_TRANSFER_REQUIRED");assert.equal(m.state.members[0].roleKey,"chatter");assert.equal(m.state.deviceCommands.length,0);
});

for(const mode of ["impersonated","expired","revoked","unbound","wrongLineage"])
 test(`ownership requires direct owner session: ${mode}`,async()=>{
  const m=makeOwnershipDb(),extra={};
  if(mode==="impersonated")m.state.refresh[0].impersonatedByAdminId="support-admin";
  if(mode==="expired")m.state.refresh[0].expiresAt=m.now;
  if(mode==="revoked")m.state.refresh[0].revokedAt=m.now;
  if(mode==="unbound")extra.actorDeviceId=null;
  if(mode==="wrongLineage")extra.authorizationSessionId="another-lineage";
  const before=globalThis.structuredClone(m.state);await assert.rejects(()=>call(m,input(),extra),e=>e.code==="OWNERSHIP_DIRECT_SESSION_REQUIRED");assert.deepEqual(m.state,before);
 });

test("migration preflight supports empty bootstrap and blocks ambiguous legacy owners before migrate deploy",async()=>{
 const {preflight}=require("../../scripts/database/phase4-single-owner-preflight");
 const empty=await preflight({$queryRawUnsafe:async()=>[{agency:false,member:false,account:false}]});assert.equal(empty.bootstrap,true);
 let calls=0;await assert.rejects(()=>preflight({$queryRawUnsafe:async()=>++calls===1?[{agency:true,member:true,account:true}]:[{agencyId:"a",owners:2,operationalOwners:2}]}),e=>e.code==="PHASE4_SINGLE_OWNER_PREFLIGHT_FAILED"&&e.blockers[0].owners===2);assert.equal(calls,2);
 await assert.rejects(()=>preflight({$queryRawUnsafe:async()=>[{agency:true,member:false,account:true}]}),e=>e.code==="PHASE4_OWNER_SCHEMA_INCOMPLETE");
});

test("schema probe fails closed on a malformed driver response instead of treating it as empty bootstrap",async()=>{
 const {preflight}=require("../../scripts/database/phase4-single-owner-preflight");
 for(const rows of [undefined,null,[],[{}],[{agency:null,member:null,account:null}],
  [{agency:'Agency',member:'AgencyMember',account:'User'}],
  [{agency:false,member:false,account:false},{agency:false,member:false,account:false}]]) {
  let calls=0;
  await assert.rejects(()=>preflight({$queryRawUnsafe:async()=>{calls++;return rows;}}),e=>e.code==="PHASE4_OWNER_SCHEMA_PROBE_INVALID");
  assert.equal(calls,1);
 }
});

test("schema probe preserves database failures and never skips ownership validation on error",async()=>{
 const {preflight}=require("../../scripts/database/phase4-single-owner-preflight");
 const failure=Object.assign(new Error("database unavailable"),{code:"P1001"});
 await assert.rejects(()=>preflight({$queryRawUnsafe:async()=>{throw failure;}}),e=>e===failure);
});
