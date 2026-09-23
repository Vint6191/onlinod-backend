"use strict";
const {createMemoryDb}=require("./admin-command-memory-db");
function createOperationalDb(options={}){
 const initial=new Date("2026-01-01T00:00:00Z");
 return createMemoryDb({...options,extendState:{users:[{id:"user-a",name:"User",email:"user@test.invalid",passwordHash:"do-not-return",disabledAt:null,sessionsRevokedAt:null,updatedAt:initial}],members:[{id:"member-a",agencyId:"agency-a",userId:"user-a",role:"OPERATOR",roleKey:"chatter",accessEpoch:1,deletedAt:null,deactivatedAt:null,permissions:{}}],devices:[{id:"device-a",agencyId:"agency-a",userId:"user-a"},{id:"device-b",agencyId:"agency-b",userId:"user-a"}],refresh:[{id:"refresh-a",userId:"user-a",agencyId:"agency-a",deviceId:"device-a",revokedAt:null,expiresAt:new Date("2027-01-01")},{id:"refresh-b",userId:"user-a",agencyId:"agency-b",deviceId:"device-b",revokedAt:null,expiresAt:new Date("2027-01-01")}],deviceCommands:[],signals:[{id:"signal-a",agencyId:"agency-a",creatorId:"creator-a",attempts:100,revision:1n}],customerAudit:[],...options.extendState},extendClient(api,{read,clock,copy}){
  const table=name=>read()[name];
  function matches(row,where={}){return Object.entries(where).every(([k,v])=>{
   if(k==="OR")return v.some(q=>matches(row,q));
   if(k==="user")return matches(table("users").find(u=>u.id===row.userId)||{},v.is||v);
   if(k==="agency")return matches(table("agencies").find(a=>a.id===row.agencyId)||{},v.is||v);
   if(v&&typeof v==="object"&&!(v instanceof Date)){if("not"in v)return row[k]!==v.not;if("gt"in v)return row[k]>v.gt;if("in"in v)return v.in.includes(row[k]);}
   return row[k]===v;
  });}
  const update=(name,where,data)=>{const row=table(name).find(r=>matches(r,where));if(!row)throw Error(`Missing ${name}`);for(const[k,v]of Object.entries(data))row[k]=v&&typeof v==="object"&&"increment"in v?row[k]+v.increment:copy(v);row.updatedAt=copy(clock);return copy(row);};
  const model=name=>({findUnique:async({where})=>copy(table(name).find(r=>matches(r,where))||null),findFirst:async({where})=>copy(table(name).find(r=>matches(r,where))||null),findMany:async({where={}}={})=>table(name).filter(r=>matches(r,where)).map(copy),count:async({where={}}={})=>table(name).filter(r=>matches(r,where)).length,update:async({where,data})=>update(name,where,data),updateMany:async({where,data})=>{const rows=table(name).filter(r=>matches(r,where));rows.forEach(r=>update(name,{id:r.id},data));return {count:rows.length};}});
  api.user=model("users");api.agencyMember=model("members");api.workerDevice=model("devices");api.refreshSession=model("refresh");api.subscriberDirectoryMaintenanceSignal=model("signals");
  api.deviceCryptoIdentity={findMany:async()=>[]};api.auditLog={create:async({data})=>{table("customerAudit").push(copy(data));return data;}};
  const query=api.$queryRawUnsafe,execute=api.$executeRawUnsafe;
  api.$queryRawUnsafe=async(sql,...args)=>{
   if(sql.includes('FROM "Phase2ReleaseCompatibilityAuthority"'))return [{requiredGeneration:"phase2_team_control_plane_v2_durable_access",activationState:options.draining?"DRAINING":"ACTIVE"}];
   if(sql.includes("set_config("))return [];
   for(const[name,key]of[["User","users"],["AgencyMember","members"],["WorkerDevice","devices"],["SubscriberDirectoryMaintenanceSignal","signals"]])if(sql.includes(`FROM "${name}"`))return table(key).filter(r=>r.id===args[0]).map(copy);
   if(sql.includes('UPDATE "SubscriberDirectoryMaintenanceSignal"')){const row=table("signals").find(r=>r.id===args[0]&&r.attempts>=50);if(!row)return [];row.attempts=0;row.revision++;row.dueAt=copy(clock);return [copy(row)];}
   return query(sql,...args);
  };
  api.$executeRawUnsafe=async(sql,...args)=>{
   if(sql.includes("set_config("))return 1;
   if(sql.startsWith('UPDATE "AgencyMember"')){const rows=table("members").filter(r=>r.userId===args[0]&&!r.deletedAt);rows.forEach(r=>{r.accessEpoch++;});return rows.length;}
   if(sql.startsWith('INSERT INTO "DeviceCommand"')){
    if(options.failOutbox)throw Error("outbox unavailable");
    const [identity,payload,adminId,now,userId,agencyId,deviceId]=args;let count=0;
    for(const d of table("devices").filter(d=>d.userId===userId&&(!agencyId||d.agencyId===agencyId)&&(!deviceId||d.id===deviceId))){const id=identity+":"+d.id;if(table("deviceCommands").some(c=>c.id===id))continue;table("deviceCommands").push({id,deviceId:d.id,agencyId:d.agencyId,payload:JSON.parse(payload),adminId,now});count++;}return count;
   }
   return execute(sql,...args);
  };
  return api;
 }});
}
module.exports={createOperationalDb};
