'use strict';
const path = require('node:path'), { createRequire } = require('node:module');
const root = path.resolve(process.env.ONLINOD_VAULT_BACKEND_ROOT || path.join(__dirname, '../..'));
const explicit = process.env.ONLINOD_NATIVE_TEST_DATABASE_URL;
if (process.env.ONLINOD_POSTGRES_INTEGRATION !== '1' || !explicit) throw Error('EXPLICIT_NATIVE_POSTGRES_FIXTURE_REQUIRED');
const url = new URL(explicit), name = decodeURIComponent(url.pathname.slice(1));
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  || !/^(?:onlinod_test_|onlinod_fixture_|audit[0-9]+_)[a-z0-9_]+$/.test(name)) throw Error('ISOLATED_LOCAL_POSTGRES_TEST_DATABASE_REQUIRED');
(async () => {
  const load = createRequire(path.join(root, 'package.json')), { PrismaClient } = load('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: explicit } } });
  try {
    const [identity] = await db.$queryRawUnsafe('SELECT current_database() AS name,version() AS version');
    if (identity.name !== name || !identity.version.startsWith('PostgreSQL ')) throw Error('NATIVE_POSTGRES_REQUIRED');
    const proof = require('../test-support/vault-chain214-backend.cjs');
    const result = process.argv[2] === '--restart'
      ? await proof.restartPhase({ db, backendRoot: root, data: JSON.parse(process.argv[3]) })
      : await proof.runVaultBackend214({ db, backendRoot: root, databaseUrl: explicit, output: process.env.ONLINOD_VAULT214_OUTPUT });
    console.log(JSON.stringify(result));
  } finally { await db.$disconnect(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
