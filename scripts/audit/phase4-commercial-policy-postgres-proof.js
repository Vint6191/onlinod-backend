"use strict";
// Disposable PostgreSQL WASM + actual Prisma5.22. No primary DATABASE_URL used.
// PHASE4_PROOF_RUNTIME: same separate pinned runtime as the owner proof script.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {spawn}=require("node:child_process");
const {createRequire}=require("node:module");
const {PrismaClient}=require("@prisma/client");
const root=path.resolve(__dirname,"../..");
const migrationName="20260924040000_phase4_global_commercial_policy";
async function main(){
 if(!process.env.PHASE4_PROOF_RUNTIME)throw new Error("PHASE4_PROOF_RUNTIME required");
 const load=createRequire(path.resolve(process.env.PHASE4_PROOF_RUNTIME,"package.json"));
 const {PGlite}=load("@electric-sql/pglite"),{PGLiteSocketServer}=load("@electric-sql/pglite-socket");
 const engine=await PGlite.create(),server=new PGLiteSocketServer({db:engine,host:"127.0.0.1",port:0,maxConnections:4});
 await server.start();
 const url=`postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
 const baseline=fs.mkdtempSync(path.join(os.tmpdir(),"onlinod-commercial-proof-"));
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

  await engine.exec(`BEGIN;
    UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE';
    SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true);
    INSERT INTO "User" ("id","email","passwordHash","updatedAt") VALUES ('owner','owner@example.test','proof',now());
    INSERT INTO "Agency" ("id","name","createdAt","updatedAt") VALUES ('historical','Historical','2026-01-01',now()),('dated','Dated','2026-01-01',now()),('subscription-trial','Subscription','2026-01-01',now());
    UPDATE "Agency" SET "trialEndsAt"='2027-01-01' WHERE "id"='dated';
    INSERT INTO "AgencyMember" ("id","agencyId","userId","role","roleKey","updatedAt") VALUES ('owner-h','historical','owner','OWNER','owner',now()),('owner-d','dated','owner','OWNER','owner',now()),('owner-s','subscription-trial','owner','OWNER','owner',now());
    INSERT INTO "AgencySubscription" ("id","agencyId","trialEndsAt","updatedAt") VALUES ('trial-sub','subscription-trial','2027-02-01',now());
    INSERT INTO "CreatorAccount" ("id","agencyId","displayName","updatedAt") VALUES ('auto','historical','Auto',now()),('manual','historical','Manual',now()),('fixed-standard','historical','Fixed standard',now());
    INSERT INTO "CreatorBillingProfile" ("id","agencyId","creatorId","tierMode","corePriceCents","aiChatterEnabled","aiChatterPriceCents","updatedAt") VALUES ('auto-profile','historical','auto','AUTO',2000,false,0,now()),('manual-profile','historical','manual','MANUAL',1700,true,0,now()),('fixed-profile','historical','fixed-standard','MANUAL',2000,false,10000,now());
    COMMIT;`);
  await db.$disconnect(); await engine.exec("DISCARD ALL");
  try { await migrate(path.join(root,"prisma/schema.prisma")); }
  catch (error) { await engine.exec("ROLLBACK"); try { await engine.exec(fs.readFileSync(path.join(root,"prisma/migrations",migrationName,"migration.sql"),"utf8")); } catch (detail) { console.error("MIGRATION_ORIGINAL_ERROR",JSON.stringify({message:detail.message,position:detail.position,internalPosition:detail.internalPosition,internalQuery:detail.internalQuery,where:detail.where})); } throw error; }
  await engine.exec("DISCARD ALL");
  require.cache[require.resolve("../../src/prisma")]={exports:db};
  const policyService=require("../../src/services/billing-commercial-policy-service");
  const {readCommercialPolicy,enableCommercialPricingWrite,POLICY_KEY}=policyService;
  const {setAdminCommercialPolicy}=require("../../src/services/admin-commercial-policy-command-service");
  const {setAdminPricing}=require("../../src/services/admin-pricing-command-service");
  const {configuredPrices,catalogForClient}=require("../../src/services/billing-catalog-service");
  const {syncAgencyBillingAggregate}=require("../../src/services/billing-entitlement-service");
  for(const [id,role] of [["admin","SUPER_ADMIN"],["support","SUPPORT"]]){
    await db.adminUser.create({data:{id,email:id+"@example.test",passwordHash:"proof",role}});
    await db.adminSession.create({data:{id:id+"-session",adminUserId:id,tokenHash:id+"-hash",expiresAt:new Date(Date.now()+3600000)}});
  }
  const actor={adminId:"admin",sessionId:"admin-session",accessEpoch:1};
  const support={adminId:"support",sessionId:"support-session",accessEpoch:1};
  const command=async(settings,options={})=>{const p=await readCommercialPolicy({db});return setAdminCommercialPolicy({db,actor,commandId:crypto.randomUUID(),payload:{expectedRevision:p.revision,reason:"Commercial proof",settings:{...p.settings,...settings}},...options});};
  const createAgency=async (id,timezone="UTC")=>db.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SELECT set_config('TimeZone',$1,true)",timezone);
    await require("../../src/services/phase2-release-compatibility-authority-service").assertTeamControlPlaneWriteAdmission(tx);
    const a=await tx.agency.create({data:{id,name:id}});
    await tx.agencyMember.create({data:{id:id+"-member",agencyId:id,userId:"owner",role:"OWNER",roleKey:"owner"}});
    return a;
  });
  await check("historical null trial anchored to creation; explicit deadline preserved",async()=>{
    const a=await db.agency.findUnique({where:{id:"historical"}}),d=await db.agency.findUnique({where:{id:"dated"}});
    assert.equal(a.trialEndsAt.toISOString(),"2026-01-15T00:00:00.000Z");assert.equal(a.trialGrantedDays,14);assert.equal(d.trialEndsAt.toISOString(),"2027-01-01T00:00:00.000Z");
  });
  await check("migration distinguishes AUTO snapshot and explicit manual/free prices",async()=>{
    const a=await db.creatorBillingProfile.findUnique({where:{creatorId:"auto"}}),m=await db.creatorBillingProfile.findUnique({where:{creatorId:"manual"}});
    assert.equal(a.corePriceOverrideCents,null);assert.equal(a.aiChatterPriceOverrideCents,null);assert.equal(m.corePriceOverrideCents,1700);assert.equal(m.aiChatterPriceOverrideCents,0);
  });
  await check("historical subscription-only deadline is preserved without resetting trial",async()=>{
    const a=await db.agency.findUnique({where:{id:"subscription-trial"}});assert.equal(a.trialEndsAt.toISOString(),"2027-02-01T00:00:00.000Z");assert.equal(a.trialGrantedDays,null);
  });
  await check("fixed standard tier at old catalog price follows future global prices",async()=>{
    const p=await db.creatorBillingProfile.findUnique({where:{creatorId:"fixed-standard"}});assert.equal(p.tierMode,"MANUAL");assert.equal(p.corePriceOverrideCents,null);
  });
  const paidPeriod=await db.creatorBillingPeriod.create({data:{id:"historical-paid",agencyId:"dated",creatorId:"paid-creator",tier:"STARTER",revenue30dCents:0,corePriceCents:2000,totalCents:2000,startedAt:new Date("2026-09-01"),endsAt:new Date("2026-10-01"),renewalKey:"historical-paid",commercialPolicyRevision:1}});
  await check("trial issuance is UTC even with a non-UTC database session",async()=>{
    const a=await createAgency("timezone-proof","Pacific/Auckland");assert.ok(Math.abs(a.trialGrantedAt.getTime()-Date.now())<3000);assert.equal(a.trialEndsAt-a.trialGrantedAt,14*86400000);
  });
  const first=await createAgency("new-default");
  await check("registration default is exactly 14 days from DB issuance",async()=>{assert.equal(first.trialGrantedDays,14);assert.equal(first.trialEndsAt-first.trialGrantedAt,14*86400000);assert.equal(first.trialPolicyRevision,1);});
  await check("same-command retry is one revision and one mandatory audit",async()=>{
    const p=await readCommercialPolicy({db});const args={db,actor,commandId:crypto.randomUUID(),payload:{expectedRevision:p.revision,reason:"Set catalog",settings:{...p.settings,trialDays:21,starterPriceCents:2700,aiChatterPriceCents:11000}}};
    const a=await setAdminCommercialPolicy(args),b=await setAdminCommercialPolicy(args);
    assert.equal(a.body.revision,2);assert.equal(b.replayed,true);assert.deepEqual(a.body,b.body);
    assert.equal(await db.adminCommandAudit.count({where:{action:"billing.commercial-policy.set"}}),1);
    await assert.rejects(setAdminCommercialPolicy({...args,payload:{...args.payload,reason:"different"}}),{code:"ADMIN_COMMAND_PAYLOAD_CONFLICT"});
  });
  await check("global policy update never rewrites paid period snapshots",async()=>{assert.deepEqual(await db.creatorBillingPeriod.findUnique({where:{id:paidPeriod.id}}),paidPeriod);});
  await check("future trial uses new revision, existing grants unchanged",async()=>{
    const next=await createAgency("new-duration");assert.equal(next.trialGrantedDays,21);assert.equal(next.trialPolicyRevision,2);assert.equal(next.trialEndsAt-next.trialGrantedAt,21*86400000);
    assert.equal((await db.agency.findUnique({where:{id:first.id}})).trialEndsAt.toISOString(),first.trialEndsAt.toISOString());
  });
  await check("new global prices reach AUTO profiles while individual overrides survive",async()=>{
    const p=await readCommercialPolicy({db}),a=await db.creatorBillingProfile.findUnique({where:{creatorId:"auto"}}),m=await db.creatorBillingProfile.findUnique({where:{creatorId:"manual"}});
    assert.equal(configuredPrices(a,p).corePriceCents,2700);assert.equal(configuredPrices(a,p).aiChatterPriceCents,11000);assert.equal(configuredPrices(m,p).corePriceCents,1700);assert.equal(configuredPrices(m,p).aiChatterPriceCents,0);
    assert.equal(catalogForClient(p).tiers.find(t=>t.key==="STARTER").priceCents,2700);
  });
  await check("stale editor receives durable conflict; SUPPORT cannot change global policy",async()=>{
    const p=await readCommercialPolicy({db});const stale=await command({}, {payload:{expectedRevision:1,reason:"Stale",settings:p.settings}});assert.equal(stale.statusCode,409);
    await assert.rejects(command({trialDays:30},{actor:support}),{code:"ADMIN_INSUFFICIENT_ROLE"});assert.equal((await readCommercialPolicy({db})).revision,2);
  });
  await check("invalid values and unknown fields cannot become global settings",async()=>{
    for(const patch of [{trialDays:0},{trialDays:1.5},{trialDays:366},{starterPriceCents:0},{outreachPriceCents:-1},{starterPriceCents:1000001},{currency:"EUR"}]) await assert.rejects(command(patch),e=>!!e.issues);
  });
  await check("mandatory audit failure rolls back actual policy mutation and receipt",async()=>{
    const before=await readCommercialPolicy({db});const failing=new Proxy(db,{get(target,key){if(key==="$transaction")return(fn,opts)=>db.$transaction(tx=>fn(new Proxy(tx,{get(t,k){if(k==="adminCommandAudit")return{create:async()=>{throw Error("proof audit failure");}};return t[k];}})),opts);return target[key];}});
    await assert.rejects(command({trialDays:30},{db:failing}),/proof audit failure/);assert.deepEqual(await readCommercialPolicy({db}),before);
  });
  await check("returning a model to global prices changes its revision and future quote",async()=>{
    const row=await db.creatorBillingProfile.findUnique({where:{creatorId:"manual"}});
    const r=await setAdminPricing({db,actor,commandId:crypto.randomUUID(),creatorId:"manual",payload:{expectedRevision:row.pricingRevision,reason:"Use global",corePriceSource:"CATALOG",aiChatterPriceSource:"CATALOG"}});
    assert.equal(r.statusCode,200);assert.equal(r.body.billing.corePriceSource,"CATALOG");assert.equal(r.body.billing.corePriceCents,2700);assert.equal(r.body.billing.aiChatterPriceCents,11000);assert.ok(r.body.billing.pricingRevision>row.pricingRevision);
  });
  await check("expired and cleared trials do not turn into perpetual TRIAL",async()=>{
    const r=await db.$transaction(tx=>syncAgencyBillingAggregate(tx,"historical",new Date()));assert.equal(r.status,"PAST_DUE");
    await db.agency.update({where:{id:first.id},data:{trialEndsAt:null}});const clear=await db.$transaction(tx=>syncAgencyBillingAggregate(tx,first.id,new Date()));assert.equal(clear.status,"PAST_DUE");
  });
  // Negative trigger tests use engine.query after committed transactions so this
  // single-session WASM adapter cannot mask a rejection behind an aborted tx.
  await check("old policy writer/delete/rename and old profile writer are fenced",async()=>{
    for(const sql of [`UPDATE "SystemSetting" SET "value"='{}' WHERE "key"='${POLICY_KEY}'`,`DELETE FROM "SystemSetting" WHERE "key"='${POLICY_KEY}'`,`UPDATE "SystemSetting" SET "key"='renamed' WHERE "key"='${POLICY_KEY}'`,`UPDATE "CreatorBillingProfile" SET "corePriceCents"=1 WHERE "creatorId"='auto'`]) await assert.rejects(engine.query(sql),/COMMERCIAL_/);
    await assert.rejects(engine.query(`UPDATE "Agency" SET "trialGrantedDays"=365 WHERE "id"='new-duration'`),/TRIAL_ISSUANCE_IMMUTABLE/);
  });
  await check("policy row read uses unique-key index; unrelated settings still writable",async()=>{
    await db.systemSetting.create({data:{key:"unrelated-proof",value:{ok:true}}});await db.systemSetting.delete({where:{key:"unrelated-proof"}});
    const p=await engine.query(`SET enable_seqscan=off;`);void p;
    const plan=await engine.query(`EXPLAIN SELECT "value","revision" FROM "SystemSetting" WHERE "key"='${POLICY_KEY}'`);
    assert.match(JSON.stringify(plan.rows),/Index Scan/);
  });
  await check("database validates settings even after writer admission",async()=>{
    await engine.exec("BEGIN; SELECT set_config('onlinod.commercial_policy_command','v1',true)");
    try { await assert.rejects(engine.query(`UPDATE "SystemSetting" SET "value"=jsonb_set("value",'{trialDays}','0') WHERE "key"='${POLICY_KEY}'`),/COMMERCIAL_POLICY_INVALID/); }
    finally { await engine.exec("ROLLBACK"); }
    assert.equal((await readCommercialPolicy({db})).settings.trialDays,21);
  });
  console.log(JSON.stringify({ok:true,passed:passed.length,cases:passed,engine:"PGlite PostgreSQL WASM + Prisma 5.22",nativeConcurrencyProven:false,scaleProven:false}));
 }finally{if(db)await db.$disconnect();await server.stop();await engine.close();fs.rmSync(baseline,{recursive:true,force:true});}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
