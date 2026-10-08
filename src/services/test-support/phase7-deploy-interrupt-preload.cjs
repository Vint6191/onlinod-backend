'use strict';
// Child-process fixture only. All DB calls and command children are replaced;
// the actual production deploy CLI, migration inventory and staging are used.
const Module = require('node:module');
const original = Module._load;
const point = process.env.PHASE7_INTERRUPT_TEST_POINT;
const termination = process.env.PHASE7_INTERRUPT_TEST_SIGNAL || 'SIGTERM';
let disconnects = 0, commands = 0;
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
      return [{ name: null }];
    }
    if (sql.includes("c.relname<>'_prisma_migrations'")) return [];
    throw new Error('UNEXPECTED_FIXTURE_DB_QUERY');
  },
};
Module._load = function(request, parent, isMain) {
  const deploy = parent?.filename.endsWith('/scripts/database/phase7-deploy.js');
  if (deploy && request === '../../src/prisma') return db;
  if (deploy && request === './phase7-role-preflight') return { inspectRoles: async () => ({ actor: 'fixture' }) };
  if (deploy && request === './phase7-deploy-child') {
    return { ...original.apply(this, arguments), runStage: async () => {
      commands++;
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
