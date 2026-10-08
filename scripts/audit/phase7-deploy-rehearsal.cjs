#!/usr/bin/env node
'use strict';
const ENTRY_ENV = { ...process.env };

// Explicit administrative connection, own newly-created database only. This
// runner never deploys into DATABASE_URL and never runs the Phase7 contract.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const sync = require('node:fs');
const { randomBytes, createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { runStage, stageName } = require('../database/phase7-deploy-child');
const { checkInterrupted, processInterrupts, disconnectAll, completeCleanup, retainFailure } = require('../database/phase7-deploy-lifecycle');
const { inventory } = require('../database/phase7-release-source');
const { CONTRACT, PRE, POST } = require('../database/phase7-deploy');
const { withDeploymentAuthority } = require('../database/phase7-deploy-authority');
const ROOT = path.resolve(__dirname, '../..');
const PREFIX = 'onlinod_p7_rehearsal_';

function settings(argv, env = ENTRY_ENV) {
  if (argv.length !== 1 || !argv[0].startsWith('--output=') || !argv[0].slice(9)) {
    throw new Error('PHASE7_REHEARSAL_OUTPUT_REQUIRED');
  }
  // No fallback to the application's production configuration or .env file.
  const raw = env.ONLINOD_PHASE7_REHEARSAL_ADMIN_URL;
  if (!raw) throw new Error('PHASE7_REHEARSAL_ADMIN_URL_REQUIRED');
  let u; try { u = new URL(raw); } catch { throw new Error('PHASE7_REHEARSAL_ADMIN_URL_INVALID'); }
  if (!['postgresql:', 'postgres:'].includes(u.protocol) || !u.hostname || u.pathname.length < 2
      || /-pooler(?=\.|$)/i.test(u.hostname) || u.searchParams.has('pgbouncer')
      || u.searchParams.has('options') || u.searchParams.has('schema') || u.hash) {
    throw new Error('PHASE7_REHEARSAL_DIRECT_ADMIN_CONNECTION_REQUIRED');
  }
  u.searchParams.set('connection_limit', '1');
  u.searchParams.set('connect_timeout', '15'); u.searchParams.set('pool_timeout', '15');
  const output = path.resolve(argv[0].slice(9));
  if (output === ROOT || output.startsWith(ROOT + path.sep)) throw new Error('PHASE7_REHEARSAL_OUTPUT_MUST_BE_EXTERNAL');
  return { adminUrl: u.toString(), output };
}

function identifier(database) {
  if (!new RegExp(`^${PREFIX}[a-f0-9]{32}$`).test(database)) throw new Error('PHASE7_REHEARSAL_DATABASE_INVALID');
  return `"${database}"`;
}

async function ownDatabase(admin, work, record = () => {}, { signal } = {}) {
  const check = phase => checkInterrupted(signal, phase, 'PHASE7_REHEARSAL_INTERRUPTED');
  check('before-create-database');
  const database = PREFIX + randomBytes(16).toString('hex'), quoted = identifier(database);
  let created = false, oid = null, failure = null, result;
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${quoted} TEMPLATE template0`);
    created = true;
    const rows = await admin.$queryRawUnsafe('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', database);
    assert.equal(rows.length, 1, 'PHASE7_REHEARSAL_CREATED_DATABASE_NOT_FOUND'); oid = rows[0].oid;
    await record({ event: 'PHASE7_REHEARSAL_CREATED', database, oid });
    // Even when interrupted during CREATE, first establish cleanup ownership.
    check('created-database-owned');
    result = await work(database);
  } catch (error) { failure = error; }
  finally {
    if (created) {
      try {
        const rows = await admin.$queryRawUnsafe('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', database);
        // If identity cannot be confirmed, leave a precise cleanup report;
        // never guess that an unrelated database with the same name is ours.
        assert(oid && rows.length === 1 && rows[0].oid === oid, 'PHASE7_REHEARSAL_CLEANUP_IDENTITY_CHANGED');
        await admin.$executeRawUnsafe(`DROP DATABASE ${quoted} WITH (FORCE)`);
        const remaining = await admin.$queryRawUnsafe('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', database);
        assert.equal(remaining.length, 0, 'PHASE7_REHEARSAL_CLEANUP_NOT_CONFIRMED');
        await record({ event: 'PHASE7_REHEARSAL_DROPPED', database, oid });
      } catch (error) {
        failure = retainFailure(failure, error);
        try { await record({ event: 'PHASE7_REHEARSAL_CLEANUP_FAILED', database, code: error.code || 'CLEANUP_FAILED' }); }
        catch (recordError) { failure = retainFailure(failure, recordError); }
      }
    }
  }
  if (failure) throw failure;
  check('database-cleanup-complete');
  return result;
}

async function verifyIndependentSessions(a, b, database, { signal } = {}) {
  const check = phase => checkInterrupted(signal, phase, 'PHASE7_REHEARSAL_INTERRUPTED');
  const identity = async db => (await db.$queryRawUnsafe('SELECT current_database() AS database,pg_backend_pid() AS pid,version() AS version'))[0];
  check('first-session');
  const first = await identity(a); check('second-session');
  const second = await identity(b); check('session-identities');
  assert.equal(first.database, database); assert.equal(second.database, database);
  assert.notEqual(first.pid, second.pid, 'PHASE7_REHEARSAL_DISTINCT_SESSIONS_REQUIRED');
  const key = randomBytes(4).readInt32BE(); let heldA = false, heldB = false, result, failure;
  const lock = async db => (await db.$queryRawUnsafe('SELECT pg_try_advisory_lock(17707128::int,$1::int) AS held', key))[0].held;
  const unlock = async db => {
    const rows = await db.$queryRawUnsafe('SELECT pg_advisory_unlock(17707128::int,$1::int) AS released', key);
    assert.equal(rows[0]?.released, true, 'PHASE7_REHEARSAL_LOCK_RELEASE_NOT_CONFIRMED');
  };
  try {
    heldA = await lock(a); check('first-lock-acquired'); assert.equal(heldA, true);
    heldB = await lock(b); check('lock-exclusion'); assert.equal(heldB, false, 'PHASE7_REHEARSAL_LOCK_EXCLUSION_REQUIRED');
    await unlock(a); heldA = false;
    check('first-lock-released');
    heldB = await lock(b); check('second-lock-acquired'); assert.equal(heldB, true, 'PHASE7_REHEARSAL_LOCK_HANDOFF_REQUIRED');
    assert.equal((await identity(a)).pid, first.pid); check('first-session-rechecked');
    assert.equal((await identity(b)).pid, second.pid); check('second-session-rechecked');
    result = { first, second, lockExclusion: true, lockHandoff: true };
  } catch (error) { failure = error; }
  try { await completeCleanup([...(heldA ? [() => unlock(a)] : []), ...(heldB ? [() => unlock(b)] : [])]); }
  catch (error) { failure = retainFailure(failure, error); }
  if (failure) throw failure;
  check('session-proof-cleanup');
  return result;
}

function saveReport(output, report) {
  // The final success receipt is committed synchronously after all async cleanup
  // and the last cancellation check. No signal callback can run between them.
  const pending = path.join(output, '.result-pending.json');
  sync.writeFileSync(pending, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  sync.renameSync(pending, path.join(output, 'result.json'));
}

function redact(text, urls) {
  for (const url of urls) text = text.split(url).join('<redacted-database-url>');
  return text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '<redacted-database-url>');
}

async function main(argv = process.argv.slice(2), env = ENTRY_ENV) {
  const config = settings(argv, env);
  const control = processInterrupts('PHASE7_REHEARSAL_INTERRUPTED');
  const check = phase => control.check(phase);
  let admin, sourceBefore, failure, outputCreated = false;
  const report = { version: 1, startedAt: new Date().toISOString(), ok: false,
    scope: 'fresh isolated PostgreSQL database; ordinary BRIDGE deploy only',
    productionCopy: false, contractTested: false, runtimeRoleSeparationTested: false,
    events: [], stages: [] };
  const save = () => saveReport(config.output, report);
  const record = async event => { report.events.push(event); await save(); console.log(JSON.stringify(event)); };
  try {
    check('prepare-output');
    if (await fs.realpath(path.dirname(config.output)) !== path.dirname(config.output)) throw new Error('PHASE7_REHEARSAL_OUTPUT_PARENT_SYMLINK');
    check('create-output');
    await fs.mkdir(config.output, { mode: 0o700 }); // existing output is never overwritten
    outputCreated = true; await save(); check('source-inventory');
    sourceBefore = await inventory(ROOT); check('source-inventory-complete');
    await fs.writeFile(path.join(config.output, 'source.json'), JSON.stringify(sourceBefore, null, 2), { mode: 0o600 });
    check('connect-admin');
    admin = new PrismaClient({ datasources: { db: { url: config.adminUrl } } });
    const version = await admin.$queryRawUnsafe("SELECT current_setting('server_version_num')::int AS version");
    check('server-version');
    assert(version[0]?.version >= 130000, 'PHASE7_REHEARSAL_POSTGRES_13_REQUIRED');
    await ownDatabase(admin, async database => {
      check('start-owned-database-work');
      const u = new URL(config.adminUrl); u.pathname = '/' + database; const url = u.toString();
      const db = new PrismaClient({ datasources: { db: { url } } });
      const other = new PrismaClient({ datasources: { db: { url } } });
      const commandEnv = { ...env, DATABASE_URL: url, DIRECT_URL: url,
        CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: 'true' };
      delete commandEnv.ONLINOD_PHASE7_REHEARSAL_ADMIN_URL;
      delete commandEnv.PHASE7_RUNTIME_DB_ROLES;
      const read = async (...args) => { check('before-fixture-query'); const value = await db.$queryRawUnsafe(...args); check('after-fixture-query'); return value; };
      const write = async (...args) => { check('before-fixture-mutation'); const value = await db.$executeRawUnsafe(...args); check('after-fixture-mutation'); return value; };
      const deploy = async (name, expectedFailure) => {
        check('before-deploy');
        await disconnectAll([db, other]); check('deploy-disconnected');
        const logPath = path.join(config.output, name + '.log'), log = await fs.open(logPath, 'wx', 0o600);
        let failure = null;
        try {
          check('deploy-log-opened');
          await runStage([path.join(ROOT, 'scripts/database/phase7-deploy.js')], {
            cwd: ROOT, env: commandEnv, timeoutMs: 2 * 60 * 60 * 1000, killGraceMs: 10000,
            signal: control.signal, stdio: ['ignore', log.fd, log.fd],
            emit: event => console.log(JSON.stringify({ rehearsal: name, ...event })),
          });
        } catch (error) { failure = error; }
        finally { try { await log.close(); } catch (error) { failure = retainFailure(failure, error); } }
        const raw = await fs.readFile(logPath, 'utf8'), output = redact(raw, [config.adminUrl, url]);
        if (raw !== output) await fs.writeFile(logPath, output, { mode: 0o600 });
        const receipt = { name, expectedFailure: expectedFailure || null, exitCode: failure?.phase7Diagnostics?.exitCode ?? (failure ? null : 0), log: name + '.log' };
        report.stages.push(receipt); await save();
        check('deploy-evidence-saved');
        if (expectedFailure) {
          assert(failure && receipt.exitCode !== null && receipt.exitCode !== 0 && output.includes(expectedFailure), 'PHASE7_REHEARSAL_EXPECTED_REFUSAL_MISSING');
          assert(!output.includes('PHASE7_DEPLOY_STAGE_START'), 'PHASE7_REHEARSAL_REFUSAL_STARTED_MUTATIONS');
        } else {
          if (failure) throw failure;
          const events = output.split(/\r?\n/).filter(line => line.startsWith('{')).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
          const starts = events.filter(x => x.event === 'PHASE7_DEPLOY_STAGE_START');
          const passed = events.filter(x => x.event === 'PHASE7_DEPLOY_STAGE_PASS');
          assert.equal(starts.length, PRE.length + POST.length + 2, 'PHASE7_REHEARSAL_HOOK_COUNT_MISMATCH');
          assert.equal(passed.length, starts.length, 'PHASE7_REHEARSAL_HOOK_PASS_MISSING');
          assert.deepEqual(starts.map(x => x.stage), passed.map(x => x.stage));
          const state = events.findLast(x => x.ok === true && x.storage);
          assert.equal(state?.storage?.phase, 'BRIDGE'); assert.equal(state.storage.targetReady, false);
          const pre = PRE.map(args => stageName(args)), post = POST.map(args => stageName(args));
          const expected = state.fresh ? ['prisma:migrate:deploy', ...pre, ...post]
            : [...pre, 'prisma:migrate:deploy', ...post];
          expected.push('phase7-legacy-storage-indexes.js:--create');
          assert.deepEqual(starts.map(x => x.stage), expected, 'PHASE7_REHEARSAL_HOOK_ORDER_MISMATCH');
          receipt.fullHooksPassed = passed.length; await save();
        }
      };
      const ledger = async () => {
        const rows = await read('SELECT id,migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
        const names = (await fs.readdir(path.join(ROOT, 'prisma/migrations'), { withFileTypes: true })).filter(x => x.isDirectory() && x.name !== CONTRACT).map(x => x.name).sort();
        check('ledger-inventory');
        assert.deepEqual(rows.map(x => x.migration_name), names);
        for (const row of rows) {
          assert(row.finished_at && !row.rolled_back_at);
          const hash = createHash('sha256').update(await fs.readFile(path.join(ROOT, 'prisma/migrations', row.migration_name, 'migration.sql'))).digest('hex');
          check('ledger-checksum');
          assert.equal(row.checksum, hash);
        }
        return rows;
      };
      let workFailure;
      try {
        report.sessions = await verifyIndependentSessions(db, other, database, { signal: control.signal });
        await other.$disconnect(); check('sessions-disconnected'); await save();
        // A separate direct keeper must survive disconnection of the fixture's
        // ordinary clients and refuse a competing REAL deploy CLI before any
        // migration/preflight child starts. Releasing it admits the next run.
        await withDeploymentAuthority({ databaseUrl: url, signal: control.signal }, async () => {
          await deploy('00-deploy-owner-refusal', 'PHASE7_DEPLOY_ALREADY_RUNNING');
        });
        report.deploymentAuthorityExclusion = true; await save();
        await write('CREATE TABLE "Phase7RehearsalUnbaselined" (id integer PRIMARY KEY)');
        await deploy('00-unbaselined-refusal', 'PHASE7_UNBASELINED_DATABASE');
        await write('DROP TABLE "Phase7RehearsalUnbaselined"');
        await deploy('01-fresh');
        const baseline = await ledger();
        await fs.writeFile(path.join(config.output, 'migration-receipts.json'), JSON.stringify(baseline, null, 2), { mode: 0o600 });
        await deploy('02-redeploy'); assert.deepEqual(await ledger(), baseline);
        const first = baseline[0];
        const cases = [
          ['03-checksum-refusal', 'checksum', '0'.repeat(64), first.checksum, 'PHASE7_MIGRATION_CHECKSUM_MISMATCH'],
          ['04-unfinished-refusal', 'finished_at', null, first.finished_at, 'PHASE7_FAILED_MIGRATION_REQUIRES_RESOLUTION'],
          ['05-unknown-refusal', 'migration_name', '20991231235959_rehearsal_unknown', first.migration_name, 'PHASE7_UNKNOWN_APPLIED_MIGRATION'],
        ];
        for (const [name, column, bad, original, expected] of cases) {
          check('before-history-injection');
          try {
            await write(`UPDATE "_prisma_migrations" SET "${column}"=$1 WHERE id=$2`, bad, first.id);
            await deploy(name, expected);
          }
          finally { await db.$executeRawUnsafe(`UPDATE "_prisma_migrations" SET "${column}"=$1 WHERE id=$2`, original, first.id); }
          assert.deepEqual(await ledger(), baseline);
        }
        const index = 'RefreshSession_user_history_created_idx';
        const before = await read('SELECT indexdef FROM pg_indexes WHERE schemaname=\'public\' AND indexname=$1', index);
        assert.equal(before.length, 1);
        await write(`DROP INDEX CONCURRENTLY "${index}"`);
        await deploy('06-index-recovery'); assert.deepEqual(await ledger(), baseline);
        const after = await read('SELECT indexdef FROM pg_indexes WHERE schemaname=\'public\' AND indexname=$1', index);
        assert.deepEqual(after, before);
        report.migrations = baseline.length; report.indexRecovered = index;
      } catch (error) { workFailure = error; }
      try { await disconnectAll([db, other]); } catch (error) { workFailure = retainFailure(workFailure, error); }
      if (workFailure) throw workFailure;
      check('fixture-clients-disconnected');
    }, record, { signal: control.signal });
    check('fixture-cleanup-complete');
    assert.deepEqual(await inventory(ROOT), sourceBefore, 'PHASE7_REHEARSAL_SOURCE_CHANGED');
    check('final-source-verified');
  } catch (error) { failure = error; }
  try { await disconnectAll([admin]); } catch (error) { failure = retainFailure(failure, error); }
  try {
    try { check('final-publication'); } catch (error) { failure = failure || error; }
    report.finishedAt = new Date().toISOString();
    report.ok = !failure;
    if (failure) report.error = { code: failure.code || null, message: redact(String(failure.message), [config.adminUrl]),
      diagnostics: failure.phase7Diagnostics || null, cleanupErrors: (failure.cleanupErrors || []).map(error => ({ code: error.code || 'CLEANUP_FAILED' })) };
    // There are no awaits between the final check, receipt commit and PASS.
    if (outputCreated) save();
    if (failure) { failure.exitCode = control.exitCode(); throw failure; }
    console.log(JSON.stringify({ event: 'PHASE7_REHEARSAL_PASS', migrations: report.migrations, output: config.output }));
    return report;
  } finally {
    control.dispose();
  }
}

module.exports = { settings, identifier, ownDatabase, verifyIndependentSessions, redact, main };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ event: 'PHASE7_REHEARSAL_FAIL', code: error.code || 'FAILED', message: redact(String(error.message), []) })); process.exitCode = error.exitCode || 1; });
