"use strict";
const crypto=require("node:crypto");
const copy=structuredClone;
const proof=Buffer.alloc(32,17).toString("base64");
const publicKey=crypto.generateKeyPairSync("x25519").publicKey.export({type:"spki",format:"der"}).toString("base64");
const envelope={algorithm:"x25519-hkdf-sha256-aes-256-gcm-v1",ephemeralPublicKey:publicKey,ciphertext:Buffer.alloc(32).toString("base64"),iv:Buffer.alloc(12).toString("base64"),tag:Buffer.alloc(16).toString("base64")};
function makeOwnershipDb(options={}){
 const now=new Date("2026-09-24T00:00:00Z");
 let state={agencies:[{id:"a",deletedAt:null}],users:[{id:"u1",disabledAt:null},{id:"u2",disabledAt:null},{id:"u3",disabledAt:null}],members:[1,2,3].map(n=>({id:`m${n}`,agencyId:"a",userId:`u${n}`,deletedAt:null,deactivatedAt:null,role:n===1?"OWNER":"OPERATOR",roleKey:n===1?"owner":"chatter",accessEpoch:1,assignedCreators:n===1?"all":["c1"],permissions:{}})),root:options.crypto?{agencyId:"a",version:1,status:"ACTIVE",recoveryProofHash:crypto.createHash("sha256").update(Buffer.from(proof,"base64")).digest("base64")}:null,identities:[1,2].map(n=>({agencyId:"a",deviceId:`d${n}`,userId:`u${n}`,status:"ACTIVE",revokedAt:null,fingerprint:`fp${n}`,publicKey,updatedAt:now})),devices:[1,2,3].map(n=>({id:`d${n}`,agencyId:"a",userId:`u${n}`})),wraps:[{id:"w1",agencyId:"a",deviceId:"d1",rootVersion:1,revokedAt:null}],refresh:[1,2,3].map(n=>({id:`r${n}`,agencyId:"a",userId:`u${n}`,deviceId:`d${n}`,authorizationSessionId:`lineage${n}`,impersonatedByAdminId:null,revokedAt:null,expiresAt:new Date("2027-01-01")})),audit:[],outbox:[]};
 function client(read){
  const match=(row,w={})=>Object.entries(w).every(([k,v])=>{
   if(k==="OR")return v.some(q=>match(row,q));
   if(k==="user"||k==="agency")return match(read()[k==="user"?"users":"agencies"].find(x=>x.id===row[k+"Id"])||{},v.is||v);
   if(k.includes("_"))return match(row,v);
   if(v&&typeof v==="object"&&!(v instanceof Date)){if("in"in v)return v.in.includes(row[k]);if("not"in v)return row[k]!==v.not;if("gt"in v)return row[k]>v.gt;}
   return row[k]===v;
  });
  const model=(key)=>{
   const find=({where={},include}={})=>{const row=read()[key].find(r=>match(r,where));return row?copy({...row,...(include?.user?{user:read().users.find(u=>u.id===row.userId)}:{})}):null;};
   const update=({where,data})=>{const row=read()[key].find(r=>match(r,where));if(!row)throw Error(`Missing ${key}`);if(options.failPromotion&&data.role==="OWNER")throw Error("promotion failed");for(const[k,v]of Object.entries(data))row[k]=v&&typeof v==="object"&&"increment"in v?row[k]+v.increment:copy(v);return copy(row);};
   return {findFirst:async args=>find(args),findUnique:async args=>find(args),findMany:async({where={}}={})=>copy(read()[key].filter(r=>match(r,where))),count:async({where={}}={})=>read()[key].filter(r=>match(r,where)).length,update:async args=>update(args),updateMany:async({where,data})=>{const rows=read()[key].filter(r=>match(r,where));for(const r of rows)update({where:r.id?{id:r.id}:{agencyId:r.agencyId,deviceId:r.deviceId,rootVersion:r.rootVersion},data});return {count:rows.length};},upsert:async({where,create,data,update:changes})=>{const row=find({where});if(row)return update({where,data:changes});const result={id:crypto.randomUUID(),...copy(create)};read()[key].push(result);return copy(result);}};
  };
  const api={agencyMember:model("members"),user:model("users"),workerDevice:model("devices"),deviceCryptoIdentity:model("identities"),agencyCryptoOwnerKeyWrap:model("wraps"),refreshSession:model("refresh"),agencyCryptoRoot:{findUnique:async()=>copy(read().root)},auditLog:{findUnique:async({where})=>copy(read().audit.find(r=>r.id===where.id)||null),create:async({data})=>{if(options.failAudit)throw Error("audit failed");read().audit.push(copy(data));return copy(data);}},$queryRawUnsafe:async(sql,...args)=>{
   if(sql.includes("clock_timestamp()"))return [{authorityNow:now}];
   if(sql.includes('FROM "Phase2ReleaseCompatibilityAuthority"'))return [{requiredGeneration:"phase2_team_control_plane_v2_durable_access",activationState:options.draining?"DRAINING":"ACTIVE"}];
   if(sql.includes('FROM "CreatorAccount"'))return [{id:args[0],agencyId:"a"}];
   if(sql.includes('FROM "Agency"'))return copy(read().agencies.filter(a=>a.id===args[0]));
   if(sql.includes('FROM "AgencyMember"'))return copy(read().members.filter(a=>a.id===args[0]));
   if(sql.includes('FROM "User"'))return copy(read().users.filter(a=>a.id===args[0]&&!a.disabledAt));
   if(sql.includes("set_config"))return [];
   throw Error(`Unmodelled query ${sql}`);
  },$executeRawUnsafe:async(sql,...args)=>{
   if(sql.includes('INSERT INTO "DeviceCommand"')){if(options.failOutbox)throw Error("outbox failed");const[receipt,at,agency,u1,u2]=args;for(const d of read().devices.filter(d=>d.agencyId===agency&&[u1,u2].includes(d.userId)))read().outbox.push({id:receipt+":"+d.id,deviceId:d.id,at});return 2;}
   if(sql.includes("pg_advisory")||sql.includes("set_config"))return 1;
   throw Error(`Unmodelled execute ${sql}`);
  }};
  return api;
 }
 const db=client(()=>state);db.$transaction=async(fn)=>{if(options.serializationConflict)throw Object.assign(Error("conflict"),{code:"P2034"});const draft=copy(state);const value=await fn(client(()=>draft));state=draft;return value;};
 return {db,get state(){return state;},now};
}
module.exports={makeOwnershipDb,proof,envelope};
