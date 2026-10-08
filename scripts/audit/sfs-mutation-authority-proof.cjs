'use strict';
// Actual Prisma + product services on a disposable retained-schema database.
// Single-session PGlite does NOT prove native PostgreSQL concurrency or scale.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
async function main(){
 const cases=[],baselineEvidence=[];let fixture,error;const keep=setInterval(()=>{},1000);
 try{
  fixture=await require('../test-support/admin-sql-runtime.cjs').createAdminSqlRuntime({runtimePath:process.env.SFS_PROOF_RUNTIME});
  const {db}=fixture;require.cache[require.resolve('../../src/prisma')]={exports:db};
  const {runDbTransaction}=require('../../src/services/db-transaction-service');
  const authority=require('../../src/services/sfs-mutation-authority-service'),sfs=require('../../src/services/sfs-service');
  const actions=require('../../src/services/automation-action-delivery-service'),control=require('../../src/services/automation-control-service');
  const jobs=require('../../src/services/job-lease-service');
  const file=path.join(fixture.root,'src/services/automation-action-delivery-service.js'),m={exports:{}},load=createRequire(file);
  vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nmodule.exports.transition=applySfsValidationTransition;',
   {module:m,exports:m.exports,require:load,__dirname:path.dirname(file),process,console,Buffer,Date,setTimeout,clearTimeout,setInterval,clearInterval},{filename:file});
  await db.$executeRawUnsafe(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE'`);
  const base=await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)",'phase2_team_control_plane_v2_durable_access');
   const user=await tx.user.create({data:{email:'sfs-136@example.test',passwordHash:'synthetic'}});
   const agency=await tx.agency.create({data:{name:'SFS136 proof',trialEndsAt:new Date(Date.now()+86400000)}});
   const member=await tx.agencyMember.create({data:{agencyId:agency.id,userId:user.id,role:'OWNER',roleKey:'owner',assignedCreators:'all'}});
   const device=await tx.workerDevice.create({data:{agencyId:agency.id,userId:user.id}});return{user,agency,member,device};
  });
  const token='synthetic-sfs136-token',hash=crypto.createHash('sha256').update(token).digest('hex');let serial=0;
  async function seed(){
   const n=++serial,creator=await db.creatorAccount.create({data:{agencyId:base.agency.id,displayName:'Creator '+n,status:'READY',remoteId:'provider-'+n}});
   const scope={agencyId:base.agency.id,creatorId:creator.id};
   await control.setAutomationControl({...scope,db,userId:base.user.id,scope:'module',moduleKey:'sfs',enabled:true,settings:{huntingEnabled:true}});
   const candidate=await db.sfsTargetCandidate.create({data:{...scope,targetUserId:'target-'+n,username:'target'+n,generation:2,state:'ACTING',phase:'ACTIONS'}});
   const delivery=await runDbTransaction(db,async tx=>{
    await require('../../src/services/phase7-legacy-storage-service').authorizeSfsGeneration(tx);
    return tx.automationDelivery.create({data:{...scope,originKind:'AUTOMATION',moduleKey:'sfs',actionType:'SFS_COMMENT_POST',targetId:'post-'+n,fanId:candidate.targetUserId,
     generation:2,payload:{candidateId:candidate.id},idempotencyKey:'sfs136:'+n,status:'CLAIMED',notBefore:new Date(0),claimedByDeviceId:base.device.id,
     leaseMemberId:base.member.id,leaseAccessEpoch:base.member.accessEpoch,leaseTokenHash:hash,leaseRevision:1,claimUntil:new Date(Date.now()+120000),attempts:1}});
   });
   return {scope,candidate,delivery,input:{deliveryId:delivery.id,userId:base.user.id,deviceId:base.device.id,leaseToken:token,leaseRevision:1}};
  }
  const check=async(name,fn)=>{await fn();cases.push({name,status:'PASS'});console.log(JSON.stringify(cases.at(-1)));};
  const candidateRow=f=>db.sfsTargetCandidate.findUnique({where:{id:f.candidate.id}});
  if(process.env.SFS_BASELINE_FUNCTIONS){
   // Compare exact uploaded135 function bodies on the same current SQL fixture.
   // Dependencies remain current; this is not a complete135 deployment replay.
   function original(name,extra=''){
    const source=fs.readFileSync(path.join(process.env.SFS_BASELINE_FUNCTIONS,name),'utf8');
    const filename=path.join(fixture.root,'src/services',name),module={exports:{}},require=createRequire(filename);
    vm.runInNewContext(source+extra,{module,exports:module.exports,require,__dirname:path.dirname(filename),process,console,Buffer,Date,setTimeout,clearTimeout,setInterval,clearInterval},{filename});
    return{service:module.exports,sha256:crypto.createHash('sha256').update(source).digest('hex')};
   }
   const oldSfs=original('sfs-service.js'),oldActions=original('automation-action-delivery-service.js','\nmodule.exports.transition=applySfsValidationTransition;');
   let f=await seed();await db.sfsTargetCandidate.update({where:{id:f.candidate.id},data:{state:'COMPLETED',completedAt:new Date()}});
   await runDbTransaction(db,tx=>oldSfs.service.finalizeSfsFailure({db:tx,delivery:{...f.delivery,generation:1},failureCode:'old-generation',retryable:false}));
   assert.equal((await candidateRow(f)).state,'FAILED');
   baselineEvidence.push({fault:'late old-generation failure overwrites a completed cycle',observedState:'FAILED',sourceSha256:oldSfs.sha256});
   const a=await seed(),b=await seed();
   await runDbTransaction(db,tx=>oldSfs.service.finalizeSfsTerminal({db:tx,delivery:{...a.delivery,payload:{candidateId:b.candidate.id}},status:'CANCELED',failureCode:'foreign'}));
   assert.equal((await candidateRow(b)).state,'CANCELED');
   baselineEvidence.push({fault:'foreign candidate id changes a different creator workflow',observedState:'CANCELED',sourceSha256:oldSfs.sha256});
   f=await seed();await db.sfsTargetCandidate.update({where:{id:f.candidate.id},data:{blocked:true}});
   assert.equal(await oldActions.service.transition(f.delivery,{ok:false,terminal:true,code:'already_unfollowed'}),true);
   assert.equal((await db.automationDelivery.findUnique({where:{id:f.delivery.id}})).status,'COMPLETED');
   baselineEvidence.push({fault:'stale validation hint creates an unjustified completed receipt',observedState:'COMPLETED',sourceSha256:oldActions.sha256});
   console.log(JSON.stringify({baselineEvidence}));
  }
  await check('500 retention scope keys use two real SQL calls with the existing fence namespaces',async()=>{
   const scopes=Array.from({length:500},(_,i)=>({agencyId:'batch-agency-'+(i%4),creatorId:'batch-creator-'+String(499-i).padStart(3,'0')}));
   const start=fixture.queries.length;
   await runDbTransaction(db,tx=>require('../../src/services/automation-write-commit-fence-service').lockAutomationWriteCommitFences({db:tx,scopes}));
   const calls=fixture.queries.slice(start).filter(x=>x.query.includes('pg_advisory_xact_lock')&&x.query.includes('jsonb_to_recordset'));
   assert.equal(calls.length,2);
  });
  await check('creator control locks its creator before the fence and foreign-key upsert',async()=>{
   const start=fixture.queries.length;await seed();const q=fixture.queries.slice(start).map(x=>x.query);
   const creator=q.findIndex(x=>/FROM "CreatorAccount".*FOR SHARE/.test(x));
   const fence=q.findIndex(x=>x.includes('pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))'));
   const upsert=q.findIndex(x=>/INSERT INTO .*AutomationControlState/.test(x));
   assert(creator>=0&&creator<fence&&fence<upsert,JSON.stringify({creator,fence,upsert}));
  });
  await check('current SFS start, write permit and completion share real transaction authority',async()=>{
   const f=await seed(),start=fixture.queries.length;
   await actions.startActionDelivery(f.input);await actions.prepareWriteActionDelivery(f.input);
   await actions.completeActionDelivery({...f.input,outcomeCode:'commented',result:{code:'commented'}});
   assert.equal((await db.automationDelivery.findUnique({where:{id:f.delivery.id}})).status,'COMPLETED');
   assert.equal((await candidateRow(f)).latestStatus,'COMPLETED');
   const q=fixture.queries.slice(start).map(x=>x.query);
   const agency=q.findIndex(x=>/FROM "Agency".*FOR SHARE/.test(x)),creator=q.findIndex(x=>/FROM "CreatorAccount".*FOR SHARE/.test(x));
   const fence=q.findIndex(x=>x.includes('pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))'));
   const candidate=q.findIndex(x=>x.includes('FOR UPDATE OF k'));
   assert(agency>=0&&agency<creator&&creator<fence&&fence<candidate,JSON.stringify({agency,creator,fence,candidate}));
  });
  await check('module disable revokes the live lease and prevents both SFS producers',async()=>{
   const f=await seed();await control.setAutomationControl({...f.scope,db,userId:base.user.id,scope:'module',moduleKey:'sfs',enabled:false});
   await assert.rejects(actions.startActionDelivery(f.input),{code:'DELIVERY_NOT_CLAIMED'});
   for(const method of ['planSfsTargets','scheduleSfsDiscovery'])await assert.rejects(sfs[method]({...f.scope,db}),{code:'module_disabled'});
   assert.equal((await db.automationDelivery.findUnique({where:{id:f.delivery.id}})).status,'PAUSED');
   assert.equal(await db.jobInstance.count({where:{creatorId:f.scope.creatorId}}),0);
  });
  await check('completed cycle rejects late scan completion and failure through the real job API',async()=>{
   const f=await seed();
   async function claimedJob(){return runDbTransaction(db,tx=>tx.jobInstance.create({data:{...f.scope,jobKey:'sfs_target_scan',scope:'creator',status:'CLAIMED',
    params:{candidateId:f.candidate.id,candidateGeneration:2},claimedByDeviceId:base.device.id,leaseMemberId:base.member.id,leaseAccessEpoch:base.member.accessEpoch,
    leaseTokenHash:hash,leaseRevision:1,leaseUntil:new Date(Date.now()+120000)}}));}
   for(const method of ['completeJob','failJob']){
    const job=await claimedJob();await db.sfsTargetCandidate.update({where:{id:f.candidate.id},data:{state:'COMPLETED',completedAt:new Date(),scanJobId:job.id}});
    const before=await candidateRow(f),input={userId:base.user.id,deviceId:base.device.id,jobId:job.id,leaseToken:token,leaseRevision:1,result:{posts:[]},error:'late failure',retryable:false};
    await jobs[method](input);assert.deepEqual(await candidateRow(f),before);
   }
   assert.equal(await db.automationDelivery.count({where:{creatorId:f.scope.creatorId}}),1);
  });
  await check('late delivery projections cannot reopen a completed cycle',async()=>{
   const f=await seed();await db.sfsTargetCandidate.update({where:{id:f.candidate.id},data:{state:'COMPLETED',completedAt:new Date()}});
   const before=await candidateRow(f);
   await runDbTransaction(db,async tx=>{
    await authority.lockSfsDeliveryMutation(tx,f.delivery);
    await sfs.finalizeSfsSuccess({db:tx,delivery:f.delivery,outcomeCode:'commented'});
    await sfs.finalizeSfsFailure({db:tx,delivery:f.delivery,failureCode:'late',retryable:false});
    await sfs.finalizeSfsTerminal({db:tx,delivery:f.delivery,status:'CANCELED',failureCode:'late'});
    await sfs.prepareSfsRetry({db:tx,delivery:f.delivery});
   });
   assert.deepEqual(await candidateRow(f),before);
   assert.equal((await sfs.validateSfsDelivery({db,delivery:f.delivery,control:{effective:{sfsEnabled:true}}})).code,'cycle_completed');
  });
  await check('a previous generation cannot project failure or authorize cleanup of the current cycle',async()=>{
   const f=await seed(),old={...f.delivery,generation:1},before=await candidateRow(f);
   await runDbTransaction(db,async tx=>{
    await authority.lockSfsDeliveryMutation(tx,old);
    await sfs.finalizeSfsSuccess({db:tx,delivery:old,outcomeCode:'commented'});
    await sfs.finalizeSfsFailure({db:tx,delivery:old,failureCode:'old',retryable:true});
    await sfs.finalizeSfsTerminal({db:tx,delivery:old,status:'SKIPPED',failureCode:'old'});
    await sfs.prepareSfsRetry({db:tx,delivery:old});
   });
   assert.deepEqual(await candidateRow(f),before);
   const cleanup={...old,actionType:'SFS_UNFOLLOW_TARGET',targetId:f.candidate.targetUserId,payload:{...old.payload,safetyCleanup:true}};
   assert.equal((await sfs.validateSfsDelivery({db,delivery:cleanup,control:{effective:{sfsEnabled:true}}})).code,'stale_candidate');
  });
  await check('foreign candidate references terminate only their own invalid queue row',async()=>{
   const a=await seed(),b=await seed(),before=await candidateRow(b);
   const bad=await db.automationDelivery.update({where:{id:a.delivery.id},data:{payload:{candidateId:b.candidate.id}}});
   assert.equal(await m.exports.transition(bad,{ok:false,terminal:true,code:'already_unfollowed'}),true);
   const after=await db.automationDelivery.findUnique({where:{id:bad.id}});
   assert.equal(after.status,'SKIPPED');assert.equal(after.failureCode,'invalid_target');assert.deepEqual(await candidateRow(b),before);
  });
  await check('malformed current SFS rows can reach invalid_target without poisoning claim admission',async()=>{
   const f=await seed(),bad=await db.automationDelivery.update({where:{id:f.delivery.id},data:{payload:{}}});
   assert.equal(await m.exports.transition(bad,{ok:false,terminal:true,code:'invalid_target'}),true);
   assert.equal((await db.automationDelivery.findUnique({where:{id:bad.id}})).status,'SKIPPED');
  });
  await check('stale validation hints are recomputed and cannot mint a completed receipt',async()=>{
   const f=await seed();assert.equal(await m.exports.transition(f.delivery,{ok:false,terminal:true,code:'blocked'}),false);
   assert.equal((await db.automationDelivery.findUnique({where:{id:f.delivery.id}})).status,'CLAIMED');
   await db.sfsTargetCandidate.update({where:{id:f.candidate.id},data:{blocked:true}});
   assert.equal(await m.exports.transition(f.delivery,{ok:false,terminal:true,code:'already_unfollowed'}),true);
   const saved=await db.automationDelivery.findUnique({where:{id:f.delivery.id}});assert.equal(saved.status,'SKIPPED');assert.equal(saved.failureCode,'blocked');
  });
  await check('delivery and candidate mutation roll back together on projection failure',async()=>{
   const f=await seed();
   await db.$executeRawUnsafe(`CREATE FUNCTION sfs136_projection_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SFS136_PROJECTION_ROLLBACK'; END $$`);
   await db.$executeRawUnsafe(`CREATE TRIGGER sfs136_projection_fault BEFORE UPDATE ON "SfsTargetCandidate" FOR EACH ROW EXECUTE FUNCTION sfs136_projection_fault()`);
   try{await assert.rejects(actions.startActionDelivery(f.input),/SFS136_PROJECTION_ROLLBACK/);}finally{await db.$executeRawUnsafe('DROP TRIGGER sfs136_projection_fault ON "SfsTargetCandidate"');}
   assert.equal((await db.automationDelivery.findUnique({where:{id:f.delivery.id}})).status,'CLAIMED');
   await actions.startActionDelivery(f.input);assert.equal((await candidateRow(f)).latestStatus,'RUNNING');
  });
 }catch(e){error={code:e.code||null,message:e.message,stack:e.stack};console.error(e);}
 finally{if(fixture)await fixture.close();clearInterval(keep);}
 const result={ok:!error,runtime:process.version,engine:'PGlite 0.5.8 + real Prisma 5.22',nativeConcurrency:false,productionAccessed:false,baselineReplay:'uploaded135 function bodies; current dependencies and SQL fixture',baselineEvidence,cases,error};
 if(process.env.SFS_PROOF_OUTPUT)fs.writeFileSync(process.env.SFS_PROOF_OUTPUT,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));if(error)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
