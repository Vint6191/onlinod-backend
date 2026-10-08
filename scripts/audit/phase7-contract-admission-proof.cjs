'use strict';
// This proof creates its own disposable PGlite database. It never accepts an
// external database URL. Operator/source/backup evidence below is SYNTHETIC.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process'), { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { createAdminSqlRuntime } = require('../test-support/admin-sql-runtime.cjs');
const { sha, manifest, COHORTS, storageState } = require('../../src/services/phase7-legacy-storage-service');
const runner = require('../../src/services/phase7-retirement-runner');
const finalizer = require('../../src/services/phase7-retirement-finalizer');
const sources = require('../database/phase7-release-source');
const { main: deploy, migrationPlan, CONTRACT } = require('../database/phase7-deploy');
const expand = '20260930180000_phase7_legacy_storage_expand_v1';

async function seed({ name, engine }) {
  if (name !== expand) return;
  await engine.exec(`BEGIN;
    UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE';
    SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true);
    INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ('p7-user','p7-proof@example.test','synthetic',now());
    INSERT INTO "Agency" (id,name,"updatedAt") VALUES ('p7-agency-a','Synthetic A',now()),('p7-agency-b','Synthetic B',now());
    INSERT INTO "AgencyMember" (id,"agencyId","userId",role,"roleKey","assignedCreators","updatedAt") VALUES
      ('p7-member-a','p7-agency-a','p7-user','OWNER','owner','"all"',now()),('p7-member-b','p7-agency-b','p7-user','OWNER','owner','"all"',now());
    INSERT INTO "AnalyticsSnapshot" (id,"agencyId",scope,"rangeKey",payload)
      SELECT 'p7-a-'||LPAD(n::text,4,'0'),'p7-agency-a','fixture',n::text,jsonb_build_object('amount',n,'marker','A') FROM generate_series(1,503) n;
    INSERT INTO "AnalyticsSnapshot" (id,"agencyId",scope,"rangeKey",payload)
      SELECT 'p7-b-'||LPAD(n::text,4,'0'),'p7-agency-b','fixture',n::text,jsonb_build_object('amount',n,'marker','B') FROM generate_series(1,3) n;
    COMMIT;`);
  const committed = await engine.query('SELECT count(*)::int AS n FROM "AnalyticsSnapshot"');
  assert.equal(committed.rows[0].n, 506, 'the pre-expand seed must have committed');
}
async function writeLedger(f) {
  // The fixture executes the unchanged SQL prefix directly. These local-only
  // receipts represent that execution; they are NOT copied production history.
  await f.db.$executeRawUnsafe(`CREATE TABLE "_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY,checksum VARCHAR(64) NOT NULL,finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,logs TEXT,rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),applied_steps_count INTEGER NOT NULL DEFAULT 0)`);
  for (const name of f.migrations) {
    await f.db.$executeRawUnsafe(`INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,applied_steps_count)
      VALUES ($1,$2,now(),$3,1)`, require('node:crypto').randomUUID(), sha(await fs.readFile(path.join(root, 'prisma/migrations', name, 'migration.sql'))), name);
  }
}
function evidence(release, exportRoot, restoreRoot) {
  const now = Date.now(), iso = n => new Date(n).toISOString();
  return { version: 1, generation: manifest.generation, ...release, operator: 'DISPOSABLE SYNTHETIC PROOF ONLY', noOldBinariesRemain: true,
    rollbackMode: 'restore_database_and_matching_sources', rollbackWindow: { openedAt: iso(now - 10000), closedAt: iso(now) },
    stoppedBinaries: [['backend', release.baseBackendHash], ['desktop', release.baseDesktopHash]].map(([component, sourceHash]) => ({ component, sourceHash, scope: 'isolated synthetic fixture', stoppedAt: iso(now - 1) })),
    archive: { durability: 'persistent_backup', exportRoot: sha(exportRoot), restoreRoot: sha(restoreRoot), backupId: 'SYNTHETIC_LOCAL_COPY_NOT_PRODUCTION_BACKUP', restoredAt: iso(now), retentionUntil: iso(now + 3600000) } };
}
async function child(argv, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    proc.stdout.on('data', data => { output += data; }); proc.stderr.on('data', data => { output += data; });
    proc.on('error', reject); proc.on('exit', code => code === 0 ? resolve(output) : reject(Object.assign(Error('PROOF_PRISMA_CHILD_FAILED:' + code), { output })));
  });
}
(async () => {
  if (!process.env.PHASE7_PROOF_RUNTIME) throw Error('PHASE7_PROOF_RUNTIME is required');
  const runtime = path.resolve(process.env.PHASE7_PROOF_RUNTIME);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'onlinod-phase7-sql-proof-'));
  const cases = [], check = async (name, work) => { await work(); cases.push({ name, status: 'PASS' }); console.log(JSON.stringify(cases.at(-1))); };
  const previousRoles = process.env.PHASE7_RUNTIME_DB_ROLES;
  process.env.PHASE7_RUNTIME_DB_ROLES = 'p7_proof_runtime';
  // Prisma disconnect may leave only unref'ed PGlite handles while its promise
  // is settling. A proof must not exit successfully before all cases/finally.
  const keepAlive = setInterval(() => {}, 1000);
  let f, error = null;
  const calls = [], output = [];
  try {
    f = await createAdminSqlRuntime({ runtimePath: runtime, beforeMigration: seed });
    const { db } = f;
    await writeLedger(f);
    await db.$executeRawUnsafe('CREATE ROLE p7_proof_runtime NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS');
    await db.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await require('../database/phase7-legacy-storage-indexes').ensureIndexes(db, { create: true });
    const exportRoot = path.join(temp, 'export'), restoreRoot = path.join(temp, 'restored');
    await fs.mkdir(exportRoot); await fs.mkdir(restoreRoot);
    // Desktop is a minimal synthetic counterpart here; both full real trees are
    // inventoried separately during release packaging.
    const desktopRoot = path.join(temp, 'desktop'); await fs.mkdir(desktopRoot); await fs.writeFile(path.join(desktopRoot, 'app.js'), '// synthetic desktop source');
    const releaseFile = path.join(temp, 'release.json');
    await sources.writeRelease({ backendRoot: root, desktopRoot, baseBackendRoot: root, baseDesktopRoot: desktopRoot, packageId: 'DISPOSABLE_PHASE7_PROOF', output: releaseFile });
    const release = await finalizer.readRelease(root, { file: releaseFile }), operatorEvidence = evidence(release, exportRoot, restoreRoot);
    const prepare = overrides => finalizer.prepareContract({ db, release, closeRollback: true, operatorEvidence, runtimeRoles: ['p7_proof_runtime'], ...overrides });
    await check('291 canonical retained migrations preserve 506 pre-expand archive rows across two agencies', async () => {
      assert.equal(f.migrations.length, 291); assert.equal(f.migrations.includes(CONTRACT), false);
      assert.equal(Number((await db.$queryRawUnsafe('SELECT count(*) AS n FROM "AnalyticsSnapshot"'))[0].n), 506);
      assert.equal((await storageState(db)).phase, 'BRIDGE');
      await assert.rejects(db.$executeRawUnsafe(`UPDATE "AnalyticsSnapshot" SET payload='{}' WHERE id='p7-a-0001'`), /PHASE7/);
      await db.$disconnect(); // PGlite socket closes an errored extended-protocol session.
    });
    await check('preparation refuses incomplete enumeration and explicit rollback closure is mandatory', async () => {
      await assert.rejects(prepare({ closeRollback: false }), { code: 'PHASE7_EXPLICIT_ROLLBACK_CLOSURE_REQUIRED' });
      await assert.rejects(prepare(), { code: 'PHASE7_ENUMERATION_INCOMPLETE' });
    });
    await check('bounded enumeration and export retain every row and separate agency partitions', async () => {
      for (const cohortId of COHORTS) {
        let complete = false;
        for (let i = 0; i < 20 && !complete; i++) complete = (await runner.enumerateCohort({ db, cohortId, budget: 1 })).complete;
        assert.equal(complete, true);
      }
      for (let i = 0; i < 30; i++) {
        const partition = await runner.claimPartition(db); if (!partition) break;
        await runner.processPartition({ db, partition, directory: exportRoot, limit: 100 });
      }
      const parts = await db.phase7RetirementPartition.findMany({ where: { tableName: 'AnalyticsSnapshot' }, orderBy: { agencyId: 'asc' } });
      assert.deepEqual(parts.map(p => [p.agencyId, Number(p.rows), p.state]), [['p7-agency-a', 503, 'EXPORTED'], ['p7-agency-b', 3, 'EXPORTED']]);
      const chunks = await db.phase7RetirementChunk.findMany(); assert.ok(chunks.every(c => c.rows <= 100 && c.bytes <= manifest.pageBytes));
      await assert.rejects(prepare(), { code: 'PHASE7_PARTITION_UNVERIFIED' });
      await fs.cp(exportRoot, restoreRoot, { recursive: true });
    });
    await check('same-directory readback and corrupted restored bytes cannot become VERIFIED', async () => {
      const p = await db.phase7RetirementPartition.findFirst({ where: { tableName: 'AnalyticsSnapshot', agencyId: 'p7-agency-a' } });
      await assert.rejects(runner.verifyPartitionPage({ db, partitionId: p.id, directory: exportRoot }), { code: 'PHASE7_INDEPENDENT_RESTORE_DIRECTORY_REQUIRED' });
      const c = await db.phase7RetirementChunk.findFirst({ where: { partitionId: p.id }, orderBy: { sequence: 'asc' } });
      const name = path.join(restoreRoot, c.fileName), original = await fs.readFile(name);
      await fs.writeFile(name, Buffer.from(original.toString().replace('"A"', '"X"')));
      await assert.rejects(runner.verifyPartitionPage({ db, partitionId: p.id, directory: restoreRoot }), { code: 'PHASE7_ARCHIVE_RESTORE_MISMATCH' });
      assert.equal((await db.phase7RetirementPartition.findUnique({ where: { id: p.id } })).verifiedSequence, 0);
      await fs.writeFile(name, original);
    });
    await check('independent local restore verifies every chunk and preserves exact scoped payloads', async () => {
      for (let i = 0; i < 40; i++) {
        const p = await db.phase7RetirementPartition.findFirst({ where: { state: 'EXPORTED' } }); if (!p) break;
        await runner.verifyPartitionPage({ db, partitionId: p.id, directory: restoreRoot });
      }
      assert.equal(await db.phase7RetirementPartition.count({ where: { state: { not: 'VERIFIED' } } }), 0);
      const chunks = await db.phase7RetirementChunk.findMany({ orderBy: [{ partitionId: 'asc' }, { sequence: 'asc' }] });
      const restored = [];
      for (const c of chunks) for (const line of (await fs.readFile(path.join(restoreRoot, c.fileName), 'utf8')).trim().split('\n')) {
        const row = JSON.parse(line); if (row.scope === 'fixture') restored.push([row.id, row.agencyId, row.payload.amount, row.payload.marker]);
      }
      const expected = await db.$queryRawUnsafe('SELECT id,"agencyId",payload FROM "AnalyticsSnapshot" ORDER BY id');
      assert.deepEqual(restored.sort((a, b) => a[0].localeCompare(b[0])), expected.map(r => [r.id, r.agencyId, r.payload.amount, r.payload.marker]));
    });
    await check('role privileges and archive-root mismatch keep preparation closed', async () => {
      await assert.rejects(prepare({ runtimeRoles: ['postgres'] }), { code: 'PHASE7_RUNTIME_ROLE_SEPARATION_REQUIRED' });
      await assert.rejects(prepare({ operatorEvidence: { ...operatorEvidence, archive: { ...operatorEvidence.archive, restoreRoot: 'a'.repeat(64) } } }), { code: 'PHASE7_ARCHIVE_EVIDENCE_ROOT_MISMATCH' });
      assert.equal(await db.phase7RetirementCohort.count({ where: { state: 'PURGE_READY' } }), 0);
    });
    await check('valid scoped proof prepares all six cohorts and accepts the exact current source receipt', async () => {
      assert.equal((await prepare()).ready, true);
      assert.equal(await db.phase7RetirementCohort.count({ where: { state: 'PURGE_READY' } }), 6);
      assert.equal((await finalizer.checkContractReady(db, { root, releaseFile })).ready, true);
    });
    await check('BASELINE ready DB still admits a stale source identity; candidate blocks it before Prisma', async () => {
      const other = { ...release, packageId: 'DIFFERENT_SOURCE_RELEASE' };
      await prepare({ release: other });
      if (process.env.PHASE7_PROOF_BASELINE) {
        const old = createRequire(path.resolve(process.env.PHASE7_PROOF_BASELINE, 'package.json'))('./src/services/phase7-retirement-finalizer');
        assert.equal((await old.checkContractReady(db, { root, releaseFile })).ready, true);
      }
      await assert.rejects(finalizer.checkContractReady(db, { root, releaseFile }), { code: 'PHASE7_PREPARED_RELEASE_MISMATCH' });
      await prepare();
    });
    await check('legacy on-disk release cannot replace the new external source receipt', async () => {
      await assert.rejects(finalizer.checkContractReady(db), error => error.code?.startsWith('PHASE7_RELEASE_'));
    });
    const commandRunner = async argv => {
      calls.push(argv[1]); assert.equal(argv[1], 'migrate');
      // The PGlite server multiplexes one physical session. Reset only session
      // state between the disconnected Prisma Client and schema-engine clients;
      // otherwise their independent prepared-statement names collide.
      await f.server.stop(); await f.engine.exec('DISCARD ALL'); await f.server.start();
      try { output.push(await child([path.join(runtime, 'node_modules/prisma/build/index.js'), ...argv.slice(1)], { ...process.env, DATABASE_URL: f.url })); }
      finally { await f.server.stop(); await f.engine.exec('DISCARD ALL'); await f.server.start(); }
    };
    await check('ordinary real Prisma redeploy preserves all nine legacy tables after preparation', async () => {
      await deploy({ db, hooks: false, commandRunner });
      assert.equal((await storageState(db)).phase, 'BRIDGE');
      assert.equal(Number((await db.$queryRawUnsafe('SELECT count(*) AS n FROM "AnalyticsSnapshot"'))[0].n), 506);
    });
    await check('explicit gated Prisma contract drops nine legacy tables only on the disposable database', async () => {
      await deploy({ db, contract: true, releaseFile, hooks: false, commandRunner });
      const state = await storageState(db); assert.equal(state.phase, 'PURGED'); assert.equal(state.targetReady, true);
      assert.equal(await db.agency.count({ where: { id: { in: ['p7-agency-a', 'p7-agency-b'] } } }), 2);
      assert.equal(await db.user.count({ where: { id: 'p7-user' } }), 1);
      assert.ok(await db.phase7RetirementChunk.count() >= 7);
      assert.equal((await migrationPlan(db)).purged, true);
    });
    await check('post-contract ordinary real Prisma redeploy remains idempotent and preserves archive receipts', async () => {
      const before = await db.phase7RetirementChunk.count(); await deploy({ db, hooks: false, commandRunner });
      assert.equal((await storageState(db)).phase, 'PURGED'); assert.equal(await db.phase7RetirementChunk.count(), before);
      assert.equal(calls.length, 3);
    });
  } catch (caught) { error = caught; throw caught; }
  finally {
    if (previousRoles === undefined) delete process.env.PHASE7_RUNTIME_DB_ROLES; else process.env.PHASE7_RUNTIME_DB_ROLES = previousRoles;
    if (process.env.PHASE7_PROOF_OUTPUT) {
      await fs.writeFile(process.env.PHASE7_PROOF_OUTPUT, JSON.stringify({ runtime: process.version, engine: 'PGlite 0.5.8 + real Prisma 5.22; serialized connection',
        migrations: f?.migrations.length, baselineExecuted: Boolean(process.env.PHASE7_PROOF_BASELINE), scope: 'synthetic pre-expand data; NOT production-copy/native-PG/100-worker evidence',
        hooks: false, syntheticBackup: true, cases, error: error ? { message: error.message, code: error.code, output: error.output } : null, prismaOutput: output }, null, 2));
    }
    if (f) await f.close(); await fs.rm(temp, { recursive: true, force: true }); clearInterval(keepAlive);
  }
})().catch(error => { console.error(error); if(error.actual)console.error(error.actual); process.exitCode = 1; });
