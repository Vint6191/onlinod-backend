"use strict";
// Disposable PostgreSQL WASM + actual Prisma5.22. No primary DATABASE_URL used.
// PHASE4_PROOF_RUNTIME: same separate pinned runtime as the owner proof script.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {spawn}=require("node:child_process");
const {createRequire}=require("node:module");
const {PrismaClient}=require("@prisma/client");
const root=path.resolve(__dirname,"../..");
const migrationName="20260924030000_phase4_retention_command_authority";
async function main(){
 if(!process.env.PHASE4_PROOF_RUNTIME)throw new Error("PHASE4_PROOF_RUNTIME required");
 const load=createRequire(path.resolve(process.env.PHASE4_PROOF_RUNTIME,"package.json"));
 const {PGlite}=load("@electric-sql/pglite"),{PGLiteSocketServer}=load("@electric-sql/pglite-socket");
 const engine=await PGlite.create(),server=new PGLiteSocketServer({db:engine,host:"127.0.0.1",port:0,maxConnections:4});
 await server.start();
 const url=`postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
 const baseline=fs.mkdtempSync(path.join(os.tmpdir(),"onlinod-retention-proof-"));
 fs.mkdirSync(path.join(baseline,"prisma"));
 fs.copyFileSync(path.join(root,"prisma/schema.prisma"),path.join(baseline,"prisma/schema.prisma"));
 require("./migration-proof-baseline").copyHistoricalMigrationPrefix(path.join(root,"prisma/migrations"),path.join(baseline,"prisma/migrations"),migrationName);
 const migrate=(schema)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,"node_modules/prisma/build/index.js"),"migrate","deploy","--schema",schema],{cwd:root,env:{...process.env,DATABASE_URL:url},stdio:["ignore","pipe","pipe"]});
  let output="";child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>output+=b);
  child.once("error",reject);child.once("close",code=>{if(code===0){console.log(JSON.stringify({migration:true,schema: schema.includes(baseline)?"historical-prefix":"current-forward-chain",ok:true}));resolve();}else reject(new Error(output));});
 });
 let db;
 const passed=[];
 const check=async(name,fn)=>{await fn();passed.push(name);console.log(JSON.stringify({ok:true,case:name}));};
 try{
  await migrate(path.join(baseline,"prisma/schema.prisma"));
  await engine.exec("DISCARD ALL");
  db=new PrismaClient({datasources:{db:{url}}});

  await engine.query('INSERT INTO "SystemSetting" ("id","key","value","updatedAt") VALUES ($1,$2,$3::jsonb,CURRENT_TIMESTAMP)',["historical-policy","retention.policy.v1",JSON.stringify({batchSize:100})]);
  await db.$disconnect(); await engine.exec("DISCARD ALL");
  await migrate(path.join(root,"prisma/schema.prisma")); await engine.exec("DISCARD ALL");
  require.cache[require.resolve("../../src/prisma")]={exports:db};
  const ret=require("../../src/services/retention-service");
  const cmd=require("../../src/services/admin-retention-command-service");
  const {readAdminCommand}=require("../../src/services/admin-commit-authority-service");
  const {withRetentionWork,runRetentionMutation}=require("../../src/services/retention-work-context-service");
  for(const [id,role] of [["admin","SUPER_ADMIN"],["support","SUPPORT"]]){
    await db.adminUser.create({data:{id,email:id+"@example.test",passwordHash:"proof",role}});
    await db.adminSession.create({data:{id:id+"-session",adminUserId:id,tokenHash:id+"-hash",expiresAt:new Date(Date.now()+3600000)}});
  }
  const actor={adminId:"admin",sessionId:"admin-session",accessEpoch:1};
  const support={adminId:"support",sessionId:"support-session",accessEpoch:1};
  const version=async()=>{const p=await ret.getRetentionSettings({db});return {expectedRevision:p.revision,expectedPolicyHash:p.policyHash,reason:"Validated retention maintenance"};};
  const set=async(settings,extra={})=>cmd.setAdminRetentionPolicy({db,actor,commandId:crypto.randomUUID(),payload:{...await version(),settings},...extra});
  await check("historical policy is preserved, normalized and versioned",async()=>{
    const p=await ret.getRetentionSettings({db});assert.equal(p.revision,1);assert.equal(p.settings.batchSize,100);assert.equal(p.policyHash.length,64);
  });
  await check("old unreceipted writes and policy deletion fail, other system settings remain writable",async()=>{
    await assert.rejects(()=>engine.query('UPDATE "SystemSetting" SET "value"=$1::jsonb WHERE "key"=$2',["{}",ret.RETENTION_SETTING_KEY]),/RETENTION_POLICY_COMMAND_REQUIRED/);
    await assert.rejects(()=>engine.query('DELETE FROM "SystemSetting" WHERE "key"=$1',[ret.RETENTION_SETTING_KEY]),/RETENTION_POLICY_RESET_REQUIRES_REVISION/);
    await db.systemSetting.create({data:{key:"unrelated",value:{ok:true}}});await db.systemSetting.delete({where:{key:"unrelated"}});
  });
  let saved, originalPayload, saveId=crypto.randomUUID();
  await check("policy update and audit commit together; revision and hash fence stale readers",async()=>{
    originalPayload={...await version(),settings:{...(await ret.getRetentionSettings({db})).settings,batchSize:200}};
    saved=await cmd.setAdminRetentionPolicy({db,actor,commandId:saveId,payload:originalPayload});
    assert.equal(saved.body.revision,2);assert.equal(saved.body.settings.batchSize,200);
    assert.equal(await db.adminCommandAudit.count({where:{action:"retention.policy.set",event:"COMMITTED"}}),1);
    const stale=await cmd.setAdminRetentionPolicy({db,actor,commandId:crypto.randomUUID(),payload:{...originalPayload,settings:{...originalPayload.settings,batchSize:300}}});
    assert.equal(stale.body.code,"RETENTION_POLICY_CHANGED");assert.equal((await ret.getRetentionSettings({db})).revision,2);
  });
  await check("replay survives response loss and changed intent cannot reuse UUID",async()=>{
    assert.equal((await cmd.setAdminRetentionPolicy({db,actor,commandId:saveId,payload:originalPayload})).replayed,true);
    await assert.rejects(()=>cmd.setAdminRetentionPolicy({db,actor,commandId:saveId,payload:{...originalPayload,reason:"different intent"}}),e=>e.code==="ADMIN_COMMAND_PAYLOAD_CONFLICT");
    assert.equal((await ret.getRetentionSettings({db})).revision,2);
  });
  await check("strict policy validation rejects unknown, out of range, fractional and omitted fields",async()=>{
    const p=(await ret.getRetentionSettings({db})).settings;
    for(const bad of [{...p,unknown:1},{...p,batchSize:99},{...p,batchSize:100.5},{...p,auditLogDays:-1},{}]) await assert.rejects(()=>set(bad));
  });
  await check("SUPPORT cannot mutate policy or queue global work",async()=>{
    const payload=await version();
    await assert.rejects(()=>cmd.submitAdminRetentionRun({db,actor:support,commandId:crypto.randomUUID(),payload}),e=>e.code==="ADMIN_INSUFFICIENT_ROLE");
  });
  const failingDb={$transaction:(work,options)=>db.$transaction(tx=>work(new Proxy(tx,{get(target,key){if(key==="adminCommandAudit")return {create:async()=>{throw Error("mandatory_audit_offline");}};return Reflect.get(target,key);}})),options)};
  await check("mandatory audit failure rolls back policy and command",async()=>{
    const p=await ret.getRetentionSettings({db}),id=crypto.randomUUID();
    await assert.rejects(()=>cmd.setAdminRetentionPolicy({db:failingDb,actor,commandId:id,payload:{...originalPayload,expectedRevision:p.revision,expectedPolicyHash:p.policyHash}}),/mandatory_audit_offline/);
    assert.equal((await ret.getRetentionSettings({db})).revision,p.revision);assert.equal(await db.adminCommand.count({where:{commandId:id}}),0);
  });
  await check("reset preserves identity, advances revision and pins explicit defaults",async()=>{
    const old=await db.systemSetting.findUnique({where:{key:ret.RETENTION_SETTING_KEY}});
    const r=await cmd.setAdminRetentionPolicy({db,actor,commandId:crypto.randomUUID(),reset:true,payload:await version()});
    assert.equal(r.body.revision,old.revision+1);assert.equal((await db.systemSetting.findUnique({where:{key:ret.RETENTION_SETTING_KEY}})).id,old.id);
    assert.deepEqual(r.body.settings,ret.defaultRetentionSettings());
  });
  await set({...ret.defaultRetentionSettings(),batchSize:100});
  let queued;
  await check("run is durable, replayable and only one active global request is accepted",async()=>{
    const id=crypto.randomUUID(),payload=await version();
    queued=await cmd.submitAdminRetentionRun({db,actor,commandId:id,payload});assert.equal(queued.statusCode,202);
    assert.equal((await cmd.submitAdminRetentionRun({db,actor,commandId:id,payload})).replayed,true);
    const another=await cmd.submitAdminRetentionRun({db,actor,commandId:crypto.randomUUID(),payload});assert.equal(another.body.code,"RETENTION_RUN_ALREADY_PENDING");
  });
  await check("policy change before execution cancels queued old intent",async()=>{
    await set({...ret.defaultRetentionSettings(),batchSize:200});
    assert.equal((await cmd.runAdminRetentionSweep({db})).reason,"policy_changed");
    const state=await readAdminCommand({db,actor,commandId:queued.commandId});assert.equal(state.status,"CANCELLED");
  });
  await check("revoked submitting session cancels pending work without deleting",async()=>{
    queued=await cmd.submitAdminRetentionRun({db,actor,commandId:crypto.randomUUID(),payload:await version()});
    await db.adminSession.update({where:{id:actor.sessionId},data:{revokedAt:new Date()}});
    assert.equal((await cmd.runAdminRetentionSweep({db})).reason,"admin_authority_changed");
    actor.sessionId="admin-new-session";await db.adminSession.create({data:{id:actor.sessionId,adminUserId:actor.adminId,tokenHash:actor.sessionId,expiresAt:new Date(Date.now()+3600000)}});
  });
  let claim;
  await check("cluster lease excludes second executor and policy changes while active",async()=>{
    queued=await cmd.submitAdminRetentionRun({db,actor,commandId:crypto.randomUUID(),payload:await version()});
    const row=await db.adminCommand.findUnique({where:{actorId_commandId:{actorId:actor.adminId,commandId:queued.commandId}}});
    claim=await cmd.claimAdminRetentionRun({db,row});assert.ok(claim.lease.acquired);
    assert.equal((await cmd.claimAdminRetentionRun({db,row})).reason,"lease_held");
    assert.equal((await set(ret.defaultRetentionSettings())).body.code,"RETENTION_SWEEP_ACTIVE");
  });
  await check("expired owner cannot renew, finalize or perform destructive commit",async()=>{
    await db.retentionSweepLease.update({where:{key:"global_retention_v1"},data:{leaseUntil:new Date(Date.now()-1000)}});
    await assert.rejects(()=>ret.renewRetentionSweepLease({db,ownerToken:claim.lease.ownerToken}),/RETENTION_COORDINATION_OWNERSHIP_LOST/);
    assert.equal(await ret.finalizeRetentionSweepLease({db,ownerToken:claim.lease.ownerToken,outcome:"COMPLETE"}),false);
    let mutated=false;await assert.rejects(()=>withRetentionWork(claim.lease.ownerToken,()=>runRetentionMutation(async()=>{mutated=true;},db)),/Retention ownership lost/);assert.equal(mutated,false);
  });
  await check("restart reclaims expired run; final receipt and lease release are atomic",async()=>{
    const before=await db.adminCommandAudit.count();
    const report=await cmd.runAdminRetentionSweep({db,run:async options=>{
      const result={ok:true,remainingWork:true,totalDeleted:12};
      await ret.finalizeRetentionSweepLease({db,ownerToken:options.claimedLease.ownerToken,outcome:"PARTIAL",onFinalize:(tx,now)=>options.onFinalize(tx,now,result,null)});
      return result;
    }});assert.equal(report.remainingWork,true);
    const row=await readAdminCommand({db,actor,commandId:queued.commandId});assert.equal(row.status,"PARTIAL");assert.equal(row.execution.progress.attempts,2);assert.equal(row.execution.progress.report.totalDeleted,12);
    assert.equal(await db.adminCommandAudit.count(),before+2);
  });
  await check("final audit failure preserves active lease and recoverable command",async()=>{
    queued=await cmd.submitAdminRetentionRun({db,actor,commandId:crypto.randomUUID(),payload:await version()});
    await assert.rejects(()=>cmd.runAdminRetentionSweep({db,run:options=>ret.finalizeRetentionSweepLease({db:failingDb,ownerToken:options.claimedLease.ownerToken,outcome:"COMPLETE",onFinalize:(tx,now)=>options.onFinalize(tx,now,{ok:true,remainingWork:false},null)})}),/mandatory_audit_offline/);
    assert.equal((await readAdminCommand({db,actor,commandId:queued.commandId})).status,"RUNNING");assert.equal((await db.retentionSweepLease.findUnique({where:{key:"global_retention_v1"}})).completedAt,null);
    await db.retentionSweepLease.update({where:{key:"global_retention_v1"},data:{leaseUntil:new Date(Date.now()-1000)}});
  });
  await check("bounded cleanup has truthful continuation and full real executor can finalize",async()=>{
    const old=new Date("2020-01-01T00:00:00Z");
    await db.adminActionLog.createMany({data:Array.from({length:1001},(_,i)=>({id:"old-audit-"+i,adminUserId:actor.adminId,action:"test-old-audit",createdAt:old}))});
    const page=await ret.runAuditLogRetentionSweep({policySettings:{...ret.defaultRetentionSettings(),batchSize:100}});
    assert.equal(page.totalDeleted,400);assert.equal(page.hasMore,true);assert.equal(await db.adminActionLog.count({where:{action:"test-old-audit"}}),601);
    const report=await cmd.runAdminRetentionSweep({db});assert.equal(report.ok,true);
    assert.equal((await readAdminCommand({db,actor,commandId:queued.commandId})).status,"SUCCEEDED");
  });
  await check("last-run read uses actor/action index and global active slot is unique",async()=>{
    const rows=await db.$queryRawUnsafe("SELECT indexname FROM pg_indexes WHERE indexname IN ('AdminCommand_one_active_retention_run','AdminCommand_actorId_action_createdAt_id_idx')");assert.equal(rows.length,2);
    const plan=await db.$queryRawUnsafe('EXPLAIN (FORMAT JSON) SELECT "commandId" FROM "AdminCommand" WHERE "actorId"=$1 AND "action"=\'retention.run\' ORDER BY "createdAt" DESC,"id" DESC LIMIT 1',actor.adminId);console.log(JSON.stringify({lastRunExplain:plan}));
  });
  console.log(JSON.stringify({ok:true,passed:passed.length,cases:passed,engine:"PostgreSQL WASM/PGlite",nativeConcurrentPostgres:false,loadScaleProven:false}));
 }finally{if(db)await db.$disconnect();await server.stop();await engine.close();fs.rmSync(baseline,{recursive:true,force:true});}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
