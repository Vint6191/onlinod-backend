"use strict";
// Disposable PostgreSQL WASM + actual Prisma5.22. No primary DATABASE_URL used.
// PHASE4_PROOF_RUNTIME: same separate pinned runtime as the owner proof script.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {spawn}=require("node:child_process");
const {createRequire}=require("node:module");
const {PrismaClient}=require("@prisma/client");
const root=path.resolve(__dirname,"../..");
const migrationName="20260924020000_phase4_scoped_support_authority";
async function main(){
 if(!process.env.PHASE4_PROOF_RUNTIME)throw new Error("PHASE4_PROOF_RUNTIME required");
 const load=createRequire(path.resolve(process.env.PHASE4_PROOF_RUNTIME,"package.json"));
 const {PGlite}=load("@electric-sql/pglite"),{PGLiteSocketServer}=load("@electric-sql/pglite-socket");
 const engine=await PGlite.create(),server=new PGLiteSocketServer({db:engine,host:"127.0.0.1",port:0,maxConnections:4});
 await server.start();
 const url=`postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
 const baseline=fs.mkdtempSync(path.join(os.tmpdir(),"onlinod-support-proof-"));
 fs.mkdirSync(path.join(baseline,"prisma"));
 fs.copyFileSync(path.join(root,"prisma/schema.prisma"),path.join(baseline,"prisma/schema.prisma"));
 fs.cpSync(path.join(root,"prisma/migrations"),path.join(baseline,"prisma/migrations"),{recursive:true,filter:p=>path.basename(p)!==migrationName});
 const migrate=(schema)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,"node_modules/prisma/build/index.js"),"migrate","deploy","--schema",schema],{cwd:root,env:{...process.env,DATABASE_URL:url},stdio:["ignore","pipe","pipe"]});
  let output="";child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>output+=b);
  child.once("error",reject);child.once("close",code=>{if(code===0){console.log(JSON.stringify({migration:true,schema: schema.includes(baseline)?"baseline254":"current255",ok:true}));resolve();}else reject(new Error(output));});
 });
 let db;
 const passed=[];
 const check=async(name,fn)=>{await fn();passed.push(name);console.log(JSON.stringify({ok:true,case:name}));};
 try{
  await migrate(path.join(baseline,"prisma/schema.prisma"));
  await engine.exec("DISCARD ALL");
  db=new PrismaClient({datasources:{db:{url}}});
  // Redirect source services' singleton to this explicitly disposable DB.
  require.cache[require.resolve("../../src/prisma")]={exports:db};
  await require("../../src/services/phase2-release-compatibility-authority-service").activateTeamControlPlaneAfterDrain(db);
  const {createPhase3PostgresActorFixture,withPhase3PostgresFixtureAuthority}=require("./phase3-postgres-proof-fixture-authority");
  const a=await createPhase3PostgresActorFixture(db,"support-a"),b=await createPhase3PostgresActorFixture(db,"support-b");
  await db.refreshSession.create({data:{id:"legacy-support",userId:a.userId,agencyId:a.agencyId,tokenHash:"legacy-token",impersonatedByAdminId:"old-admin",expiresAt:new Date(Date.now()+86400000)}});
  await db.refreshSession.create({data:{id:"direct-session",userId:b.userId,agencyId:b.agencyId,tokenHash:"direct-token",expiresAt:new Date(Date.now()+86400000)}});
  await db.impersonationToken.create({data:{id:"old-link",tokenHash:"old-link-hash",targetUserId:a.userId,targetAgencyId:a.agencyId,adminUserId:"old-admin",expiresAt:new Date(Date.now()+300000)}});
  await db.$disconnect();await engine.exec("DISCARD ALL");
  await migrate(path.join(root,"prisma/schema.prisma"));
  await engine.exec("DISCARD ALL");
  await check("migration retires only legacy impersonated access and preserves direct sessions",async()=>{
    assert.ok((await db.refreshSession.findUnique({where:{id:"legacy-support"}})).revokedAt);
    assert.equal((await db.refreshSession.findUnique({where:{id:"direct-session"}})).revokedAt,null);
    assert.ok((await db.user.findUnique({where:{id:a.userId}})).sessionsRevokedAt);
    assert.equal((await db.user.findUnique({where:{id:b.userId}})).sessionsRevokedAt,null);
    assert.equal(await db.adminActionLog.count({where:{action:"support.legacy_retired"}}),1);
  });
  await check("old backend cannot issue or claim legacy links after migration",async()=>{
    await assert.rejects(()=>db.impersonationToken.update({where:{id:"old-link"},data:{claimedAt:new Date()}}),/LEGACY_IMPERSONATION_RETIRED/);
    await assert.rejects(()=>db.impersonationToken.create({data:{tokenHash:"new-old-link",targetUserId:a.userId,targetAgencyId:a.agencyId,adminUserId:"old-admin",expiresAt:new Date(Date.now()+300000)}}),/LEGACY_IMPERSONATION_RETIRED/);
  });
  await check("old backend cannot create or reactivate a customer support refresh session",async()=>{
    await assert.rejects(()=>db.refreshSession.create({data:{userId:a.userId,agencyId:a.agencyId,tokenHash:"new-legacy",impersonatedByAdminId:"old-admin",expiresAt:new Date(Date.now()+300000)}}));
    await assert.rejects(()=>db.refreshSession.update({where:{id:"legacy-support"},data:{revokedAt:null}}));
  });
  const admin=await db.adminUser.create({data:{id:"admin-a",email:"admin-a@example.test",passwordHash:"proof",role:"SUPPORT"}});
  await db.adminUser.create({data:{id:"admin-b",email:"admin-b@example.test",passwordHash:"proof",role:"SUPER_ADMIN"}});
  await db.adminSession.create({data:{id:"admin-session-a",adminUserId:admin.id,tokenHash:"admin-session-a",expiresAt:new Date(Date.now()+3600000)}});
  await db.adminSession.create({data:{id:"admin-session-b",adminUserId:"admin-b",tokenHash:"admin-session-b",expiresAt:new Date(Date.now()+3600000)}});
  const actor={adminId:"admin-a",sessionId:"admin-session-a",accessEpoch:1},other={adminId:"admin-b",sessionId:"admin-session-b",accessEpoch:1};
  const {openAdminSupport,revokeAdminSupport,readAdminSupport}=require("../../src/services/admin-support-command-service");
  const payload={agencyId:a.agencyId,reason:"Inspect reported model connection",durationMinutes:15};
  const id=crypto.randomUUID();let grant;
  await check("grant commit has mandatory audit and no customer credentials or writes",async()=>{
    const before=await db.refreshSession.count();
    const result=await openAdminSupport({db,actor,commandId:id,payload});assert.equal(result.body.ok,true);grant=result.body.grant;
    assert.equal(await db.refreshSession.count(),before);assert.equal(await db.adminCommandAudit.count({where:{action:"support.grant.open"}}),1);
    assert.doesNotMatch(JSON.stringify(result),/accessToken|refreshToken|passwordHash|tokenHash/);
  });
  await check("idempotency replay creates no second grant and conflicting intent is rejected",async()=>{
    const result=await openAdminSupport({db,actor,commandId:id,payload});assert.equal(result.replayed,true);assert.equal(result.body.grant.id,grant.id);
    await assert.rejects(()=>openAdminSupport({db,actor,commandId:id,payload:{...payload,agencyId:b.agencyId}}),e=>e.code==="ADMIN_COMMAND_PAYLOAD_CONFLICT");assert.equal(await db.adminSupportGrant.count(),1);
  });
  await withPhase3PostgresFixtureAuthority(db,tx=>tx.creatorAccount.createMany({data:[...Array.from({length:123},(_,i)=>({id:`a-model-${String(i).padStart(4,"0")}`,agencyId:a.agencyId,displayName:`Model ${i}`})),{id:"b-private",agencyId:b.agencyId,displayName:"Foreign model"}]}));
  await check("cursor pagination is complete and agency isolation survives foreign cursors",async()=>{
    const seen=[];let cursor;
    do{const page=await readAdminSupport({db,actor,grantId:grant.id,query:{limit:50,...(cursor?{cursor}:{})}});assert.ok(page.creators.length<=50);seen.push(...page.creators.map(c=>c.id));cursor=page.nextCursor;}while(cursor);
    assert.equal(seen.length,123);assert.equal(new Set(seen).size,123);assert.ok(!seen.includes("b-private"));
    assert.equal((await readAdminSupport({db,actor,grantId:grant.id,query:{cursor:"b-private"}})).creators.length,0);
  });
  await check("another administrator and another session cannot borrow the grant",async()=>{
    await assert.rejects(()=>readAdminSupport({db,actor:other,grantId:grant.id}),e=>e.code==="SUPPORT_GRANT_NOT_FOUND");
    await db.adminSession.create({data:{id:"admin-a-new-login",adminUserId:actor.adminId,tokenHash:"another-login",expiresAt:new Date(Date.now()+3600000)}});
    await assert.rejects(()=>readAdminSupport({db,actor:{...actor,sessionId:"admin-a-new-login"},grantId:grant.id}),e=>e.code==="SUPPORT_GRANT_NOT_FOUND");
  });
  await check("oversized pages and unsupported request fields are rejected",async()=>{
    for(const query of [{limit:101},{limit:0},{limit:1.5},{agencyId:b.agencyId},{cursor:"x".repeat(181)}])await assert.rejects(()=>readAdminSupport({db,actor,grantId:grant.id,query}));
  });
  await check("expired grant fails closed using database time",async()=>{
    const row=await db.adminSupportGrant.findUnique({where:{id:grant.id}});
    const expired=await db.adminSupportGrant.create({data:{...row,id:"expired-grant",createdAt:new Date(Date.now()-600000),expiresAt:new Date(Date.now()-1000)}});
    await assert.rejects(()=>readAdminSupport({db,actor,grantId:expired.id}),e=>e.code==="SUPPORT_GRANT_EXPIRED");
  });
  await check("admin epoch change, disable and session revoke invalidate the grant",async()=>{
    await db.adminUser.update({where:{id:actor.adminId},data:{role:"SUPER_ADMIN"}});
    await assert.rejects(()=>readAdminSupport({db,actor,grantId:grant.id}),e=>e.code==="ADMIN_AUTH_GENERATION_CHANGED");
    await db.adminUser.update({where:{id:actor.adminId},data:{active:false}});
    await assert.rejects(()=>readAdminSupport({db,actor,grantId:grant.id}),e=>e.code==="ADMIN_DISABLED");
    await db.adminUser.update({where:{id:actor.adminId},data:{active:true}});
    await db.adminSession.update({where:{id:actor.sessionId},data:{revokedAt:new Date()}});
    await assert.rejects(()=>readAdminSupport({db,actor,grantId:grant.id}),e=>e.code==="ADMIN_AUTH_INVALID");
    const current=await db.adminUser.findUnique({where:{id:actor.adminId}});
    actor.accessEpoch=current.accessEpoch;actor.sessionId="admin-a-after-generation";
    await db.adminSession.create({data:{id:actor.sessionId,adminUserId:actor.adminId,issuedAccessEpoch:actor.accessEpoch,tokenHash:"new-generation-login",expiresAt:new Date(Date.now()+3600000)}});
    await assert.rejects(()=>readAdminSupport({db,actor,grantId:grant.id}),e=>e.code==="SUPPORT_GRANT_NOT_FOUND");
    grant=(await openAdminSupport({db,actor,commandId:crypto.randomUUID(),payload})).body.grant;
  });
  await check("mandatory audit failure rolls back grant and command receipt",async()=>{
    const before=await db.adminSupportGrant.count();
    const commandId=crypto.randomUUID();
    const failingDb={$transaction:(work,options)=>db.$transaction(tx=>work(new Proxy(tx,{get(target,key){
      if(key==="adminCommandAudit")return {create:async()=>{throw new Error("proof_audit_failure");}};
      return Reflect.get(target,key);
    }})),options)};
    await assert.rejects(()=>openAdminSupport({db:failingDb,actor,commandId,payload}),/proof_audit_failure/);
    assert.equal(await db.adminSupportGrant.count(),before);assert.equal(await db.adminCommand.count({where:{commandId}}),0);
  });
  await check("super admin revoke is audited and rejects subsequent reads",async()=>{
    const result=await revokeAdminSupport({db,actor:other,commandId:crypto.randomUUID(),grantId:grant.id,payload:{reason:"Support incident resolved"}});assert.equal(result.body.ok,true);
    await assert.rejects(()=>readAdminSupport({db,actor,grantId:grant.id}),e=>e.code==="SUPPORT_GRANT_EXPIRED");
    assert.equal(await db.adminCommandAudit.count({where:{action:"support.grant.revoke"}}),1);
  });
  await check("database forbids reactivation, extension and rebind of issued grants",async()=>{
    for(const [field,value] of [["revokedAt",null],["agencyId",b.agencyId],["actorId",other.adminId],["expiresAt",new Date(Date.now()+600000).toISOString()]])
      await assert.rejects(()=>engine.query(`UPDATE "AdminSupportGrant" SET "${field}"=$1 WHERE "id"=$2`,[value,grant.id]),/SUPPORT_GRANT_IMMUTABLE/);
  });
  await check("indexed agency/id page plan has a LIMIT independent of global history",async()=>{
    const plan=await db.$queryRawUnsafe('EXPLAIN (FORMAT JSON) SELECT "id" FROM "CreatorAccount" WHERE "agencyId"=$1 AND "id">$2 ORDER BY "id" LIMIT 51',a.agencyId,"a-model-0050");
    console.log(JSON.stringify({pageExplain:plan}));assert.match(JSON.stringify(plan),/Limit/);
    const indexes=await db.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='CreatorAccount_agencyId_id_key'`);assert.equal(indexes.length,1);
  });
  console.log(JSON.stringify({ok:true,cases:passed,passed:passed.length,engine:"PostgreSQL WASM/PGlite",nativeConcurrentPostgres:false,loadScaleProven:false}));
 }finally{if(db)await db.$disconnect();await server.stop();await engine.close();fs.rmSync(baseline,{recursive:true,force:true});}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
