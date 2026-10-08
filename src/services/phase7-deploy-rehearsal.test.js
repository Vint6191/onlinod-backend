'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), path = require('node:path');
const { settings, ownDatabase, identifier, verifyIndependentSessions, redact } = require('../../scripts/audit/phase7-deploy-rehearsal.cjs');
const output = '--output=' + path.join(os.tmpdir(), 'phase7-rehearsal-unit');

test('rehearsal requires its explicit direct administrative URL and external new output', () => {
  assert.throws(() => settings([output], { DATABASE_URL: 'postgresql://user:pass@production/app' }), /ADMIN_URL_REQUIRED/);
  const env = { ONLINOD_PHASE7_REHEARSAL_ADMIN_URL: 'postgresql://owner:secret@localhost/postgres' };
  const result = settings([output], env);
  assert.equal(new URL(result.adminUrl).pathname, '/postgres');
  assert.equal(new URL(result.adminUrl).searchParams.get('connection_limit'), '1');
  for (const url of ['https://host/db', 'postgresql://host/db?schema=public', 'postgresql://host/db?options=x', 'postgresql://host/db?pgbouncer=true', 'postgresql://x-pooler.example/db', 'malformed']) {
    assert.throws(() => settings([output], { ONLINOD_PHASE7_REHEARSAL_ADMIN_URL: url }), /INVALID|DIRECT_ADMIN/);
  }
  assert.throws(() => settings([output, '--contract'], env), /OUTPUT_REQUIRED/);
  assert.throws(() => settings(['--output=' + path.resolve(__dirname, '../../result')], env), /OUTPUT_MUST_BE_EXTERNAL/);
  assert.throws(() => identifier('neondb'), /DATABASE_INVALID/);
  assert.equal(redact('error postgresql://owner:secret@localhost/db', []), 'error <redacted-database-url>');
});

function catalog({ createFails = false, changedOid = false, dropFails = false } = {}) {
  let exists = false, reads = 0;
  const sql = [];
  return { sql,
    async $executeRawUnsafe(query) {
      sql.push(query);
      if (query.startsWith('CREATE DATABASE ')) { if (createFails) throw new Error('create refused'); exists = true; }
      else if (query.startsWith('DROP DATABASE ')) { if (dropFails) throw new Error('drop refused'); exists = false; }
      else throw new Error('unexpected mutation');
    },
    async $queryRawUnsafe(query, database) {
      sql.push(query); identifier(database); reads++;
      return exists ? [{ oid: changedOid && reads > 1 ? '999' : '100' }] : [];
    },
  };
}

test('successful rehearsal drops only the exact database created by this invocation', async () => {
  const admin = catalog(), events = []; let ownName;
  const result = await ownDatabase(admin, async name => { ownName = name; return 42; }, e => events.push(e));
  assert.equal(result, 42);
  assert.equal(admin.sql[0], `CREATE DATABASE "${ownName}" TEMPLATE template0`);
  assert.equal(admin.sql.filter(x => x.startsWith('DROP DATABASE')).length, 1);
  assert(admin.sql.includes(`DROP DATABASE "${ownName}" WITH (FORCE)`));
  assert.equal(events.at(-1).event, 'PHASE7_REHEARSAL_DROPPED');
  assert(!admin.sql.some(x => /LIKE|pg_terminate_backend/.test(x)));
});

test('failure of CREATE never grants cleanup ownership of an existing database', async () => {
  const admin = catalog({ createFails: true });
  await assert.rejects(ownDatabase(admin, () => assert.fail('work must not start')), /create refused/);
  assert.equal(admin.sql.length, 1);
});

test('work failure still removes the owned fixture and preserves the original error', async () => {
  const admin = catalog(), events = [];
  await assert.rejects(ownDatabase(admin, () => { throw new Error('proof failed'); }, e => events.push(e)), /proof failed/);
  assert.equal(events.at(-1).event, 'PHASE7_REHEARSAL_DROPPED');
});

test('cleanup refuses a changed database identity and cannot report PASS', async () => {
  const admin = catalog({ changedOid: true }), events = [];
  await assert.rejects(ownDatabase(admin, () => true, e => events.push(e)), /CLEANUP_IDENTITY_CHANGED/);
  assert(!admin.sql.some(x => x.startsWith('DROP DATABASE')));
  assert.equal(events.at(-1).event, 'PHASE7_REHEARSAL_CLEANUP_FAILED');
});

test('cleanup error prevents success even when every proof passed', async () => {
  const admin = catalog({ dropFails: true }), events = [];
  await assert.rejects(ownDatabase(admin, () => true, e => events.push(e)), /drop refused/);
  assert.equal(events.at(-1).event, 'PHASE7_REHEARSAL_CLEANUP_FAILED');
});

test('single-session engine is rejected before any rehearsal mutation', async () => {
  const queries = [], db = { async $queryRawUnsafe(sql) { queries.push(sql); return [{ database: 'fixture', pid: 1, version: 'fixture' }]; } };
  await assert.rejects(verifyIndependentSessions(db, db, 'fixture'), /DISTINCT_SESSIONS_REQUIRED/);
  assert.equal(queries.length, 2); assert(queries.every(x => x.startsWith('SELECT current_database()')));
});

test('distinct PIDs alone do not substitute for actual advisory-lock exclusion', async () => {
  const unlocked = [];
  const client = pid => ({ async $queryRawUnsafe(sql) {
    if (sql.includes('current_database()')) return [{ database: 'fixture', pid }];
    if (sql.includes('pg_advisory_unlock')) { unlocked.push(pid); return [{ released: true }]; }
    return [{ held: true }]; // broken isolation, both sessions claim the lock
  } });
  await assert.rejects(verifyIndependentSessions(client(1), client(2), 'fixture'), /LOCK_EXCLUSION_REQUIRED/);
  assert.deepEqual(unlocked, [1, 2]);
});
