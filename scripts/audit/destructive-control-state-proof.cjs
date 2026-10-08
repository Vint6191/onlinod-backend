'use strict';
// Disposable current-schema SQL proof. No DATABASE_URL is used and no claim is
// made about native PostgreSQL concurrency or production deletion acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAdminSqlRuntime } = require('../test-support/admin-sql-runtime.cjs');
const { purgeCreatorNonFkPhase2Batch, purgeAgencyNonFkTenantBatch } = require('../../src/services/phase2-destructive-delete-authority-service');

async function main() {
  const f = await createAdminSqlRuntime({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME });
  const { db } = f;
  const models = ['operationalControlState', 'dialogControlResumeDemand'];
  const checks = [];
  const snapshot = async () => Object.fromEntries(await Promise.all(models.map(async model =>
    [model, await db[model].findMany({ orderBy: { id: 'asc' } })])));
  try {
    for (const model of models) {
      const rows = [
        ...Array.from({ length: 4 }, (_, i) => ({ id: model + '-target-' + i, agencyId: 'agency-a', creatorId: 'creator-a' })),
        { id: model + '-other-creator', agencyId: 'agency-a', creatorId: 'creator-b' },
        { id: model + '-other-agency', agencyId: 'agency-b', creatorId: 'creator-a' },
      ];
      await db[model].createMany({ data: rows.map(row => ({ ...row,
        ...(model === 'operationalControlState' ? { family: row.id } : { moduleUpdatedAt: new Date() }),
      })) });
    }
    const before = await snapshot();
    await assert.rejects(db.$transaction(async tx => {
      const result = await purgeCreatorNonFkPhase2Batch({ tx, agencyId: 'agency-a', creatorId: 'creator-a', limit: 3 });
      assert.equal(result.deleted, 3);
      throw Error('fixture rollback');
    }), /fixture rollback/);
    assert.deepEqual(await snapshot(), before);
    checks.push({ name: 'creator cleanup rolls back atomically', passed: true });

    let total = 0;
    const batches = [];
    for (let i = 0; i < 5; i++) {
      const result = await db.$transaction(tx => purgeCreatorNonFkPhase2Batch({ tx, agencyId: 'agency-a', creatorId: 'creator-a', limit: 3 }));
      assert(result.deleted <= 3);
      total += result.deleted;
      batches.push(result.deleted);
      for (const model of models) {
        assert.equal(await db[model].count({ where: { agencyId: 'agency-b', creatorId: 'creator-a' } }), 1);
        assert.equal(await db[model].count({ where: { agencyId: 'agency-a', creatorId: 'creator-b' } }), 1);
      }
      if (!result.exhausted) break;
    }
    assert.equal(total, 8);
    for (const model of models) assert.equal(await db[model].count({ where: { agencyId: 'agency-a', creatorId: 'creator-a' } }), 0);
    checks.push({ name: 'creator cleanup is bounded, restartable and exact in both agency and creator', passed: true, batches, deleted: total });

    const retained = await snapshot();
    await assert.rejects(db.$transaction(async tx => {
      assert.equal((await purgeAgencyNonFkTenantBatch({ tx, agencyId: 'agency-a', limit: 1 })).deleted, 1);
      throw Error('fixture rollback');
    }), /fixture rollback/);
    assert.deepEqual(await snapshot(), retained);
    const agencyBatches = [];
    for (let i = 0; i < 3; i++) {
      const result = await db.$transaction(tx => purgeAgencyNonFkTenantBatch({ tx, agencyId: 'agency-a', limit: 1 }));
      assert(result.deleted <= 1);
      agencyBatches.push(result.deleted);
      if (!result.exhausted) break;
    }
    assert.deepEqual(agencyBatches, [1, 1, 0]);
    for (const model of models) {
      assert.equal(await db[model].count({ where: { agencyId: 'agency-a' } }), 0);
      assert.equal(await db[model].count({ where: { agencyId: 'agency-b' } }), 1);
    }
    checks.push({ name: 'agency cleanup is bounded, rollback-safe and leaves other agencies intact', passed: true, batches: agencyBatches });
    const result = { ok: true, runtime: process.version, engine: 'PGlite', migrations: f.migrations.length,
      nativePostgres: false, productionAccessed: false, checks };
    if (process.env.ONLINOD_DESTRUCTIVE_CONTROL_EVIDENCE) {
      const output = path.resolve(process.env.ONLINOD_DESTRUCTIVE_CONTROL_EVIDENCE);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { await f.close(); }
}
const alive = setInterval(() => {}, 1000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(alive));
