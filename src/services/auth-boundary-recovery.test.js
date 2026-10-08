'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {ipScope,admissionKeys}=require('./login-admission-service');
function compiled(relative,ports={}){const filename=path.resolve(__dirname,relative),m={exports:{}};const {createRequire}=require('node:module'),r=createRequire(filename);vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:m,exports:m.exports,Date,console:{error(){}},require:n=>Object.hasOwn(ports,n)?ports[n]:r(n)},{filename});return m.exports;}
function response(){const r=new EventEmitter();r.statusCode=200;r.headers={};r.set=(k,v)=>{r.headers[k]=v;return r;};r.status=n=>{r.statusCode=n;return r;};r.json=b=>{r.body=b;return r;};return r;}
function auth(db,verify){return compiled('../middleware/auth.js',{'../prisma':db,'../utils/tokens':{verifyAccessToken:verify}}).authRequired;}
const decoded=()=>({userId:'u',agencyId:'a',deviceId:'d',authorizationSessionId:'s',iat:Date.now()/1000});
const request=()=>({headers:{authorization:'Bearer fixture'}});
function membership(){return{id:'m',userId:'u',agencyId:'a',role:'OWNER',permissions:{},user:{id:'u',disabledAt:null,emailVerifiedAt:new Date(),refreshSessions:[{id:'r',authorizationSessionId:'s'}]},agency:{id:'a'}};}
test('JWT rejection stays401; verifier configuration and both DB failure boundaries produce503',async()=>{
 for(const [which,status,code]of [['jwt',401,'AUTH_INVALID'],['config',503,'AUTH_AUTHORITY_UNAVAILABLE'],['clock',503,'AUTH_AUTHORITY_UNAVAILABLE'],['membership',503,'AUTH_AUTHORITY_UNAVAILABLE']]){
  const db={$queryRawUnsafe:async()=>{if(which==='clock')throw Object.assign(Error('outage'),{code:'P1001'});return[{authorityNow:new Date()}];},agencyMember:{findFirst:async()=>{throw Object.assign(Error('outage'),{code:'P1001'});}}};
  const verify=()=>{if(which==='jwt')throw Object.assign(Error('bad'),{name:'JsonWebTokenError'});if(which==='config')throw Error('secret unavailable');return decoded();};
  const res=response();let next=false;await auth(db,verify)(request(),res,()=>next=true);assert.equal(next,false);assert.equal(res.statusCode,status);assert.equal(res.body.code,code);if(status===503)assert.equal(res.headers['Retry-After'],'2');
 }
});
test('revoked, disabled and valid sessions keep their semantics; infrastructure recovery needs no new token',async()=>{
 let state='outage',passed=0;const db={$queryRawUnsafe:async()=>{if(state==='outage')throw Error('offline');return[{authorityNow:new Date()}];},agencyMember:{findFirst:async()=>{const m=membership();if(state==='revoked')m.user.refreshSessions=[];if(state==='disabled')m.user.disabledAt=new Date();return m;}}};
 const middleware=auth(db,decoded);
 for(const [nextState,status,code]of [['outage',503,'AUTH_AUTHORITY_UNAVAILABLE'],['revoked',401,'SESSION_REVOKED'],['disabled',403,'USER_DISABLED'],['healthy',200,null]]){
  state=nextState;const r=response();await middleware(request(),r,()=>passed++);assert.equal(r.statusCode,status);assert.equal(r.body?.code??null,code);
 }
 assert.equal(passed,1);
 await assert.rejects(middleware(request(),response(),()=>{throw Error('downstream failure');}),/downstream failure/);
});
test('IP normalization closes alternate IPv6 spellings, mapped IPv4 and interface-id rotation',()=>{
 assert.equal(ipScope('::ffff:192.0.2.7'),'192.0.2.7');assert.equal(ipScope('2001:db8:1:2:0:0:0:1'),ipScope('2001:0db8:1:2::abcd'));
 assert.notEqual(ipScope('2001:db8:1:3::1'),ipScope('2001:db8:1:2::1'));
 const a=admissionKeys({surface:'admin',email:' OWNER@EXAMPLE.COM ',ip:'192.0.2.7'}),b=admissionKeys({surface:'admin',email:'owner@example.com',ip:'::ffff:192.0.2.7'});assert.deepEqual(a,b);assert.ok(a.every(k=>/^[a-f0-9]{64}$/.test(k.id)));
});
test('member/admin login both attach durable admission before credential handling',()=>{
 for(const [file,surface]of [['../routes/auth.js','member'],['../routes/admin-auth.js','admin']]){const s=fs.readFileSync(path.resolve(__dirname,file),'utf8');assert.ok(s.includes(`router.post("/login", require("../middleware/login-admission").loginAdmission({ db: prisma, surface: "${surface}" }), async`));}
});
test('login middleware refunds success once, retains failures and fails closed on admission outage',async()=>{
 let released=0,next=0,failure=null;const service={reserveLoginAttempt:async()=>{if(failure)throw failure;return[{id:'r',windowStartedAt:new Date()}];},releaseSuccessfulAttempt:async()=>released++};
 const {loginAdmission}=compiled('../middleware/login-admission.js',{'../services/login-admission-service':service});const middleware=loginAdmission({db:{},surface:'admin'});
 for(const status of [200,401,503]){const r=response();await middleware({ip:'x',body:{email:'a'}},r,()=>next++);r.statusCode=status;r.emit('finish');r.emit('finish');}
 await new Promise(r=>setImmediate(r));assert.equal(released,1);assert.equal(next,3);
 failure=Object.assign(Error('limited'),{code:'LOGIN_RATE_LIMITED',retryAfter:17});let r=response();await middleware({},r,()=>next++);assert.equal(r.statusCode,429);assert.equal(r.headers['Retry-After'],'17');
 failure=Error('database down');r=response();await middleware({},r,()=>next++);assert.equal(r.statusCode,503);assert.equal(r.body.code,'LOGIN_ADMISSION_UNAVAILABLE');assert.equal(next,3);
});

test('admin session outages return retryable503 and recover with the same bearer',async()=>{
 let state='db',passed=0;
 const db={adminSession:{findUnique:async()=>{if(state==='db')throw Object.assign(Error('offline'),{code:'P1001'});return state==='revoked'?null:{expiresAt:new Date(Date.now()+60000),issuedAccessEpoch:3,adminUser:{active:true,role:'OWNER',accessEpoch:3}};}}};
 const {adminSessionRequired}=compiled('../middleware/admin-session.js',{'../prisma':db,'../services/db-time-authority-service':{dbAuthorityNow:async()=>{if(state==='clock')throw Error('clock offline');return new Date();}},'../services/admin-session-authority-service':{KNOWN_ROLES:new Set(['OWNER'])}});
 for(const [nextState,status,code]of [['db',503,'ADMIN_AUTH_AUTHORITY_UNAVAILABLE'],['clock',503,'ADMIN_AUTH_AUTHORITY_UNAVAILABLE'],['revoked',401,'ADMIN_AUTH_INVALID'],['healthy',200,null]]){
  state=nextState;const r=response();await adminSessionRequired(request(),r,()=>passed++);assert.equal(r.statusCode,status);assert.equal(r.body?.code??null,code);
 }
 assert.equal(passed,1);
 await assert.rejects(adminSessionRequired(request(),response(),()=>{throw Error('downstream');}),/downstream/);
});
