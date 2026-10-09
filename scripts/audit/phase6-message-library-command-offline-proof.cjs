"use strict";
// Disposable full migration chain + actual application Prisma/services. Never
// connects to DATABASE_URL. Fault injection is deterministic, not native load.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");
const { PrismaClient, Prisma } = require("@prisma/client");
const root = path.resolve(__dirname, "../..");

async function main() {
  if (!process.env.PHASE5_PROOF_RUNTIME) throw new Error("PHASE5_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite");
  const { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  console.log("PROOF_ENGINE_START");
  const engine = await PGlite.create();
  console.log("PROOF_ENGINE_READY");
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  console.log("PROOF_SOCKET_READY");
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const cases = [];
  const check = async (name, work) => {
    await work(); cases.push({ name, status: "PASS" }); console.log(JSON.stringify(cases.at(-1)));
  };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
        cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
      child.once("error", reject); child.once("close", code => code ? reject(new Error(output)) : resolve());
    });
    console.log("PROOF_MIGRATIONS_APPLIED");
    await engine.exec("DISCARD ALL");
    console.log("PROOF_WIRE_RESET");
    await engine.exec("SET TIME ZONE 'UTC'");
    console.log("PROOF_FIXTURE_DDL_READY");
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const team = require("../../src/services/team-administration-service");
    const owner = require("../../src/services/team-ownership-transfer-service");
    const { executeAdminOperation } = require("../../src/services/admin-operational-command-service");
    const { executeAdminCommand } = require("../../src/services/admin-commit-authority-service");
    const { adminError } = require("../../src/services/admin-command-contract");
    const { runRootCommit, deferCommitHint } = require("../../src/services/db-commit-kernel");
    const { waitForDesktopControlEvents } = require("../../src/services/desktop-control-events");
    const events = s => waitForDesktopControlEvents({ agencyId: s.agencyId, userId: s.member.userId, memberId: s.member.id, streamId: "proof-other-stream" });
    const generation = tx => tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", "phase2_team_control_plane_v2_durable_access");
    let serial = 0;
    async function seed() {
      const key = `proof-${++serial}`;
      return db.$transaction(async tx => {
        await generation(tx);
        const actorUser = await tx.user.create({ data: { email: `${key}-owner@example.test`, passwordHash: "proof" } });
        const targetUser = await tx.user.create({ data: { email: `${key}-member@example.test`, passwordHash: "proof" } });
        const agency = await tx.agency.create({ data: { name: key, trialEndsAt: new Date("2099-01-01") } });
        const actorMember = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: actorUser.id, role: "OWNER", roleKey: "owner", assignedCreators: "all", permissions: {} } });
        const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: key } });
        const member = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: targetUser.id, role: "OPERATOR", roleKey: "chatter", assignedCreators: [creator.id], permissions: {} } });
        await tx.workerDevice.create({ data: { id: key + "-device", agencyId: agency.id, userId: actorUser.id } });
        await tx.workerDevice.create({ data: { id: key + "-target", agencyId: agency.id, userId: targetUser.id } });
        const invitation = await tx.agencyInvitation.create({ data: { agencyId: agency.id, tokenHash: key, roleKey: "chatter", invitedByUserId: actorUser.id, assignedCreators: [], expiresAt: new Date(Date.now() + 86400000) } });
        await tx.agencyCustomRole.create({ data: { agencyId: agency.id, key: "custom_proof", label: "Proof", access: {}, basedOn: "chatter" } });
        await tx.refreshSession.create({ data: { agencyId: agency.id, userId: actorUser.id, tokenHash: key + "-owner", deviceId: key + "-device", authorizationSessionId: key + "-lineage", expiresAt: new Date(Date.now() + 86400000) } });
        await tx.refreshSession.create({ data: { agencyId: agency.id, userId: targetUser.id, tokenHash: key + "-member", expiresAt: new Date(Date.now() + 86400000) } });
        return { key, creator, agencyId: agency.id, actorUserId: actorUser.id, actorMember, member, invitation, db };
      });
    }

    const router = require("../../src/routes/content-store");
    async function call(s, input, cancel=false) {
      const route = router.stack.find(x => x.route?.path === '/message-library/commands/v3'+(cancel?'/cancel':'')).route;
      let status=200, result;
      await route.stack[0].handle({auth:{agencyId:s.agencyId,userId:s.actorUserId,membership:s.actorMember},body:input,query:{}}, {status(n){status=n;return this},json(x){result=JSON.parse(JSON.stringify(x));return this}});
      if(status>=400) throw Object.assign(new Error(JSON.stringify(result)),{status,code:result.code});
      return result;
    }
    const cmd=(s,action,targetId='script',payload={})=>({commandId:crypto.randomUUID(),action,targetId,payload:{creatorId:s.creator.id,...payload}});
    const script={title:'Private title',messages:[{id:'one',text:'Private text',media:[]},{id:'two',text:'Second',media:[]}]};
    async function snapshot(s){const out={};for(const table of ['ContentCollection','AuditLog','MessageLibraryCommandReceipt'])out[table]=(await db.$queryRawUnsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."id"),'[]'::jsonb) rows FROM "${table}" t WHERE "agencyId"=$1`,s.agencyId))[0].rows;out.blocks=await db.contentBlock.findMany({where:{collection:{agencyId:s.agencyId}},orderBy:{id:'asc'}});return out;}
    for(const action of ['save','duplicate','trash','restore','permanent','block.trash','block.restore']){
      const s=await seed();
      if(action!=='save')await call(s,cmd(s,'save','script',script));
      if(['restore','permanent'].includes(action))await call(s,cmd(s,'trash'));
      if(action==='block.restore')await call(s,cmd(s,'block.trash','script',{messageId:'one'}));
      const request=cmd(s,action,'script',action==='save'?script:action.startsWith('block.')?{messageId:'one'}:{});
      await check(action+': required audit failure rolls back domain and receipt',async()=>{const before=await snapshot(s);await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=true');try{await assert.rejects(()=>call(s,request),{status:500});}finally{await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=false');}assert.deepEqual(await snapshot(s),before);});
      await check(action+': replay is one domain transition and one audit',async()=>{const first=await call(s,request),before=await snapshot(s),second=await call(s,request);assert.deepEqual(second,{...first,replayed:true});assert.deepEqual(await snapshot(s),before);});
    }
    await check('updated save replays before stale expected revision is re-evaluated',async()=>{const s=await seed(),first=await call(s,cmd(s,'save','script',script));const edit=cmd(s,'save','script',{...first.item,title:'Changed'});const result=await call(s,edit);assert.deepEqual(await call(s,edit),{...result,replayed:true});});
    await check('changed result is acknowledged without replaying old content',async()=>{const s=await seed(),request=cmd(s,'save','script',script),first=await call(s,request);await call(s,cmd(s,'save','script',{...first.item,title:'Newer'}));const r=await call(s,request);assert.equal(r.resultUnavailable,true);assert.equal(r.item,null);assert.equal((await db.contentCollection.findFirst({where:{agencyId:s.agencyId}})).title,'Newer');});
    await check('receipts retain no title, message body or media; cleanup does not resurrect',async()=>{const s=await seed(),request=cmd(s,'save','script',script);await call(s,request);await call(s,cmd(s,'trash'));const permanent=cmd(s,'permanent');await call(s,permanent);await require('../../src/services/message-library-lifecycle-service').cleanupMessageLibraryScript({db,agencyId:s.agencyId,creatorId:s.creator.id,scriptId:'script',actorMember:s.actorMember,userId:s.actorUserId});const receipts=await db.$queryRawUnsafe('SELECT result FROM "MessageLibraryCommandReceipt" WHERE "agencyId"=$1',s.agencyId);assert.doesNotMatch(JSON.stringify(receipts),/Private title|Private text|Second|"media"/);for(const input of [request,permanent]){const r=await call(s,input);assert.equal(r.resultUnavailable,true);assert.equal(r.item,null);}assert.equal(await db.contentCollection.count({where:{agencyId:s.agencyId}}),0);});
    await check('cancel before execute is a durable tombstone',async()=>{const s=await seed(),request=cmd(s,'save','script',script);assert.equal((await call(s,request,true)).abandoned,true);await assert.rejects(()=>call(s,request),{code:'MESSAGE_LIBRARY_COMMAND_ABANDONED'});assert.equal(await db.contentCollection.count({where:{agencyId:s.agencyId}}),0);});
    await check('cancel after commit reports outcome and preserves content',async()=>{const s=await seed(),request=cmd(s,'save','script',script);await call(s,request);assert.equal((await call(s,request,true)).alreadyCommitted,true);assert.equal(await db.contentCollection.count({where:{agencyId:s.agencyId}}),1);});
    await check('same command ID with a different intent cannot mutate',async()=>{const s=await seed(),request=cmd(s,'save','script',script);await call(s,request);await assert.rejects(()=>call(s,{...request,payload:{...request.payload,title:'Other'}}),{code:'MESSAGE_LIBRARY_COMMAND_CONFLICT'});});
    await check('billing is rechecked before committed replay',async()=>{const s=await seed(),request=cmd(s,'save','script',script);await call(s,request);await db.$executeRawUnsafe('UPDATE "Agency" SET "billingSupportHold"=true WHERE id=$1',s.agencyId);await assert.rejects(()=>call(s,request),e=>e.status===402||e.status===403);});
    await check('500 active-message cap rolls back without receipt',async()=>{const s=await seed(),request=cmd(s,'save','script',{messages:Array.from({length:501},(_,i)=>({id:String(i),text:'x'}))});await assert.rejects(()=>call(s,request),{status:413});assert.equal((await snapshot(s)).MessageLibraryCommandReceipt.length,0);});
    await check('legacy writes all refuse unkeyed mutations',async()=>{const paths=['/message-library/scripts','/message-library/scripts/:id','/message-library/scripts/:id/restore','/message-library/scripts/:id/permanent','/message-library/scripts/:scriptId/messages/:messageId','/message-library/scripts/:scriptId/messages/:messageId/restore'];let n=0;for(const layer of router.stack){if(!paths.includes(layer.route?.path)||layer.route.methods.get)continue;let status;layer.route.stack[0].handle({}, {status(x){status=x;return this},json(){}});assert.equal(status,410);n++;}assert.equal(n,7);});

    await check('receipt insert failure rolls back save and required audit together',async()=>{
      const s=await seed(),request=cmd(s,'save','script',script),before=await snapshot(s);
      await db.$executeRawUnsafe(`CREATE FUNCTION phase6_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt fault'; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER phase6_receipt_fault BEFORE INSERT ON "MessageLibraryCommandReceipt" FOR EACH ROW EXECUTE FUNCTION phase6_receipt_fault()');
      try{await assert.rejects(()=>call(s,request),{status:500});assert.deepEqual(await snapshot(s),before);}finally{await db.$executeRawUnsafe('DROP TRIGGER phase6_receipt_fault ON "MessageLibraryCommandReceipt"');}
      assert.equal((await call(s,request)).replayed,false);
    });
    await check('stale membership epoch cannot read a committed result',async()=>{const s=await seed(),request=cmd(s,'save','script',script);await call(s,request);await db.$transaction(async tx=>{await generation(tx);await tx.$executeRawUnsafe('UPDATE "AgencyMember" SET "accessEpoch"="accessEpoch"+1 WHERE id=$1',s.actorMember.id)});assert.ok((await db.agencyMember.findUnique({where:{id:s.actorMember.id}})).accessEpoch>s.actorMember.accessEpoch);await assert.rejects(()=>call(s,request),e=>e.status===403||e.status===409);});
    await check('same UUID is isolated by agency and actor',async()=>{const a=await seed(),b=await seed(),request=cmd(a,'save','script',script);await call(a,request);const result=await call(b,{...request,payload:{...request.payload,creatorId:b.creator.id}});assert.equal(result.replayed,false);assert.equal(result.item.creatorId,b.creator.id);});
    await check('CUSTOM media after the first 200 references rejects save atomically',async()=>{
      const s=await seed();await db.creatorMediaAsset.create({data:{agencyId:s.agencyId,creatorId:s.creator.id,mediaId:'205',source:'CUSTOM'}});
      const messages=Array.from({length:3},(_,b)=>({id:'m'+b,text:'content',media:Array.from({length:b===2?5:100},(_,i)=>({id:String(b*100+i+1),type:'photo'}))}));
      await assert.rejects(()=>call(s,cmd(s,'save','script',{messages})),{code:'MESSAGE_LIBRARY_CUSTOM_MEDIA_FORBIDDEN'});assert.equal(await db.contentCollection.count({where:{agencyId:s.agencyId}}),0);assert.equal((await snapshot(s)).MessageLibraryCommandReceipt.length,0);
    });
    await check('duplicate rechecks current media provenance inside its transaction',async()=>{
      const s=await seed();await call(s,cmd(s,'save','script',{messages:[{id:'m',text:'exact text',media:[{id:'42',type:'photo'}]}]}));
      await db.creatorMediaAsset.create({data:{agencyId:s.agencyId,creatorId:s.creator.id,mediaId:'42',source:'CUSTOM'}});
      const before=await snapshot(s);await assert.rejects(()=>call(s,cmd(s,'duplicate')),{code:'MESSAGE_LIBRARY_CUSTOM_MEDIA_FORBIDDEN'});assert.deepEqual(await snapshot(s),before);
    });
    await check('creator identity collision cannot reassign an existing script',async()=>{const s=await seed();await call(s,cmd(s,'save','script',script));const creator=await db.$transaction(async tx=>{await generation(tx);return tx.creatorAccount.create({data:{agencyId:s.agencyId,displayName:'other'}})});await assert.rejects(()=>call(s,cmd(s,'save','script',{...script,creatorId:creator.id})),{code:'MESSAGE_LIBRARY_SCRIPT_CREATOR_MISMATCH'});});
    await check('receipt primary-key lookup stays indexed across 16000 unrelated intents',async()=>{
      const s=await seed(),request=cmd(s,'save','script',script);await call(s,request);
      await db.$executeRawUnsafe(`INSERT INTO "MessageLibraryCommandReceipt" (id,"agencyId","userId","creatorId",fingerprint,status,result) SELECT 'filler_'||g::text,$1,$2,$3,'f','ABANDONED','{}'::jsonb FROM generate_series(1,16000) g`,s.agencyId,s.actorUserId,s.creator.id);
      await db.$executeRawUnsafe('ANALYZE "MessageLibraryCommandReceipt"');
      const plan=await db.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) SELECT * FROM "MessageLibraryCommandReceipt" WHERE id=$1`,'ml_command_v3_'+require('../../src/services/team-command-contract').digest([s.agencyId,s.actorUserId,request.commandId]));assert.match(JSON.stringify(plan),/Index Scan|Index Only Scan/);assert.equal((await call(s,request)).replayed,true);
    });
    await check('tenant receipt purge is limited and preserves another agency',async()=>{
      const a=await seed(),b=await seed(),other=cmd(b,'save','script',script);await call(b,other);for(let i=0;i<3;i++)await call(a,cmd(a,'save','s'+i,script));const before=(await snapshot(a)).MessageLibraryCommandReceipt.length;const purge=require('../../src/services/phase2-destructive-delete-authority-service').purgeAgencyNonFkTenantBatch;const r=await db.$transaction(tx=>purge({tx,agencyId:a.agencyId,limit:2}));assert.equal(r.deleted,2);assert.equal((await snapshot(a)).MessageLibraryCommandReceipt.length,before-2);assert.equal((await call(b,other)).replayed,true);
    });
    await check('reused client ID in another creator cannot replace a committed result',async()=>{
      const s=await seed(),request=cmd(s,'save','script',script);await call(s,request);await call(s,cmd(s,'trash'));await call(s,cmd(s,'permanent'));await require('../../src/services/message-library-lifecycle-service').cleanupMessageLibraryScript({db,agencyId:s.agencyId,creatorId:s.creator.id,scriptId:'script',actorMember:s.actorMember,userId:s.actorUserId});
      const creator=await db.$transaction(async tx=>{await generation(tx);return tx.creatorAccount.create({data:{agencyId:s.agencyId,displayName:'replacement'}})});await call(s,cmd(s,'save','script',{...script,creatorId:creator.id,title:'Replacement'}));const r=await call(s,request);assert.equal(r.ok,true);assert.equal(r.resultUnavailable,true);assert.equal(r.item,null);assert.equal((await db.contentCollection.findFirst({where:{agencyId:s.agencyId}})).title,'Replacement');
    });
    await check('rejected payload can be cancelled and its UUID cannot be repurposed',async()=>{
      const s=await seed();await call(s,cmd(s,'save','script',script));const request=cmd(s,'duplicate','script',{title:{invalid:true}});await assert.rejects(()=>call(s,request),{status:400});const result=await call(s,request,true);assert.equal(result.abandoned,true);assert.equal((await call(s,request,true)).abandoned,true);await assert.rejects(()=>call(s,{...request,payload:{creatorId:s.creator.id,title:'Corrected'}}),{code:'MESSAGE_LIBRARY_COMMAND_CONFLICT'});assert.equal(await db.contentCollection.count({where:{agencyId:s.agencyId}}),1);
    });
    await check('new Prisma client and fresh route recover the same committed snapshot',async()=>{
      const s=await seed(),request=cmd(s,'save','script',script),first=await call(s,request);await db.$disconnect();const fresh=new PrismaClient({datasources:{db:{url}}});const routePath=require.resolve('../../src/routes/content-store');delete require.cache[routePath];require.cache[require.resolve('../../src/prisma')]={exports:fresh};
      try{const route=require(routePath).stack.find(x=>x.route?.path==='/message-library/commands/v3').route;let result,status=200;await route.stack[0].handle({auth:{agencyId:s.agencyId,userId:s.actorUserId,membership:s.actorMember},body:request,query:{}},{status(n){status=n;return this},json(x){result=JSON.parse(JSON.stringify(x))}});assert.equal(status,200);assert.deepEqual(result,{...first,replayed:true});}finally{await fresh.$disconnect();}
    });
    console.log(JSON.stringify({ status: "PASS", cases: cases.length, actualPrisma: true, fullMigrationChain: true, physicalMultiSessionPostgres: false }));
  } finally { await db.$disconnect(); await server.stop(); await engine.close(); }
}
const keepAlive = setInterval(() => {}, 1000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
