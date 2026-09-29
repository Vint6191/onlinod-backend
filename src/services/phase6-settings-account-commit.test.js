"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), Module = require("node:module");
const settingsPath = process.env.ONLINOD_AUDIT_SOURCE_ROOT ? require("node:path").join(process.env.ONLINOD_AUDIT_SOURCE_ROOT,"src/services/settings-service.js") : "./settings-service";
function load() {
  const original=Module._load;
  Module._load=function(request,parent,isMain){
    if(request==="bcryptjs")return {compare:async()=>true,hash:async()=>"next-hash"};
    if(request==="../prisma")return {};
    if(request==="./auth-service")return {publicUser:u=>u};
    if(request==="./audit-service")return {audit:async()=>null};
    return original.call(this,request,parent,isMain);
  };
  try {delete require.cache[require.resolve(settingsPath)];return require(settingsPath);}finally{Module._load=original;}
}
const service=load();
function fixture() {
  const f={user:{id:"user",name:"before",passwordHash:"old-hash",disabledAt:null},writes:[],revokes:0,locks:[],beforeCommit:null};
  const tx={
    $executeRawUnsafe:async(sql,...args)=>{f.locks.push({sql,args});return 1;},
    $queryRawUnsafe:async(sql,...args)=>{f.locks.push({sql,args});return [{id:"user",authorityNow:new Date()}];},
    user:{findUnique:async()=>structuredClone(f.user),update:async({data})=>{f.writes.push(data);Object.assign(f.user,data);return f.user;}},
    refreshSession:{updateMany:async()=>{f.revokes++;return {count:1};}},
  };
  f.db={...tx,$transaction:async work=>{if(f.beforeCommit)f.beforeCommit();return work(tx);}};return f;
}
for(const [name,run] of [
  ["profile",f=>service.updateAccountProfile({userId:"user",name:"after",db:f.db})],
  ["avatar",f=>service.updateAccountAvatar({userId:"user",avatarUrl:"https://example.test/avatar",db:f.db})],
  ["password",f=>service.changeAccountPassword({userId:"user",currentPassword:"old-password",newPassword:"new-password",db:f.db})],
]) {
  test(`D5 ${name} rejects User disable between admission and commit`,async()=>{const f=fixture();f.beforeCommit=()=>{f.user.disabledAt=new Date();};await assert.rejects(run(f),e=>e.code==="SETTINGS_ACCOUNT_INACTIVE");assert.equal(f.writes.length,0);assert.equal(f.revokes,0);});
  test(`D5 ${name} owns the account row before its mutation`,async()=>{const f=fixture();await run(f);assert.equal(f.writes.length,1);assert.ok(f.locks.some(x=>x.sql.includes('FROM "User"')&&x.sql.includes("FOR UPDATE")));assert.ok(f.locks.some(x=>x.args.includes("authorization-user:user")));});
}
test("D5 stale password verification cannot overwrite a concurrently replaced hash or revoke sessions",async()=>{
  const f=fixture();f.beforeCommit=()=>{f.user.passwordHash="other-password-hash";};
  await assert.rejects(service.changeAccountPassword({userId:"user",currentPassword:"old-password",newPassword:"new-password",db:f.db}),e=>e.code==="SETTINGS_PASSWORD_CHANGED"&&e.status===409);
  assert.equal(f.user.passwordHash,"other-password-hash");assert.equal(f.writes.length,0);assert.equal(f.revokes,0);
});
