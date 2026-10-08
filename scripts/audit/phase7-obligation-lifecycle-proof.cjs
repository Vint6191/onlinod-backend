'use strict';
// Disposable SQL + filesystem integration proof. Synthetic actors, migration
// receipts and backup; one PGlite session is NOT native concurrency evidence.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),root=path.resolve(__dirname,'../..');
const {createAdminSqlRuntime}=require('../test-support/admin-sql-runtime.cjs');
const storage=require('../../src/services/phase7-legacy-storage-service');
const {runDbTransaction,sha,manifest,COHORTS}=storage;
const handoff=require('../../src/services/phase7-obligation-handoff-service');
const authority=require('../../src/services/phase7-obligation-authority-service');
const contract=require('../../src/services/phase7-cleanup-contract');
const {drainLifecycleLegacyJobs}=require('../../src/services/phase7-lifecycle-archive-service');
const {archiveAutomationDeliveryBatch}=require('../../src/services/automation-history-service');
const runner=require('../../src/services/phase7-retirement-runner'),finalizer=require('../../src/services/phase7-retirement-finalizer');
const keys=['dual','retry','lifecycle','rebind','oldcanonical','settle','rollback','failed','canceled','source','postpurge','p14'];
const cleanupId=k=>k==='p14'?'p14_sfs_cleanup_'+crypto.createHash('md5').update('job-'+k).digest('hex').slice(0,20):'cleanup-'+k;
async function seed({name,engine}){
 if(name!=='20260930180000_phase7_legacy_storage_expand_v1')return;
 await engine.exec(`BEGIN;
 UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE';
 SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true);
 INSERT INTO "User"(id,email,"passwordHash","updatedAt") VALUES('u135','proof135@example.test','synthetic',now());
 INSERT INTO "Agency"(id,name,"updatedAt") VALUES('a135','Synthetic',now());
 INSERT INTO "AgencyMember"(id,"agencyId","userId",role,"roleKey","assignedCreators","updatedAt") VALUES('m135','a135','u135','OWNER','owner','"all"',now());
 COMMIT;`);
 for(const key of keys){
  await engine.query(`INSERT INTO "CreatorAccount"(id,"agencyId","displayName","remoteId","updatedAt") VALUES($1,'a135',$1,$2,now())`,['c-'+key,'remote-'+key]);
  await engine.query(`INSERT INTO "AutomationJob"(id,"agencyId","creatorId",type,action,status,"runAfter",payload,error,"updatedAt")
    VALUES($1,'a135',$2,'sfs_hunter','sfs_unfollow_due','canceled',now(),$3::jsonb,'P14_LEGACY_SFS_DISABLED',now())`,['job-'+key,'c-'+key,JSON.stringify({targetUserId:'target-'+key})]);
  await engine.query(`INSERT INTO "SfsTargetCandidate"(id,"agencyId","creatorId","targetUserId",username,generation,state,phase,"safetyUnfollowDeliveryId",metadata,"updatedAt")
    VALUES($1,'a135',$2,$3,$3,1,'UNFOLLOW_DUE','UNFOLLOW',$4,'{"legacyMigration":true}',now())`,['candidate-'+key,'c-'+key,'target-'+key,key==='lifecycle'?null:cleanupId(key)]);
  if(key!=='p14')await engine.query(`INSERT INTO "AutomationDelivery"(id,"agencyId","creatorId","moduleKey","actionType","targetId","fanId",generation,payload,status,"writeCommitAt",result,"finishedAt","updatedAt")
    VALUES($1,'a135',$2,'sfs','SFS_FOLLOW_TARGET',$3,$3,1,$4::jsonb,'COMPLETED',now(),'{"code":"followed"}',now(),now())`,['follow-'+key,'c-'+key,'target-'+key,JSON.stringify({candidateId:'candidate-'+key})]);
  if(key!=='lifecycle')await engine.query(`INSERT INTO "AutomationDelivery"(id,"agencyId","creatorId","moduleKey","actionType","targetId","fanId",generation,payload,status,"idempotencyKey","updatedAt")
    VALUES($1,'a135',$2,'sfs','SFS_UNFOLLOW_TARGET',$3,$3,1,$4::jsonb,'QUEUED',$5,now())`,[cleanupId(key),'c-'+key,'target-'+key,JSON.stringify({candidateId:'candidate-'+key,safetyCleanup:true,legacyMigration:true,sourceJobId:'job-'+key}),`sfs_unfollow:c-${key}:target-${key}:1`]);
 }
}
async function main(){
 if(!process.env.PHASE7_PROOF_RUNTIME)throw Error('PHASE7_PROOF_RUNTIME required');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'onlinod135-lifecycle-')),cases=[];
 const check=async(name,fn)=>{await fn();cases.push({name,status:'PASS'});console.log(JSON.stringify(cases.at(-1)));};
 let f,error,cleanupError;const keep=setInterval(()=>{},1000);
 try{
  f=await createAdminSqlRuntime({runtimePath:process.env.PHASE7_PROOF_RUNTIME,beforeMigration:seed});const {db}=f;
  await db.$executeRawUnsafe(`CREATE TABLE "_prisma_migrations"(migration_name text,checksum text,started_at timestamptz,finished_at timestamptz,rolled_back_at timestamptz)`);
  const p14='20260715153000_p14_sfs_automation',checksum=sha(await fs.readFile(path.join(root,'prisma/migrations',p14,'migration.sql')));
  await db.$executeRawUnsafe(`INSERT INTO "_prisma_migrations" VALUES($1,$2,now(),now(),null)`,p14,checksum);
  const source=async k=>{const [r]=await db.$queryRawUnsafe(`SELECT to_jsonb(j)::text AS body,encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex') AS hash FROM "AutomationJob" j WHERE id=$1`,'job-'+k);return{db,job:JSON.parse(r.body),sourceHash:r.hash};};
  const retire=k=>runDbTransaction(db,tx=>authority.assertSfsRetirable({db:tx,agencyId:'a135',...(k?{creatorId:'c-'+k}:{})}));
  const settle=async(k,code='unfollowed',finalize=true)=>runDbTransaction(db,async tx=>{
   await authority.lockCleanupMutation(tx,await tx.automationDelivery.findUnique({where:{id:cleanupId(k)}}));
   const d=await tx.automationDelivery.update({where:{id:cleanupId(k)},data:{status:'COMPLETED',result:{code},writeCommitAt:code==='already_unfollowed'?null:new Date(),finishedAt:new Date()}});
   if(finalize)await require('../../src/services/sfs-service').finalizeSfsSuccess({db:tx,delivery:d,outcomeCode:code});return d;
  });
  await check('291 retained migrations, storage fences and online index definitions agree',async()=>{
   assert.equal(f.migrations.length,291);await require('../database/phase7-legacy-storage-indexes').ensureIndexes(db,{create:true});
   assert.equal((await storage.storageState(db)).phase,'BRIDGE');
  });
  await check('creator and agency retirement refuse unresolved effects before credentials can be revoked',async()=>{
   await assert.rejects(retire('dual'),{code:'SFS_CLEANUP_BLOCKS_RETIREMENT'});await assert.rejects(retire(),{code:'SFS_CLEANUP_BLOCKS_RETIREMENT'});
  });
  await check('cleanup-first and source-first handoff converge on one immutable execution attestation',async()=>{
   const a=await handoff.handoffExistingCleanup({db,deliveryId:cleanupId('dual')}),b=await handoff.handoffLegacyJob(await source('dual'));
   assert.equal(a.proofId,b.id);assert.equal(b.sourceTable,'AutomationJob');
   const c=await handoff.handoffLegacyJob(await source('retry')),d=await handoff.handoffExistingCleanup({db,deliveryId:cleanupId('retry')});assert.equal(c.id,d.proofId);
  });
  await check('source hash is enforced and caller-supplied payload cannot change the frozen obligation',async()=>{
   const s=await source('source');await assert.rejects(handoff.handoffLegacyJob({...s,sourceHash:'0'.repeat(64)}),{code:'PHASE7_LEGACY_SOURCE_CHANGED'});
   const p=await handoff.handoffLegacyJob({...s,job:{...s.job,payload:{targetUserId:'foreign-target'}}});assert.equal(p.targetId,'target-source');
  });
  await check('handoff retry survives actual FOLLOW history retention',async()=>{
   const row=await db.automationDelivery.findUnique({where:{id:'follow-retry'}});
   const result=await runDbTransaction(db,tx=>archiveAutomationDeliveryBatch({tx,rows:[row],olderThan:new Date(Date.now()+10000),strict:true}));assert.equal(result.archived,1);
   assert.equal((await handoff.handoffLegacyJob(await source('retry'))).deliveryId,cleanupId('retry'));
  });
  await check('duplicate handoff and SQL attestation recheck changed ownership',async()=>{
   await handoff.handoffLegacyJob(await source('rebind'));
   await db.sfsTargetCandidate.update({where:{id:'candidate-rebind'},data:{metadata:{legacyMigration:true,followEffectOwnership:'OWNED',followEffectDeliveryId:'newer-follow'}}});
   assert.equal((await db.$queryRawUnsafe('SELECT phase7_cleanup_attested($1) AS ok',cleanupId('rebind')))[0].ok,false);
   await assert.rejects(handoff.handoffExistingCleanup({db,deliveryId:cleanupId('rebind')}),{code:'PHASE7_CLEANUP_ATTESTATION_STALE'});
   await db.sfsTargetCandidate.update({where:{id:'candidate-rebind'},data:{metadata:{legacyMigration:true}}});
  });
  await check('already installed delivery-based proofs retain identity and gain a distinct frozen-source receipt',async()=>{
   const d=await db.automationDelivery.findUnique({where:{id:cleanupId('oldcanonical')}});
   const p=await runDbTransaction(db,async tx=>{
    const p=await storage.putProof(tx,{cohortId:'automation_job',sourceTable:'AutomationDelivery',sourceId:d.id,sourceHash:sha(JSON.stringify([d.id,d.agencyId,d.creatorId,d.targetId,d.generation,d.payload])),kind:'SFS_CLEANUP',agencyId:d.agencyId,creatorId:d.creatorId,providerSubject:'remote-oldcanonical',targetId:d.targetId,generation:1,deliveryId:d.id,evidence:{basis:'CURRENT_FOLLOW_RECEIPT',candidateId:'candidate-oldcanonical',followDeliveryId:'follow-oldcanonical'}});
    await tx.automationDelivery.update({where:{id:d.id},data:{legacyCleanupProofId:p.id}});return p;
   });
   const linked=await handoff.handoffLegacyJob(await source('oldcanonical'));assert.equal(linked.id,p.id);assert.ok(linked.sourceReceiptId);
   assert.equal((await db.phase7RetirementProof.findUnique({where:{id:linked.sourceReceiptId}})).deliveryId,null);
   assert.equal(await db.phase7RetirementProof.count({where:{deliveryId:d.id,kind:'SFS_CLEANUP'}}),1);
  });
  await check('P14 compensation accepts only the canonical migration checksum and exact historical tuple',async()=>{
   await db.$executeRawUnsafe('UPDATE "_prisma_migrations" SET checksum=$1','0'.repeat(64));
   await assert.rejects(handoff.handoffLegacyJob(await source('p14')),{code:'PHASE7_SFS_FOLLOW_AUTHORITY_UNPROVEN'});
   await db.$executeRawUnsafe('UPDATE "_prisma_migrations" SET checksum=$1',checksum);
   assert.equal((await handoff.handoffLegacyJob(await source('p14'))).evidence.basis,'P14_ACCEPTED_COMPENSATION:'+checksum);
  });
  await check('destructive lifecycle commits the new handoff and yields without deleting its source',async()=>{
   const first=await runDbTransaction(db,tx=>drainLifecycleLegacyJobs({tx,agencyId:'a135',creatorId:'c-lifecycle'}));
   assert.equal(first.waiting,true);assert.equal(first.deleted,0);assert.equal(await db.automationDelivery.count({where:{creatorId:'c-lifecycle',actionType:'SFS_UNFOLLOW_TARGET'}}),1);
   const second=await runDbTransaction(db,tx=>drainLifecycleLegacyJobs({tx,agencyId:'a135',creatorId:'c-lifecycle'}));assert.equal(second.deliveryId,first.deliveryId);
  });
  await check('FAILED and CANCELED queue statuses do not settle an external cleanup obligation',async()=>{
   for(const k of ['failed','canceled']){
    await handoff.handoffLegacyJob(await source(k));await db.automationDelivery.update({where:{id:cleanupId(k)},data:{status:k.toUpperCase(),finishedAt:new Date()}});
    await assert.rejects(retire(k),{code:'SFS_CLEANUP_BLOCKS_RETIREMENT'});
    const r=await runDbTransaction(db,tx=>drainLifecycleLegacyJobs({tx,agencyId:'a135',creatorId:'c-'+k}));assert.equal(r.waiting,true);
    const row=await db.automationDelivery.findUnique({where:{id:cleanupId(k)}});
    const kept=await runDbTransaction(db,tx=>archiveAutomationDeliveryBatch({tx,rows:[row],olderThan:new Date(Date.now()+10000)}));assert.equal(kept.archived,0);
   }
  });
  await check('real SFS success atomically writes immutable settlement before completing the candidate',async()=>{
   await handoff.handoffLegacyJob(await source('settle'));const d=await settle('settle');
   const p=await runDbTransaction(db,tx=>authority.settlementForDelivery(tx,d));assert.ok(p);
   const c=await db.sfsTargetCandidate.findUnique({where:{id:'candidate-settle'}});assert.equal(c.state,'COMPLETED');assert.ok(c.completedAt);
  });
  await check('cleanup retention and exact frozen-source recovery work after both execution receipts disappear',async()=>{
   const rows=await db.automationDelivery.findMany({where:{creatorId:'c-settle'}});
   assert.equal((await runDbTransaction(db,tx=>archiveAutomationDeliveryBatch({tx,rows,olderThan:new Date(Date.now()+10000),strict:true}))).archived,2);
   assert.equal((await handoff.handoffLegacyJob(await source('settle'))).kind,'SETTLED');
   const r=await runDbTransaction(db,tx=>drainLifecycleLegacyJobs({tx,agencyId:'a135',creatorId:'c-settle'}));assert.equal(r.deleted,1);await retire('settle');
  });
  await check('delivery-based compatibility proof also survives settlement and retention',async()=>{
   const file=path.join(root,'src/services/automation-action-delivery-service.js'),m={exports:{}},load=require('node:module').createRequire(file);
   require('node:vm').runInNewContext(await fs.readFile(file,'utf8')+'\nmodule.exports.proofTransition=applySfsValidationTransition;',
    {module:m,exports:m.exports,require:id=>id==='../prisma'?db:load(id),__dirname:path.dirname(file),process,console,Buffer,Date,setTimeout,clearTimeout,setInterval,clearInterval},{filename:file});
   const before=await db.automationDelivery.findUnique({where:{id:cleanupId('oldcanonical')}});
   // A caller hint is insufficient: only the state read under SFS authority
   // can prove already_unfollowed. First exercise the rejected stale hint.
   assert.equal(await m.exports.proofTransition(before,{terminal:true,code:'already_unfollowed'}),false);
   assert.equal((await db.automationDelivery.findUnique({where:{id:before.id}})).status,'QUEUED');
   await db.sfsTargetCandidate.update({where:{id:'candidate-oldcanonical'},data:{state:'COMPLETED',completedAt:new Date()}});
   assert.equal(await m.exports.proofTransition(before,{terminal:true,code:'already_unfollowed'}),true);
   const finished=await db.automationDelivery.findUnique({where:{id:before.id}});assert.equal(finished.result.code,'already_unfollowed');assert.equal(finished.writeCommitAt,null);
   const rows=await db.automationDelivery.findMany({where:{creatorId:'c-oldcanonical'}});
   await runDbTransaction(db,tx=>archiveAutomationDeliveryBatch({tx,rows,olderThan:new Date(Date.now()+10000),strict:true}));
   assert.equal((await handoff.handoffLegacyJob(await source('oldcanonical'))).kind,'SETTLED');
  });
  await check('retention failure rolls back settlement, deletion and monthly counters together',async()=>{
   await handoff.handoffLegacyJob(await source('rollback'));const d=await settle('rollback','unfollowed',false);
   let checks=0;await assert.rejects(runDbTransaction(db,tx=>archiveAutomationDeliveryBatch({tx,rows:[d],olderThan:new Date(Date.now()+10000),strict:true,
    commitGuard:async()=>{if(++checks===2)throw Error('INJECTED_COMMIT_FAILURE');}})),/INJECTED_COMMIT_FAILURE/);
   assert.ok(await db.automationDelivery.findUnique({where:{id:d.id}}));assert.equal(await db.phase7RetirementProof.count({where:{sourceTable:'AutomationDelivery',sourceId:d.id,kind:'SETTLED'}}),0);
   assert.equal(await db.automationMonthlyAggregate.count({where:{creatorId:'c-rollback'}}),0);
   await runDbTransaction(db,tx=>archiveAutomationDeliveryBatch({tx,rows:[d],olderThan:new Date(Date.now()+10000),strict:true}));
   assert.equal((await handoff.handoffLegacyJob(await source('rollback'))).kind,'SETTLED');
  });
  await check('a completed-source duplicate cannot conceal a changed current delivery status',async()=>{
   await settle('dual');assert.equal((await handoff.handoffExistingCleanup({db,deliveryId:cleanupId('dual')})).kind,'SETTLED');
   await db.automationDelivery.update({where:{id:cleanupId('dual')},data:{status:'FAILED'}});
   await assert.rejects(handoff.handoffExistingCleanup({db,deliveryId:cleanupId('dual')}),{code:'PHASE7_SFS_SETTLEMENT_CONFLICT'});
   await db.automationDelivery.update({where:{id:cleanupId('dual')},data:{status:'COMPLETED'}});
  });
  await check('all live legacy cleanup identities agree between JS and SQL',async()=>{
   await handoff.handoffLegacyJob(await source('postpurge'));
   const rows=await db.automationDelivery.findMany({where:{moduleKey:'sfs',actionType:'SFS_UNFOLLOW_TARGET'}});
   for(const d of rows){const c=await db.sfsTargetCandidate.findUnique({where:{id:d.payload.candidateId}}),p=await db.phase7RetirementProof.findUnique({where:{id:d.legacyCleanupProofId}}),owner=await db.creatorAccount.findUnique({where:{id:d.creatorId}});
    assert.equal(contract.matchesSfsAttestation({proof:p,delivery:d,candidate:c,providerSubject:owner.remoteId}),true);
    assert.equal((await db.$queryRawUnsafe('SELECT phase7_cleanup_attested($1) AS ok',d.id))[0].ok,true);
   }
  });
  const exported=path.join(temp,'export'),restored=path.join(temp,'restore');await fs.mkdir(exported);await fs.mkdir(restored);
  await check('every destructive cohort completes bounded export and independent restore verification',async()=>{
   for(const cohortId of COHORTS){let done=false;for(let n=0;n<40&&!done;n++)done=(await runner.enumerateCohort({db,cohortId,budget:1})).complete;assert.equal(done,true);}
   for(let n=0;n<100;n++){const partition=await runner.claimPartition(db);if(!partition)break;await runner.processPartition({db,partition,directory:exported,limit:3});}
   assert.equal(await db.phase7RetirementPartition.count({where:{state:{not:'EXPORTED'}}}),0);await fs.cp(exported,restored,{recursive:true});
   for(let n=0;n<100;n++){const p=await db.phase7RetirementPartition.findFirst({where:{state:'EXPORTED'}});if(!p)break;await runner.verifyPartitionPage({db,partitionId:p.id,directory:restored});}
   assert.equal(await db.phase7RetirementPartition.count({where:{state:{not:'VERIFIED'}}}),0);
  });
  await db.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await db.$executeRawUnsafe('CREATE ROLE lifecycle_runtime NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');await db.$executeRawUnsafe('CREATE ROLE lifecycle_bypass NOLOGIN BYPASSRLS');
  const desktop=path.join(temp,'desktop');await fs.mkdir(desktop);await fs.writeFile(path.join(desktop,'app.js'),'// Synthetic counterpart\n');
  const sourceTools=require('../database/phase7-release-source'),releaseFile=path.join(temp,'release.json');
  await sourceTools.writeRelease({backendRoot:root,desktopRoot:desktop,baseBackendRoot:root,baseDesktopRoot:desktop,packageId:'SYNTHETIC135_LIFECYCLE',output:releaseFile});
  const release=await sourceTools.readRelease(root,{file:releaseFile}),now=Date.now(),iso=n=>new Date(n).toISOString();
  const operatorEvidence={version:1,generation:manifest.generation,...release,operator:'ISOLATED SYNTHETIC PROOF',noOldBinariesRemain:true,rollbackMode:'restore_database_and_matching_sources',rollbackWindow:{openedAt:iso(now-10000),closedAt:iso(now)},stoppedBinaries:[['backend',release.baseBackendHash],['desktop',release.baseDesktopHash]].map(([component,sourceHash])=>({component,sourceHash,scope:'synthetic',stoppedAt:iso(now-1)})),archive:{durability:'persistent_backup',exportRoot:sha(exported),restoreRoot:sha(restored),backupId:'SYNTHETIC_NOT_PRODUCTION',restoredAt:iso(now),retentionUntil:iso(now+3600000)}};
  await check('all six cohorts prepare under current source, archive and role authority',async()=>{
   assert.equal((await finalizer.prepareContract({db,release,closeRollback:true,operatorEvidence,runtimeRoles:['lifecycle_runtime']})).ready,true);
   assert.equal((await finalizer.checkContractReady(db,{root,releaseFile})).ready,true);
  });
  const contractSql=await fs.readFile(path.join(root,'prisma/migrations',f.excludedContract,'migration.sql'),'utf8');
  // PGlite has one physical session. Fully detach the wire-protocol endpoint
  // before direct multi-statement SQL, then discard session state and restart
  // it. A Prisma disconnect alone can leave a pending protocol detach racing
  // the direct engine call and reject the next connection nondeterministically.
  const directContract=async work=>{
   await db.$disconnect();await f.server.stop();
   try{await f.engine.exec('DISCARD ALL');return await work();}
   finally{await f.engine.exec('ROLLBACK');await f.engine.exec('DISCARD ALL');await f.server.start();}
  };
  const refusedContract=async pattern=>{await directContract(()=>assert.rejects(f.engine.exec(contractSql),pattern));assert.equal((await storage.storageState(db)).phase,'BRIDGE');assert.equal(await db.phase7RetirementCohort.count({where:{state:'PURGE_READY'}}),6);};
  await check('archive tampering after preparation rolls back all nine DROP statements in the unchanged contract',async()=>{
   const p=await db.phase7RetirementPartition.findFirst({where:{sequence:{gt:0}}});await db.phase7RetirementPartition.update({where:{id:p.id},data:{rows:p.rows+1n}});
   await refusedContract(/PHASE7_ARCHIVE_ADMISSION_INCONSISTENT/);await db.phase7RetirementPartition.update({where:{id:p.id},data:{rows:p.rows}});
  });
  await check('new BYPASSRLS membership after preparation aborts the actual destructive transaction',async()=>{
   await db.$executeRawUnsafe('GRANT lifecycle_bypass TO lifecycle_runtime');await refusedContract(/PHASE7_RUNTIME_ROLE_UNSAFE/);await db.$executeRawUnsafe('REVOKE lifecycle_bypass FROM lifecycle_runtime');
  });
  await check('ownership rebinding after preparation aborts the actual destructive transaction',async()=>{
   await db.sfsTargetCandidate.update({where:{id:'candidate-rebind'},data:{metadata:{legacyMigration:true,followEffectOwnership:'OWNED',followEffectDeliveryId:'newer-follow'}}});
   await refusedContract(/PHASE7_CLEANUP_HANDOFF_INCOMPLETE/);await db.sfsTargetCandidate.update({where:{id:'candidate-rebind'},data:{metadata:{legacyMigration:true}}});
  });
  await check('valid unchanged contract removes exactly the nine compatibility tables and retains all obligations',async()=>{
   const before=await db.phase7RetirementProof.count();await directContract(()=>f.engine.exec(contractSql));
   const state=await storage.storageState(db);assert.equal(state.phase,'PURGED');assert.equal(state.targetReady,true);assert.equal(await db.phase7RetirementProof.count(),before);
   assert.equal(await db.creatorAccount.count({where:{agencyId:'a135'}}),keys.length);
  });
  await check('cleanup retry, settlement and retention remain operational after source tables are gone',async()=>{
   const p=await handoff.handoffExistingCleanup({db,deliveryId:cleanupId('postpurge')});assert.equal(p.kind,'SFS_CLEANUP');await settle('postpurge');
   const rows=await db.automationDelivery.findMany({where:{creatorId:'c-postpurge'}});await runDbTransaction(db,tx=>archiveAutomationDeliveryBatch({tx,rows,olderThan:new Date(Date.now()+10000),strict:true}));
   await retire('postpurge');await db.phase7RetirementCohort.update({where:{id:'automation_job'},data:{revision:{increment:1}}});
  });
 }catch(e){error=e;throw e;}finally{
  try{if(f)await f.close();}catch(e){cleanupError=e;}try{await fs.rm(temp,{recursive:true,force:true});}catch(e){cleanupError ||= e;}clearInterval(keep);
  if(process.env.PHASE7_PROOF_OUTPUT)await fs.writeFile(process.env.PHASE7_PROOF_OUTPUT,JSON.stringify({runtime:process.version,engine:'PGlite 0.5.8 + real Prisma 5.22, one physical session',migrations:f?.migrations.length,nativeConcurrency:false,productionAccessed:false,syntheticBackup:true,cases,ok:!error&&!cleanupError,error:error||cleanupError?{message:(error||cleanupError).message,code:(error||cleanupError).code}:null},null,2)+'\n');
  if(cleanupError&&!error)throw cleanupError;
 }
 console.log('PHASE7_OBLIGATION_LIFECYCLE_SQL_PROOF_PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
