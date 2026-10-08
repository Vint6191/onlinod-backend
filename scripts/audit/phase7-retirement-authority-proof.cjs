'use strict';
// Disposable SQL/filesystem proof. Fault injection is explicit; PGlite has one
// physical session and cannot establish native lock contention or concurrency.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), sync = require('node:fs');
const path = require('node:path'), os = require('node:os'), vm = require('node:vm'), { createRequire } = require('node:module');
const { createAdminSqlRuntime } = require('../test-support/admin-sql-runtime.cjs');
const storage = require('../../src/services/phase7-legacy-storage-service');
const runner = require('../../src/services/phase7-retirement-runner');
const finalizer = require('../../src/services/phase7-retirement-finalizer');
const root = path.resolve(__dirname, '../..');
async function seed({ name, engine }) {
  if (name !== '20260930180000_phase7_legacy_storage_expand_v1') return;
  await engine.exec(`BEGIN;
    UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE';
    SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true);
    INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ('retirement-user','retirement@example.test','synthetic',now());
    INSERT INTO "Agency" (id,name,"updatedAt") SELECT 'retirement-'||x,'Synthetic '||x,now() FROM unnest(ARRAY['a','b','c']) x;
    INSERT INTO "AgencyMember" (id,"agencyId","userId",role,"roleKey","assignedCreators","updatedAt")
      SELECT 'member-'||x,'retirement-'||x,'retirement-user','OWNER','owner','"all"',now() FROM unnest(ARRAY['a','b','c']) x;
    INSERT INTO "AnalyticsSnapshot" (id,"agencyId",scope,"rangeKey",payload)
      SELECT x||'-'||n,'retirement-'||x,'fixture',n::text,jsonb_build_object('amount',n)
      FROM unnest(ARRAY['a','b','c']) x CROSS JOIN generate_series(1,3) n;
    COMMIT;`);
}
function baselineRunner() {
  if (!process.env.PHASE7_RETIREMENT_BASELINE) return null;
  const source = sync.readFileSync(process.env.PHASE7_RETIREMENT_BASELINE, 'utf8');
  const filename = path.join(root, 'src/services/phase7-retirement-runner.js'), module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: createRequire(filename), Buffer, console }, { filename });
  return { api: module.exports, sourceHash: storage.sha(source) };
}
async function main() {
  if (!process.env.PHASE7_PROOF_RUNTIME) throw Error('Explicit PHASE7_PROOF_RUNTIME is required');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'onlinod137-retirement-'));
  const cases = [], baselineEvidence = [], keepAlive = setInterval(() => {}, 1000);
  const check = async (name, work) => { await work(); cases.push({ name, status: 'PASS' }); console.log(JSON.stringify(cases.at(-1))); };
  let f, error;
  try {
    f = await createAdminSqlRuntime({ runtimePath: process.env.PHASE7_PROOF_RUNTIME, beforeMigration: seed });
    const { db } = f, exported = path.join(temp, 'export'), restored = path.join(temp, 'restore');
    await fs.mkdir(exported); await fs.mkdir(restored);
    await require('../database/phase7-legacy-storage-indexes').ensureIndexes(db, { create: true });
    const partId = key => runner.partitionId('AnalyticsSnapshot', 'a:retirement-' + key);
    const part = key => db.phase7RetirementPartition.findUnique({ where: { id: partId(key) } });
    const remove = (key, n) => storage.runDbTransaction(db, async tx => {
      await storage.authorizeLegacyLifecycle(tx, { agencyId: 'retirement-' + key });
      return tx.$executeRawUnsafe('DELETE FROM "AnalyticsSnapshot" WHERE "id"=$1', key + '-' + n);
    });
    const drain = async () => {
      for (let i = 0; i < 40; i++) {
        const p = await runner.claimPartition(db); if (!p) break;
        await runner.processPartition({ db, partition: p, directory: exported, limit: 1 });
      }
      assert.equal(await db.phase7RetirementPartition.count({ where: { state: { not: 'EXPORTED' } } }), 0);
      await fs.cp(exported, restored, { recursive: true });
      for (let i = 0; i < 40; i++) {
        const p = await db.phase7RetirementPartition.findFirst({ where: { state: 'EXPORTED' }, orderBy: { id: 'asc' } });
        if (!p) break;
        await runner.verifyPartitionPage({ db, partitionId: p.id, directory: restored });
      }
      assert.equal(await db.phase7RetirementPartition.count({ where: { state: { not: 'VERIFIED' } } }), 0);
    };
    await check('292 retained migrations and all 11 SQL function fingerprints agree', async () => {
      assert.equal(f.migrations.length, 292);
      assert.equal((await storage.storageState(db)).phase, 'BRIDGE');
    });
    await check('bounded source enumeration acquires relation authority before cohort metadata', async () => {
      for (const cohortId of storage.COHORTS) {
        let done = false;
        for (let i = 0; i < 20 && !done; i++) {
          const start = f.queries.length;
          done = (await runner.enumerateCohort({ db, cohortId, budget: 1 })).complete;
          const queries = f.queries.slice(start).map(x => x.query);
          const sources = queries.findIndex(x => x.includes('phase7_lock_retirement_sources()'));
          const cohort = queries.findIndex(x => x.includes('phase7_lock_retirement_cohort('));
          assert.ok(sources >= 0 && cohort > sources);
        }
        assert.equal(done, true);
      }
    });
    await check('receipt insertion failure rolls back cursor advancement and resumes without duplicate chunks', async () => {
      const p = await runner.claimPartition(db, { onlyId: partId('c') });
      await db.$executeRawUnsafe(`CREATE FUNCTION retirement_chunk_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_CHUNK_FAILURE'; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER retirement_chunk_fault BEFORE INSERT ON "Phase7RetirementChunk" FOR EACH ROW EXECUTE FUNCTION retirement_chunk_fault()');
      try {
        await assert.rejects(runner.processPartition({ db, partition: p, directory: exported, limit: 1 }), e => e.message.includes('INJECTED_CHUNK_FAILURE'));
        const current = await part('c');
        assert.equal(current.state, 'BLOCKED'); assert.equal(current.sequence, 0); assert.equal(current.cursor, null);
        assert.equal(current.rows, 0n); assert.equal(current.bytes, 0n);
        assert.equal(await db.phase7RetirementChunk.count({ where: { partitionId: p.id } }), 0);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER retirement_chunk_fault ON "Phase7RetirementChunk"');
        await db.$executeRawUnsafe('DROP FUNCTION retirement_chunk_fault()');
      }
      assert.equal((await runner.resumePartition({ db, id: p.id })).count, 1);
      await drain();
      assert.equal(await db.phase7RetirementChunk.count(), 10); // 9 data rows plus FanObservationClock
    });
    const racedDb = (key, mutation) => new Proxy(db, {
      get(target, prop) {
        if (prop === 'phase7RetirementPartition') return new Proxy(target[prop], {
          get(model, method) {
            if (method !== 'findUnique') return typeof model[method] === 'function' ? model[method].bind(model) : model[method];
            return async args => {
              const p = await model.findUnique(args);
              if (args.where.id === partId(key) && mutation) { const work = mutation; mutation = null; await work(); }
              return p;
            };
          }
        });
        return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
      }
    });
    const baseline = baselineRunner();
    if (baseline) await check('uploaded136 falsely reports alreadyVerified after a committed source-epoch invalidation', async () => {
      const old = await part('a');
      const result = await baseline.api.verifyPartitionPage({ db: racedDb('a', () => remove('a', 1)), partitionId: old.id, directory: restored });
      assert.equal(result.alreadyVerified, true);
      const current = await part('a'); assert.equal(current.state, 'PENDING'); assert.equal(current.sourceEpoch, old.sourceEpoch + 1n);
      baselineEvidence.push({ fault: 'stale alreadyVerified success after lifecycle deletion', sourceHash: baseline.sourceHash,
        returnedVerified: true, databaseState: current.state, sourceEpoch: String(current.sourceEpoch) });
    });
    await check('current verification rejects the same committed invalidation before reporting success', async () => {
      await assert.rejects(runner.verifyPartitionPage({ db: racedDb('b', () => remove('b', 1)), partitionId: partId('b'), directory: restored }),
        { code: 'PHASE7_ARCHIVE_VERIFY_STALE' });
      assert.equal((await part('b')).state, 'PENDING');
    });
    await check('an old export owner cannot advance or block a lifecycle-created source epoch', async () => {
      const p = await runner.claimPartition(db, { onlyId: partId('b') });
      await remove('b', 2);
      await assert.rejects(runner.processPartition({ db, partition: p, directory: exported, limit: 1 }), { code: 'PHASE7_STALE_PARTITION_OWNER' });
      const current = await part('b'); assert.equal(current.sourceEpoch, p.sourceEpoch + 1n);
      assert.equal(current.state, 'PENDING'); assert.equal(current.cursor, null); assert.equal(current.ownerToken, null);
    });
    await check('injected busy authority rolls back lifecycle deletion and preserves the export lease for retry', async () => {
      const p = await runner.claimPartition(db, { onlyId: partId('b') });
      const definition = (await db.$queryRawUnsafe("SELECT pg_get_functiondef('phase7_lock_retirement_cohort(text)'::regprocedure) AS body"))[0].body;
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION phase7_lock_retirement_cohort(cohort_id text) RETURNS "Phase7RetirementCohort"
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PHASE7_RETIREMENT_BUSY' USING ERRCODE='55P03'; END $$`);
      try {
        const before = await db.phase7RetirementProof.count();
        await assert.rejects(remove('b', 3), e => e.message.includes('PHASE7_RETIREMENT_BUSY'));
        assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "AnalyticsSnapshot" WHERE "id"=$1', 'b-3'))[0].n, 1);
        assert.equal(await db.phase7RetirementProof.count(), before);
        await assert.rejects(runner.processPartition({ db, partition: p, directory: exported, limit: 1 }),
          e => e.code === 'PHASE7_RETIREMENT_BUSY' && e.retryable === true);
        const current = await part('b'); assert.equal(current.state, 'RUNNING');
        assert.equal(current.ownerToken, p.ownerToken); assert.equal(current.leaseRevision, p.leaseRevision);
        assert.equal(current.cursor, p.cursor); assert.equal(current.sequence, p.sequence);
      } finally { await db.$executeRawUnsafe(definition); }
      await db.$executeRawUnsafe('UPDATE "Phase7RetirementPartition" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE "id"=$1', p.id);
      const next = await runner.claimPartition(db, { onlyId: p.id });
      assert.ok(next.leaseRevision > p.leaseRevision); assert.notEqual(next.ownerToken, p.ownerToken);
      await runner.processPartition({ db, partition: next, directory: exported, limit: 1 });
      // drain also revisits previously VERIFIED partitions only when invalidated.
    });
    // The remaining uninvalidated partitions are already VERIFIED.
    const completeArchives = async () => {
      for (let i = 0; i < 40; i++) { const p = await runner.claimPartition(db); if (!p) break; await runner.processPartition({ db, partition: p, directory: exported, limit: 1 }); }
      await fs.cp(exported, restored, { recursive: true });
      for (let i = 0; i < 40; i++) { const p = await db.phase7RetirementPartition.findFirst({ where: { state: 'EXPORTED' } }); if (!p) break; await runner.verifyPartitionPage({ db, partitionId: p.id, directory: restored }); }
      assert.equal(await db.phase7RetirementPartition.count({ where: { state: { not: 'VERIFIED' } } }), 0);
    };
    await check('reclaimed source epochs rebuild verifiable chains and retain previous immutable receipts', async () => {
      await completeArchives();
      assert.equal((await part('b')).rows, 1n);
      assert.equal(await db.phase7RetirementChunk.count({ where: { partitionId: partId('b'), sourceEpoch: 1n } }), 3);
      assert.equal((await storage.storageState(db)).phase, 'BRIDGE');
    });
    await db.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.$executeRawUnsafe('CREATE ROLE retirement_runtime NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');
    const desktop = path.join(temp, 'desktop'); await fs.mkdir(desktop); await fs.writeFile(path.join(desktop, 'app.js'), '// synthetic\n');
    const sources = require('../database/phase7-release-source'), releaseFile = path.join(temp, 'release.json');
    await sources.writeRelease({ backendRoot: root, desktopRoot: desktop, baseBackendRoot: root, baseDesktopRoot: desktop, packageId: 'ISOLATED137_PROOF', output: releaseFile });
    const release = await sources.readRelease(root, { file: releaseFile }), now = Date.now(), iso = n => new Date(n).toISOString();
    const operatorEvidence = { version: 1, generation: storage.manifest.generation, ...release, operator: 'ISOLATED SYNTHETIC PROOF', noOldBinariesRemain: true,
      rollbackMode: 'restore_database_and_matching_sources', rollbackWindow: { openedAt: iso(now - 10000), closedAt: iso(now) },
      stoppedBinaries: [['backend', release.baseBackendHash], ['desktop', release.baseDesktopHash]].map(([component, sourceHash]) => ({ component, sourceHash, scope: 'synthetic fixture', stoppedAt: iso(now - 1) })),
      archive: { durability: 'persistent_backup', exportRoot: storage.sha(exported), restoreRoot: storage.sha(restored), backupId: 'SYNTHETIC_NOT_PRODUCTION', restoredAt: iso(now), retentionUntil: iso(now + 3600000) } };
    const prepare = () => finalizer.prepareContract({ db, release, closeRollback: true, operatorEvidence, runtimeRoles: ['retirement_runtime'] });
    await check('prepared admission is invalidated atomically by a legitimate lifecycle deletion', async () => {
      assert.equal((await prepare()).ready, true);
      await remove('c', 1);
      const cohort = await db.phase7RetirementCohort.findUnique({ where: { id: 'analytics_compat' } });
      assert.equal(cohort.state, 'DRAINING'); assert.equal(cohort.verifiedAt, null);
      assert.equal((await part('c')).state, 'PENDING');
      await assert.rejects(finalizer.checkContractReady(db, { root, releaseFile }), { code: 'PHASE7_CONTRACT_NOT_PREPARED' });
      await assert.rejects(prepare(), { code: 'PHASE7_PARTITION_UNVERIFIED' });
      await completeArchives(); assert.equal((await prepare()).ready, true);
      assert.equal((await finalizer.checkContractReady(db, { root, releaseFile })).ready, true);
    });
    await check('a closed cohort refuses partition resume without changing the supplied damaged row', async () => {
      await db.$executeRawUnsafe('UPDATE "Phase7RetirementPartition" SET state=\'BLOCKED\' WHERE id=$1', partId('c'));
      await assert.rejects(runner.resumePartition({ db, id: partId('c') }), { code: 'PHASE7_COHORT_CLOSED' });
      assert.equal((await part('c')).state, 'BLOCKED');
      await db.$executeRawUnsafe('UPDATE "Phase7RetirementPartition" SET state=\'VERIFIED\' WHERE id=$1', partId('c'));
      assert.equal((await runner.verifyPartitionPage({ db, partitionId: partId('c'), directory: restored })).alreadyVerified, true);
    });
  } catch (cause) { error = cause; throw cause; }
  finally {
    let cleanupError;
    try { if (f) await f.close(); } catch (cause) { cleanupError = cause; }
    try { await fs.rm(temp, { recursive: true, force: true }); } catch (cause) { cleanupError ||= cause; }
    clearInterval(keepAlive);
    if (process.env.PHASE7_PROOF_OUTPUT) await fs.writeFile(process.env.PHASE7_PROOF_OUTPUT, JSON.stringify({ ok: !error && !cleanupError,
      runtime: process.version, engine: 'PGlite 0.5.8 + real Prisma 5.22; one physical session', retainedMigrations: f?.migrations.length,
      nativeConcurrency: false, productionAccessed: false, syntheticBackup: true, faultInjection: ['chunk insert exception', 'cohort authority busy SQLSTATE55P03', 'closed-cohort damaged partition'],
      baselineReplay: 'uploaded136 runner function bodies with current dependencies and SQL fixture', baselineEvidence, cases,
      error: error || cleanupError ? { code: (error || cleanupError).code, message: (error || cleanupError).message } : null }, null, 2) + '\n');
    if (cleanupError && !error) throw cleanupError;
  }
  console.log('PHASE7_RETIREMENT_SQL_PROOF_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
