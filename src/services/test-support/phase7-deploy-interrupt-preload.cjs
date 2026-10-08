'use strict';
// Child-process fixture only. All DB calls and command children are replaced;
// the actual production deploy CLI, migration inventory and staging are used.
const Module = require('node:module');
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const original = Module._load;
const point = process.env.PHASE7_INTERRUPT_TEST_POINT;
const termination = process.env.PHASE7_INTERRUPT_TEST_SIGNAL || 'SIGTERM';
let disconnects = 0, commands = 0, migrated = false;
async function interrupt() {
  console.log('FIXTURE_INTERRUPT:' + point);
  process.kill(process.pid, termination);
  await new Promise(resolve => setTimeout(resolve, 30));
}
const db = {
  async $disconnect() {
    disconnects++;
    if (disconnects === 3) {
      console.log('FIXTURE_FINAL_DISCONNECT');
      if (point === 'disconnect') await interrupt();
      if (point === 'disconnect-error') throw new Error('FIXTURE_DISCONNECT_FAILED');
    }
  },
  async $queryRawUnsafe(sql) {
    if (sql.includes("to_regclass('public._prisma_migrations')")) {
      if (point === 'history') await interrupt();
      return [{ name: migrated ? '_prisma_migrations' : null }];
    }
    if (sql.startsWith('SELECT migration_name,checksum,')) {
      const root = path.resolve(__dirname, '../../..'), dir = path.join(root, 'prisma/migrations');
      return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== '20260930190000_phase7_legacy_storage_contract_v1').map(entry => ({ migration_name: entry.name,
        checksum: createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name, 'migration.sql'))).digest('hex'), finished_at: new Date('2026-10-08T00:00:00Z'), rolled_back_at: null }));
    }
    if (sql.includes("c.relname<>'_prisma_migrations'")) return [];
    throw new Error('UNEXPECTED_FIXTURE_DB_QUERY');
  },
};
Module._load = function(request, parent, isMain) {
  const deploy = parent?.filename.endsWith('/scripts/database/phase7-deploy.js');
  if (deploy && request === '../../src/prisma') return db;
  if (deploy && request === './phase7-deploy-authority') return { withDeploymentAuthority: async (options, work) => work({ signal: options.signal, assertCurrent: async () => {} }) };
  if (deploy && request === './phase7-role-preflight') return { inspectRoles: async () => ({ actor: 'fixture' }) };
  if (deploy && request === './phase7-deploy-child') {
    return { ...original.apply(this, arguments), runStage: async args => {
      commands++;
      if (args[1] === 'migrate') migrated = true;
      if (commands === 1 && point === 'child-completion') await interrupt();
      return { exitCode: 0 };
    } };
  }
  if (deploy && request === '../../src/services/phase7-legacy-storage-service') {
    return { storageState: async () => {
      if (point === 'storage') await interrupt();
      return { phase: 'BRIDGE', targetReady: false };
    } };
  }
  return original.apply(this, arguments);
};
