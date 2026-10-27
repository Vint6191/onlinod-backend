"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {createScaleSqlRuntime}=require('../test-support/scale-sql-runtime.cjs');
const {scope}=require('./analytics-traffic/fixture.cjs');
const {runRootCommit}=require('../../src/services/db-commit-kernel');
const root=path.resolve(__dirname,'../..'),logs=fs.mkdtempSync(path.join(os.tmpdir(),'nod-ltv178-upgrade-'));
function install(url, label) {
  return new Promise((resolve, reject) => {
    const file = path.join(logs, label + ".log"), fd = fs.openSync(file, "w");
    const env = { ...process.env, DATABASE_URL: url };
    delete env.DIRECT_URL; delete env.SHADOW_DATABASE_URL;
    const child = spawn(process.execPath, ["scripts/database/install-current.js"], { cwd: root, env, stdio: ["ignore", fd, fd] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.once("error", error => { clearTimeout(timer); fs.closeSync(fd); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer); fs.closeSync(fd);
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${label} failed: ${fs.readFileSync(file, "utf8")}`));
    });
  });
}
const keep=setInterval(()=>{},1000);
(async()=>{const runtime=await createScaleSqlRuntime({beforeMigration:'20261026010000_fan_ltv178'});try{
 const {db}=runtime,s=await scope(db),now=new Date(Math.floor(Date.now()/1000)*1000);
 const write=fn=>runRootCommit(db,async({tx})=>{
  await require('../../src/services/earnings-generation-service').lock(tx,s.creatorId);
  await require('../../src/services/creator-fact-write-authority').lockCreatorFacts(tx,s.agencyId,s.creatorId);
  return fn(tx);
 });
 await write(async tx=>{
  await tx.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGeneration"(id,"agencyId","creatorId","runId",state,phase,"fromAt","throughAt","snapshotAt","fullScan","publishedAt")
   VALUES('before178',$1,$2,'old-run','ACTIVE','READY',$3,$3,$3,true,$3)`,s.agencyId,s.creatorId,now);
  for(const [id,net] of [['matching',1000],['newer-identity',2000],['missing-identity',3000]]){
   await tx.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGenerationEntry"(generation,"transactionId","occurredAt",category,"netCents",status,"observedAt")
    VALUES('before178',$1,$2,'tips',$3,'done',$2)`,id,now,net);
   if(id!=='missing-identity')await tx.creatorFinancialTransaction.create({data:{...s,userId:undefined,externalTransactionId:id,
    transactionType:'tip',factType:'TIP',netCents:net,currency:'USD',occurredAt:now,transactionStatus:'done',fanOnlyFansUserId:'42',
    sourceUpdatedAt:id==='matching'?now:new Date(+now+1000)}});
  }
  await tx.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerProof"("creatorId","agencyId","fromAt","throughAt",generation,"activeGeneration")
   VALUES($1,$2,$3,$3,'old-proof','before178')`,s.creatorId,s.agencyId,now);
 });
 const receipts=await db.$queryRawUnsafe('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name');
 await db.$disconnect();await install(runtime.url,'upgrade178');
 assert.equal((await require('../../src/services/database-contract-service').readDatabaseContract(db)).ready,true);
 const projection=require('../../src/services/fan-ltv-projection-service'),{readFanLtv}=require('../../src/services/fan-ltv-read-repository');
 assert.equal((await readFanLtv({db,creatorId:s.creatorId})).available,false);
 assert((await require('../../src/services/analytics-hot-executor').due(db)).has('FAN_LTV_PROJECTION'));
 let state;
 for(let i=0;i<30;i++){
  const result=await projection.runSweep({db});assert.equal(result.ok,true,JSON.stringify(result));
  state=await readFanLtv({db,creatorId:s.creatorId});if(state.available&&!state.pending)break;
 }
 assert.equal(state.pending,false);assert.equal(state.allTime.netCents,6000);assert.equal(state.allTime.payingFans,1);
 assert.equal(state.allTime.knownNetCents,1000);assert.equal(state.allTime.unknownPayments,2);assert.equal(state.allTime.complete,false);
 assert.equal(await db.jobInstance.count(),0);
 console.log('PASS actual 177 installer upgrade adopts saved history automatically; only the same verified revision supplies a missing fan identity');
 await db.$disconnect();await install(runtime.url,'repeat178');
 const after=await db.$queryRawUnsafe('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name');
 assert.equal(after.length,receipts.length+1);assert.deepEqual(after.slice(0,receipts.length),receipts);
 assert.equal((await readFanLtv({db,creatorId:s.creatorId})).allTime.knownNetCents,1000);
 const maintenance=require('../../src/services/phase2-maintenance-admission-service'),seen=new Set();
 for(let i=0;i<10;i++){const turn=await maintenance.selectPhase2MaintenanceLanes({db,laneNames:maintenance.MAINTENANCE_LANE_NAMES});turn.selected.forEach(name=>seen.add(name));}
 assert(seen.has('fanLtvProjection'));assert.equal(seen.size,maintenance.MAINTENANCE_LANE_NAMES.length);
 assert.equal((await require('../../src/services/maintenance-runtime-contract').verifyMaintenanceRuntime({db})).ready,true);
 console.log('PASS repeated installation preserves receipts and saved LTV; the new lane and all existing lanes receive bounded admission');
 console.log('FAN_LTV178_UPGRADE_OK',runtime.native?'native PostgreSQL':'PGlite PostgreSQL engine');
}finally{await runtime.close();fs.rmSync(logs,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>clearInterval(keep));
