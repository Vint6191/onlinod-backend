'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { runStage, stageTimeout, stageName } = require('../../scripts/database/phase7-deploy-child');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onlinod-deploy-child-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function until(read, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('fixture did not become ready');
}
const options = extra => ({ stdio: 'ignore', emit() {}, timeoutMs: 5000, killGraceMs: 100, ...extra });

test('deadline is finite, explicit and cannot be disabled by malformed configuration', () => {
  assert.equal(stageTimeout({}), 3600000);
  assert.equal(stageTimeout({ PHASE7_DEPLOY_STAGE_TIMEOUT_MS: '1000' }), 1000);
  for (const value of ['', '0', '-1', '1000ms', '1e6', ' 1000', '999', '21600001']) {
    assert.throws(() => stageTimeout({ PHASE7_DEPLOY_STAGE_TIMEOUT_MS: value }), /TIMEOUT_INVALID/);
  }
  assert.equal(stageName(['/tmp/prisma.js', 'migrate', 'deploy', '--schema', '/private/file']), 'prisma:migrate:deploy');
  assert.equal(stageName(['/tmp/check.js', '--create', 'postgresql://secret']), 'check.js:--create');
});

test('successful child drains its final output and emits a named receipt', async t => {
  const dir = await fixture(t), log = await fs.open(path.join(dir, 'child.log'), 'w'), events = [];
  try {
    const result = await runStage(['-e', "process.stdout.write('x'.repeat(250000));process.stderr.write('FINAL_DIAGNOSTIC\\n')"],
      options({ stdio: ['ignore', log.fd, log.fd], emit: event => events.push(event) }));
    assert.equal(result.exitCode, 0); assert(result.pid > 0);
    assert.equal(events[0].event, 'PHASE7_DEPLOY_STAGE_START');
    assert.equal(events.at(-1).event, 'PHASE7_DEPLOY_STAGE_PASS');
    const output = await fs.readFile(path.join(dir, 'child.log'), 'utf8');
    assert(output.includes('x'.repeat(250000)));
    assert(output.includes('FINAL_DIAGNOSTIC\n'));
  } finally { await log.close(); }
});

test('nonzero exit reports the actual failing stage and status without argument secrets', async () => {
  await assert.rejects(runStage(['-e', 'process.exit(23)', 'secret-token'], options()), error => {
    assert.equal(error.message, 'PHASE7_DEPLOY_CHILD_FAILED');
    assert.equal(error.phase7Diagnostics.exitCode, 23);
    assert.equal(error.phase7Diagnostics.reason, 'exit');
    assert(!JSON.stringify(error.phase7Diagnostics).includes('secret-token')); return true;
  });
});

test('spawn failure is reported without waiting for the deadline', async t => {
  const dir = await fixture(t);
  await assert.rejects(runStage(['-e', 'process.exit(0)'], options({ cwd: path.join(dir, 'absent') })), error => {
    assert.equal(error.phase7Diagnostics.reason, 'spawn');
    assert.equal(error.phase7Diagnostics.spawnCode, 'ENOENT'); return true;
  });
});

test('timeout escalates for an unresponsive child and reports heartbeats', async () => {
  const events = [];
  await assert.rejects(runStage(['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    options({ timeoutMs: 500, killGraceMs: 100, heartbeatMs: 100, emit: x => events.push(x) })), error => {
    assert.equal(error.message, 'PHASE7_DEPLOY_STAGE_TIMEOUT');
    assert.equal(error.phase7Diagnostics.reason, 'timeout'); return true;
  });
  assert(events.some(x => x.event === 'PHASE7_DEPLOY_STAGE_WAIT'));
  assert(events.some(x => x.event === 'PHASE7_DEPLOY_STAGE_STOPPING'));
  assert(!events.some(x => x.event === 'PHASE7_DEPLOY_STAGE_PASS'));
});

test('cancellation stops a running child and prevents a following stage', async t => {
  const dir = await fixture(t), ready = path.join(dir, 'ready'), forbidden = path.join(dir, 'forbidden');
  const controller = new AbortController();
  const running = runStage(['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`], options({ signal: controller.signal }));
  const rejected = assert.rejects(running, /PHASE7_DEPLOY_INTERRUPTED/);
  await until(() => fs.readFile(ready, 'utf8').catch(() => null)); controller.abort(); await rejected;
  await assert.rejects(runStage(['-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'bad')`], options({ signal: controller.signal })), /PHASE7_DEPLOY_INTERRUPTED/);
  await assert.rejects(fs.stat(forbidden), { code: 'ENOENT' });
});

test('POSIX cancellation also kills an engine descendant after its parent exits', { skip: process.platform !== 'linux' }, async t => {
  const dir = await fixture(t), ready = path.join(dir, 'pid'), controller = new AbortController();
  // /proc can be mounted from a parent PID namespace. Use the child's own
  // proc identity for observation, and its namespace PID only for signals.
  const descendant = `process.on('SIGTERM',()=>{});const f=require('node:fs'),s=f.readFileSync('/proc/self/stat','utf8');f.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,procPid:s.split(' ')[0],start:s.slice(s.lastIndexOf(')')+2).split(' ')[19]}));setInterval(()=>{},1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const running = runStage(['-e', parent], options({ signal: controller.signal }));
  const rejected = assert.rejects(running, /PHASE7_DEPLOY_INTERRUPTED/);
  const identity = JSON.parse(await until(() => fs.readFile(ready, 'utf8').catch(() => null)));
  let ended = false;
  t.after(() => { if (!ended) { try { process.kill(identity.pid, 'SIGKILL'); } catch {} } });
  controller.abort(); await rejected;
  await until(async () => {
    const stat = await fs.readFile(`/proc/${identity.procPid}/stat`, 'utf8').catch(() => null);
    const fields = stat?.slice(stat.lastIndexOf(')') + 2).split(' ');
    return !fields || fields[0] === 'Z' || fields[19] !== identity.start;
  });
  ended = true;
});

test('production orchestrator removes staged SQL and never starts hooks after a migration child timeout', async () => {
  const entry = path.resolve(__dirname, '../../scripts/database/phase7-deploy.js');
  const nativeRequire = require('node:module').createRequire(entry), module = { exports: {} };
  require('node:vm').runInNewContext(await fs.readFile(entry, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(entry), process, console,
    require(id) {
      if (id === './phase7-deploy-authority') return { withDeploymentAuthority: async (options, work) => work({ signal: options.signal, assertCurrent: async () => {} }) };
      return nativeRequire(id);
    },
  }, { filename: entry });
  const { main } = module.exports;
  const calls = []; let staged;
  const db = { async $disconnect() {}, async $queryRawUnsafe(sql, role) {
    if (sql.includes("to_regclass('public._prisma_migrations')")) return [{ name: null }];
    if (sql.includes("c.relname<>'_prisma_migrations'")) return [];
    if (sql === 'SELECT current_user AS name') return [{ name: 'fixture' }];
    if (sql.includes('FROM pg_roles r WHERE r.rolname=$1')) return [{ name: role, superuser: false }];
    throw new Error('unexpected database access after failed migration');
  } };
  await assert.rejects(main({ db, commandRunner: async args => {
    calls.push(args); assert.equal(args[1], 'migrate');
    staged = path.dirname(args.at(-1));
    assert((await fs.stat(path.join(staged, 'schema.prisma'))).isFile());
    await runStage(['-e', 'setInterval(()=>{},1000)'], options({ timeoutMs: 100 }));
  } }), /PHASE7_DEPLOY_STAGE_TIMEOUT/);
  assert.equal(calls.length, 1);
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
});
