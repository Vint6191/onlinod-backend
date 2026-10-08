'use strict';
// Isolated SQL/filesystem proof. Never accepts an application database URL.
// PGlite has one physical session: this is not native multi-session evidence.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { createAdminSqlRuntime } = require('../test-support/admin-sql-runtime.cjs');
const { COHORTS, sha, manifest, runDbTransaction, authorizeLegacyLifecycle } = require('../../src/services/phase7-legacy-storage-service');
const runner = require('../../src/services/phase7-retirement-runner');
const finalizer = require('../../src/services/phase7-retirement-finalizer');
const roles = require('../database/phase7-role-preflight');
const sources = require('../database/phase7-release-source');
async function seed({ name, engine }) {
  if (name !== '20260930180000_phase7_legacy_storage_expand_v1') return;
  await engine.exec(`BEGIN;
    UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE';
    SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true);
    INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ('p7-user','p7-proof@example.test','synthetic',now());
    INSERT INTO "Agency" (id,name,"updatedAt") VALUES ('p7-a','Synthetic A',now()),('p7-b','Synthetic B',now()),('p7-empty','Synthetic empty',now());
    INSERT INTO "AgencyMember" (id,"agencyId","userId",role,"roleKey","assignedCreators","updatedAt") VALUES
      ('p7-member-a','p7-a','p7-user','OWNER','owner','"all"',now()),
      ('p7-member-b','p7-b','p7-user','OWNER','owner','"all"',now()),
      ('p7-member-empty','p7-empty','p7-user','OWNER','owner','"all"',now());
    INSERT INTO "AnalyticsSnapshot" (id,"agencyId",scope,"rangeKey",payload)
      SELECT 'a-'||LPAD(n::text,4,'0'),'p7-a','fixture',n::text,jsonb_build_object('amount',n) FROM generate_series(1,503) n;
    INSERT INTO "AnalyticsSnapshot" (id,"agencyId",scope,"rangeKey",payload)
      SELECT 'b-'||LPAD(n::text,4,'0'),'p7-b','fixture',n::text,jsonb_build_object('amount',n) FROM generate_series(1,3) n;
    INSERT INTO "AnalyticsSnapshot" (id,"agencyId",scope,"rangeKey",payload) VALUES ('empty-row','p7-empty','fixture','empty','{}');
    COMMIT;`);
}
async function main() {
  if (!process.env.PHASE7_PROOF_RUNTIME) throw Error('PHASE7_PROOF_RUNTIME is required');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'onlinod134-archive-proof-'));
  const cases = [], check = async (name, work) => { await work(); cases.push({ name, status:'PASS' }); console.log(JSON.stringify(cases.at(-1))); };
  const keepAlive = setInterval(() => {}, 1000);
  let fixture, error;
  try {
    fixture = await createAdminSqlRuntime({ runtimePath: process.env.PHASE7_PROOF_RUNTIME, beforeMigration: seed });
    const { db } = fixture;
    await db.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.$executeRawUnsafe('CREATE ROLE p7_runtime NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');
    await db.$executeRawUnsafe('CREATE ROLE p7_bypass NOLOGIN BYPASSRLS');
    await db.$executeRawUnsafe('CREATE ROLE p7_database_creator NOLOGIN CREATEDB');
    await db.$executeRawUnsafe('CREATE ROLE p7_replication NOLOGIN REPLICATION');
    await require('../database/phase7-legacy-storage-indexes').ensureIndexes(db, { create:true });
    const exported = path.join(temp,'export'), restored = path.join(temp,'restore');
    await fs.mkdir(exported); await fs.mkdir(restored);
    const baseline = process.env.ONLINOD_PHASE7_BASELINE_ROOT
      ? createRequire(path.resolve(process.env.ONLINOD_PHASE7_BASELINE_ROOT,'package.json')) : null;
    await check('all 291 retained migrations apply; safe isolated runtime role remains admissible', async () => {
      assert.equal(fixture.migrations.length, 291);
      assert.equal((await roles.inspectRoles(db,{roles:['p7_runtime'],strict:true})).verified,true);
    });
    await check('BYPASSRLS membership and CREATEDB/REPLICATION privileges cannot pass runtime admission', async () => {
      await db.$executeRawUnsafe('GRANT p7_bypass TO p7_runtime');
      for (const name of ['p7_runtime','p7_database_creator','p7_replication']) {
        if (baseline) assert.equal((await baseline('./scripts/database/phase7-role-preflight').inspectRoles(db,{roles:[name],strict:true})).verified,true);
        await assert.rejects(roles.inspectRoles(db,{roles:[name],strict:true}),{code:'PHASE7_RUNTIME_ROLE_SEPARATION_REQUIRED'});
      }
      await db.$executeRawUnsafe('REVOKE p7_bypass FROM p7_runtime');
    });
    await check('bounded enumeration plus legitimate lifecycle deletion produces a verifiable empty partition', async () => {
      for (const cohortId of COHORTS) {
        let done=false;
        for(let n=0;n<30&&!done;n++) done=(await runner.enumerateCohort({db,cohortId,budget:1})).complete;
        assert.equal(done,true);
      }
      await runDbTransaction(db,async tx=>{
        await authorizeLegacyLifecycle(tx,{agencyId:'p7-empty'});
        await tx.$executeRawUnsafe('DELETE FROM "AnalyticsSnapshot" WHERE id=$1','empty-row');
      });
      for(let n=0;n<30;n++) {
        const partition=await runner.claimPartition(db);if(!partition)break;
        await runner.processPartition({db,partition,directory:exported,limit:100});
      }
      assert.equal(await db.phase7RetirementPartition.count({where:{state:{not:'EXPORTED'}}}),0);
      assert.equal(await db.phase7RetirementChunk.count({where:{partition:{tableName:'AnalyticsSnapshot'}}}),7);
      await fs.cp(exported,restored,{recursive:true});
    });
    await check('corrupted restored bytes fail before any verification checkpoint advances', async () => {
      const p=await db.phase7RetirementPartition.findFirst({where:{sequence:{gt:0}},orderBy:{id:'asc'}});
      const chunk=await db.phase7RetirementChunk.findFirst({where:{partitionId:p.id},orderBy:{sequence:'asc'}});
      const file=path.join(restored,chunk.fileName), data=await fs.readFile(file);
      await fs.appendFile(file,'invalid');
      await assert.rejects(runner.verifyPartitionPage({db,partitionId:p.id,directory:restored}),e=>e.code?.startsWith('PHASE7_ARCHIVE_'));
      assert.equal((await db.phase7RetirementPartition.findUnique({where:{id:p.id}})).verifiedSequence,0);
      await fs.writeFile(file,data);
    });
    await check('all 506 rows and an empty lifecycle partition complete real Prisma aggregate/CAS verification', async () => {
      for(let n=0;n<30;n++) {
        const p=await db.phase7RetirementPartition.findFirst({where:{state:'EXPORTED'},orderBy:{id:'asc'}});if(!p)break;
        await runner.verifyPartitionPage({db,partitionId:p.id,directory:restored});
      }
      assert.equal(await db.phase7RetirementPartition.count({where:{state:{not:'VERIFIED'}}}),0);
      const totals=await db.phase7RetirementPartition.aggregate({where:{tableName:'AnalyticsSnapshot'},_sum:{rows:true}});assert.equal(totals._sum.rows,506n);
    });
    const desktop=path.join(temp,'desktop');await fs.mkdir(desktop);await fs.writeFile(path.join(desktop,'app.js'),'// synthetic desktop source\n');
    const releaseFile=path.join(temp,'release.json');
    await sources.writeRelease({backendRoot:root,desktopRoot:desktop,baseBackendRoot:root,baseDesktopRoot:desktop,packageId:'ISOLATED134_PROOF',output:releaseFile});
    const release=await sources.readRelease(root,{file:releaseFile}), now=Date.now(), iso=n=>new Date(n).toISOString();
    const operatorEvidence={version:1,generation:manifest.generation,...release,operator:'ISOLATED SYNTHETIC PROOF',noOldBinariesRemain:true,
      rollbackMode:'restore_database_and_matching_sources',rollbackWindow:{openedAt:iso(now-10000),closedAt:iso(now)},
      stoppedBinaries:[['backend',release.baseBackendHash],['desktop',release.baseDesktopHash]].map(([component,sourceHash])=>({component,sourceHash,scope:'synthetic fixture',stoppedAt:iso(now-1)})),
      archive:{durability:'persistent_backup',exportRoot:sha(exported),restoreRoot:sha(restored),backupId:'SYNTHETIC_NOT_A_PRODUCTION_BACKUP',restoredAt:iso(now),retentionUntil:iso(now+3600000)}};
    const prepare=()=>finalizer.prepareContract({db,release,closeRollback:true,operatorEvidence,runtimeRoles:['p7_runtime']});
    await check('valid complete archives prepare all cohorts and pass current-source destructive admission',async()=>{
      assert.equal((await prepare()).ready,true);
      assert.equal((await finalizer.checkContractReady(db,{root,releaseFile})).ready,true);
    });
    await check('prepared flags cannot conceal changed restore binding, totals, cursor or verified prefix',async()=>{
      const p=await db.phase7RetirementPartition.findFirst({where:{sequence:{gt:0}},orderBy:{id:'asc'}});
      for(const data of [{restoreRoot:'a'.repeat(64)},{rows:p.rows+1n},{bytes:p.bytes+1n},{verifiedSequence:p.sequence-1},{cursor:'wrong-cursor'}]) {
        await db.phase7RetirementPartition.update({where:{id:p.id},data});
        if(baseline)assert.equal((await baseline('./src/services/phase7-retirement-finalizer').checkContractReady(db,{root,releaseFile})).ready,true);
        await assert.rejects(finalizer.checkContractReady(db,{root,releaseFile}),{code:'PHASE7_ARCHIVE_ADMISSION_INCONSISTENT'});
        await assert.rejects(prepare(),e=>['PHASE7_ARCHIVE_ADMISSION_INCONSISTENT','PHASE7_ARCHIVE_EVIDENCE_ROOT_MISMATCH'].includes(e.code));
        const restore=Object.fromEntries(Object.keys(data).map(key=>[key,p[key]]));
        await db.phase7RetirementPartition.update({where:{id:p.id},data:restore});
      }
    });
    await check('a role becoming privileged after preparation cannot reuse the stored safe-role report',async()=>{
      await db.$executeRawUnsafe('GRANT p7_bypass TO p7_runtime');
      if(baseline)assert.equal((await baseline('./src/services/phase7-retirement-finalizer').checkContractReady(db,{root,releaseFile})).ready,true);
      await assert.rejects(finalizer.checkContractReady(db,{root,releaseFile}),{code:'PHASE7_RUNTIME_ROLE_SEPARATION_REQUIRED'});
      await db.$executeRawUnsafe('REVOKE p7_bypass FROM p7_runtime');
      assert.equal((await finalizer.checkContractReady(db,{root,releaseFile})).ready,true);
    });
  } catch(caught) {error=caught;throw caught;}
  finally {
    let cleanupError;
    try {if(fixture)await fixture.close();}catch(caught){cleanupError=caught;}
    try {await fs.rm(temp,{recursive:true,force:true});}catch(caught){cleanupError ||= caught;}
    clearInterval(keepAlive);
    if(process.env.PHASE7_PROOF_OUTPUT)await fs.writeFile(process.env.PHASE7_PROOF_OUTPUT,JSON.stringify({runtime:process.version,
      engine:'PGlite 0.5.8 + real Prisma 5.22; one physical session',canonicalRetainedMigrations:fixture?.migrations.length,
      baselineCompared:Boolean(process.env.ONLINOD_PHASE7_BASELINE_ROOT),nativeConcurrency:false,productionAccessed:false,
      syntheticBackup:true,cases,ok:!error&&!cleanupError,error:(error||cleanupError)?{message:(error||cleanupError).message,code:(error||cleanupError).code}:null},null,2)+'\n');
    if(cleanupError&&!error)throw cleanupError;
  }
  console.log('PHASE7_ARCHIVE_SQL_PROOF_PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
