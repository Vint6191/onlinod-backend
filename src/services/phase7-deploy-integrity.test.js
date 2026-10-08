'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path');
const vm = require('node:vm'), { createRequire } = require('node:module'), { createHash } = require('node:crypto');
const root = process.env.ONLINOD_DEPLOY_SOURCE_ROOT || path.resolve(__dirname, '../..'), entry = path.join(root, 'scripts/database/phase7-deploy.js');
const contract = '20260930190000_phase7_legacy_storage_contract_v1';
const names = sync.readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true })
  .filter(x => x.isDirectory() && x.name !== contract).map(x => x.name).sort();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const history = () => names.map(name => ({ migration_name: name,
  checksum: sha(sync.readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'))),
  finished_at: new Date('2026-10-08T00:00:00Z'), rolled_back_at: null }));

function fixture({ duplicate = false, initiallyEmpty = false, missingAfterMigrate = false, corruptAfterHooks = false, rewriteReceipt = false,
                   tamperSchema = false, tamperMigration = false } = {}) {
  let rows = history(), migrations = 0, post = 0, disconnects = 0;
  if (initiallyEmpty) rows = [];
  if (duplicate) rows.push({ ...rows[0] });
  const receipts = [], calls = [], load = createRequire(entry), module = { exports: {} };
  const db = {
    async $disconnect() { disconnects++; },
    async $queryRawUnsafe(sql) {
      if (sql.includes("to_regclass('public._prisma_migrations')")) return [{ name: '_prisma_migrations' }];
      if (sql.startsWith('SELECT migration_name,checksum,')) return structuredClone(rows);
      if (sql.includes("c.relname<>'_prisma_migrations'")) return [];
      throw new Error('Unexpected fixture SQL: ' + sql);
    },
  };
  vm.runInNewContext(sync.readFileSync(entry, 'utf8'), {
    module, exports: module.exports, process, __dirname: path.dirname(entry), console: { log() {} },
    require(id) {
      if (id === './phase7-deploy-authority') return { withDeploymentAuthority: async (options, work) => work({ signal: options.signal, assertCurrent: async () => {} }) };
      if (id === './phase7-role-preflight') return { inspectRoles: async () => ({ verified: true }) };
      if (id === '../../src/services/phase7-legacy-storage-service') return { storageState: async () => ({ phase: 'BRIDGE', targetReady: false }) };
      if (id === 'node:fs/promises') return { ...fs,
        async copyFile(from, to) {
          await fs.copyFile(from, to);
          if (tamperSchema && to.endsWith('/schema.prisma')) await fs.appendFile(to, '\n// tampered staged bytes\n');
        },
        async cp(from, to, options) {
          await fs.cp(from, to, options);
          if (tamperMigration && path.basename(from) === names[0]) await fs.appendFile(path.join(to, 'migration.sql'), '\n-- tampered staged bytes\n');
        },
      };
      return load(id);
    },
  }, { filename: entry });
  return { receipts, calls, get migrations() { return migrations; }, get post() { return post; },
    run: () => module.exports.main({ db, emitResult: value => receipts.push(value), commandRunner: async args => {
      calls.push(path.basename(args[0]));
      if (args[1] === 'migrate') { migrations++; if (initiallyEmpty) rows = history(); if (missingAfterMigrate) rows.pop(); }
      else if (migrations) { post++; if (corruptAfterHooks) rows[0].checksum = '0'.repeat(64); if (rewriteReceipt) rows[0].finished_at = new Date('2026-10-08T01:00:00Z'); }
    } }),
  };
}

test('deploy rejects duplicate successful receipts before starting a child', async () => {
  const f = fixture({ duplicate: true });
  await assert.rejects(f.run(), /PHASE7_DUPLICATE_APPLIED_MIGRATION/);
  assert.equal(f.calls.length, 0); assert.equal(f.receipts.length, 0);
});
test('zero migration exit cannot authorize postflight work with an incomplete ledger', async () => {
  const f = fixture({ missingAfterMigrate: true });
  await assert.rejects(f.run(), /PHASE7_MIGRATION_LEDGER_INCOMPLETE/);
  assert.equal(f.migrations, 1); assert.equal(f.post, 0); assert.equal(f.receipts.length, 0);
});
test('history corruption during postflights prevents the final success receipt', async () => {
  const f = fixture({ corruptAfterHooks: true });
  await assert.rejects(f.run(), /PHASE7_MIGRATION_CHECKSUM_MISMATCH/);
  assert.equal(f.migrations, 1); assert(f.post > 0); assert.equal(f.receipts.length, 0);
});
test('an existing receipt cannot be silently replaced while preserving its SQL checksum', async () => {
  const f = fixture({ rewriteReceipt: true });
  await assert.rejects(f.run(), /PHASE7_MIGRATION_RECEIPT_CHANGED/);
  assert.equal(f.receipts.length, 0);
});
test('freshly created migration receipts are also pinned across the postflight stages', async () => {
  const f = fixture({ initiallyEmpty: true, rewriteReceipt: true });
  await assert.rejects(f.run(), /PHASE7_MIGRATION_RECEIPT_CHANGED/);
  assert.equal(f.migrations, 1); assert.equal(f.receipts.length, 0);
});
for (const mode of ['tamperSchema', 'tamperMigration']) {
  test(`ordinary deployment verifies ${mode} before Prisma can execute the staged source`, async () => {
    const f = fixture({ [mode]: true });
    await assert.rejects(f.run(), /PHASE7_STAGED_SOURCE_MISMATCH/);
    assert.equal(f.migrations, 0); assert.equal(f.receipts.length, 0);
  });
}
test('unchanged complete migration history retains every hook and yields one receipt', async () => {
  const f = fixture();
  await f.run(); assert.equal(f.migrations, 1); assert.equal(f.post, 20);
  assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].ok, true);
});
