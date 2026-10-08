'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),load=createRequire(path.join(root,'package.json'));
const runtimePath=process.env.ONLINOD_SQL_PROOF_RUNTIME;
if(!runtimePath)throw new Error('Set ONLINOD_SQL_PROOF_RUNTIME to an isolated local package containing @electric-sql/pglite and @electric-sql/pglite-socket');
const {createAdminSqlRuntime}=load('./scripts/test-support/admin-sql-runtime.cjs');
const keep=setInterval(()=>{},1000),result={ok:false,nativePostgres:false,productionAccessed:false,scope:'real retained SQL/Prisma on disposable PGlite; not native multi-session concurrency',cases:[]};
(async()=>{let f;try{
 f=await createAdminSqlRuntime({runtimePath});const db=f.db;
 let service=load('./src/services/login-admission-service');const ip='192.0.2.1',email='owner@example.test';
 const count=async()=>db.$queryRawUnsafe('SELECT "id","attempts","windowStartedAt" FROM "LoginAdmissionBucket" ORDER BY "id"');
 const base={db,surface:'admin',ip,email};
 async function caseRun(name,fn){await fn();result.cases.push({name,ok:true});}
 await caseRun('all retained migrations include new admission table',async()=>{assert.ok(f.migrations.includes('20261008220000_login_admission_authority'));assert.equal(await db.loginAdmissionBucket.count(),0);});
 await caseRun('10 reservations accepted; 11th rejected; a new service instance sees same durable state',async()=>{
  for(let i=0;i<10;i++)await service.reserveLoginAttempt(base);
  delete require.cache[load.resolve('./src/services/login-admission-service')];service=load('./src/services/login-admission-service');
  await assert.rejects(service.reserveLoginAttempt(base),e=>e.code==='LOGIN_RATE_LIMITED'&&e.status===429&&e.retryAfter>0);
  assert.ok((await count()).every(row=>row.attempts===10));
 });
 await caseRun('account limit survives IP rotation and normalization; other account/IP works',async()=>{
  await assert.rejects(service.reserveLoginAttempt({...base,ip:'192.0.2.2',email:' OWNER@EXAMPLE.TEST '}),e=>e.code==='LOGIN_RATE_LIMITED');
  const r=await service.reserveLoginAttempt({...base,email:'other@example.test',ip:'192.0.2.3'});await service.releaseSuccessfulAttempt({db,reservations:r});
 });
 await caseRun('IP limit spans admin/member surfaces and rolls back other bucket on rejection',async()=>{
  const before=await count();await assert.rejects(service.reserveLoginAttempt({...base,surface:'member',email:'different@example.test'}),e=>e.code==='LOGIN_RATE_LIMITED');assert.deepEqual(await count(),before);
 });
 await caseRun('successful reservations refund exactly their windows and permit repeated good logins',async()=>{
  for(let i=0;i<14;i++){const reservations=await service.reserveLoginAttempt({...base,ip:'192.0.2.4',email:'good@example.test'});await service.releaseSuccessfulAttempt({db,reservations});}
  const ids=service.admissionKeys({...base,ip:'192.0.2.4',email:'good@example.test'}).map(k=>k.id);assert.ok((await count()).filter(r=>ids.includes(r.id)).every(r=>r.attempts===0));
 });
 await caseRun('late success from an expired window cannot refund a new attempt',async()=>{
  const next={...base,ip:'192.0.2.5',email:'window@example.test'},old=await service.reserveLoginAttempt(next);
  for(const entry of old)await db.$executeRawUnsafe('UPDATE "LoginAdmissionBucket" SET "expiresAt"=clock_timestamp()-interval \'1 second\',"windowStartedAt"=clock_timestamp()-interval \'1 hour\' WHERE "id"=$1',entry.id);
  const current=await service.reserveLoginAttempt(next);await service.releaseSuccessfulAttempt({db,reservations:old});
  assert.ok((await count()).filter(r=>current.some(c=>c.id===r.id)).every(r=>r.attempts===1));
  await service.releaseSuccessfulAttempt({db,reservations:current});
 });
 await caseRun('blocked second bucket leaves no partial first reservation',async()=>{
  const accountId=service.admissionKeys(base).find(k=>!service.admissionKeys({...base,email:'different@example.test'}).some(x=>x.id===k.id)).id;
  let selected;for(let i=10;i<250;i++){const next={...base,ip:'198.51.100.'+i};const keys=service.admissionKeys(next);if(keys[0].id!==accountId){selected=next;break;}}
  assert.ok(selected);const before=await count();await assert.rejects(service.reserveLoginAttempt(selected),e=>e.code==='LOGIN_RATE_LIMITED');assert.deepEqual(await count(),before);
 });
 await caseRun('queued competing attempts retain cap on the SQL runtime',async()=>{
  const input={...base,ip:'203.0.113.1',email:'parallel@example.test'};
  const outcomes=await Promise.allSettled(Array.from({length:13},()=>service.reserveLoginAttempt(input)));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,10);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='LOGIN_RATE_LIMITED').length,3);
 });
 await caseRun('cleanup bounds each batch and keeps live buckets',async()=>{
  await db.$executeRawUnsafe(`INSERT INTO "LoginAdmissionBucket" ("id","windowStartedAt","expiresAt","attempts") SELECT 'expired:'||n,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',1 FROM generate_series(1,300) n`);
  const reservations=await service.reserveLoginAttempt({...base,ip:'203.0.113.3',email:'cleanup@example.test'});await service.releaseSuccessfulAttempt({db,reservations});
  const rows=await db.$queryRawUnsafe(`SELECT count(*)::int n FROM "LoginAdmissionBucket" WHERE "id" LIKE 'expired:%'`);assert.equal(rows[0].n,172);
  assert.ok((await count()).some(r=>r.attempts===10));
 });
 result.migrations=f.migrations.length;result.ok=true;
}catch(e){result.error={code:e.code,message:e.message,stack:e.stack};}finally{if(f)await f.close();clearInterval(keep);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}})();
