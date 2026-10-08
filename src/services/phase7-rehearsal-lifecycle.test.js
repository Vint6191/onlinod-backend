'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), { createRequire } = require('node:module'), { createHash } = require('node:crypto');
const lifecycle = require('../../scripts/database/phase7-deploy-lifecycle');
const { ownDatabase, verifyIndependentSessions } = require('../../scripts/audit/phase7-deploy-rehearsal.cjs');
const entry = path.resolve(__dirname, '../../scripts/audit/phase7-deploy-rehearsal.cjs');
const root = path.resolve(__dirname, '../..'), load = createRequire(entry);
const { PRE, POST, CONTRACT } = require('../../scripts/database/phase7-deploy');
const { stageName } = require('../../scripts/database/phase7-deploy-child');

// This exercises the actual runner's control flow with deterministic SQL and
// child-process doubles. It is NOT evidence of a native PostgreSQL rehearsal.
async function rehearsal(t, point) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'onlinod-rehearsal-lifecycle-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const output = path.join(parent, 'proof'), controller = new AbortController();
  const events = [], printed = [], disconnects = [], mutations = [];
  let exists = false, database, lockOwner = null, deploymentHeld = false, unbaselined = false, deployed = false, clients = 0, inventories = 0, disposed = false;
  const migration = '20200101000000_fixture', sql = 'SELECT 1;';
  const baseline = { id: 'receipt', migration_name: migration, checksum: createHash('sha256').update(sql).digest('hex'), finished_at: '2020-01-01T00:00:00.000Z', rolled_back_at: null };
  const row = { ...baseline };
  const hit = name => { events.push(name); if (point === name) controller.abort('SIGTERM'); };
  class PrismaClient {
    constructor(options) { this.id = ++clients; this.database = new URL(options.datasources.db.url).pathname.slice(1); }
    async $disconnect() {
      disconnects.push(this.id);
      if (this.id === 1) { hit('admin-disconnect'); if (point === 'admin-disconnect-error') throw new Error('admin disconnect failed'); }
    }
    async $queryRawUnsafe(query) {
      if (query.includes('server_version_num')) { hit('server-version'); return [{ version: 160000 }]; }
      if (query.includes('FROM pg_database')) return exists ? [{ oid: '100' }] : [];
      if (query.includes('current_database()')) return [{ database: this.database, pid: this.id, version: 'fixture' }];
      if (query.includes('pg_try_advisory_lock')) {
        const held = lockOwner === null || lockOwner === this.id;
        if (held) lockOwner = this.id;
        hit(this.id === 2 ? 'first-lock' : 'second-lock'); return [{ held }];
      }
      if (query.includes('pg_advisory_unlock')) {
        const released = lockOwner === this.id; if (released) lockOwner = null;
        events.push('unlock-' + this.id); return [{ released }];
      }
      if (query.includes('FROM "_prisma_migrations"')) return deployed ? [{ ...row }] : [];
      if (query.includes('FROM pg_indexes')) return [{ indexdef: 'fixture definition' }];
      throw new Error('unexpected fixture query: ' + query);
    }
    async $executeRawUnsafe(query, value) {
      mutations.push(query);
      if (query.startsWith('CREATE DATABASE')) { database = query.split('"')[1]; exists = true; hit('create'); }
      else if (query.startsWith('DROP DATABASE')) { exists = false; hit('drop'); }
      else if (query.startsWith('CREATE TABLE')) { unbaselined = true; hit('unbaselined-create'); }
      else if (query.startsWith('DROP TABLE')) unbaselined = false;
      else if (query.startsWith('UPDATE "_prisma_migrations"')) {
        const column = query.match(/SET "(\w+)"/)[1]; row[column] = value;
        if (value !== baseline[column]) hit('inject-' + column); else events.push('restore-' + column);
      } else if (!query.startsWith('DROP INDEX')) throw new Error('unexpected fixture mutation: ' + query);
      return 1;
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(sync.readFileSync(entry, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(entry), process, URL,
    console: { log(value) { printed.push(JSON.parse(value)); } },
    require(id) {
      if (id === '@prisma/client') return { PrismaClient };
      if (id === '../database/phase7-deploy-authority') return { async withDeploymentAuthority(options, work) {
        lifecycle.checkInterrupted(options.signal, 'fixture-owner', 'PHASE7_REHEARSAL_INTERRUPTED');
        deploymentHeld = true;
        try { return await work(); } finally { deploymentHeld = false; }
      } };
      if (id === 'node:fs/promises') return { ...fs,
        async readdir(dir, options) {
          if (dir === path.join(root, 'prisma/migrations')) return [migration, CONTRACT].map(name => ({ name, isDirectory: () => true }));
          return fs.readdir(dir, options);
        },
        async readFile(file, ...args) { return file === path.join(root, 'prisma/migrations', migration, 'migration.sql') ? Buffer.from(sql) : fs.readFile(file, ...args); },
      };
      if (id === 'node:fs') return { ...sync, renameSync(from, to) {
        if (point === 'final-save-error' && JSON.parse(sync.readFileSync(from, 'utf8')).ok) throw Object.assign(new Error('receipt rename failed'), { code: 'EIO' });
        return sync.renameSync(from, to);
      } };
      if (id === '../database/phase7-deploy-lifecycle') return { ...lifecycle,
        processInterrupts(code) { return { signal: controller.signal, check: phase => lifecycle.checkInterrupted(controller.signal, phase, code),
          exitCode: () => controller.signal.aborted ? 143 : 1, dispose() { disposed = true; } }; },
      };
      if (id === '../database/phase7-release-source') return { async inventory() { hit(++inventories === 1 ? 'initial-inventory' : 'final-inventory'); return { hash: 'fixture' }; } };
      if (id === '../database/phase7-deploy-child') return { stageName, async runStage(args, options) {
        hit('deploy');
        const refusal = deploymentHeld ? 'PHASE7_DEPLOY_ALREADY_RUNNING' : unbaselined ? 'PHASE7_UNBASELINED_DATABASE'
          : row.checksum !== baseline.checksum ? 'PHASE7_MIGRATION_CHECKSUM_MISMATCH'
          : row.finished_at === null ? 'PHASE7_FAILED_MIGRATION_REQUIRES_RESOLUTION'
          : row.migration_name !== migration ? 'PHASE7_UNKNOWN_APPLIED_MIGRATION' : null;
        if (refusal) {
          sync.writeSync(options.stdio[1], refusal + '\n');
          throw Object.assign(new Error(refusal), { phase7Diagnostics: { exitCode: 1 } });
        }
        const fresh = !deployed, pre = PRE.map(stageName), post = POST.map(stageName);
        const names = fresh ? ['prisma:migrate:deploy', ...pre, ...post] : [...pre, 'prisma:migrate:deploy', ...post];
        names.push('phase7-legacy-storage-indexes.js:--create');
        const logs = names.flatMap(stage => ['START', 'PASS'].map(status => ({ event: 'PHASE7_DEPLOY_STAGE_' + status, stage })));
        logs.push({ ok: true, fresh, storage: { phase: 'BRIDGE', targetReady: false } });
        sync.writeSync(options.stdio[1], logs.map(value => JSON.stringify(value)).join('\n') + '\n'); deployed = true;
      } };
      return load(id);
    },
  }, { filename: entry });
  return { events, printed, disconnects, mutations, row, baseline,
    get exists() { return exists; }, get database() { return database; }, get lockOwner() { return lockOwner; }, get disposed() { return disposed; },
    run: () => module.exports.main(['--output=' + output], { ONLINOD_PHASE7_REHEARSAL_ADMIN_URL: 'postgresql://owner:secret@localhost/postgres' }),
    report: async () => JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8')),
  };
}

for (const point of ['initial-inventory', 'server-version', 'create', 'first-lock', 'unbaselined-create', 'inject-checksum', 'inject-finished_at', 'inject-migration_name', 'drop', 'final-inventory', 'admin-disconnect']) {
  test(`rehearsal interrupted at ${point} cleans owned resources and saves a failed receipt`, async t => {
    const f = await rehearsal(t, point);
    await assert.rejects(f.run(), { code: 'PHASE7_REHEARSAL_INTERRUPTED', exitCode: 143 });
    assert.equal((await f.report()).ok, false);
    assert(!f.printed.some(value => value.event === 'PHASE7_REHEARSAL_PASS'));
    assert.equal(f.exists, false); assert.equal(f.lockOwner, null); assert.equal(f.disposed, true);
    if (point !== 'initial-inventory') assert(f.disconnects.includes(1));
    if (point.startsWith('inject-')) { assert.deepEqual(f.row, f.baseline); assert(f.events.includes('restore-' + point.slice(7))); }
    if (['create', 'first-lock'].includes(point)) assert(!f.events.includes('deploy'));
    if (point === 'unbaselined-create') assert.equal(f.events.filter(value => value === 'deploy').length, 1, 'only the read-only competing-deploy refusal has run');
    if (point === 'create') assert.equal(f.disconnects.length, 1, 'work clients must not be created after cancellation');
  });
}

for (const point of ['admin-disconnect-error', 'final-save-error']) {
  test(`rehearsal ${point} cannot publish PASS`, async t => {
    const f = await rehearsal(t, point);
    await assert.rejects(f.run(), point === 'final-save-error' ? { code: 'EIO' } : { code: 'PHASE7_CLEANUP_FAILED' });
    assert.equal((await f.report()).ok, false); assert.equal(f.exists, false); assert.equal(f.disposed, true);
    assert(!f.printed.some(value => value.event === 'PHASE7_REHEARSAL_PASS'));
  });
}

test('rehearsal success is committed after fixture drop, final source check and administrative disconnect', async t => {
  const f = await rehearsal(t);
  const report = await f.run();
  assert.equal(report.ok, true); assert.equal((await f.report()).ok, true);
  assert.deepEqual(f.events.slice(-3), ['drop', 'final-inventory', 'admin-disconnect']);
  assert.equal(f.printed.at(-1).event, 'PHASE7_REHEARSAL_PASS'); assert.equal(f.exists, false); assert.equal(f.disposed, true);
  assert.equal(report.stages.length, 8); assert.equal(report.deploymentAuthorityExclusion, true); assert.deepEqual(f.row, f.baseline);
});

test('pre-aborted rehearsal never creates a database', async () => {
  const controller = new AbortController(); controller.abort('SIGTERM');
  await assert.rejects(ownDatabase({ $executeRawUnsafe: () => assert.fail('CREATE must not run') }, () => {}, () => {}, { signal: controller.signal }), { code: 'PHASE7_REHEARSAL_INTERRUPTED' });
});

test('both held session locks receive cleanup attempts even if the first unlock rejects', async () => {
  const unlocked = [];
  const client = pid => ({ async $queryRawUnsafe(sql) {
    if (sql.includes('current_database()')) return [{ database: 'fixture', pid }];
    if (sql.includes('pg_advisory_unlock')) { unlocked.push(pid); if (pid === 1) throw new Error('unlock failed'); return [{ released: true }]; }
    return [{ held: true }];
  } });
  await assert.rejects(verifyIndependentSessions(client(1), client(2), 'fixture'), error => /LOCK_EXCLUSION_REQUIRED/.test(error.message) && error.cleanupErrors[0].code === 'PHASE7_CLEANUP_FAILED');
  assert.deepEqual(unlocked, [1, 2]);
});

test('an unconfirmed final advisory unlock prevents rehearsal success', async () => {
  let owner = null;
  const client = pid => ({ async $queryRawUnsafe(sql) {
    if (sql.includes('current_database()')) return [{ database: 'fixture', pid }];
    if (sql.includes('pg_advisory_unlock')) { if (pid === 2) return [{ released: false }]; owner = null; return [{ released: true }]; }
    const held = owner === null; if (held) owner = pid; return [{ held }];
  } });
  await assert.rejects(verifyIndependentSessions(client(1), client(2), 'fixture'), error => error.code === 'PHASE7_CLEANUP_FAILED' && /LOCK_RELEASE_NOT_CONFIRMED/.test(error.errors[0].message));
});
