'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module');
const {randomUUID}=require('node:crypto');
const root=process.env.D8_SOURCE_ROOT || path.join(__dirname,'../..');
function load(rel,stubs={}){
 const file=path.join(root,rel),m={exports:{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:m,exports:m.exports,require:name=>name in stubs?stubs[name]:Module.createRequire(file)(name),Buffer,Date,process,console,setTimeout,clearTimeout},{filename:file});return m.exports;
}
function authFixture(){
 const now=new Date();const f={rows:[
 {id:'old',userId:'u',agencyId:'a',deviceId:'d',authorizationSessionId:'old-login',tokenHash:'hash:token',revokedAt:now,expiresAt:new Date('2099-01-01'),user:{id:'u'}},
 {id:'same',userId:'u',agencyId:'a',deviceId:'d',authorizationSessionId:'old-login',revokedAt:null,expiresAt:new Date('2099-01-01')},
 {id:'new',userId:'u',agencyId:'a',deviceId:'d',authorizationSessionId:'new-login',revokedAt:null,expiresAt:new Date('2099-01-01')},
 {id:'agency',userId:'u',agencyId:'b',deviceId:'d',authorizationSessionId:'elsewhere',revokedAt:null,expiresAt:new Date('2099-01-01')},
 ],writes:0};
 const matches=(row,w)=>Object.entries(w).every(([k,v])=>v&&typeof v==='object'&&v.gt?row[k]>v.gt:row[k]===v);
 const tx={refreshSession:{findUnique:async()=>({...f.rows[0]}),updateMany:async({where,data})=>{let count=0;for(const row of f.rows)if(matches(row,where)){Object.assign(row,data);count++;f.writes++;}return {count};}},$executeRawUnsafe:async()=>1};
 const db={...tx,$transaction:async fn=>fn(tx)};
 const service=load('src/services/auth-service.js',{'../prisma':db,'jsonwebtoken':{},'../utils/crypto':{sha256:s=>'hash:'+s},'../utils/tokens':{},'./email-service':{},'./db-time-authority-service':{dbAuthorityNow:async()=>now}});
 return {...f,service};
}
test('D8 prior defect: old refresh reuse cannot revoke a fresh login on the same device',async()=>{
 const f=authFixture();const r=await f.service.refreshAccessToken({refreshToken:'token',req:{headers:{}}});assert.equal(r.code,'REFRESH_REUSED');assert.equal(f.rows[2].revokedAt,null);assert.equal(f.rows[3].revokedAt,null);assert.ok(f.rows[1].revokedAt);
});
test('D8 prior defect: logout after token rotation closes the original login lineage',async()=>{
 const f=authFixture();await f.service.revokeRefreshToken('token');assert.ok(f.rows[1].revokedAt);assert.equal(f.rows[2].revokedAt,null);
});
test('D8 prior defect: delayed logout cannot end another agency or newer login',async()=>{
 const f=authFixture();f.rows[0].revokedAt=null;await f.service.revokeRefreshToken('token');assert.equal(f.rows[2].revokedAt,null);assert.equal(f.rows[3].revokedAt,null);
});
function resetFixture(change){
 const now=new Date('2026-09-29T00:00:00Z');const f={record:{id:'t',userId:'u',type:'PASSWORD_RESET',usedAt:null,expiresAt:new Date('2099-01-01')},writes:0};
 const tx={$queryRawUnsafe:async()=>[{id:'u'}],authToken:{findUnique:async()=>({...f.record}),update:async()=>{f.writes++;},updateMany:async()=>{f.writes++;return {count:1};}},user:{findUnique:async()=>({id:'u'}),update:async()=>{f.writes++;}},refreshSession:{updateMany:async()=>{f.writes++;}}};
 const db={...tx,authToken:{...tx.authToken,findUnique:async()=>({...f.record})}};
 const stubs={bcryptjs:{hash:async()=>{change(f,now);return 'hash-new';}},'../utils/crypto':{sha256:x=>x},'./db-transaction-service':{runDbTransaction:async(_db,work)=>work(tx)},'./authorization-session-authority-service':{acquireAuthorizationUserLock:async()=>{}},'./db-time-authority-service':{dbAuthorityNow:async()=>now}};
 const route=fs.readFileSync(path.join(root,'src/routes/auth.js'),'utf8');const snippet=route.slice(route.indexOf('router.post("/reset-password"'),route.indexOf('router.get("/me"'));
 let handler;
 vm.runInNewContext(snippet,{router:{post:(_path,fn)=>{handler=fn;}},resetPasswordSchema:{parse:x=>x},prisma:db,bcrypt:stubs.bcryptjs,sha256:x=>x,
 runDbTransaction:stubs['./db-transaction-service'].runDbTransaction,acquireAuthorizationUserLock:async()=>{},dbAuthorityNow:async()=>now,Date,console,
 require:()=>load('src/services/account-password-reset-service.js',stubs),validationError:()=>{throw Error('Unexpected validation');}});
 f.run=async()=>{const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({body:{token:'synthetic-reset-token',password:'replacement-password'}},res);return res;};return f;
}
test('D8 prior defect: token consumed during password hashing cannot reset again',async()=>{
 const f=resetFixture((f,now)=>{f.record.usedAt=now;}),r=await f.run();assert.equal(r.body.code,'TOKEN_USED');assert.equal(f.writes,0);
});
test('D8 prior defect: token expiring during hashing cannot commit',async()=>{
 const f=resetFixture((f,now)=>{f.record.expiresAt=now;}),r=await f.run();assert.equal(r.body.code,'TOKEN_EXPIRED');assert.equal(f.writes,0);
});
test('D8 prior defect: unbound access JWT cannot bypass device logout fences',async()=>{
 let queries=0;const auth=load('src/middleware/auth.js',{'../prisma':{agencyMember:{findFirst:async()=>{queries++;return {id:'m',userId:'u',agencyId:'a',user:{emailVerifiedAt:new Date()},agency:{}};}}},'../utils/tokens':{verifyAccessToken:()=>({userId:'u',agencyId:'a'})}});
 let next=false;const res={status(c){this.code=c;return this;},json(x){this.body=x;return this;}};
 await auth.authRequired({headers:{authorization:'Bearer synthetic'}},res,()=>{next=true;});assert.equal(next,false);assert.equal(res.body.code,'AUTH_DEVICE_BOUND_SESSION_REQUIRED');assert.equal(queries,0);
});
if(!process.env.D8_SOURCE_ROOT){
 const {parse,ACTIONS}=require('./account-security-command-service');const {sessionRevision,readActiveSessions}=require('./account-security-state');
 for(const action of ACTIONS)test(`${action}: strict complete envelope and stable cancel fingerprint`,()=>{
  const c={commandId:randomUUID(),action,targetId:['account.logoutDevice','account.revokeSession'].includes(action)?'target':'',payload:{deviceId:'device',originAuthorizationSessionId:'lineage',...(action==='account.password'?{currentPassword:'current-password',newPassword:'next-password'}:{expectedRevision:'a'.repeat(64)})}};
  assert.equal(parse(c).fingerprint,parse(c,true).fingerprint);assert.throws(()=>parse({...c,payload:{...c.payload,unexpected:true}}));assert.notEqual(parse(c).fingerprint,parse({...c,payload:{...c.payload,changed:true}},true).fingerprint);
 });
 test('session revision is stable across rotation but changes for another login or agency',()=>{
  const base={id:'a',agencyId:'agency',deviceId:'device',authorizationSessionId:'lineage'};
  assert.equal(sessionRevision([base]),sessionRevision([{...base,id:'b',expiresAt:new Date()}]));assert.notEqual(sessionRevision([base]),sessionRevision([{...base,authorizationSessionId:'new'}]));assert.notEqual(sessionRevision([base]),sessionRevision([{...base,agencyId:'other'}]));
  assert.notEqual(sessionRevision([{...base,authorizationSessionId:null}]),sessionRevision([{...base,id:'b',authorizationSessionId:null}]));
 });
 test('session enumeration fails closed above its explicit per-account bound',async()=>{
  let limit;await assert.rejects(readActiveSessions({refreshSession:{findMany:async args=>{limit=args.take;return Array(2049).fill({});}}},'user',new Date()),{code:'ACCOUNT_SECURITY_SESSION_LIMIT'});assert.equal(limit,2049);
 });
}

if (!process.env.D8_SOURCE_ROOT) {
 const gateway=require('../middleware/retired-account-security-writes');
 for (const [method,p] of [['POST','/account/password'],['POST','/ACCOUNT/DEVICES/logout-others/'],['DELETE','/account/devices/d'],['DELETE','/account/sessions/s'],['POST','/account/sessions/revoke-others']]) test(`${method} ${p} retires before the legacy mutation`,()=>{
  let next=false;const res={status(code){this.code=code;return this;},json(v){this.body=v;return this;}};gateway({method,path:p},res,()=>{next=true;});assert.equal(next,false);assert.equal(res.code,410);
 });
 test('retirement gateway preserves independent avatar, email and read protocols',()=>{
  for(const [method,path] of [['POST','/account/forgot-password'],['POST','/account/avatar'],['GET','/account'],['GET','/account/devices/d']]){let next=false;gateway({method,path},{},()=>{next=true;});assert.equal(next,true);}
 });
}
