'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path');
const vm = require('node:vm'), { createRequire } = require('node:module');
const { createHash } = require('node:crypto'), { spawn } = require('node:child_process');
const { disconnectAll } = require('../../scripts/database/phase7-deploy-lifecycle');
const entry = path.resolve(__dirname, '../../scripts/database/phase7-deploy.js');
const root = path.resolve(__dirname, '../..');

async function deployment(t, { point, existing = false, contract = false, cleanupFails = false } = {}) {
  const controller = new AbortController(), events = [], receipts = [];
  let staged, admission = 0, firstCommand = true, migrated = false;
  const hit = name => { events.push(name); if (point === name) controller.abort('SIGTERM'); };
  const names = (await fs.readdir(path.join(root, 'prisma/migrations'), { withFileTypes: true }))
    .filter(x => x.isDirectory()).map(x => x.name).sort();
  const first = names[0], bytes = await fs.readFile(path.join(root, 'prisma/migrations', first, 'migration.sql'));
  const db = {
    async $disconnect() { hit('disconnect'); },
    async $queryRawUnsafe(sql) {
      if (sql.includes("to_regclass('public._prisma_migrations')")) { hit('history'); return [{ name: existing || migrated ? '_prisma_migrations' : null }]; }
      if (sql.startsWith('SELECT migration_name,checksum,')) { hit('receipts'); return (migrated ? names.filter(name => contract || name !== '20260930190000_phase7_legacy_storage_contract_v1') : [first]).map(name => ({ migration_name: name, checksum: createHash('sha256').update(sync.readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'))).digest('hex'), finished_at: new Date('2026-10-08T00:00:00Z'), rolled_back_at: null })); }
      if (sql.includes("c.relname<>'_prisma_migrations'")) { hit('empty-catalog'); return []; }
      throw new Error('unexpected fixture SQL');
    },
  };
  const module = { exports: {} }, load = createRequire(entry);
  vm.runInNewContext(sync.readFileSync(entry, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(entry), process,
    console: { log() {} }, require(id) {
      if (id === './phase7-deploy-authority') return { withDeploymentAuthority: async (options, work) => work({ signal: options.signal, assertCurrent: async () => {} }) };
      if (id === 'node:fs/promises') return { ...fs,
        async mkdtemp(...args) { staged = await fs.mkdtemp(...args); hit('allocate'); return staged; },
        async copyFile(...args) { await fs.copyFile(...args); if (args[1].endsWith('schema.prisma')) hit('stage-schema'); },
        async cp(...args) { await fs.cp(...args); hit('stage-migration'); },
        async rm(...args) { events.push('cleanup'); if (cleanupFails) throw new Error('fixture cleanup failed'); return fs.rm(...args); },
      };
      if (id === './phase7-role-preflight') return { inspectRoles: async () => { hit('roles'); return {}; } };
      if (id === '../../src/services/phase7-legacy-storage-service') return { storageState: async () => { hit('storage'); return { phase: 'BRIDGE' }; } };
      if (id === '../../src/services/phase7-retirement-finalizer') return { checkContractReady: async () => { hit(++admission === 1 ? 'admission' : 'readmission'); return { ready: true, release: {} }; } };
      if (id === './phase7-release-source') return { verifyStagedRelease: async () => hit('stage-verification'), sameRelease() {} };
      return load(id);
    },
  }, { filename: entry });
  t.after(async () => { if (staged) await fs.rm(staged, { recursive: true, force: true }); });
  return { events, receipts, get staged() { return staged; }, async run() {
    if (point === 'pre-aborted') controller.abort('SIGTERM');
    return module.exports.main({ db, contract, signal: controller.signal, emitResult: value => receipts.push(value), commandRunner: async args => {
      if (args[1] === 'migrate') migrated = true;
      hit(args[1] === 'migrate' ? 'migration-child' : path.basename(args[0]) === 'phase7-legacy-storage-indexes.js' ? 'final-child' : 'hook');
      if (firstCommand) { firstCommand = false; hit('first-child'); }
    } });
  } };
}

for (const point of ['pre-aborted', 'history', 'empty-catalog', 'roles', 'disconnect', 'allocate', 'stage-schema', 'stage-migration', 'migration-child', 'final-child', 'storage']) {
  test(`deploy cancellation at ${point} refuses success and cleans owned staging`, async t => {
    const f = await deployment(t, { point });
    await assert.rejects(f.run(), { code: 'PHASE7_DEPLOY_INTERRUPTED' });
    assert.equal(f.receipts.length, 0);
    if (f.staged) await assert.rejects(fs.stat(f.staged), { code: 'ENOENT' });
    if (!['final-child', 'storage'].includes(point)) assert(!f.events.includes('storage'));
    if (['pre-aborted', 'history', 'empty-catalog', 'roles', 'disconnect', 'allocate', 'stage-schema', 'stage-migration'].includes(point)) assert(!f.events.includes('first-child'));
    if (point === 'migration-child') assert(!f.events.includes('hook'));
  });
}

test('cancellation after an existing-database preflight cannot start the next preflight or Prisma', async t => {
  const f = await deployment(t, { point: 'first-child', existing: true });
  await assert.rejects(f.run(), { code: 'PHASE7_DEPLOY_INTERRUPTED' });
  assert.equal(f.events.filter(x => x === 'hook').length, 1);
  assert(!f.events.includes('migration-child')); assert.equal(f.staged, undefined);
});

for (const point of ['receipts', 'admission', 'stage-verification', 'readmission']) {
  test(`contract cancellation at ${point} cannot reach the destructive migration child`, async t => {
    const f = await deployment(t, { point, existing: true, contract: true });
    await assert.rejects(f.run(), { code: 'PHASE7_DEPLOY_INTERRUPTED' });
    assert(!f.events.includes('migration-child')); assert.equal(f.receipts.length, 0);
    if (f.staged) await assert.rejects(fs.stat(f.staged), { code: 'ENOENT' });
  });
}

test('cleanup failure retains interruption diagnostics and cannot publish success', async t => {
  const f = await deployment(t, { point: 'stage-schema', cleanupFails: true });
  await assert.rejects(f.run(), error => error.code === 'PHASE7_DEPLOY_INTERRUPTED' && error.cleanupErrors[0].message === 'fixture cleanup failed');
  assert.equal(f.receipts.length, 0);
});

test('all independent clients are disconnected even if one disconnect rejects', async () => {
  const calls = [], a = { async $disconnect() { calls.push('a'); throw new Error('failure'); } }, b = { async $disconnect() { calls.push('b'); } };
  await assert.rejects(disconnectAll([a, b, a]), { code: 'PHASE7_CLEANUP_FAILED' });
  assert.deepEqual(calls, ['a', 'b']);
});

function cli(point, signal = 'SIGTERM') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'test-support/phase7-deploy-interrupt-preload.cjs'), entry], {
      cwd: root, env: { ...process.env, PHASE7_INTERRUPT_TEST_POINT: point, PHASE7_INTERRUPT_TEST_SIGNAL: signal }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', (code, exitSignal) => { clearTimeout(timer); resolve({ code, exitSignal, stdout, stderr }); });
  });
}

for (const point of ['history', 'child-completion', 'storage', 'disconnect']) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`real deploy CLI ${signal} at ${point} returns cancellation without a success receipt`, async () => {
      const result = await cli(point, signal);
      assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, result.stderr);
      assert.equal(result.exitSignal, null); assert.doesNotMatch(result.stdout, /"ok":true/);
      assert.match(result.stderr, /PHASE7_DEPLOY_INTERRUPTED/);
    });
  }
}

test('deploy CLI publishes success only after final disconnect completes', async () => {
  const result = await cli('success');
  assert.equal(result.code, 0, result.stderr);
  assert(result.stdout.indexOf('FIXTURE_FINAL_DISCONNECT') < result.stdout.indexOf('"ok":true'));
});

test('final disconnect error prevents deploy CLI success', async () => {
  const result = await cli('disconnect-error');
  assert.equal(result.code, 1); assert.doesNotMatch(result.stdout, /"ok":true/);
  assert.match(result.stderr, /PHASE7_CLEANUP_FAILED/);
});
