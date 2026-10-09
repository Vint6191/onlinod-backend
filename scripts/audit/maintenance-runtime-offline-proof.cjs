'use strict';
// Disposable local PostgreSQL/WASM fixture only. Never reads DATABASE_URL.
// PGlite's JS timestamp parser uses process TZ; Prisma's production wire reader
// decodes timestamp columns as UTC. Pin both clocks in this isolated process.
process.env.TZ='UTC';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const {PGlite}=require(process.env.ONLINOD_PGLITE_MODULE||'@electric-sql/pglite');
const ROOT=path.resolve(__dirname,'../..');
const report=[],trace=[];
const check=async(name,fn)=>{const details=await fn();report.push({name,details});console.log('PASS',name,JSON.stringify(details||{}));};
const adapter=client=>({
  $queryRawUnsafe:async(sql,...args)=>{trace.push({sql,args});return(await client.query(sql,args)).rows;},
  $executeRawUnsafe:async(sql,...args)=>{trace.push({sql,args});return(await client.query(sql,args)).affectedRows||0;},
});
(async()=>{
 const pg=await PGlite.create();await pg.exec("SET TIME ZONE 'UTC'");
 try{
  await pg.exec(fs.readFileSync(path.join(ROOT,'prisma/migrations',require('../../src/services/database-contract.json').migration,'migration.sql'),'utf8'));
  const db={...adapter(pg),$transaction:fn=>pg.transaction(tx=>fn(adapter(tx)))};
  require.cache[path.join(ROOT,'src/prisma.js')]={exports:db};
  const registry=require('../../src/services/maintenance-lane-registry'),admission=require('../../src/services/phase2-maintenance-admission-service');
  const verify=require('../../src/services/maintenance-runtime-contract').verifyMaintenanceRuntime;
  const indexes=require('../database/background-maintenance-indexes');
  const generation=registry.MAINTENANCE_ADMISSION_GENERATION;
  await check('fresh baseline installs every current handler, ordinal and index',async()=>{
    const rows=await db.$queryRawUnsafe('SELECT * FROM "MaintenanceAdmissionClassState" WHERE generation=$1 ORDER BY ordinal',generation);
    assert.deepEqual(rows.map(r=>r.laneName),registry.MAINTENANCE_LANE_NAMES);
    assert.ok(rows.every(r=>Number(r.turnCount)===0));assert.equal((await verify({db})).handlers,registry.MAINTENANCE_LANES.length);
  });
  await check('read-only verification catches a wrong index definition',async()=>{
    await indexes.ensureIndexes(db);await indexes.ensureIndexes(db);
    await pg.exec('DROP INDEX "FanObservationToken_expiry_id_idx"; CREATE INDEX "FanObservationToken_expiry_id_idx" ON "FanObservationToken"("id","createdAt")');
    await assert.rejects(verify({db}),/MAINTENANCE_INDEX_INVALID/);
    await pg.exec('DROP INDEX "FanObservationToken_expiry_id_idx"');await indexes.ensureIndexes(db,{create:true});
  });
  await check('missing callback fails verification before any DB query',async()=>{
    const load=createRequire(path.join(ROOT,'src/services/maintenance-lane-registry.js'));
    const target=load('./analytics-fact-publication-service'),original=target.runSweep;target.runSweep=undefined;
    const before=trace.length;try{await assert.rejects(verify({db}),/MAINTENANCE_HANDLER_MISSING:analyticsFactPublication/);assert.equal(trace.length,before);}finally{target.runSweep=original;}
  });
  await check('actual pump visits every current lane and continues after one callback fails',async()=>{
    const load=createRequire(path.join(ROOT,'src/services/maintenance-lane-registry.js')),restore=[],calls=[];
    const pump=require('../../src/services/job-scheduler').runPhase2MaintenancePump;
    try{
      for(const lane of registry.MAINTENANCE_LANES){const module=load(lane.module),original=module[lane.method];restore.push(()=>module[lane.method]=original);module[lane.method]=async options=>{assert.equal(options.db,db);calls.push(lane.name);if(lane.name==='financialReceiptRetention')throw Error('controlled lane failure');return{ok:true};};}
      for(let i=0;i<Math.ceil(registry.MAINTENANCE_LANES.length/5);i++){const result=await pump({db});assert.equal(result.admission.selected.length,5);}
      assert.equal(new Set(calls).size,registry.MAINTENANCE_LANES.length);
    }finally{restore.reverse().forEach(fn=>fn());}
    assert.equal((await admission.readMaintenanceAdmissionProgress({db})).minimumTurns,'1');
  });
  const retention=require('../../src/services/background-retention-service'),credit=require('../../src/services/provider-request-credit-authority-service');
  const tokenRows=async(count,age)=>pg.query(`INSERT INTO "FanObservationToken"("token","jobId","deviceId","leaseRevision","purpose","scopeHash","observedAt","createdAt") SELECT 'token-'||g,'offline-job','d',1,'p','h',clock_timestamp(),statement_timestamp()-$2::interval FROM generate_series(1,$1::int) g`,[count,age]);
  const waiterRows=async(count,age='1 day',prefix='stale',priority='normal',category='default')=>pg.query(`INSERT INTO "OfProviderRequestGateWaiter"("waiterId","ownerInstanceId","agencyId","creatorId","deviceId","capability","priority","category","operation","leaseUntil","updatedAt") SELECT $3||g,'owner','agency','creator','device','read',$4,$5,'read',statement_timestamp()-$2::interval,clock_timestamp() FROM generate_series(1,$1::int) g`,[count,age,prefix,priority,category]);
  const count=async(table)=>Number((await pg.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n);
  await check('token retention drains fixed200 per root and leaves fresh tokens; rollback leaves all rows',async()=>{
    await tokenRows(451,'2 days');await pg.exec(`INSERT INTO "FanObservationToken"("token","jobId","deviceId","leaseRevision","purpose","scopeHash","observedAt") VALUES('live','offline-job','d',1,'p','h',clock_timestamp())`);
    const rollback={...db,$transaction:fn=>pg.transaction(async tx=>{await fn(adapter(tx));throw Error('rollback');})};
    await assert.rejects(retention.runFanObservationTokenRetention({db:rollback}),/rollback/);assert.equal(await count('FanObservationToken'),452);
    assert.equal((await retention.runFanObservationTokenRetention({db})).deleted,200);
    assert.equal((await retention.runFanObservationTokenRetention({db})).deleted,200);
    assert.equal((await retention.runFanObservationTokenRetention({db})).deleted,51);
    assert.equal((await retention.runFanObservationTokenRetention({db})).deleted,0);assert.equal(await count('FanObservationToken'),1);
  });
  await db.$transaction(async tx=>{
    await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true),set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)`);
    await tx.$executeRawUnsafe(`INSERT INTO "Agency"("id","name","updatedAt") VALUES('agency','Offline',clock_timestamp())`);
    await tx.$executeRawUnsafe(`INSERT INTO "User"("id","email","passwordHash","updatedAt") VALUES('user','offline@example.test','fixture',clock_timestamp())`);
    await tx.$executeRawUnsafe(`INSERT INTO "AgencyMember"("id","agencyId","userId","role","roleKey","assignedCreators","permissions","updatedAt") VALUES('member','agency','user','OWNER','owner','"all"','{}',clock_timestamp())`);
    await tx.$executeRawUnsafe(`INSERT INTO "CreatorAccount"("id","agencyId","displayName","status","updatedAt") VALUES('creator','agency','Offline','READY',clock_timestamp())`);
  });
  const scope={ownerInstanceId:'owner',agencyId:'agency',creatorId:'creator',deviceId:'device',capability:'read'};
  await check('waiter re-registration keeps a renewed row; old prefix cleanup is bounded and FIFO survives',async()=>{
    await waiterRows(80);await credit.registerDurableProviderWaiter({db,...scope,waiterId:'stale1',priority:'normal'});
    const now=new Date();const heads=await db.$transaction(tx=>credit._test.waiterHeads(tx,now));
    assert.equal(heads.length,1,JSON.stringify({now,rows:(await pg.query(`SELECT "waiterId","priority","category","ticket","leaseUntil" FROM "OfProviderRequestGateWaiter" ORDER BY "ticket" LIMIT 2`)).rows},(_,v)=>typeof v==='bigint'?String(v):v));assert.equal(heads[0].waiterId,'stale1');assert.equal(await count('OfProviderRequestGateWaiter'),49);
    assert.equal((await retention.runProviderWaiterRetention({db})).deleted,48);assert.equal(await count('OfProviderRequestGateWaiter'),1);
    await assert.rejects(credit.registerDurableProviderWaiter({db,...scope,deviceId:'foreign',waiterId:'stale1'}),{code:'OF_PROVIDER_GATE_WAITER_COLLISION'});
  });
  await check('a stale prefix longer than one page yields and progresses; all eight buckets remain represented',async()=>{
    await pg.exec('TRUNCATE "OfProviderRequestGateWaiter"');await waiterRows(65);
    await credit.registerDurableProviderWaiter({db,...scope,waiterId:'new-live',priority:'normal'});
    for(const left of [34,2]){const heads=await db.$transaction(tx=>credit._test.waiterHeads(tx,new Date()));assert.equal(heads.length,0);assert.equal(await count('OfProviderRequestGateWaiter'),left);}
    const heads=await db.$transaction(tx=>credit._test.waiterHeads(tx,new Date()));assert.equal(heads[0].waiterId,'new-live');
    for(const [i,bucket] of credit.PROVIDER_GATE_BUCKETS.entries())await credit.registerDurableProviderWaiter({db,...scope,waiterId:'bucket'+i,...bucket});
    const all=await db.$transaction(tx=>credit._test.waiterHeads(tx,new Date()));assert.equal(all.length,8);assert.equal(all.find(h=>h.priority==='normal').waiterId,'new-live');
  });
  await check('real provider grant retains exact scope, single active permit, started acknowledgement and spacing',async()=>{
    await pg.exec('TRUNCATE "OfProviderRequestGateWaiter"');
    await credit.registerDurableProviderWaiter({db,...scope,waiterId:'permit',priority:'normal'});
    const args={db,...scope,waiterId:'permit',permitId:'permit',intervalMs:700};
    assert.equal((await credit.tryAcquireDurableProviderPermit({...args,deviceId:'foreign'})).reason,'waiter_missing');
    assert.equal((await credit.tryAcquireDurableProviderPermit(args)).granted,true);
    await credit.registerDurableProviderWaiter({db,...scope,waiterId:'next',priority:'critical_write'});
    assert.equal((await credit.tryAcquireDurableProviderPermit({...args,waiterId:'next',permitId:'next'})).reason,'active_permit');
    const started=await credit.acknowledgeDurableProviderStarted({db,...scope,permitId:'permit'});assert.ok(started.startedAt instanceof Date);assert.equal(started.intervalMs,700);
    assert.equal((await credit.tryAcquireDurableProviderPermit({...args,waiterId:'next',permitId:'next'})).reason,'spacing');
  });
  await check('SQL expiry edges preserve token-at-cutoff and live waiter, expire waiter-at-cutoff',async()=>{
    await pg.exec('TRUNCATE "FanObservationToken","OfProviderRequestGateWaiter"');
    const now=new Date('2026-10-04T12:00:00Z'),cutoff=new Date(+now-86400000);
    for(const [id,offset] of [['old',-1],['edge',0],['fresh',1]]){
      await pg.query(`INSERT INTO "FanObservationToken"("token","jobId","deviceId","leaseRevision","purpose","scopeHash","observedAt","createdAt") VALUES($1,'offline-job','d',1,'p','h',$2,$2)`,[id,new Date(+cutoff+offset)]);
      await credit.registerDurableProviderWaiter({db,...scope,waiterId:id,priority:'normal'});
      await pg.query(`UPDATE "OfProviderRequestGateWaiter" SET "leaseUntil"=$2 WHERE "waiterId"=$1`,[id,new Date(+now+offset)]);
    }
    // The fixture fixes the returned DB clock at an exact millisecond; the actual
    // production DELETEs and their comparisons execute unchanged in PostgreSQL.
    const fixed={...db,$transaction:fn=>pg.transaction(client=>{
      const tx=adapter(client),query=tx.$queryRawUnsafe;
      tx.$queryRawUnsafe=(sql,...args)=>sql.includes("AT TIME ZONE 'UTC' AS now")?Promise.resolve([{now}]):query(sql,...args);
      return fn(tx);
    })};
    assert.equal((await retention.runFanObservationTokenRetention({db:fixed})).deleted,1);
    assert.deepEqual((await pg.query('SELECT token FROM "FanObservationToken" ORDER BY token')).rows.map(r=>r.token),['edge','fresh']);
    assert.equal((await retention.runProviderWaiterRetention({db:fixed})).deleted,2);
    assert.deepEqual((await pg.query('SELECT "waiterId" FROM "OfProviderRequestGateWaiter"')).rows.map(r=>r.waiterId),['fresh']);
  });
  await check('200k expired tokens and waiters: actual query plans stay on bounded index prefixes',async()=>{
    await pg.exec('TRUNCATE "FanObservationToken","OfProviderRequestGateWaiter"');await tokenRows(200000,'2 days');for (const [i,bucket] of credit.PROVIDER_GATE_BUCKETS.entries()) await waiterRows(25000,'1 day','scale'+i+'-',bucket.priority,bucket.category);
    await pg.exec(`UPDATE "OfProviderRequestGateWaiter" SET "leaseUntil"='2020-01-01'`);
    await pg.exec('ANALYZE "FanObservationToken"; ANALYZE "OfProviderRequestGateWaiter"');
    const plans=[];let before=trace.length;await retention.runFanObservationTokenRetention({db});await retention.runProviderWaiterRetention({db});
    const retentionQueries=trace.slice(before).filter(x=>x.sql.startsWith('WITH expired'));
    for(const query of retentionQueries){const plan=await db.$transaction(async tx=>tx.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query.sql,...query.args));plans.push(plan);}
    before=trace.length;await db.$transaction(tx=>credit._test.waiterHeads(tx,new Date()));
    const query=trace.slice(before).find(x=>x.sql.includes('CROSS JOIN LATERAL'));
    const plan=await db.$transaction(tx=>tx.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query.sql,...query.args));plans.push(plan);
    if(process.env.ONLINOD_PROOF_OUTPUT)fs.writeFileSync(path.join(process.env.ONLINOD_PROOF_OUTPUT,'maintenance-scale-plans.json'),JSON.stringify(plans,null,2));
    const text=JSON.stringify(plans);assert.match(text,/FanObservationToken_expiry_id_idx/);assert.match(text,/OfProviderRequestGateWaiter_expiry_id_idx/);assert.match(text,/OfProviderRequestGateWaiter_bucket_ticket_idx/);assert.doesNotMatch(text,/Seq Scan/);
    const walk=node=>{if(node['Node Type']==='Limit')assert.ok(node['Actual Rows']<=200);for(const p of node.Plans||[])walk(p);};for(const result of plans)walk(result[0]['QUERY PLAN'][0].Plan);
    return{tokens:200000,waiters:200000,retentionLimit:200,gatePage:32,buckets:8,concurrency:'single connection; not native multi-replica evidence'};
  });
  console.log(JSON.stringify({passed:report.length,checks:report}));
 }finally{await pg.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
