'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { createHash } = require('node:crypto');

function failure(code, details = {}) {
  const error = Object.assign(new Error(code), { code });
  error.phase7Diagnostics = { event: code, ...details };
  return error;
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function regularBytes(root, relative) {
  const name = path.join(root, relative), stat = await fs.lstat(name);
  if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(name) !== name) {
    throw failure('PHASE7_MIGRATION_SOURCE_INVALID', { file: relative });
  }
  const bytes = await fs.readFile(name);
  if (bytes.length !== stat.size) throw failure('PHASE7_MIGRATION_SOURCE_CHANGED', { file: relative });
  return bytes;
}

async function captureMigrationSource(root) {
  const prisma = path.join(root, 'prisma');
  const entries = await fs.readdir(path.join(prisma, 'migrations'), { withFileTypes: true });
  if (entries.some(entry => entry.isSymbolicLink())) throw failure('PHASE7_MIGRATION_SOURCE_INVALID');
  const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const files = new Map();
  for (const name of ['schema.prisma', 'migrations/migration_lock.toml',
    ...names.map(name => `migrations/${name}/migration.sql`)]) {
    files.set(name, await regularBytes(prisma, name));
  }
  const after = (await fs.readdir(path.join(prisma, 'migrations'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(after)) throw failure('PHASE7_MIGRATION_SOURCE_CHANGED');
  const hashes = [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: digest(bytes) }));
  return { names, files, hashes, hash: digest(JSON.stringify(hashes)) };
}

async function verifyStagedMigrationSource(staged, names, snapshot) {
  const expected = ['schema.prisma', 'migrations/migration_lock.toml',
    ...names.map(name => `migrations/${name}/migration.sql`)];
  const found = [];
  async function walk(folder, prefix = '') {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const key = prefix + entry.name;
      if (entry.isSymbolicLink()) throw failure('PHASE7_STAGED_SOURCE_MISMATCH', { file: key });
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), key + '/');
      else if (entry.isFile()) found.push(key);
      else throw failure('PHASE7_STAGED_SOURCE_MISMATCH', { file: key });
    }
  }
  await walk(staged);
  if (JSON.stringify(found.sort()) !== JSON.stringify([...expected].sort())) throw failure('PHASE7_STAGED_SOURCE_MISMATCH');
  for (const name of expected) {
    const bytes = await regularBytes(staged, name), original = snapshot.files.get(name);
    if (!original || !bytes.equals(original)) throw failure('PHASE7_STAGED_SOURCE_MISMATCH', { file: name });
  }
}

async function verifyMigrationSource(root, snapshot) {
  const current = await captureMigrationSource(root);
  if (current.hash !== snapshot.hash) throw failure('PHASE7_MIGRATION_SOURCE_CHANGED');
}

function assertCompletedLedger(expected, observed) {
  const actual = new Set(observed.appliedNames), wanted = new Set(expected.names);
  const missing = expected.names.filter(name => !actual.has(name));
  const unexpected = observed.appliedNames.filter(name => !wanted.has(name));
  if (missing.length) throw failure('PHASE7_MIGRATION_LEDGER_INCOMPLETE', { total: missing.length, migrations: missing.slice(0, 20) });
  if (unexpected.length) throw failure('PHASE7_MIGRATION_PLAN_CHANGED', { total: unexpected.length, migrations: unexpected.slice(0, 20) });
  const records = new Map(observed.appliedReceipts.map(row => [row.migration_name, row]));
  const canonical = value => value?.toISOString ? value.toISOString() : value;
  for (const receipt of expected.appliedReceipts) {
    const current = records.get(receipt.migration_name);
    if (['id', 'checksum', 'started_at', 'finished_at'].some(key => canonical(current?.[key]) !== canonical(receipt[key]))) {
      throw failure('PHASE7_MIGRATION_RECEIPT_CHANGED', { migration: receipt.migration_name });
    }
  }
}

module.exports = { captureMigrationSource, verifyStagedMigrationSource, verifyMigrationSource, assertCompletedLedger };
