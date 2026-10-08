'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), sync = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), { createRequire } = require('node:module');
const { sha } = require('./phase7-legacy-storage-service');
const root = process.env.ONLINOD_PHASE7_BASELINE_ROOT || path.resolve(__dirname, '../..');
function loadRunner({ filesystem = fs, page, transaction } = {}) {
  const file = path.join(root, 'src/services/phase7-retirement-runner.js'), req = createRequire(file), module = { exports: {} };
  vm.runInNewContext(sync.readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer, console,
    require(id) {
      if (id === 'node:fs/promises') return filesystem;
      if (id === './phase7-legacy-storage-service') return { ...req(id),
        runDbTransaction: transaction || (async (db, work) => work(db)),
        ...(page ? { readArchivePage: page } : {}) };
      return req(id);
    } }, { filename: file });
  return module.exports;
}
async function fixture(t, { groups = 2 } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'onlinod-archive-lifecycle-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const exported = path.join(temp, 'export'), restored = path.join(temp, 'restore');
  await fs.mkdir(exported); await fs.mkdir(restored);
  const runner = loadRunner(), id = runner.partitionId('AnalyticsSnapshot', 'a:agency');
  const p = { id, cohortId: 'analytics_compat', tableName: 'AnalyticsSnapshot', agencyKey: 'a:agency', agencyId: 'agency',
    sourceEpoch: 1n, sequence: groups, rows: BigInt(groups), bytes: 0n, digest: '', state: 'EXPORTED', cursor: groups ? 'row-' + groups : null,
    upperBound: groups ? 'row-' + groups : null, archiveRoot: groups ? sha(exported) : null, restoreRoot: null,
    verifiedSequence: 0, verifiedDigest: null, archiveVerifiedAt: null };
  const chunks = [];
  function descriptor(c) { return { version: 1, generation: 'phase7_legacy_storage_v1', planHash: require('./phase7-legacy-storage-manifest.json').planHash,
    partitionId: p.id, tableName: p.tableName, agencyId: p.agencyId, sourceEpoch: String(p.sourceEpoch), sequence: c.sequence,
    startCursor: c.startCursor, endCursor: c.endCursor, rows: c.rows, bytes: c.bytes, digest: c.digest, previousDigest: c.previousDigest }; }
  for (let i = 1; i <= groups; i++) {
    const data = Buffer.from(JSON.stringify({ id: 'row-' + i, agencyId: 'agency', value: i }) + '\n');
    const c = { partitionId: id, sourceEpoch: 1n, sequence: i, startCursor: i === 1 ? null : 'row-' + (i - 1), endCursor: 'row-' + i,
      rows: 1, bytes: data.length, digest: sha(data), previousDigest: p.digest };
    c.fileName = sha(JSON.stringify([id, '1', i, c.digest])) + '.jsonl';
    p.digest = sha(JSON.stringify([p.digest, c.digest, c.endCursor, c.rows, c.bytes])); p.bytes += BigInt(data.length);
    chunks.push(c);
    for (const folder of [exported, restored]) {
      await fs.writeFile(path.join(folder, c.fileName), data);
      await fs.writeFile(path.join(folder, c.fileName.replace('.jsonl', '.manifest.json')), JSON.stringify(descriptor(c)) + '\n');
    }
  }
  let writes = 0;
  const db = { async $queryRawUnsafe(sql, id) {
    if (sql.includes('phase7_lock_retirement_cohort')) {
      assert.equal(id, p.cohortId); return [{id:p.cohortId,state:'DRAINING'}];
    }
    if (sql.includes('"Phase7RetirementPartition"') && sql.includes('FOR UPDATE')) {
      assert.equal(id, p.id); return [structuredClone(p)];
    }
    throw Error('Unexpected SQL: '+sql);
  }, phase7RetirementPartition: {
    findUnique: async () => structuredClone(p),
    updateMany: async ({ where, data }) => {
      for (const [key, value] of Object.entries(where)) if (p[key] !== value) return { count: 0 };
      writes++; Object.assign(p, data); return { count: 1 };
    } }, phase7RetirementChunk: {
    findMany: async ({ where, take }) => structuredClone(chunks.filter(c => c.sourceEpoch === where.sourceEpoch
      && (where.sequence.gt === undefined || c.sequence > where.sequence.gt)
      && (where.sequence.gte === undefined || c.sequence >= where.sequence.gte)).slice(0, take)),
    aggregate: async () => ({ _count: { _all: chunks.length }, _sum: {
      rows: chunks.reduce((n, c) => n + c.rows, 0) || null, bytes: chunks.reduce((n, c) => n + c.bytes, 0) || null },
      _min: { sequence: chunks.length ? Math.min(...chunks.map(c => c.sequence)) : null },
      _max: { sequence: chunks.length ? Math.max(...chunks.map(c => c.sequence)) : null } }) } };
  return { temp, exported, restored, p, chunks, db, runner, descriptor, get writes() { return writes; },
    verify: (directory = restored) => runner.verifyPartitionPage({ db, partitionId: id, directory }) };
}

test('two real archived pages verify incrementally and bind the restored directory', async t => {
  const f = await fixture(t);
  assert.equal((await f.verify()).verified, false);
  assert.equal(f.p.verifiedSequence, 1);
  assert.equal((await f.verify()).verified, true);
  assert.equal(f.p.state, 'VERIFIED'); assert.equal(f.p.restoreRoot, sha(f.restored));
  assert.equal((await f.verify()).verified, true);
});
test('missing next receipt is an explicit failure with no false progress write', async t => {
  const f = await fixture(t); f.chunks.splice(0);
  await assert.rejects(f.verify(), { code: 'PHASE7_ARCHIVE_CHUNK_MISSING' }); assert.equal(f.writes, 0);
});
test('a completed verification cannot be reused with another restore directory', async t => {
  const f = await fixture(t, { groups: 1 }); await f.verify();
  const other = path.join(f.temp, 'different'); await fs.mkdir(other);
  await assert.rejects(f.verify(other), { code: 'PHASE7_RESTORE_ROOT_CHANGED' });
});
test('verification never creates a nonexistent restored backup directory', async t => {
  const f = await fixture(t, { groups: 0 }); const missing = path.join(f.temp, 'missing');
  await assert.rejects(f.verify(missing), { code: 'ENOENT' });
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' }); assert.equal(f.writes, 0);
});
test('a missing previously checked receipt invalidates a partial proof', async t => {
  const f = await fixture(t); await f.verify(); f.chunks.shift();
  await assert.rejects(f.verify(), { code: 'PHASE7_ARCHIVE_CHUNK_MISSING' }); assert.equal(f.p.state, 'EXPORTED');
});
test('cursor continuity is checked independently of each internally matching descriptor', async t => {
  const f = await fixture(t); await f.verify(); f.chunks[1].startCursor = 'different-start';
  await fs.writeFile(path.join(f.restored, f.chunks[1].fileName.replace('.jsonl', '.manifest.json')), JSON.stringify(f.descriptor(f.chunks[1])) + '\n');
  await assert.rejects(f.verify(), { code: 'PHASE7_ARCHIVE_CURSOR_MISMATCH' }); assert.equal(f.p.state, 'EXPORTED');
});
test('valid file digests cannot conceal wrong exported row or byte totals', async t => {
  for (const key of ['rows', 'bytes']) {
    const f = await fixture(t, { groups: 1 }); f.p[key] += 1n;
    await assert.rejects(f.verify(), { code: 'PHASE7_ARCHIVE_TOTALS_MISMATCH' }); assert.equal(f.writes, 0);
  }
});
test('an empty archive cannot carry nonzero exported rows', async t => {
  const f = await fixture(t, { groups: 0 }); f.p.rows = 1n;
  await assert.rejects(f.verify(), { code: 'PHASE7_ARCHIVE_PARTITION_INCONSISTENT' }); assert.equal(f.writes, 0);
});
test('verified metadata with an unfinished prefix never returns success', async t => {
  const f = await fixture(t); f.p.state = 'VERIFIED'; f.p.restoreRoot = sha(f.restored); f.p.archiveVerifiedAt = new Date();
  await assert.rejects(f.verify(), { code: 'PHASE7_ARCHIVE_PARTITION_INCONSISTENT' });
});
test('source epoch changing during file verification defeats the final compare-and-swap', async t => {
  const f = await fixture(t, { groups: 1 }); let changed = false;
  const runner = loadRunner({ filesystem: { ...fs, async open(name, ...args) {
    if (String(name).endsWith('.jsonl') && !changed) { changed = true; f.p.sourceEpoch++; f.p.state = 'PENDING'; }
    return fs.open(name, ...args);
  } } });
  await assert.rejects(runner.verifyPartitionPage({ db:f.db, partitionId:f.p.id, directory:f.restored }), { code: 'PHASE7_ARCHIVE_VERIFY_STALE' });
  assert.equal(changed, true); assert.equal(f.p.state, 'PENDING');
});
test('real content corruption leaves the partition unverified', async t => {
  const f = await fixture(t, { groups: 1 }); await fs.appendFile(path.join(f.restored, f.chunks[0].fileName), 'x');
  await assert.rejects(f.verify(), error => error.code?.startsWith('PHASE7_ARCHIVE_')); assert.equal(f.writes, 0);
});
test('write failure cleans the owned temporary artifact and preserves the original error', async t => {
  const f = await fixture(t, { groups: 0 }), diskFull = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const runner = loadRunner({ filesystem: { ...fs, async open(file, ...args) {
    const handle = await fs.open(file, ...args);
    if (path.basename(String(file)).startsWith('.pending-')) handle.writeFile = async () => { throw diskFull; };
    return handle;
  } } });
  await assert.rejects(runner.durableArtifact(f.exported, 'a'.repeat(64) + '.jsonl', Buffer.from('x')), error => error === diskFull);
  assert.deepEqual(await fs.readdir(f.exported), []);
});
test('the artifact writer cannot publish a traversal filename', async t => {
  const f = await fixture(t, { groups: 0 });
  await assert.rejects(f.runner.durableArtifact(f.exported, '../outside.jsonl', Buffer.from('x')), { code: 'PHASE7_ARCHIVE_NAME_INVALID' });
  await assert.rejects(fs.stat(path.join(f.temp, 'outside.jsonl')), { code: 'ENOENT' });
});
test('exclusive-create failure never removes a temporary file owned by another writer', async t => {
  const f = await fixture(t, { groups: 0 });
  const collision = Object.assign(new Error('already exists'), { code: 'EEXIST' });
  let otherFile;
  const runner = loadRunner({ filesystem: { ...fs, async open(file, ...args) {
    if (args[0] === 'wx') { otherFile = file; await fs.writeFile(file, 'other writer'); throw collision; }
    return fs.open(file, ...args);
  } } });
  await assert.rejects(runner.durableArtifact(f.exported, 'a'.repeat(64) + '.jsonl', Buffer.from('x')), e => e === collision);
  assert.equal(await fs.readFile(otherFile, 'utf8'), 'other writer');
});
test('file replacement between lstat and open is detected even with equal bytes', async t => {
  const f = await fixture(t, { groups: 1 }), file = path.join(f.restored, f.chunks[0].fileName); let replaced = false;
  const runner = loadRunner({ filesystem: { ...fs, async open(name, ...args) {
    if (name === file && !replaced) { replaced = true; const data = await fs.readFile(file); await fs.rename(file, file + '.old'); await fs.writeFile(file, data); }
    return fs.open(name, ...args);
  } } });
  await assert.rejects(runner.readArtifact(f.restored, f.chunks[0].fileName), { code: 'PHASE7_ARCHIVE_FILE_CHANGED' });
});
test('a reader close failure preserves the detected file identity error', async t => {
  const f = await fixture(t, { groups: 1 }), file = path.join(f.restored, f.chunks[0].fileName);
  const runner = loadRunner({ filesystem: { ...fs, async open(name, ...args) {
    if (name === file) { const data = await fs.readFile(file); await fs.rename(file, file + '.old'); await fs.writeFile(file, data); }
    const handle = await fs.open(name, ...args), close = handle.close.bind(handle);
    handle.close = async () => { await close(); throw Object.assign(new Error('close failed'), { code: 'EIO' }); };
    return handle;
  } } });
  await assert.rejects(runner.readArtifact(f.restored, f.chunks[0].fileName), error =>
    error.code === 'PHASE7_ARCHIVE_FILE_CHANGED' && error.phase7CleanupErrors[0].code === 'EIO');
});
test('directory close failure cannot replace the original durability failure', async t => {
  const f = await fixture(t, { groups: 0 }), original = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
  const runner = loadRunner({ filesystem: { ...fs, async open(file, ...args) {
    const handle = await fs.open(file, ...args);
    if (file === f.exported) {
      const close = handle.close.bind(handle);
      handle.sync = async () => { throw original; };
      handle.close = async () => { await close(); throw Object.assign(new Error('directory close failed'), { code: 'EBADF' }); };
    }
    return handle;
  } } });
  await assert.rejects(runner.durableArtifact(f.exported, 'a'.repeat(64) + '.jsonl', Buffer.from('x')), error =>
    error === original && error.phase7CleanupErrors[0].code === 'EBADF');
  assert.equal((await fs.readdir(f.exported)).some(name => name.startsWith('.pending-')), false);
});
test('a failed error-state write cannot hide the original archive failure', async t => {
  const f = await fixture(t, { groups: 0 }), original = Object.assign(new Error('original page error'), { code: 'SOURCE_FAILED' });
  const runner = loadRunner({ page: async () => { throw original; }, transaction: async () => { throw Object.assign(new Error('db disconnected'), { code: 'DB_GONE' }); } });
  f.p.state = 'RUNNING';
  await assert.rejects(runner.processPartition({ db: f.db, partition: f.p, directory: f.exported }), error => error === original);
});
