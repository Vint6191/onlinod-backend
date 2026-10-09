"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs');
const {createAdminSqlRuntime}=require('../test-support/admin-sql-runtime.cjs');
async function main(){
 const fixture=await createAdminSqlRuntime({runtimePath:process.env.R3_PROOF_RUNTIME});const {db,queries}=fixture,cases=[],plans={};let hints=[];
 require.cache[require.resolve('../../src/prisma')]={exports:db};
 require.cache[require.resolve('../../src/services/desktop-control-events')]={exports:{publishDesktopControlEvent:event=>{hints.push({event,lastQuery:queries.at(-1)?.query});}}};
 const repo=require('../../src/services/job-planning-repository'),authority=require('../../src/services/fan-data-authority-service');
 const {runDbTransaction}=require('../../src/services/db-transaction-service');
 const {ensureSingleJob}=require('../../src/services/job-scheduler');
 const {agency,creators}=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)",'phase2_team_control_plane_v2_durable_access');
  const user=await tx.user.create({data:{email:'r3-sql@example.test',passwordHash:'fixture'}});
  const agency=await tx.agency.create({data:{name:'R3 SQL fixture'}});
  await tx.agencyMember.create({data:{agencyId:agency.id,userId:user.id,role:'OWNER',roleKey:'owner',assignedCreators:'all'}});
  const creators=[];for(let i=0;i<10;i++)creators.push(await tx.creatorAccount.create({data:{agencyId:agency.id,displayName:'c'+i,status:'READY'}}));
  return {agency,creators};
 });
 let n=0;const input=(creator=creators[0],extra={})=>({db,publish:true,jobKey:'fan_data_point_refresh',agencyId:agency.id,creatorId:creator.id,idempotencyKey:'r3-'+(++n),params:{fanIds:[String(n)]},...extra});
 const check=async(name,run)=>{await db.jobInstance.deleteMany({});hints=[];queries.length=0;await run();cases.push({name,status:'PASS'});console.log(JSON.stringify(cases.at(-1)));};
 const fill=async(creator=creators[0],count=4)=>{const jobs=[];for(let i=0;i<count;i++)jobs.push(await repo.createPlannedJob(input(creator)));return jobs;};
 try{
  await check('generic creation and manual ensure cannot bypass creator pending capacity',async()=>{
   await fill();await assert.rejects(repo.createPlannedJob(input()),{code:'FAN_DATA_REFRESH_BACKLOG_FULL'});await assert.rejects(repo.ensurePlannedJob(input()),{code:'FAN_DATA_REFRESH_BACKLOG_FULL'});assert.equal(await db.jobInstance.count(),4);assert.equal(hints.length,4);assert.ok(hints.every(h=>h.lastQuery==='COMMIT'));
  });
  await check('same identity is reusable at capacity; terminal reset consumes a slot',async()=>{
   const terminal=await repo.createPlannedJob(input());await db.jobInstance.update({where:{id:terminal.id},data:{status:'FAILED'}});const jobs=await fill();
   const replay=await repo.createPlannedJobIfAbsent(input(creators[0],{idempotencyKey:jobs[0].idempotencyKey}));assert.equal(replay.created,false);assert.equal(replay.job.id,jobs[0].id);
   const failed=await db.jobInstance.findUnique({where:{id:terminal.id}});await assert.rejects(repo.reschedulePlannedJob({db,job:failed}),{code:'FAN_DATA_REFRESH_BACKLOG_FULL'});
   await assert.rejects(repo.reschedulePlannedJob({db,jobId:failed.id}),{code:'FAN_DATA_REFRESH_BACKLOG_FULL'});
   await db.jobInstance.update({where:{id:jobs[0].id},data:{status:'DONE'}});assert.equal((await repo.reschedulePlannedJob({db,job:failed})).rescheduled,true);
  });
  await check('global pending capacity applies across independently scoped creators',async()=>{
   for(let i=0;i<8;i++)await fill(creators[i]);await assert.rejects(repo.createPlannedJob(input(creators[8])),{code:'FAN_DATA_REFRESH_BACKLOG_FULL'});assert.equal(await db.jobInstance.count(),32);
  });
  await check('100 queued SQL calls share bounded admission, with exact same-demand coalescing',async()=>{
   const results=await Promise.allSettled(Array.from({length:100},()=>repo.createPlannedJobIfAbsent(input(creators[0],{params:{fanIds:['same'],rangeKey:'r3:shared'}}))));
   assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.created).length,1);assert.equal(results.filter(r=>r.status==='rejected').length,0);assert.equal(new Set(results.map(r=>r.value.job.id)).size,1);assert.equal(await db.jobInstance.count(),1);
  });
  await check('100 distinct queued SQL demands never exceed four pending jobs for one creator',async()=>{
   const outcomes=await Promise.allSettled(Array.from({length:100},()=>repo.createPlannedJobIfAbsent(input())));
   assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,4);assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.code==='FAN_DATA_REFRESH_BACKLOG_FULL').length,96);assert.equal(await db.jobInstance.count(),4);
  });
  await check('terminal job winning the create race is not acknowledged as durable refresh debt',async()=>{
   let injected=false;
   const raceDb=new Proxy(db,{get(target,key){if(key==='jobInstance')return new Proxy(db.jobInstance,{get(model,method){if(method==='findUnique')return async args=>{const found=await model.findUnique(args);if(!injected&&!found&&args.where.idempotencyKey){injected=true;const job=await repo.createPlannedJob(input(creators[0],{idempotencyKey:args.where.idempotencyKey}));await db.jobInstance.update({where:{id:job.id},data:{status:'FAILED'}});}return found;};const value=model[method];return typeof value==='function'?value.bind(model):value;}});const value=target[key];return typeof value==='function'?value.bind(target):value;}});
   const result=await authority.scheduleFanDataPointRefresh({db:raceDb,agencyId:agency.id,creatorId:creators[0].id,onlyFansUserIds:['991']});assert.equal(injected,true);assert.equal(result.reason,'same_bucket_failed');assert.equal(authority.fanDataPointRefreshDecisionDurable(result),false);
  });
  await check('pending refresh survives 30 newer terminal rows and an idempotency bucket change',async()=>{
   const pending=await repo.createPlannedJob(input(creators[0],{params:{fanIds:['99'],rangeKey:'r3:old'}}));
   for(let i=0;i<30;i++){const j=await repo.createPlannedJob(input());await db.jobInstance.update({where:{id:j.id},data:{status:'FAILED'}});}
   const decision=await ensureSingleJob({db,jobKey:'fan_data_point_refresh',creatorId:creators[0].id,agencyId:agency.id,params:{fanIds:['99'],rangeKey:'r3:old'},now:new Date(),freshnessWindowMs:120000});assert.equal(decision.created,false);assert.equal(decision.jobId,pending.id);assert.equal(decision.reason,'already_in_flight');
  });
  await check('joined kernel commit uses its own SQL client; rollback leaves no row or notification',async()=>{
   await assert.rejects(runDbTransaction(db,async tx=>{await repo.createPlannedJob(input(creators[0],{db:tx}));throw Error('rollback fixture');}),/rollback fixture/);assert.equal(await db.jobInstance.count(),0);assert.equal(hints.length,0);
   await runDbTransaction(db,async tx=>{await repo.createPlannedJob(input(creators[0],{db:tx}));assert.equal(hints.length,0);});assert.equal(hints.length,1);assert.equal(hints[0].lastQuery,'COMMIT');
  });
  await check('repeatable-read snapshot cannot bypass admission by using a stale count',async()=>{
   await assert.rejects(runDbTransaction(db,tx=>repo.createPlannedJob(input(creators[0],{db:tx})),{isolationLevel:'RepeatableRead'}),{code:'FAN_DATA_ADMISSION_ISOLATION_UNSUPPORTED'});assert.equal(await db.jobInstance.count(),0);
  });
  await check('durable point-refresh denial preserves the whole caller debt without prefix scheduling',async()=>{
   await fill();const result=await authority.scheduleDurableFanDataRefreshDebt({agencyId:agency.id,creatorId:creators[0].id,fanIds:['701','702'],scheduleFanRefresh:args=>authority.scheduleFanDataPointRefresh({...args,db})});assert.equal(result.durable,false);assert.deepEqual(result.fanIds,['701','702']);assert.equal(result.error,'FAN_DATA_REFRESH_BACKLOG_FULL');assert.equal(await db.jobInstance.count(),4);
  });
  await check('all five consumer refresh adapters use the explicit DB and the common admission path',async()=>{
   const adapters=[['likes','scheduleLikesCurrentRefresh'],['bump','scheduleBumpCurrentRefresh'],['follow-back','scheduleFollowBackCurrentRefresh'],['follow-automation','scheduleRefollowCurrentRefresh'],['sfs','scheduleSfsCurrentRefresh']];
   for(let i=0;i<adapters.length;i++){const [file,name]=adapters[i],module=require('../../src/services/'+file+'-service'),fn=module[name]||module._test?.[name];const result=await fn({db,agencyId:agency.id,creatorId:creators[i].id,fanIds:['55']});assert.equal(result.durable,true,JSON.stringify(result));assert.equal(result.requested,1);const denied=await fn({db,agencyId:agency.id,creatorId:creators[i].id,fanIds:Array(501).fill('55')});assert.equal(denied.durable,false);assert.equal(denied.requested,501);}
   assert.equal(await db.jobInstance.count(),5);
  });
  await check('current fan lookup preserves complete bounded membership and rejects raw overflow before SQL',async()=>{
   await db.creatorFan.createMany({data:[1,2].map(i=>({creatorId:creators[0].id,agencyId:agency.id,onlyFansUserId:String(i)}))});const rows=await authority.readFanCurrent(db,{agencyId:agency.id,creatorId:creators[0].id,onlyFansUserIds:['1','2']});assert.equal(rows.length,2);
   queries.length=0;await assert.rejects(authority.readFanCurrent(db,{agencyId:agency.id,creatorId:creators[0].id,onlyFansUserIds:Array(501).fill('1')}),{code:'FAN_DATA_CURRENT_REQUEST_TOO_LARGE'});assert.equal(queries.length,0);
  });
  await check('pending admission and demand lookup retain indexed access behind 5000 terminal jobs',async()=>{
   for(let start=0;start<5000;start+=500)await db.jobInstance.createMany({data:Array.from({length:500},(_,i)=>({jobKey:'fan_data_point_refresh',scope:'creator',agencyId:agency.id,creatorId:creators[(start+i)%10].id,status:'DONE',params:{fanIds:['old'],rangeKey:'old'},scheduledAt:new Date(),nextRunAt:new Date()}))});
   const job=await repo.createPlannedJob(input(creators[0],{params:{fanIds:['future'],rangeKey:'live'}}));
   await db.$executeRawUnsafe('ANALYZE "JobInstance"');
   plans.capacity=await db.$queryRawUnsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT COUNT(*) FROM "JobInstance" WHERE "jobKey"='fan_data_point_refresh' AND "status" IN ('SCHEDULED','CLAIMED','PUBLISHING')`);
   plans.demand=await db.$queryRawUnsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT "id" FROM "JobInstance" WHERE "jobKey"='fan_data_point_refresh' AND "creatorId"=$1 AND "agencyId"=$2 AND "status" IN ('SCHEDULED','CLAIMED','PUBLISHING') AND ("params"#>ARRAY['rangeKey'])=to_jsonb($3::text) LIMIT 1`,creators[0].id,agency.id,'live');
   for(const plan of Object.values(plans)){assert.match(JSON.stringify(plan),/Index/);assert.doesNotMatch(JSON.stringify(plan),/Seq Scan/);}
   assert.equal((await repo.createPlannedJobIfAbsent(input(creators[0],{params:{fanIds:['future'],rangeKey:'live'}}))).job.id,job.id);
  });
  const report={cases,plans,migrations:fixture.migrations.length,excludedContract:fixture.excludedContract,runtime:process.version,limitations:['PGlite SQL with real Prisma; one serialized connection, not native PostgreSQL 100-worker concurrency/load proof']};
  if(process.env.R3_PROOF_OUTPUT)fs.writeFileSync(process.env.R3_PROOF_OUTPUT,JSON.stringify(report,null,2)+'\n');
 } finally {await fixture.close();}
}
main().catch(e=>{console.error(e);process.exit(1);});
