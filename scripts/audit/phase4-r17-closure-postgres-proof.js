"use strict";
// Disposable PGlite + actual Prisma. Never connects to an environment DATABASE_URL.
// This verifies SQL/lease contracts, not native concurrency or production load.
const assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { createRequire } = require("node:module"), { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const root = path.resolve(__dirname, "../..");
async function main() {
  if (!process.env.PHASE4_PROOF_RUNTIME) throw new Error("PHASE4_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE4_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite"), { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  const engine = await PGlite.create(), server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 4 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const cases = [], check = async (name, work) => { await work(); cases.push(name); console.log(JSON.stringify({ ok: true, case: name })); };
  let gate;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
      child.once("error", reject); child.once("close", code => code ? reject(new Error(output)) : resolve());
    });
    await engine.exec("DISCARD ALL");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`BEGIN;
      SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true);
      INSERT INTO "User" ("id","email","passwordHash","updatedAt") VALUES ('owner','owner@example.test','proof',now());
      INSERT INTO "Agency" ("id","name","updatedAt") VALUES ('a','A',now()),('b','B',now());
      INSERT INTO "AgencyMember" ("id","agencyId","userId","role","roleKey","updatedAt") VALUES
        ('owner-a','a','owner','OWNER','owner',now()),('owner-b','b','owner','OWNER','owner',now());
      UPDATE "Agency" SET "trialEndsAt"=now()-interval '1 day';
      INSERT INTO "CreatorAccount" ("id","agencyId","displayName","status","updatedAt") VALUES
        ('paid','a','Paid','READY',now()),('unpaid','a','Unpaid','READY',now()),('future','a','Future','READY',now()),
        ('foreign','b','Foreign','READY',now()),('deleted','a','Deleted','READY',now());
      UPDATE "CreatorAccount" SET "deletedAt"=now() WHERE "id"='deleted';
      INSERT INTO "CreatorBillingEntitlement" ("id","creatorId","agencyId","coreValidFrom","coreValidUntil","updatedAt") VALUES
        ('paid','paid','a',now()-interval '1 day',now()+interval '10 days',now()),
        ('future','future','a',now()+interval '1 day',now()+interval '10 days',now()),
        ('foreign','foreign','a',now()-interval '1 day',now()+interval '10 days',now());
      INSERT INTO "WorkerDevice" ("id","agencyId","userId","lastSeenAt","updatedAt") VALUES ('device','a','owner',clock_timestamp(),now());
      INSERT INTO "DeviceCreatorBinding" ("id","agencyId","deviceId","creatorId","sessionReadReady","sessionWriteReady","lastSeenAt","updatedAt")
        SELECT "id",'a','device',"id",true,true,clock_timestamp(),now() FROM "CreatorAccount" WHERE "agencyId"='a' AND "deletedAt" IS NULL;
      COMMIT;`);
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const access = require("../../src/services/billing-execution-access-service");
    const { requestBillingEarningsRefresh } = require("../../src/services/billing-recovery-service");
    const lease = require("../../src/services/job-lease-service");
    gate = require("../../src/services/of-request-gate-service");
    const state = (creatorId, agencyId = "a") => access.creatorBillingAccess({ db, agencyId, creatorId });
    const member = await db.agencyMember.findUnique({ where: { id: "owner-a" } });
    const actor = { agencyId: "a", userId: "owner", deviceId: "device", creatorId: "unpaid", member, capability: "read", operation: "earnings.chart" };
    const paidToken = "paid-test-lease";
    await db.jobInstance.create({ data: { id: "paid-job", agencyId: "a", creatorId: "paid", scope: "creator", jobKey: "dialog_intelligence_scan", status: "CLAIMED",
      claimedByDeviceId: "device", leaseTokenHash: crypto.createHash("sha256").update(paidToken).digest("hex"), leaseRevision: 1,
      leaseMemberId: member.id, leaseAccessEpoch: member.accessEpoch, leaseUntil: new Date(Date.now() + 600000) } });
    const paidActor = { ...actor, creatorId: "paid", operation: "chats.list", priority: "normal", timeoutMs: 5000,
      jobLease: { jobId: "paid-job", leaseToken: paidToken, leaseRevision: 1 } };
    const now = (await state("unpaid")).now, day = Math.floor(now.getTime() / 86400000) * 86400000;
    const params = { analyticsContractVersion: 1, sourceTimezone: "UTC", scanFrom: new Date(day - 30 * 86400000).toISOString().slice(0, 10), scanTo: new Date(day - 86400000).toISOString().slice(0, 10) };
    let recovery;

    const fs = require('node:fs');
    const express = require('express'), app = express();
    const billing = require('../../src/services/product-billing-context-service');
    app.use(express.json());
    app.use((req,res,next)=>{req.auth={agencyId:'a',userId:'owner',membership:member};next();});
    app.use('/api/team/schedule',require('../../src/middleware/product-billing').productBilling,require('../../src/routes/team-schedule'));
    const http=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
    const base='http://127.0.0.1:'+http.address().port;
    const request=async(method,path,body)=>{const r=await fetch(base+'/api/team/schedule'+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
    const payload={memberId:member.id,creatorIds:['paid'],startsAt:'2026-10-01T10:00:00Z',endsAt:'2026-10-01T12:00:00Z'};
    let shift;
    try {
      await check('paid schedule create/update and cancel remain functional through actual HTTP routes',async()=>{
        shift=await request('POST','/shifts',payload);assert.equal(shift.status,201,JSON.stringify(shift));
        const update=await request('PATCH','/shifts/'+shift.body.shiftId,{...payload,expectedRevision:1,note:'paid update'});assert.equal(update.status,200,JSON.stringify(update));shift=update;
      });
      await check('expired trial rejects creation, new unpaid targets and existing unpaid updates without DB mutation',async()=>{
        assert.equal((await request('POST','/shifts',{...payload,creatorIds:['unpaid']})).status,402);
        assert.equal((await request('PATCH','/shifts/'+shift.body.shiftId,{...payload,creatorIds:['unpaid'],expectedRevision:2})).status,402);
        assert.equal(await db.teamShift.count(),1);
        assert.equal((await db.teamShift.findUnique({where:{id:shift.body.shiftId}})).revision,2);
        await db.creatorBillingEntitlement.update({where:{id:'paid'},data:{coreValidUntil:new Date(Date.now()-1000)}});
        assert.equal((await request('PATCH','/shifts/'+shift.body.shiftId,{...payload,expectedRevision:2})).status,402);
        await db.creatorBillingEntitlement.update({where:{id:'paid'},data:{coreValidUntil:new Date(Date.now()+600000)}});
      });
      await check('hold denies both new shifts and edits of paid existing shifts',async()=>{
        await db.agency.update({where:{id:'a'},data:{billingSupportHold:true}});
        assert.equal((await request('POST','/shifts',payload)).status,403);
        assert.equal((await request('PATCH','/shifts/'+shift.body.shiftId,{...payload,expectedRevision:2})).status,403);
        assert.equal(await db.teamShift.count(),1);
        await db.agency.update({where:{id:'a'},data:{billingSupportHold:false}});
      });
      await check('foreign creator and caller-supplied admission scope cannot widen product authority',async()=>{
        const result=await request('POST','/shifts',{...payload,creatorIds:['foreign'],actorAllowedCreatorIds:['foreign']});assert.notEqual(result.status,201);
        await assert.rejects(()=>billing.withProductBilling('a',()=>db.$transaction(tx=>require('../../src/services/management-commit-authority-service').assertManagementCommitAuthority({tx,agencyId:'a',actorMember:member,creatorIds:['unpaid']}))),{code:'CREATOR_SUBSCRIPTION_REQUIRED'});
      });
      await check('time is checked after wait, not at trial admission',async()=>{
        await db.agency.update({where:{id:'a'},data:{trialEndsAt:new Date(Date.now()+100)}});
        await assert.rejects(()=>billing.withProductBilling('a',()=>db.$transaction(async tx=>{
          await require('../../src/services/management-commit-authority-service').lockAgencyLifecycle({tx,agencyId:'a'});
          await new Promise(resolve=>setTimeout(resolve,140));
          await require('../../src/services/management-commit-authority-service').assertManagementCommitAuthority({tx,agencyId:'a',actorMember:member,creatorIds:['unpaid']});
        })),{code:'CREATOR_SUBSCRIPTION_REQUIRED'});
      });
      await check('payment restores previously unpaid product operation',async()=>{
        await db.creatorBillingEntitlement.create({data:{id:'unpaid',agencyId:'a',creatorId:'unpaid',coreValidFrom:new Date(Date.now()-1000),coreValidUntil:new Date(Date.now()+600000)}});
        assert.equal((await request('POST','/shifts',{...payload,creatorIds:['unpaid']})).status,201);
      });
      await check('cancellation is gated by current billing and succeeds after hold is removed',async()=>{
        await db.agency.update({where:{id:'a'},data:{billingSupportHold:true}});
        assert.equal((await request('POST','/shifts/'+shift.body.shiftId+'/cancel',{expectedRevision:2})).status,403);
        await db.agency.update({where:{id:'a'},data:{billingSupportHold:false}});
        assert.equal((await request('POST','/shifts/'+shift.body.shiftId+'/cancel',{expectedRevision:2})).status,200);
      });
      await check('PPV and Tip product commands reject unpaid and held creators before ledger mutation',async()=>{
        await db.teamPpvResolveJob.create({data:{id:'proof-ppv',agencyId:'a',creatorId:'future',purchaseId:'proof-purchase',messageId:'proof-message',status:'conflict'}});
        await db.teamTipLedger.create({data:{id:'proof-tip',agencyId:'a',creatorId:'future',eventHash:'proof-hash',tipId:'proof-tip',receivedAt:new Date()}});
        const ppv=()=>billing.withProductBilling('a',()=>require('../../src/services/team-ppv-ledger-service').resolvePpvConflict({agencyId:'a',jobId:'proof-ppv',actorMember:member,actorMemberId:member.id,action:'creator_revenue',reason:'proof action'}));
        const tip=()=>billing.withProductBilling('a',()=>require('../../src/services/team-tip-ledger-service').applyTipOverride({agencyId:'a',eventHash:'proof-hash',actorMember:member,byMemberId:member.id,byUserId:member.userId,action:'manager_override',reason:'proof action'}));
        for(const command of [ppv,tip])await assert.rejects(command,{code:'CREATOR_SUBSCRIPTION_REQUIRED'});
        await db.agency.update({where:{id:'a'},data:{billingSupportHold:true}});
        for(const command of [ppv,tip])await assert.rejects(command,{code:'BILLING_ACCESS_HELD'});
        assert.equal((await db.teamPpvResolveJob.findUnique({where:{id:'proof-ppv'}})).status,'conflict');
        assert.equal((await db.teamTipLedger.findUnique({where:{id:'proof-tip'}})).resolvedAt,null);
        await db.agency.update({where:{id:'a'},data:{billingSupportHold:false}});
      });
      await check('full schedule HTTP read preserves every paid model beyond 10000 and excludes foreign models',async()=>{
        for (let from=1;from<=10005;from+=250) {
          const to=Math.min(10005,from+249);
          await require('./phase3-postgres-proof-fixture-authority').withPhase3PostgresFixtureAuthority(db,async tx=>{
            await tx.$executeRawUnsafe(`INSERT INTO "CreatorAccount" ("id","agencyId","displayName","status","updatedAt")
              SELECT 'scope-'||lpad(n::text,6,'0'),'a','Scope '||n,'READY',now() FROM generate_series($1::int,$2::int) n`,from,to);
            await tx.$executeRawUnsafe(`INSERT INTO "CreatorBillingEntitlement" ("id","creatorId","agencyId","coreValidFrom","coreValidUntil","updatedAt")
              SELECT "id","id",'a',now()-interval '1 day',now()+interval '1 day',now() FROM "CreatorAccount"
              WHERE "id">=$1 AND "id"<=$2`, 'scope-'+String(from).padStart(6,'0'),'scope-'+String(to).padStart(6,'0'));
          },{timeout:30000});
        }
        await db.teamProjectionCoverage.upsert({where:{agencyId:'a'},create:{agencyId:'a',responseCoverageFrom:new Date('2020-01-01'),dialogCoverageFrom:new Date('2020-01-01')},update:{}});
        const r=await fetch(base+'/api/team/schedule');const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));
        assert.equal(body.context.creators.filter(c=>c.id.startsWith('scope-')).length,10005);
        assert.ok(body.creatorScope.includes('scope-010005'));assert.ok(!body.creatorScope.includes('foreign'));
      });
      await check('account/control authority still works with no product billing context',async()=>{
        await db.agency.update({where:{id:'a'},data:{billingSupportHold:true}});
        const result=await db.$transaction(tx=>require('../../src/services/management-commit-authority-service').assertManagementCommitAuthority({tx,agencyId:'a',actorMember:member,ownerOrAdmin:true}));assert.equal(result.member.id,member.id);
        await db.agency.update({where:{id:'a'},data:{billingSupportHold:false}});
      });
    } finally {await new Promise(resolve=>http.close(resolve));}
    await check('current diagnostics use the maintained current-schema SQL proof', async () => {
      const result = await require('./current-admin-diagnostics-proof.cjs').main();
      assert.equal(result.ok, true);
    });
    console.log(JSON.stringify({ ok: true, passed: cases.length, cases, engine: "PGlite with Prisma 5.22", nativeConcurrency: false, productionScale: false }));
  } finally { gate?._test.reset(); await db.$disconnect(); await server.stop(); await engine.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
