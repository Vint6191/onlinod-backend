'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withDeploymentAuthority, authorityUrl } = require('../../scripts/database/phase7-deploy-authority');
const databaseUrl = 'postgresql://fixture:synthetic-secret@localhost/fixture?sslmode=disable';
const tick = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function server() {
  let next = 1, owner = null;
  const events = [], clients = [];
  function createClient() {
    const client = { pid: next++, started: 'epoch-' + next, database: 'fixture', schema: 'public',
      failQuery: false, failRelease: false, failDisconnect: false, blockAcquire: null, blockProbe: null,
      identity() { return { pid: this.pid, started: this.started, database: this.database, schema: this.schema }; },
      async $queryRawUnsafe(sql, ...args) {
        if (sql.includes('pg_try_advisory_lock')) {
          events.push(['acquire', this.pid]); const acquired = owner === null || owner === this.pid;
          if (acquired) owner = this.pid;
          if (this.blockAcquire) await this.blockAcquire.promise;
          return [{ ...this.identity(), acquired }];
        }
        if (sql.includes('pg_advisory_unlock')) {
          events.push(['release', this.pid]);
          if (this.failRelease) throw new Error('release failed');
          const released = owner === this.pid && args[0] === this.pid && args[1] === this.database && args[2] === this.started;
          if (released) owner = null;
          return [{ ...this.identity(), released }];
        }
        events.push(['probe', this.pid]);
        if (this.blockProbe) await this.blockProbe.promise;
        if (this.failQuery) throw Object.assign(new Error(databaseUrl), { code: 'P1001' });
        return [{ ...this.identity(), held: owner === this.pid }];
      },
      async $disconnect() {
        events.push(['disconnect', this.pid]); if (owner === this.pid) owner = null;
        if (this.failDisconnect) throw new Error('disconnect failed');
      },
    };
    clients.push(client); return client;
  }
  const options = { databaseUrl, createClient, emit() {}, heartbeatMs: 60_000 };
  return { options, createClient, events, clients, get owner() { return owner; }, dropLock() { owner = null; } };
}

test('dedicated keeper URL preserves target/TLS but bounds its own pool and query times', () => {
  const u = new URL(authorityUrl(databaseUrl + '&connection_limit=99&socket_timeout=0'));
  assert.equal(u.pathname, '/fixture'); assert.equal(u.searchParams.get('sslmode'), 'disable');
  for (const [key, value] of Object.entries({ connection_limit: '1', connect_timeout: '15', pool_timeout: '15', socket_timeout: '15' })) assert.equal(u.searchParams.get(key), value);
  assert.doesNotThrow(() => authorityUrl(databaseUrl + '&pgbouncer=false&schema=public'));
});
test('keeper refuses pooled, ambiguous-schema and missing configuration without exposing credentials', () => {
  for (const url of [undefined, 'bad', 'https://host/db', 'postgresql://host/db?schema=other',
    'postgresql://host/db?schema=public&schema=other', 'postgresql://host/db?pgbouncer=false&pgbouncer=true',
    'postgresql://ep-pooler.example/db', 'postgresql://host/db#fragment']) {
    assert.throws(() => authorityUrl(url), error => /^PHASE7_DEPLOY_/.test(error.code) && !error.message.includes('postgresql:'));
  }
});
test('two deployments cannot own the pipeline at once, then ownership transfers after cleanup', async () => {
  const s = server(), entered = deferred(), release = deferred();
  const first = withDeploymentAuthority(s.options, async scope => { entered.resolve(); await release.promise; await scope.assertCurrent(); return 1; });
  await entered.promise;
  try { await assert.rejects(withDeploymentAuthority(s.options, () => assert.fail('contender entered')), { code: 'PHASE7_DEPLOY_ALREADY_RUNNING' }); }
  finally { release.resolve(); }
  assert.equal(await first, 1); assert.equal(s.owner, null);
  assert.equal(await withDeploymentAuthority(s.options, () => 2), 2); assert.equal(s.owner, null);
});
test('liveness probes never acquire a reentrant lock and release exactly once', async () => {
  const s = server();
  await withDeploymentAuthority(s.options, async scope => { for (let n = 0; n < 5; n++) await scope.assertCurrent(); });
  assert.equal(s.events.filter(x => x[0] === 'acquire').length, 1);
  assert.equal(s.events.filter(x => x[0] === 'release').length, 1);
  assert.equal(s.events.at(-1)[0], 'disconnect');
});
test('cancellation during acquisition still releases the lock it acquired', async () => {
  const s = server(), gate = deferred(), controller = new AbortController();
  const pending = withDeploymentAuthority({ ...s.options, signal: controller.signal, createClient() { const c = s.createClient(); c.blockAcquire = gate; return c; } }, () => assert.fail('cancelled work entered'));
  await tick(); controller.abort('SIGTERM'); gate.resolve();
  await assert.rejects(pending, { code: 'PHASE7_DEPLOY_INTERRUPTED' }); assert.equal(s.owner, null);
  assert.equal(s.events.filter(x => x[0] === 'release').length, 1);
});
test('pre-aborted work creates no keeper connection', async () => {
  const s = server(), controller = new AbortController(); controller.abort('SIGINT');
  await assert.rejects(withDeploymentAuthority({ ...s.options, signal: controller.signal }, () => {}), { code: 'PHASE7_DEPLOY_INTERRUPTED' });
  assert.equal(s.clients.length, 0);
});
test('external cancellation retains ownership until the child work has drained', async () => {
  const s = server(), entered = deferred(), drain = deferred(), controller = new AbortController(); let completed = false;
  const pending = withDeploymentAuthority({ ...s.options, signal: controller.signal }, async scope => {
    entered.resolve(); await new Promise(resolve => scope.signal.addEventListener('abort', resolve, { once: true })); await drain.promise;
  }).finally(() => { completed = true; });
  await entered.promise; controller.abort('SIGTERM'); await tick();
  assert.equal(completed, false); assert.notEqual(s.owner, null);
  drain.resolve(); await assert.rejects(pending, { code: 'PHASE7_DEPLOY_INTERRUPTED' }); assert.equal(s.owner, null);
});
for (const change of ['pid', 'started', 'database', 'schema', 'lock']) {
  test(`changed ${change} identity fails closed without reacquiring or unlocking a replacement session`, async () => {
    const s = server();
    await assert.rejects(withDeploymentAuthority(s.options, async scope => {
      if (change === 'lock') s.dropLock(); else if (change === 'pid') s.clients[0].pid++; else s.clients[0][change] = 'changed';
      await scope.assertCurrent('boundary'); assert.fail('lost authority continued');
    }), { code: 'PHASE7_DEPLOY_AUTHORITY_LOST' });
    assert.equal(s.events.filter(x => x[0] === 'acquire').length, 1);
    assert.equal(s.events.filter(x => x[0] === 'release').length, 0);
  });
}
test('heartbeat loss aborts a running child and waits for its settlement', async () => {
  const s = server(), drained = deferred(), aborted = deferred(); let done = false;
  const pending = withDeploymentAuthority({ ...s.options, heartbeatMs: 5 }, async scope => {
    s.clients[0].failQuery = true;
    scope.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    await aborted.promise; await drained.promise;
  }).finally(() => { done = true; });
  await aborted.promise; assert.equal(done, false); drained.resolve();
  await assert.rejects(pending, error => error.code === 'PHASE7_DEPLOY_AUTHORITY_LOST' && !JSON.stringify(error).includes('synthetic-secret'));
  assert.equal(s.events.filter(x => x[0] === 'release').length, 0);
});
test('concurrent probes share one in-flight query and cleanup waits for it', async () => {
  const s = server();
  await withDeploymentAuthority(s.options, async scope => {
    const gate = deferred(); s.clients[0].blockProbe = gate;
    const before = s.events.length, pending = Array.from({ length: 8 }, () => scope.assertCurrent());
    await tick(); assert.equal(s.events.length - before, 1);
    s.clients[0].blockProbe = null; gate.resolve(); await Promise.all(pending);
  });
});
for (const mode of ['failRelease', 'failDisconnect']) {
  test(`${mode} prevents success despite completed work`, async () => {
    const s = server();
    await assert.rejects(withDeploymentAuthority(s.options, () => { s.clients[0][mode] = true; return 42; }), /PHASE7_DEPLOY_AUTHORITY_(RELEASE|DISCONNECT)_FAILED/);
    assert.equal(s.events.at(-1)[0], 'disconnect');
  });
}
test('work failure retains its identity while cleanup failures remain attached', async () => {
  const s = server(), problem = new Error('original failure');
  await assert.rejects(withDeploymentAuthority(s.options, () => { s.clients[0].failRelease = true; s.clients[0].failDisconnect = true; throw problem; }), error => error === problem && error.cleanupErrors.length === 2);
});
test('failure to publish acquisition still releases the owned session', async () => {
  const s = server();
  await assert.rejects(withDeploymentAuthority({ ...s.options, emit() { throw new Error('diagnostic failed'); } }, () => assert.fail('work started')), { code: 'PHASE7_DEPLOY_AUTHORITY_CONNECTION_FAILED' });
  assert.equal(s.owner, null); assert.equal(s.events.at(-1)[0], 'disconnect');
});

test('connection construction failure is redacted before CLI reporting', async () => {
  await assert.rejects(withDeploymentAuthority({ databaseUrl, createClient() { throw new Error(databaseUrl); } }, () => {}), error =>
    error.code === 'PHASE7_DEPLOY_AUTHORITY_CONNECTION_FAILED' && !JSON.stringify(error).includes('synthetic-secret'));
});

async function deploymentFixture(s, commandRunner) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createHash } = require('node:crypto'), { createRequire } = require('node:module');
  const root = path.resolve(__dirname, '../..'), entry = path.join(root, 'scripts/database/phase7-deploy.js');
  const load = createRequire(entry), module = { exports: {} }, receipts = [], events = s.events;
  const rows = fs.readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true })
    .filter(x => x.isDirectory() && x.name !== '20260930190000_phase7_legacy_storage_contract_v1').map(x => ({
      migration_name: x.name, checksum: createHash('sha256').update(fs.readFileSync(path.join(root, 'prisma/migrations', x.name, 'migration.sql'))).digest('hex'),
      finished_at: new Date('2026-10-08T00:00:00Z'), rolled_back_at: null,
    }));
  const db = { async $disconnect() {}, async $queryRawUnsafe(sql) {
    events.push(['application-query']); assert.notEqual(s.owner, null, 'catalog work requires deployment ownership');
    if (sql.includes("to_regclass('public._prisma_migrations')")) return [{ name: '_prisma_migrations' }];
    if (sql.startsWith('SELECT migration_name,checksum,')) return rows;
    throw new Error('Unexpected SQL');
  } };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(entry), process, console: { log() {} },
    require(id) {
      if (id === './phase7-deploy-authority') return { withDeploymentAuthority: (options, work) => withDeploymentAuthority({ ...s.options, ...options }, work) };
      if (id === './phase7-role-preflight') return { inspectRoles: async () => ({ verified: true }) };
      if (id === '../../src/services/phase7-legacy-storage-service') return { storageState: async () => ({ phase: 'BRIDGE', targetReady: false }) };
      return load(id);
    },
  }, { filename: entry });
  return { receipts, run: () => module.exports.main({ db, commandRunner, emitResult(value) {
    assert.equal(s.owner, null, 'success must follow authority cleanup'); receipts.push(value);
  } }) };
}

test('actual deployment entrypoint acquires authority before catalog access and publishes after its cleanup', async () => {
  const s = server(), f = await deploymentFixture(s, async () => {});
  await f.run(); assert.equal(s.events[0][0], 'acquire'); assert.equal(f.receipts.length, 1);
  assert.equal(s.events.at(-1)[0], 'disconnect');
});
test('actual deployment cannot publish a receipt when authority release fails', async () => {
  const s = server(), f = await deploymentFixture(s, async () => { s.clients[0].failRelease = true; });
  await assert.rejects(f.run(), { code: 'PHASE7_DEPLOY_AUTHORITY_RELEASE_FAILED' });
  assert.equal(f.receipts.length, 0);
});
test('authority heartbeat loss propagates through the entrypoint to a real running child and drains it', async () => {
  const s = server(); s.options.heartbeatMs = 5;
  const { runStage } = require('../../scripts/database/phase7-deploy-child');
  let children = 0, startedPid;
  const f = await deploymentFixture(s, async (args, options) => {
    children++;
    try {
      await runStage(['-e', 'setInterval(()=>{},1000)'], { signal: options.signal, timeoutMs: 5000,
        killGraceMs: 100, stdio: 'ignore', emit(event) {
          if (event.event === 'PHASE7_DEPLOY_STAGE_START') { startedPid = event.pid; s.clients[0].failQuery = true; }
        } });
    } finally { s.events.push(['child-drained']); }
  });
  await assert.rejects(f.run(), { code: 'PHASE7_DEPLOY_AUTHORITY_LOST' });
  assert(Number.isInteger(startedPid)); assert.equal(children, 1); assert.equal(f.receipts.length, 0);
  assert(s.events.findIndex(x => x[0] === 'disconnect') > s.events.findIndex(x => x[0] === 'child-drained'));
});
