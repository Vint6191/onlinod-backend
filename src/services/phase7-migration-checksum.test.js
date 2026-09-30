'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { migrationChecksumReport } = require('../../scripts/database/phase7-migration-checksum');
const root = path.resolve(__dirname, '../..');
const migrations = path.join(root, 'prisma/migrations');
const traffic = '20260614_traffic_core_v1';
const contract = '20260930190000_phase7_legacy_storage_contract_v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytesOf = name => fs.readFileSync(path.join(migrations, name, 'migration.sql'));
const crlf = bytes => Buffer.from(bytes.toString('utf8').replace(/\n/g, '\r\n'));
const oldHex = bytes => [...crypto.createHash('sha256').update(bytes).digest()].map(b => b.toString(16)).join('');
const row = (name, checksum = sha(bytesOf(name))) => ({ migration_name: name, checksum, finished_at: new Date('2026-09-01T00:00:00Z'), rolled_back_at: null });

// Load the real deployment module without requiring an installed Prisma client
// or a database connection. All filesystem reads and migration planning are real.
function deployment(overrides = {}) {
  const file = path.join(root, 'scripts/database/phase7-deploy.js');
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  const output = [];
  const requireForTest = id => {
    if (id === 'dotenv') return { config() {} };
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
    return nativeRequire(id);
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, require: requireForTest, __dirname: path.dirname(file),
    process, console: { log: (...args) => output.push(args), error: (...args) => output.push(args) },
  }, { filename: file });
  return { ...module.exports, output };
}
function database(applied, { hasLedger = true, tables = [] } = {}) {
  const queries = [];
  let disconnects = 0;
  return {
    queries, get disconnects() { return disconnects; },
    async $disconnect() { disconnects++; },
    async $queryRawUnsafe(sql) {
      queries.push(sql);
      if (sql.includes("to_regclass('public._prisma_migrations')")) return [{ name: hasLedger ? '_prisma_migrations' : null }];
      if (sql.startsWith('SELECT migration_name,checksum,')) return applied;
      if (sql.includes("c.relkind IN ('r','p','v')")) return tables;
      throw new Error('Unexpected SQL in readonly history gate: ' + sql);
    },
    async $executeRawUnsafe() { throw new Error('Migration history must not be written by the checksum gate'); },
  };
}

test('Phase7 checksum retains SHA256 golden vector and exact raw matching', () => {
  const report = migrationChecksumReport(Buffer.from('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(report.matches, true); assert.equal(report.matchMode, 'RAW');
});
test('Actual traffic migration reproduces the old raw-hash rejection and accepts its CRLF checksum', () => {
  const bytes = bytesOf(traffic);
  assert.equal(sha(bytes), '5eba8ec5d27ac8d5b78472482bcbc62f44427fc4e3e8a79fce7df1af664f00e2');
  const stored = '30c03135345fe14c7ee8b387fa8676b80ff24861c828809eceae4468615942e2';
  assert.equal(sha(crlf(bytes)), stored);
  assert.notEqual(sha(bytes), stored); // Prior Phase7 gate would abort here.
  const report = migrationChecksumReport(bytes, stored);
  assert.equal(report.matches, true); assert.equal(report.matchMode, 'CRLF');
});
test('Prisma LF/CRLF compatibility is bidirectional and preserves standalone CR', () => {
  for (const text of ['ab\ncd\nef\ngh\rab', 'ab\ncd\nef\ngh\rab\n']) {
    const lf = Buffer.from(text), windows = crlf(lf);
    assert.equal(migrationChecksumReport(lf, sha(windows)).matches, true);
    assert.equal(migrationChecksumReport(windows, sha(lf)).matches, true);
    assert.equal(migrationChecksumReport(lf, sha(Buffer.from(text.replace(/\r/g, '')))).matches, false);
  }
});
test('Old per-byte unpadded hex is recognized for raw and newline variants', () => {
  const bytes = bytesOf(traffic);
  assert.ok(oldHex(bytes).length < 64);
  assert.ok(oldHex(crlf(bytes)).length < 64);
  assert.equal(migrationChecksumReport(bytes, oldHex(bytes)).matchMode, 'RAW_LEGACY_HEX');
  assert.equal(migrationChecksumReport(bytes, oldHex(crlf(bytes))).matchMode, 'CRLF_LEGACY_HEX');
});
test('SQL edits, comments, spaces, BOM and added/removed final newline remain mismatches', () => {
  const sql = 'CREATE TABLE "proof" ("id" TEXT);\n';
  for (const altered of [sql.replace('TEXT', 'INTEGER'), '-- comment\n' + sql, sql + ' ', '\ufeff' + sql, sql.slice(0, -1)]) {
    assert.equal(migrationChecksumReport(Buffer.from(sql), sha(Buffer.from(altered))).matches, false);
  }
  assert.equal(migrationChecksumReport(Buffer.from('abc\n'), sha(Buffer.from('abc'))).matches, false);
  assert.equal(migrationChecksumReport(Buffer.from('abc'), sha(Buffer.from('abcd'))).matches, false);
});
test('Malformed checksums and invalid UTF8 cannot pass compatibility checks', () => {
  for (const value of ['', null, undefined, '0'.repeat(64), sha(Buffer.from('hello')).toUpperCase(), ' ' + sha(Buffer.from('hello'))]) {
    assert.equal(migrationChecksumReport(Buffer.from('hello'), value).matches, false);
  }
  assert.throws(() => migrationChecksumReport(Buffer.from([0xff]), '0'.repeat(64)), /INVALID_UTF8/);
});
test('Planner validates the entire 268-migration history, reports compat, and selects expand only', async () => {
  const names = fs.readdirSync(migrations).filter(n => fs.statSync(path.join(migrations, n)).isDirectory() && n < '20260930180000_phase7_legacy_storage_expand_v1').sort();
  assert.equal(names.length, 268);
  const rows = names.map(name => row(name, name === traffic ? sha(crlf(bytesOf(name))) : sha(bytesOf(name))));
  const db = database(rows), notices = [];
  const plan = await deployment().migrationPlan(db, { onCompatibility: event => notices.push(event) });
  assert.equal(plan.fresh, false); assert.equal(plan.purged, false);
  assert.equal(plan.names.length, 269); assert.equal(plan.names.includes(contract), false);
  assert.equal(notices.length, 1); assert.equal(notices[0].total, 1);
  assert.equal(notices[0].migrations[0].migration, traffic);
  assert.equal(notices[0].migrations[0].matchMode, 'CRLF');
  assert.equal(db.queries.length, 2);
});
test('Real SQL mismatch remains blocking and contains stored/current candidate hashes for all failing rows', async () => {
  const other = fs.readdirSync(migrations).find(n => n !== traffic && fs.existsSync(path.join(migrations, n, 'migration.sql')));
  const db = database([row(traffic, '0'.repeat(64)), row(other, '1'.repeat(64))]);
  await assert.rejects(deployment().migrationPlan(db), error => {
    assert.equal(error.message, 'PHASE7_MIGRATION_CHECKSUM_MISMATCH:' + traffic);
    assert.equal(error.phase7Diagnostics.total, 2);
    assert.equal(error.phase7Diagnostics.migrations[0].storedChecksum, '0'.repeat(64));
    assert.equal(error.phase7Diagnostics.migrations[0].currentChecksum, sha(bytesOf(traffic)));
    assert.equal(error.phase7Diagnostics.migrations[0].candidates.length, 3);
    assert.equal(JSON.stringify(error.phase7Diagnostics).includes('CREATE TABLE'), false);
    return true;
  });
  assert.equal(db.queries.length, 2);
});
test('Diagnostic output stays bounded when more than 20 checksums differ', async () => {
  const names = fs.readdirSync(migrations).filter(n => fs.existsSync(path.join(migrations, n, 'migration.sql'))).slice(0, 25);
  await assert.rejects(deployment().migrationPlan(database(names.map(n => row(n, '0'.repeat(64))))), error => {
    assert.equal(error.phase7Diagnostics.total, 25);
    assert.equal(error.phase7Diagnostics.shown, 20);
    assert.equal(error.phase7Diagnostics.migrations.length, 20);
    return true;
  });
});
test('Rolled-back attempts stay ignored; unfinished and unknown applied migrations still fail', async () => {
  const { migrationPlan } = deployment();
  const rolledBack = { ...row(traffic, 'invalid'), finished_at: null, rolled_back_at: new Date() };
  const plan = await migrationPlan(database([rolledBack, row(traffic)]));
  assert.equal(plan.fresh, false);
  await assert.rejects(migrationPlan(database([{ ...row(traffic), finished_at: null }])), /FAILED_MIGRATION_REQUIRES_RESOLUTION/);
  await assert.rejects(migrationPlan(database([{ ...row(traffic), migration_name: 'unknown-migration' }])), /UNKNOWN_APPLIED_MIGRATION/);
});
test('Empty database, populated unbaselined database, explicit contract and PURGED plans retain their gates', async () => {
  const { migrationPlan } = deployment();
  const fresh = await migrationPlan(database([], { hasLedger: false }));
  assert.equal(fresh.fresh, true); assert.equal(fresh.names.length, 269);
  await assert.rejects(migrationPlan(database([], { hasLedger: false, tables: [{ relname: 'existing_table' }] })), /UNBASELINED_DATABASE/);
  const purged = await migrationPlan(database([row(traffic), row(contract)]));
  assert.equal(purged.purged, true); assert.equal(purged.names.length, 270);
  const explicit = await migrationPlan(database([row(traffic)]), { contract: true });
  assert.equal(explicit.names.length, 270);
});
test('A mismatch stops main before any role gate, hook, deployment command or storage action', async () => {
  const called = [];
  const { main } = deployment({
    './phase7-role-preflight': { inspectRoles: async () => { called.push('role'); } },
    '../../src/services/phase7-legacy-storage-service': { storageState: async () => { called.push('storage'); } },
  });
  await assert.rejects(main({ db: database([row(traffic, '0'.repeat(64))]), contract: false, commandRunner: async () => { called.push('command'); } }), /CHECKSUM_MISMATCH/);
  assert.deepEqual(called, []);
});
test('Compatible history traverses every existing pre/post hook; staged Prisma tree excludes DROP contract', async () => {
  const roles = [], calls = [];
  const { main, PRE, POST } = deployment({
    './phase7-role-preflight': { inspectRoles: async (db, options) => { roles.push(options); return { verified: true }; } },
    '../../src/services/phase7-legacy-storage-service': { storageState: async () => ({ ready: true, targetReady: false, state: 'BRIDGE' }) },
  });
  let stagedDirectory;
  const result = await main({
    db: database([row(traffic, sha(crlf(bytesOf(traffic))))]), contract: false,
    commandRunner: async args => {
      calls.push(args);
      if (args[1] === 'migrate') {
        stagedDirectory = path.dirname(args.at(-1));
        const names = fs.readdirSync(path.join(stagedDirectory, 'migrations')).filter(n => n !== 'migration_lock.toml');
        assert.equal(names.length, 269); assert.equal(names.includes(contract), false);
        assert.deepEqual(fs.readFileSync(path.join(stagedDirectory, 'migrations', traffic, 'migration.sql')), bytesOf(traffic));
      }
    },
  });
  assert.equal(result.state, 'BRIDGE'); assert.equal(roles[0].strict, false);
  assert.equal(PRE.length, 8); assert.equal(POST.length, 4); assert.equal(calls.length, 14);
  assert.equal(calls[8][1], 'migrate');
  assert.equal(path.basename(calls.at(-1)[0]), 'phase7-legacy-storage-indexes.js');
  assert.equal(fs.existsSync(stagedDirectory), false);
});
test('Checksum compatibility does not bypass explicit contract readiness', async () => {
  const calls = [];
  const { main } = deployment({
    './phase7-role-preflight': { inspectRoles: async (db, options) => { assert.equal(options.strict, true); return { verified: true }; } },
    '../../src/services/phase7-retirement-finalizer': { checkContractReady: async () => { throw new Error('PHASE7_CONTRACT_NOT_PREPARED'); } },
  });
  await assert.rejects(main({
    db: database([row(traffic, sha(crlf(bytesOf(traffic))))]), contract: true, hooks: false,
    commandRunner: async args => calls.push(args),
  }), /CONTRACT_NOT_PREPARED/);
  assert.equal(calls.length, 0);
});
