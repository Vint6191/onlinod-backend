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
      UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE';
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
    await db.jobInstance.create({ data: { id: "paid-job", agencyId: "a", creatorId: "paid", scope: "creator", jobKey: "traffic_sources_scan", status: "CLAIMED",
      claimedByDeviceId: "device", leaseTokenHash: crypto.createHash("sha256").update(paidToken).digest("hex"), leaseRevision: 1,
      leaseMemberId: member.id, leaseAccessEpoch: member.accessEpoch, leaseUntil: new Date(Date.now() + 600000) } });
    const paidActor = { ...actor, creatorId: "paid", operation: "chats.list", priority: "normal", timeoutMs: 5000,
      jobLease: { jobId: "paid-job", leaseToken: paidToken, leaseRevision: 1 } };
    const now = (await state("unpaid")).now, day = Math.floor(now.getTime() / 86400000) * 86400000;
    const params = { analyticsContractVersion: 1, sourceTimezone: "UTC", scanFrom: new Date(day - 30 * 86400000).toISOString().slice(0, 10), scanTo: new Date(day - 86400000).toISOString().slice(0, 10) };
    let recovery;

    const fs=require('node:fs'),diag=require('../../src/services/admin-diagnostics-service');
    await db.$executeRawUnsafe(`INSERT INTO "CrmProfile" ("id","agencyId","creatorId","fanId","updatedAt") VALUES ('p1','a','paid','1',now()),('p2','a','paid','2',now())`);
    await db.$executeRawUnsafe(`INSERT INTO "CrmProfileTag" ("id","agencyId","profileId","tagKey","label","updatedAt")
      SELECT 'tag-'||n,'a','p1','tag-'||n,'Tag',now() FROM generate_series(1,20000) n`);
    await check('CRM diagnostics probes tags by profile with LIMIT 1 without hashing all historical tags',async()=>{
      await db.$executeRawUnsafe('ANALYZE "CrmProfileTag"');
      await db.$executeRawUnsafe('SET enable_seqscan=off'); // Same planner contract as diagnosticsStep.
      const plan=await db.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+diag.PROFILE_PAGE_SQL,'','p2',500);
      const nodes=[];function walk(n){if(!n || typeof n!=='object')return;if(n['Node Type'])nodes.push(n);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v && typeof v==='object')walk(v);}walk(plan);
      assert.ok(nodes.some(n=>(n['Index Name']||'').includes('CrmProfileTag_profileId')));
      assert.ok(!nodes.some(n=>n['Relation Name']==='CrmProfileTag' && n['Node Type']==='Seq Scan'));
      await db.$executeRawUnsafe('RESET enable_seqscan');
      const result=await db.$queryRawUnsafe(diag.PROFILE_PAGE_SQL,'','p2',500);assert.deepEqual(result,[{id:'p1',tagged:true},{id:'p2',tagged:false}]);
      if(process.env.PHASE4_PROOF_OUTPUT)fs.writeFileSync(path.join(process.env.PHASE4_PROOF_OUTPUT,'admin-crm-diagnostics-explain.json'),JSON.stringify(plan,null,2));
    });
    await check('production diagnostic step uses bounded planner policy and publishes correct CRM coverage',async()=>{
      for(let i=0;i<3;i++) {
        await db.$executeRawUnsafe(`UPDATE "SystemSetting" SET "value"=jsonb_set("value",'{nextAt}','"2000-01-01T00:00:00Z"') WHERE "key"=$1`,diag.KEY);
        await diag.diagnosticsStep({db});
      }
      const result=await diag.readDiagnostics({db});assert.equal(result.coverage.status,'AVAILABLE');
      assert.equal(result.anomalies.find(a=>a.key==='untagged_profiles').count,1);
    });
    console.log(JSON.stringify({ ok: true, passed: cases.length, cases, engine: "PGlite with Prisma 5.22", nativeConcurrency: false, productionScale: false }));
  } finally { gate?._test.reset(); await db.$disconnect(); await server.stop(); await engine.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
