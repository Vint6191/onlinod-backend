'use strict';
// Disposable local PostgreSQL WASM only; fixture replaces all DB URLs.
const { fixture, scope } = require('./fixture.cjs');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const alive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error('CAPACITY_PROOF_DEADLINE'); process.exit(2); }, 180000);
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS', name); };
async function main() {
  const f = await fixture({ newMigrations: false }), { db, pg, root } = f;
  try {
    const s = await scope(db);
    const kernel = require(path.join(root, 'src/services/db-commit-kernel'));
    const debt = require(path.join(root, 'src/services/provider-capacity-debt-authority-service'));
    const projection = require(path.join(root, 'src/services/provider-capacity-projection-service'));
    const postflight = require(path.join(root, 'scripts/database/provider-capacity-catalog-postflight'));
    const migration = fs.readFileSync(path.join(root, 'prisma/migrations/20261009000000_current_baseline/migration.sql'), 'utf8');
    const sql = async query => { await db.$disconnect(); await pg.exec('DISCARD ALL'); return pg.exec(query); };
    const state = async () => (await db.$queryRawUnsafe('SELECT * FROM "ProviderCapacityProjectionState"'))[0];
    const snapshot = () => debt.readProviderCapacityDebtSnapshot({ db });
    const currentJobs = [
      { id: 'live-earnings', jobKey: 'fetch_earnings', status: 'PAUSED' },
      { id: 'live-dialog', jobKey: 'dialog_intelligence_scan', status: 'SCHEDULED' },
      { id: 'live-fan', jobKey: 'fan_data_point_refresh', status: 'SCHEDULED' },
    ];
    await kernel.runRootCommit(db, async ({ tx }) => tx.jobInstance.createMany({ data: [
      ...Array.from({ length: 205 }, (_, i) => ({ id: 'old-traffic-' + String(i).padStart(4, '0'), jobKey: 'traffic_sources_scan', status: ['SCHEDULED', 'CLAIMED', 'PAUSED'][i % 3] })),
      ...currentJobs,
    ].map(row => ({ ...row, agencyId: s.agencyId, creatorId: s.creatorId, scope: 'creator' })) }));
    // Realistic populated old cache, including a saved completed bootstrap. All
    // canonical rows also carry their real trigger-created durable dirty keys.
    await sql(`INSERT INTO "ProviderCapacityContribution"(kind,"sourceId",bucket,"itemCount","oldestAt")
      SELECT 'job',id,'job:'||"jobKey",1,"scheduledAt" FROM "JobInstance";
      INSERT INTO "ProviderCapacityBucket"(bucket,"itemCount") SELECT bucket,SUM("itemCount") FROM "ProviderCapacityContribution" GROUP BY bucket;
      UPDATE "ProviderCapacityProjectionState" SET revision=8,"directoryComplete"=true,"fanComplete"=true,"jobComplete"=true,
      "directoryCursor"='saved-directory',"fanCursor"='saved-fan',"jobCursor"='saved-job';`);
    await kernel.runRootCommit(db, async ({ tx }) => {
      await tx.$queryRawUnsafe("SELECT set_config('onlinod.capacity_projection_revision','8',true)");
      return debt.persistProviderCapacityDebtSnapshot({ db: tx, snapshot: debt.deriveProviderCapacityDebtSnapshot({
        backgroundOther: { pendingJobs: 207, pendingJobClasses: 3 }, fanData: { pendingJobs: 1 }, projection: { complete: true, revision: 8n },
      }) });
    });
    for (const name of ['20261009000000_current_baseline', '20261009000000_current_baseline'])
      await sql(fs.readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8'));
    await require(path.join(root, 'scripts/database/analytics-traffic-indexes')).ensureIndexes(db, { create: true });
    const before = await state(), originalDebt = await snapshot();
    const dirtyBefore = await db.providerCapacityDirty.count();
    await check('Actual103 failure reproduced on populated full schema; runtime and deploy reject 12 vs 11 without consuming debt', async () => {
      await assert.rejects(debt.refreshProviderCapacityDebtSnapshot({ db }), { code: 'CAPACITY_PROJECTION_CATALOG_CHANGED' });
      await assert.rejects(postflight.verifyCapacityCatalog(db), { code: 'CAPACITY_PROJECTION_CATALOG_CHANGED' });
      assert.equal(await db.providerCapacityDirty.count(), dirtyBefore); assert.deepEqual(await state(), before); assert.deepEqual(await snapshot(), originalDebt);
    });
    await check('failed catalog transition rolls back BOTH the catalog and snapshot; old cursors and dirty signals survive', async () => {
      await sql(`CREATE FUNCTION qa_reject_capacity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_TRANSITION_FAULT'; END $$;
        CREATE TRIGGER z_qa_reject_capacity BEFORE UPDATE ON "ProviderCapacityDebtState" FOR EACH ROW EXECUTE FUNCTION qa_reject_capacity();`);
      await assert.rejects(sql(migration), /QA_TRANSITION_FAULT/); await pg.exec('ROLLBACK');
      await pg.exec('DROP TRIGGER z_qa_reject_capacity ON "ProviderCapacityDebtState"; DROP FUNCTION qa_reject_capacity();');
      assert.deepEqual(await state(), before); assert.deepEqual(await snapshot(), originalDebt); assert.equal(await db.providerCapacityDirty.count(), dirtyBefore);
    });
    await check('forward migration switches catalog atomically, invalidates the old snapshot and preserves all bootstrap progress', async () => {
      await sql(migration); const after = await state(), saved = await snapshot();
      assert.equal(after.jobKeys.length, 11); assert(!after.jobKeys.includes('traffic_sources_scan')); assert.equal(after.revision, 9n);
      for (const key of ['directoryCursor','directoryComplete','fanCursor','fanComplete','jobCursor','jobComplete']) assert.equal(after[key], before[key]);
      assert.equal(saved.status, 'UNKNOWN'); assert.equal(saved.controlMode, 'CONSERVATIVE'); assert.equal(saved.projectionCoverageStatus, 'PARTIAL');
      assert.equal(saved.projectionRevision, after.revision); assert.equal(saved.campaignDirectoryAdmissionBudgetCalls, saved.campaignDirectoryGuaranteedCallsPerSweep);
      assert.equal(await db.providerCapacityDirty.count(), dirtyBefore); assert.equal((await postflight.verifyCapacityCatalog(db)).ready, true);
    });
    async function drainCapacity(size = 6) {
      for (let i = 0; i < 100; i++) {
        const result = await debt.refreshProviderCapacityDebtSnapshot({ db, batchSize: size });
        assert.equal(result.scanned, 0, 'subtractive transition must not restart a completed historical bootstrap');
        assert(result.processed <= size); if (result.projectionComplete) return i + 1;
      }
      throw Error('capacity queue did not converge');
    }
    await check('bounded repair removes the retired debt and preserves active classes; current totals equal canonical diagnostic query', async () => {
      assert((await drainCapacity()) > 30);
      const saved = await snapshot(); assert.equal(saved.backgroundOtherPendingJobs, 2); assert.equal(saved.fanDataPendingJobs, 1);
      assert.equal(saved.backgroundOtherPendingJobClasses, 2); assert.equal(saved.projectionCoverageStatus, 'COMPLETE_AT_SAMPLE');
      const inputs = await debt.readCanonicalCapacityInputs({ db, now: saved.sampledAt });
      const canonical = debt.deriveProviderCapacityDebtSnapshot({ now: saved.sampledAt, ...inputs });
      for (const key of ['backgroundOtherPendingJobs','backgroundOtherPendingJobClasses','fanDataPendingJobs','fanDataUnsatisfiedDemands','campaignDirectoryRequiredCalls']) assert.equal(saved[key], canonical[key]);
      assert.equal(await db.providerCapacityContribution.count({ where: { bucket: 'job:traffic_sources_scan' } }), 0);
      assert.equal((await db.providerCapacityBucket.findUnique({ where: { bucket: 'job:traffic_sources_scan' } })).itemCount, 0n);
    });
    await check('existing Traffic retirement drains 205 old jobs in bounded work and leaves current jobs untouched', async () => {
      const traffic = require(path.join(root, 'src/services/traffic-projection-service'));
      let turns = 0;
      for (; turns < 30; turns++) {
        const result = await traffic.runTrafficProjectionSweep({ db }); assert.equal(result.ok, true, JSON.stringify(result));
        if (!await db.jobInstance.count({ where: { jobKey: 'traffic_sources_scan', status: { in: ['SCHEDULED','CLAIMED','PAUSED'] } } })) break;
      }
      assert(turns < 30); assert.equal(await db.jobInstance.count({ where: { jobKey: 'traffic_sources_scan', status: 'CANCELLED' } }), 205);
      await drainCapacity();
      for (const row of currentJobs) assert.equal((await db.jobInstance.findUnique({ where: { id: row.id } })).status, row.status);
      assert.equal((await snapshot()).backgroundOtherPendingJobs, 2);
    });
    await check('interrupted publication rolls back contribution changes and dirty deletion; retry converges exactly once', async () => {
      await kernel.runRootCommit(db, ({ tx }) => tx.jobInstance.update({ where: { id: 'live-dialog' }, data: { status: 'CANCELLED' } }));
      const oldState = await state(), oldDebt = await snapshot(), pending = await db.providerCapacityDirty.count();
      await assert.rejects(projection.runProviderCapacityProjectionBatch({ db, publish: async () => { throw Error('QA_PUBLICATION_FAULT'); } }), /QA_PUBLICATION_FAULT/);
      assert.deepEqual(await state(), oldState); assert.deepEqual(await snapshot(), oldDebt); assert.equal(await db.providerCapacityDirty.count(), pending);
      await drainCapacity(); assert.equal((await snapshot()).backgroundOtherPendingJobs, 1);
    });
    await check('reapplying the exact transition is a no-op and does not invalidate a new runtime snapshot', async () => {
      const oldState = await state(), oldDebt = await snapshot(); await sql(migration);
      assert.deepEqual(await state(), oldState); assert.deepEqual(await snapshot(), oldDebt);
    });
    await check('unknown catalog is rejected by SQL transition as well as runtime; no automatic oscillation across releases', async () => {
      await db.$executeRawUnsafe(`UPDATE "ProviderCapacityProjectionState" SET "jobKeys"=ARRAY['unknown']`);
      const oldState = await state(), oldDebt = await snapshot();
      await assert.rejects(sql(migration), /CAPACITY_CATALOG_TRANSITION_SOURCE_MISMATCH/); await pg.exec('ROLLBACK');
      assert.deepEqual(await state(), oldState); assert.deepEqual(await snapshot(), oldDebt);
      await assert.rejects(debt.refreshProviderCapacityDebtSnapshot({ db }), { code: 'CAPACITY_PROJECTION_CATALOG_CHANGED' });
    });
    console.log(JSON.stringify({ ok: true, checks, retiredJobs: 205, nativeConcurrency: false, runtime: process.version }, null, 2));
  } finally { await f.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => { clearInterval(alive); clearTimeout(deadline); });
