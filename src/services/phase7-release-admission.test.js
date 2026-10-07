'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');
const source = require('../../scripts/database/phase7-release-source');
const { GENERATION, manifest, COHORTS, sha } = require('./phase7-legacy-storage-service');
const { validateEvidence } = require('./phase7-contract-evidence');
const { deployArguments } = require('../../scripts/database/phase7-deploy');
const { args } = require('../../scripts/maintenance/phase7-legacy-storage');
const codeRoot = path.resolve(__dirname, '../..');

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'onlinod-phase7-source-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const roots = {};
  for (const name of ['backendRoot', 'desktopRoot', 'baseBackendRoot', 'baseDesktopRoot']) {
    roots[name] = path.join(temp, name); await fs.mkdir(roots[name]);
    await fs.writeFile(path.join(roots[name], 'app.js'), `module.exports=${JSON.stringify(name)};\n`);
  }
  const output = path.join(temp, 'release.json'), options = { ...roots, packageId: 'ADMISSION_TEST', output };
  await source.writeRelease(options);
  return { temp, roots, output, options, release: await source.readRelease(roots.backendRoot, { file: output }) };
}
function evidence(release) {
  const now = Date.now(), iso = n => new Date(n).toISOString();
  return validateEvidence({ version: 1, generation: GENERATION, ...release, operator: 'isolated test', noOldBinariesRemain: true,
    rollbackMode: 'restore_database_and_matching_sources', rollbackWindow: { openedAt: iso(now - 10000), closedAt: iso(now) },
    stoppedBinaries: [['backend', release.baseBackendHash], ['desktop', release.baseDesktopHash]].map(([component, sourceHash]) => ({ component, sourceHash, scope: 'fixture', stoppedAt: iso(now - 1) })),
    archive: { durability: 'persistent_backup', exportRoot: 'e'.repeat(64), restoreRoot: 'f'.repeat(64), backupId: 'synthetic proof only', restoredAt: iso(now), retentionUntil: iso(now + 600000) } }, release);
}
function admissionModule(root = codeRoot) {
  const name = path.join(root, 'src/services/phase7-retirement-finalizer.js'), load = createRequire(name), module = { exports: {} };
  vm.runInNewContext(sync.readFileSync(name, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(name),
    require(id) {
      if (id === './phase7-legacy-storage-service') return { ...load(id), storageState: async () => ({ ready: true }) };
      if (id.endsWith('/phase7-legacy-storage-indexes')) return { ensureIndexes: async () => ({ ready: true }) };
      if (id.endsWith('/phase7-role-preflight')) return { inspectRoles: async () => ({ verified: true }) };
      return load(id);
    },
  }, { filename: name });
  return module.exports;
}
function readyDatabase(release) {
  const checked = evidence(release), receipt = { ...release, operatorEvidence: checked.evidence, operatorEvidenceHash: checked.evidenceHash,
    roleReport: { runtimeRoles: [{ name: 'runtime' }], verified: true } };
  const rows = COHORTS.map(id => ({ id, planHash: manifest.planHash, state: 'PURGE_READY', rollbackClosedAt: new Date(),
    enumerationComplete: true, verifiedAt: new Date(), fingerprint: 'fingerprint', releaseManifest: structuredClone(receipt) }));
  return { rows, phase7RetirementCohort: { findMany: async () => rows }, phase7RetirementPartition: { findFirst: async () => null },
    $queryRawUnsafe: async sql => sql.includes('phase7_storage_fingerprint') ? [{ value: 'fingerprint' }] : [] };
}

test('paired source evidence hashes actual four trees without rewriting historical manifests', async t => {
  const f = await fixture(t);
  for (const root of Object.values(f.roots)) await fs.writeFile(path.join(root, 'phase7-release.json'), 'old receipt stays byte-identical');
  const before = await source.readRelease(f.roots.backendRoot, { file: f.output });
  const again = await source.createRelease(f.options);
  assert.deepEqual(source.identity(again), before);
  for (const root of Object.values(f.roots)) assert.equal(await fs.readFile(path.join(root, 'phase7-release.json'), 'utf8'), 'old receipt stays byte-identical');
  assert.notEqual(before.backendHash, before.baseBackendHash); assert.notEqual(before.desktopHash, before.baseDesktopHash);
});
test('changed, added and removed executable source invalidates an existing receipt', async t => {
  const f = await fixture(t), file = path.join(f.roots.backendRoot, 'app.js'), original = await fs.readFile(file);
  await fs.writeFile(file, 'changed'); await assert.rejects(source.readRelease(f.roots.backendRoot, { file: f.output }), { code: 'PHASE7_RELEASE_SOURCE_MISMATCH' });
  await fs.writeFile(file, original); await fs.writeFile(path.join(f.roots.backendRoot, 'extra.js'), 'extra');
  await assert.rejects(source.readRelease(f.roots.backendRoot, { file: f.output }), { code: 'PHASE7_RELEASE_SOURCE_SET_MISMATCH' });
  await fs.unlink(path.join(f.roots.backendRoot, 'extra.js')); await fs.unlink(file);
  await assert.rejects(source.readRelease(f.roots.backendRoot, { file: f.output }), { code: 'PHASE7_RELEASE_SOURCE_SET_MISMATCH' });
});
test('Desktop inventory, duplicate paths and malformed identities cannot be hidden behind a valid Backend', async t => {
  const f = await fixture(t), original = JSON.parse(await fs.readFile(f.output, 'utf8'));
  for (const mutate of [x => { x.desktopFiles[0].sha256 = '0'.repeat(64); }, x => { x.desktopFiles.push(x.desktopFiles[0]); x.desktopHash = sha(JSON.stringify(x.desktopFiles)); },
    x => { x.version = 2; }, x => { x.packageId = ''; }, x => { x.baseDesktopHash = null; }, x => { x.backendFiles[0].path = '../escape'; }]) {
    const bad = structuredClone(original); mutate(bad); await fs.writeFile(f.output, JSON.stringify(bad));
    await assert.rejects(source.readRelease(f.roots.backendRoot, { file: f.output }), error => error.code.startsWith('PHASE7_'));
  }
});
test('source symlinks and an external receipt symlink fail closed; output cannot overwrite or enter a source tree', async t => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.roots.desktopRoot, 'app.js'), path.join(f.roots.backendRoot, 'linked.js'));
  await assert.rejects(source.readRelease(f.roots.backendRoot, { file: f.output }), /SOURCE_SYMLINK/); await fs.unlink(path.join(f.roots.backendRoot, 'linked.js'));
  const link = path.join(f.temp, 'linked-receipt.json'); await fs.symlink(f.output, link);
  await assert.rejects(source.readRelease(f.roots.backendRoot, { file: link }), { code: 'PHASE7_RELEASE_MANIFEST_INVALID' });
  await assert.rejects(source.writeRelease(f.options), { code: 'EEXIST' });
  await assert.rejects(source.writeRelease({ ...f.options, output: path.join(f.roots.desktopRoot, 'new.json') }), { code: 'PHASE7_RELEASE_FILE_MUST_BE_EXTERNAL' });
  await fs.copyFile(f.output, path.join(f.roots.backendRoot, 'external.json'));
  await assert.rejects(source.readRelease(f.roots.backendRoot, { file: path.join(f.roots.backendRoot, 'external.json') }), { code: 'PHASE7_RELEASE_FILE_MUST_BE_EXTERNAL' });
});
test('ready DB receipt accepts only the exact current paired release, including rollback base and package identity', async t => {
  const f = await fixture(t), finalizer = admissionModule();
  assert.equal((await finalizer.checkContractReady(readyDatabase(f.release), { root: f.roots.backendRoot, releaseFile: f.output })).ready, true);
  for (const key of ['backendHash', 'desktopHash', 'baseBackendHash', 'baseDesktopHash', 'packageId']) {
    const previous = { ...f.release, [key]: key === 'packageId' ? 'PREVIOUS' : 'a'.repeat(64) };
    await assert.rejects(finalizer.checkContractReady(readyDatabase(previous), { root: f.roots.backendRoot, releaseFile: f.output }), { code: 'PHASE7_PREPARED_RELEASE_MISMATCH' });
  }
});
test('prepared receipt is insufficient when source was changed or release evidence disappeared', async t => {
  const f = await fixture(t), finalizer = admissionModule(), db = readyDatabase(f.release);
  await fs.appendFile(path.join(f.roots.backendRoot, 'app.js'), '\n// next deployment\n');
  await assert.rejects(finalizer.checkContractReady(db, { root: f.roots.backendRoot, releaseFile: f.output }), { code: 'PHASE7_RELEASE_SOURCE_MISMATCH' });
  await fs.unlink(f.output);
  await assert.rejects(finalizer.checkContractReady(db, { root: f.roots.backendRoot, releaseFile: f.output }), { code: 'ENOENT' });
});
test('staged schema/migrations must match the attested release and must not gain extra executable files', async t => {
  const f = await fixture(t), prisma = path.join(f.roots.backendRoot, 'prisma');
  await fs.mkdir(path.join(prisma, 'migrations/001'), { recursive: true });
  await fs.writeFile(path.join(prisma, 'schema.prisma'), 'schema'); await fs.writeFile(path.join(prisma, 'migrations/migration_lock.toml'), 'lock');
  await fs.writeFile(path.join(prisma, 'migrations/001/migration.sql'), 'SELECT 1;');
  await fs.unlink(f.output); await source.writeRelease(f.options); const release = await source.readRelease(f.roots.backendRoot, { file: f.output });
  const staged = path.join(f.temp, 'staged'); await fs.cp(prisma, staged, { recursive: true });
  const verify = () => source.verifyStagedRelease(f.roots.backendRoot, staged, ['001'], { file: f.output, expectedRelease: release });
  await verify(); await fs.writeFile(path.join(staged, 'schema.prisma'), 'other schema');
  await assert.rejects(verify(), { code: 'PHASE7_RELEASE_SOURCE_MISMATCH' }); await fs.copyFile(path.join(prisma, 'schema.prisma'), path.join(staged, 'schema.prisma'));
  await fs.writeFile(path.join(staged, 'migrations/001/migration.sql'), 'SELECT 2;');
  await assert.rejects(verify(), { code: 'PHASE7_RELEASE_SOURCE_MISMATCH' }); await fs.copyFile(path.join(prisma, 'migrations/001/migration.sql'), path.join(staged, 'migrations/001/migration.sql'));
  await fs.writeFile(path.join(staged, 'unreviewed.sql'), 'DROP TABLE old;'); await assert.rejects(verify(), { code: 'PHASE7_RELEASE_SOURCE_SET_MISMATCH' });
});
test('CLI requires an explicit destructive flag and does not silently discard release or maintenance options', () => {
  assert.deepEqual(deployArguments([]), { contract: false });
  assert.deepEqual(deployArguments(['--contract', '--release-file=/secure/release.json']), { contract: true, releaseFile: '/secure/release.json' });
  for (const argv of [['--contract=false'], ['--contarct'], ['--release-file=x'], ['--contract', '--contract'], ['--contract', '--release-file='], ['--contract', '--unknown']]) assert.throws(() => deployArguments(argv), /PHASE7_/);
  assert.deepEqual(args(['prepare-contract', '--close-rollback', '--release-file=/secure/release.json', '--operator-evidence=/secure/evidence.json']),
    { command: 'prepare-contract', 'close-rollback': true, 'release-file': '/secure/release.json', 'operator-evidence': '/secure/evidence.json' });
  for (const argv of [['indexes', '--create=false'], ['status', '--release-file=x'], ['run', '--steps=0'], ['run', '--steps=1.5'], ['run', '--steps=101'], ['run', '--steps=2', '--steps=3'], ['prepare-contract', '--release-fiel=x'], ['status', '--state=UNKNOWN']]) assert.throws(() => args(argv), /PHASE7_/);
});

// This deliberately loads the frozen source supplied to the previous release.
// It reproduces acceptance of stale/missing sources without touching that tree.
if (process.env.PHASE7_ADMISSION_BASELINE_ROOT) test('BASELINE reproduces stale and missing source acceptance at contract admission', async t => {
  const f = await fixture(t), previous = admissionModule(path.resolve(process.env.PHASE7_ADMISSION_BASELINE_ROOT));
  const db = readyDatabase({ ...f.release, backendHash: 'a'.repeat(64), desktopHash: 'b'.repeat(64) });
  await fs.appendFile(path.join(f.roots.backendRoot, 'app.js'), '// changed'); await fs.unlink(f.output);
  assert.equal((await previous.checkContractReady(db, { root: f.roots.backendRoot, releaseFile: f.output })).ready, true);
});

async function deploymentFixture(t, { corruptStage = false, afterFirstAdmission, beforeSecondAdmission } = {}) {
  const f = await fixture(t), CONTRACT = '20260930190000_phase7_legacy_storage_contract_v1';
  const names = ['20200101000000_base', CONTRACT], prisma = path.join(f.roots.backendRoot, 'prisma');
  await fs.mkdir(path.join(prisma, 'migrations'), { recursive: true });
  await fs.writeFile(path.join(prisma, 'schema.prisma'), 'fixture schema');
  await fs.writeFile(path.join(prisma, 'migrations/migration_lock.toml'), 'provider="postgresql"');
  for (const name of names) { await fs.mkdir(path.join(prisma, 'migrations', name)); await fs.writeFile(path.join(prisma, 'migrations', name, 'migration.sql'), 'SELECT 1;'); }
  await fs.unlink(f.output); await source.writeRelease(f.options);
  f.release = await source.readRelease(f.roots.backendRoot, { file: f.output });
  const db = readyDatabase(f.release), readyQuery = db.$queryRawUnsafe;
  db.$disconnect = async () => {};
  db.$queryRawUnsafe = async sql => {
    if (sql.includes("to_regclass('public._prisma_migrations')")) return [{ name: '_prisma_migrations' }];
    if (sql.startsWith('SELECT migration_name,checksum,')) return [{ migration_name: names[0], checksum: sha('SELECT 1;'), finished_at: new Date(), rolled_back_at: null }];
    return readyQuery(sql);
  };
  let checks = 0, staged;
  const finalizer = admissionModule(), file = path.join(codeRoot, 'scripts/database/phase7-deploy.js'), load = createRequire(file), module = { exports: {} };
  vm.runInNewContext(sync.readFileSync(file, 'utf8'), { module, exports: module.exports, __dirname: path.join(f.roots.backendRoot, 'scripts/database'), process,
    console: { log() {} }, require(id) {
      if (id === 'node:fs/promises') return { ...fs, async copyFile(from, to) { await fs.copyFile(from, to); if (path.basename(to) === 'schema.prisma') { staged = path.dirname(to); if (corruptStage) await fs.writeFile(to, 'unattested schema'); } } };
      if (id === './phase7-role-preflight') return { inspectRoles: async () => ({ verified: true }) };
      if (id === '../../src/services/phase7-legacy-storage-service') return { storageState: async () => ({ ready: true }) };
      if (id === '../../src/services/phase7-retirement-finalizer') return { async checkContractReady(client, options) {
        checks++; if (checks === 2 && beforeSecondAdmission) await beforeSecondAdmission({ ...f, db });
        const result = await finalizer.checkContractReady(client, options);
        if (checks === 1 && afterFirstAdmission) await afterFirstAdmission({ ...f, db });
        return result;
      } };
      return load(id);
    },
  }, { filename: file });
  const calls = [];
  return { ...f, db, names, get checks() { return checks; }, get staged() { return staged; }, calls,
    async run(contract = true) { return module.exports.main({ db, contract, releaseFile: f.output, hooks: false, commandRunner: async argv => {
      calls.push(argv); assert.equal(argv[1], 'migrate'); assert.equal(argv[2], 'deploy');
      const present = await fs.readdir(path.join(path.dirname(argv.at(-1)), 'migrations'));
      assert.equal(present.includes(CONTRACT), contract);
    } }); },
  };
}
test('real deployment staging rechecks admission twice and removes the temporary source bundle', async t => {
  const f = await deploymentFixture(t); await f.run(); assert.equal(f.checks, 2); assert.equal(f.calls.length, 1);
  await assert.rejects(fs.stat(f.staged), { code: 'ENOENT' });
});
test('source replacement after first admission stops deployment before the migration child', async t => {
  const f = await deploymentFixture(t, { afterFirstAdmission: async x => fs.appendFile(path.join(x.roots.backendRoot, 'app.js'), '// newer source') });
  await assert.rejects(f.run(), { code: 'PHASE7_RELEASE_SOURCE_MISMATCH' }); assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.staged), { code: 'ENOENT' });
});
test('corrupted staged bytes stop deployment while original source still matches', async t => {
  const f = await deploymentFixture(t, { corruptStage: true });
  await assert.rejects(f.run(), { code: 'PHASE7_RELEASE_SOURCE_MISMATCH' }); assert.equal(f.calls.length, 0);
  await source.readRelease(f.roots.backendRoot, { file: f.output });
});
test('different prepared DB release after staging is rejected before the migration child', async t => {
  const f = await deploymentFixture(t, { beforeSecondAdmission: async x => {
    const changed = readyDatabase({ ...x.release, packageId: 'ANOTHER_RELEASE' });
    x.db.rows.splice(0, x.db.rows.length, ...changed.rows);
  } });
  await assert.rejects(f.run(), { code: 'PHASE7_PREPARED_RELEASE_MISMATCH' }); assert.equal(f.calls.length, 0); assert.equal(f.checks, 2);
});
test('expired backup evidence after staging cannot reuse the earlier successful check', async t => {
  const f = await deploymentFixture(t, { beforeSecondAdmission: async x => {
    for (const row of x.db.rows) row.releaseManifest.operatorEvidence.archive.retentionUntil = '2000-01-01T00:00:00.000Z';
  } });
  await assert.rejects(f.run(), { code: 'PHASE7_DURABLE_ARCHIVE_EVIDENCE_INVALID' }); assert.equal(f.calls.length, 0);
});
test('ordinary deployment keeps its retained-schema path and does not depend on a release evidence file', async t => {
  const f = await deploymentFixture(t); await fs.unlink(f.output); await f.run(false);
  assert.equal(f.checks, 0); assert.equal(f.calls.length, 1);
});
