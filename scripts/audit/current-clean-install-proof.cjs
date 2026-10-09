const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const runtimePath=process.env.ONLINOD_SQL_PROOF_RUNTIME;
if(!runtimePath)throw Error('Set ONLINOD_SQL_PROOF_RUNTIME to a separate local SQL proof runtime');
const runtimeLoad=createRequire(path.resolve(runtimePath,'package.json'));
const {PGlite}=runtimeLoad('@electric-sql/pglite');
const {PGLiteSocketServer}=runtimeLoad('@electric-sql/pglite-socket');
const root=path.resolve(__dirname,'../..'),load=createRequire(path.join(root,'package.json'));
const w=process.env.ONLINOD_SQL_PROOF_OUTPUT?path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT):fs.mkdtempSync(path.join(require('node:os').tmpdir(),'onlinod-current-proof-'));
fs.mkdirSync(path.join(w,'evidence'),{recursive:true});
const report={ok:false,nativePostgres:false,engine:'PGlite PostgreSQL 18.3 + real Prisma 5.22',externalProviders:false,cases:[]};
async function run(name,fn){await fn();report.cases.push({name,ok:true});console.log('PASS',name);}
function cli(url,label){return new Promise((resolve,reject)=>{
 const log=fs.openSync(path.join(w,'evidence',label+'.log'),'w');
 const child=spawn(process.execPath,['scripts/database/install-current.js'],{cwd:root,env:{...process.env,DATABASE_URL:url},stdio:['ignore',log,log]});
 const timer=setTimeout(()=>child.kill('SIGTERM'),90000);
 child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);fs.closeSync(log);code===0?resolve():reject(Error(label+': exit '+code));});
});}
(async()=>{let engine,server,db;const keep=setInterval(()=>{},1000);try{
 engine=await PGlite.create();server=new PGLiteSocketServer({db:engine,host:'127.0.0.1',port:0});
 // PGlite shares one PostgreSQL session; reset it between sequential clients.
 server.addEventListener('connection',()=>{engine.exec('DISCARD ALL').catch(e=>console.error('session reset:',e.message));});
 await server.start();
 const url=`postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
 process.env.DATABASE_URL=url;process.env.JWT_SECRET='onlinod-isolated-proof-only-not-a-real-secret';
 await run('actual installer accepts an empty database',()=>cli(url,'clean-install-first'));
 await run('actual installer repeats without reapplying DDL',()=>cli(url,'clean-install-repeat'));
 db=load('./src/prisma');
 const contract=load('./src/services/database-contract-service');
 await run('readiness verifies the complete installed contract',async()=>assert.equal((await contract.readDatabaseContract(db)).ready,true));
 await run('all current runtime handlers and indexes resolve',async()=>{
  assert.equal((await load('./src/services/maintenance-runtime-contract').verifyMaintenanceRuntime({db})).ready,true);
  assert.equal((await load('./src/services/external-delivery-runtime-contract').verifyExternalDeliveryRuntime({db})).ready,true);
 });
 await run('retired physical tables are absent; Team current tables remain',async()=>{
  for(const name of load('./scripts/test-support/current-business-contract.json').retiredTables){
   const rows=await db.$queryRawUnsafe('SELECT to_regclass($1)::text AS name','public."'+name+'"');assert.equal(rows[0].name,null,name);
  }
  assert.equal((await db.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename IN ('TeamResponseCaseCurrent','TeamPendingDialogStateCurrent')`))[0].count,2);
 });
 await run('all retained columns preserve types, nullability and reviewed defaults',async()=>{
  const expected=load('./scripts/test-support/current-business-contract.json').columns;
  const actual=await db.$queryRawUnsafe(`SELECT table_name AS table,column_name AS name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public'`);
  const key=x=>JSON.stringify([x.table,x.name,x.data_type,x.udt_name,x.is_nullable,x.column_default]);const found=new Set(actual.map(key));
  for(const row of expected)assert.ok(found.has(key(row)),key(row));
 });
 await run('readiness refuses a disabled writer guard',async()=>{
  await db.$executeRawUnsafe('ALTER TABLE "Agency" DISABLE TRIGGER phase2_team_writer_generation_agency_lifecycle');
  try{assert.equal((await contract.readDatabaseContract(db)).ready,false);}finally{await db.$executeRawUnsafe('ALTER TABLE "Agency" ENABLE TRIGGER phase2_team_writer_generation_agency_lifecycle');}
 });
 await run('readiness refuses an index with the right name but wrong keys',async()=>{
  await db.$executeRawUnsafe('DROP INDEX "FanObservationToken_expiry_id_idx"');
  await db.$executeRawUnsafe('CREATE INDEX "FanObservationToken_expiry_id_idx" ON "FanObservationToken"("id","createdAt")');
  try{assert.equal((await contract.readDatabaseContract(db)).ready,false);}finally{
   await db.$executeRawUnsafe('DROP INDEX "FanObservationToken_expiry_id_idx"');
   await db.$executeRawUnsafe('CREATE INDEX "FanObservationToken_expiry_id_idx" ON "FanObservationToken"("createdAt","id")');
  }
 });
 await run('readiness refuses a retired table restored beside the current schema',async()=>{
  await db.$executeRawUnsafe('CREATE TABLE "AutomationJob" (id text)');
  try{assert.equal((await contract.readDatabaseContract(db)).ready,false);}finally{await db.$executeRawUnsafe('DROP TABLE "AutomationJob"');}
 });
 await run('readiness refuses a missing campaign dispatch lane',async()=>{
  const rows=await db.$queryRawUnsafe(`DELETE FROM "MaintenanceAdmissionClassState" WHERE "generation"='campaign_projection_execution_v2' AND "laneName"='CAMPAIGN_FACT' RETURNING *`);
  assert.equal(rows.length,1);
  try{assert.equal((await contract.readDatabaseContract(db)).ready,false);}finally{
   await db.$executeRawUnsafe(`INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName","ordinal","turnCount") VALUES('campaign_projection_execution_v2','CAMPAIGN_FACT',$1,0)`,rows[0].ordinal);
  }
 });
 let fixture;
 const writers=load('./src/services/database-write-contract-service');
 await run('unadmitted Team writes fail physically',async()=>{
  await assert.rejects(db.agency.create({data:{name:'must not be created'}}),/PHASE2_INCOMPATIBLE_TEAM_CONTROL_PLANE_WRITER/);
  await db.$disconnect();
 });
 await run('first owner, agency, creator and device commit together',async()=>{
  fixture=await db.$transaction(async tx=>{
   await writers.assertTeamControlPlaneWriteAdmission(tx);
   const user=await tx.user.create({data:{email:'clean-owner@example.test',passwordHash:'local-fixture'}});
   const agency=await tx.agency.create({data:{name:'Clean installation',trialEndsAt:new Date(Date.now()+86400000)}});
   const member=await tx.agencyMember.create({data:{agencyId:agency.id,userId:user.id,role:'OWNER',roleKey:'owner',assignedCreators:'all'}});
   await writers.authorizeCreatorAccountWrite(tx);
   const creator=await tx.creatorAccount.create({data:{agencyId:agency.id,displayName:'Creator',status:'READY'}});
   const device=await tx.workerDevice.create({data:{agencyId:agency.id,userId:user.id,lastSeenAt:new Date()}});
   return {user,agency,member,creator,device};
  });
 });
 await run('last operational owner cannot be disabled',async()=>{
  await db.$disconnect();
  await engine.exec("BEGIN; SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true)");
  await engine.query('UPDATE "AgencyMember" SET "deactivatedAt"=now() WHERE id=$1',[fixture.member.id]);
  await assert.rejects(engine.exec('COMMIT'),/OWNER/);
  await engine.exec('ROLLBACK');
  assert.equal((await db.agencyMember.findUnique({where:{id:fixture.member.id}})).deactivatedAt,null);
 });
 await run('login publishes a current authorization lineage and rotates refresh',async()=>{
  const auth=load('./src/services/auth-service');
  const result=await auth.issueLoginTokens({user:fixture.user,membership:fixture.member,deviceId:fixture.device.id,client:'desktop',authorizationScopeIncarnation:'current-clean-profile'});
  assert.ok(result.accessToken);assert.equal(result.authorizationSessionId,'current-clean-profile');
  const refreshed=await auth.refreshAccessToken({refreshToken:result.refreshToken,deviceId:fixture.device.id,client:'desktop',authorizationScopeIncarnation:'current-clean-profile'});
  assert.ok(refreshed.accessToken);assert.notEqual(refreshed.refreshToken,result.refreshToken);
 });
 await run('creator observation time is monotonic without global clock activation',async()=>{
  const job=await db.jobInstance.create({data:{agencyId:fixture.agency.id,creatorId:fixture.creator.id,jobKey:'fan_data_point_refresh',scope:'creator',status:'SCHEDULED'}});
  const obs=load('./src/services/fan-observation-token-service');
  const input={db,job,deviceId:fixture.device.id,leaseRevision:1,purpose:'clean-install-proof',subjects:['123']};
  const first=await obs.createFanObservationToken(input),second=await obs.createFanObservationToken(input);
  assert.ok(+second.observedAt>+first.observedAt);
  await obs.consumeFanObservationToken({...input,token:first.token});
  await assert.rejects(obs.consumeFanObservationToken({...input,token:first.token}));
 });
 await run('current work publishes, claims and acknowledges without a fleet drain',async()=>{
  const work=load('./src/services/domain-work-authority-service');
  const item=await work.publishDomainWork({db,agencyId:fixture.agency.id,creatorId:fixture.creator.id,workClass:work.WORK_CLASS.TEAM_READ_SUMMARY,objectType:'CreatorAccount',objectId:fixture.creator.id,partitionKey:fixture.creator.id});
  const claim=await work.claimDomainWorkBatch({db,agencyId:fixture.agency.id,workClass:work.WORK_CLASS.TEAM_READ_SUMMARY,objectType:'CreatorAccount',objectIds:[fixture.creator.id],limit:1});
  assert.equal(claim.items.length,1);assert.equal(claim.items[0].id,item.id);
  const ack=await work.ackDomainWorkClaim({db,item:claim.items[0],ownerToken:claim.ownerToken});assert.ok(!ack.lost);
 });
 await run('connection restart preserves readiness and active controls',async()=>{await db.$disconnect();assert.equal((await contract.readDatabaseContract(db)).ready,true);});
 report.ok=true;
 }catch(e){report.error={message:e.message,code:e.code,stack:e.stack};console.error(e.message);process.exitCode=1;}
 finally{if(db)await db.$disconnect().catch(()=>{});if(server)await server.stop();if(engine)await engine.close();clearInterval(keep);fs.writeFileSync(path.join(w,'evidence/clean-install-proof.json'),JSON.stringify(report,null,2)+'\n');}
})();
