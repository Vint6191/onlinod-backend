'use strict';
// Run only against an explicitly supplied disposable PostgreSQL instance.
// Installs v41 over populated v40, including two concurrent real installers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const currentRoot = path.resolve(__dirname, '../..');
const tables = ['CreatorSale', 'CreatorMediaAsset', 'CreatorMediaUsageFact', 'CreatorMediaUsageContribution',
  'CreatorMediaUsageSourceState', 'CreatorMediaSaleLink', 'CreatorMediaMessageFinancialState',
  'CreatorEntityChange', 'CreatorEntityCurrent', 'CreatorEntityChangeHead', 'DialogScanRun',
  'DialogScanState', 'DialogReconciliationTarget', 'JobInstance'];
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item, 2);
const hash = value => createHash('sha256').update(json(value)).digest('hex');
function localUrl(value) {
  const u = new URL(value);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && /^(?:audit\d+_|onlinod_test_|onlinod_fixture_)/.test(u.pathname.slice(1)),
    'Explicit local disposable PostgreSQL is required');
  return value;
}
exports.runVault214Upgrade = async function runVault214Upgrade(options) {
  assert.equal(process.env.ONLINOD_POSTGRES_INTEGRATION, '1');
  const urls = { DATABASE_URL: localUrl(options.url), DIALOGS_DATABASE_URL: localUrl(options.dialogsUrl), CRM_DATABASE_URL: localUrl(options.crmUrl) };
  assert.equal(new Set(Object.values(urls).map(value => new URL(value).pathname)).size, 3);
  const oldRoot = path.resolve(options.baselineBackendRoot), output = path.resolve(options.output);
  assert.notEqual(oldRoot, currentRoot); fs.mkdirSync(output, { recursive: true });
  const oldLoad = createRequire(path.join(oldRoot, 'package.json')), currentLoad = createRequire(path.join(currentRoot, 'package.json'));
  const oldContract = oldLoad('./src/services/database-migration-chain').currentContract();
  const nextContract = currentLoad('./src/services/database-migration-chain').currentContract();
  assert.match(oldContract.version, /^nod_current_v40_/); assert.match(nextContract.version, /^nod_current_v41_/);
  const oldDb = new (oldLoad('@prisma/client').PrismaClient)({ datasources: { db: { url: urls.DATABASE_URL } } });
  const currentDb = new (currentLoad('@prisma/client').PrismaClient)({ datasources: { db: { url: urls.DATABASE_URL } } });
  for (const [load, db] of [[oldLoad, oldDb], [currentLoad, currentDb]]) require.cache[load.resolve('./src/prisma')] = { exports: db };
  const evidence = { ok: false, nativePostgres: true, node: process.version, from: oldContract.version,
    to: nextContract.version, productionAccessed: false, checks: [], installers: [] };
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), json(evidence));
  const check = async (name, work) => {
    try { const detail = await work(); evidence.checks.push({ name, ok: true, detail }); save(); console.log('PASS', name); return detail; }
    catch (error) { evidence.checks.push({ name, ok: false, error: error.stack }); save(); throw error; }
  };
  const write = work => oldLoad('./src/services/db-commit-kernel').runRootCommit(oldDb, ({ tx }) => work(tx));
  const childEnv = { ...process.env, ...urls, DIRECT_URL: urls.DATABASE_URL, CHECKPOINT_DISABLE: '1',
    JWT_SECRET: randomBytes(48).toString('hex'), SNAPSHOT_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
  async function install(label) {
    const fd = fs.openSync(path.join(output, label + '.log'), 'w'), started = Date.now();
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/database/install-all.js'], { cwd: currentRoot, env: childEnv, stdio: ['ignore', fd, fd] });
        child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      evidence.installers.push({ label, ...result, milliseconds: Date.now() - started }); save();
      assert.equal(result.code, 0, label); return result;
    } finally { fs.closeSync(fd); }
  }
  async function snapshot(db, creatorId) {
    const out = {};
    for (const table of tables) {
      const rows = await db.$queryRawUnsafe(`SELECT to_jsonb(t)::text AS row FROM "${table}" t WHERE "creatorId"=$1 ORDER BY to_jsonb(t)::text`, creatorId);
      out[table] = rows.map(row => row.row);
    }
    return out;
  }
  try {
    const receipts = await oldDb.$queryRawUnsafe('SELECT migration_name, checksum, to_jsonb(t)::text AS row FROM "_prisma_migrations" t ORDER BY migration_name');
    await check('Pristine v40 schema has46 complete migration receipts and an independent Prisma client', async () => {
      assert.equal(receipts.length, 46);
      assert.equal((await oldLoad('./src/services/database-contract-service').readDatabaseContract(oldDb)).ready, true);
      assert.equal(oldLoad('@prisma/client').Prisma.dmmf.datamodel.models.some(row => row.name === 'CreatorMediaMessageEvidence'), false);
      assert.equal(currentLoad('@prisma/client').Prisma.dmmf.datamodel.models.some(row => row.name === 'CreatorMediaMessageEvidence'), true);
      return { migrations: receipts.length };
    });
    const scope = await oldLoad('./scripts/audit/analytics-traffic/fixture.cjs').scope(oldDb);
    const own = { agencyId: scope.agencyId, creatorId: scope.creatorId }, capturedAt = new Date().toISOString();
    const projection = oldLoad('./src/services/media-financial-projection-service');
    const sourceKey = projection.sourceKey(scope.creatorId, '2148001');
    await write(async tx => {
      await oldLoad('./src/services/creator-fact-write-authority').lockCreatorFacts(tx, scope.agencyId, scope.creatorId);
      await tx.creatorSale.create({ data: { ...own, id: 'vault214_upgrade_sale', eventFingerprint: 'b'.repeat(64),
        externalTransactionId: 'vault214_upgrade_transaction', fanOnlyFansUserIdAtEvent: '2148001', saleType: 'MESSAGE', messageId: '2147001',
        amountCents: 1004, netCents: 803, transactionStatus: 'done', currency: 'USD', purchasedAt: new Date(capturedAt) } });
      await oldLoad('./src/services/creator-entity-change-service').publishCanonicalSales({ db: tx, ...own, saleIds: ['vault214_upgrade_sale'] });
    });
    const facts = ['2149001', '2149002', '2149999'].map((mediaId, index) => ({ messageId: '2147001', mediaId,
      sentCount: 1, soldCount: 1, notOpenedCount: 0, freeCount: 0, revenueCents: 0, uniqueBuyers: 1, lastSoldAt: capturedAt,
      allocationCount: 3, allocationIndex: index, purchaseEvidence: 'PROVIDER' }));
    const source = { protocolVersion: 2, sourceKey, sourceRevision: 'upgrade-v40-history', capturedAt,
      coverage: { version: 1, complete: true, localRevision: 'upgrade-v40-history', messageCount: 1,
        oldestMessageAt: capturedAt, newestMessageAt: capturedAt }, facts,
      factPage: { runId: createHash('sha256').update(JSON.stringify([sourceKey, 'upgrade-v40-history'])).digest('hex'), pageNumber: 1,
        previousHash: null, pageHash: oldLoad('./src/services/realtime-receipt-hash').hashCanonicalJson(facts), done: true, totalFacts: 3 } };
    await oldLoad('./src/services/media-library-service').replaceUsageSources({ ...own, db: oldDb, sources: [source] });
    await write(tx => oldLoad('./src/services/dialog-intelligence-service').scheduleDialogScanTx(tx, {
      ...own, dialogId: '2148001', mode: 'targeted', targetMessageId: '2147001', source: 'vault214_populated_upgrade' }));
    const before = await snapshot(oldDb, scope.creatorId);
    evidence.before = Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, { count: rows.length, sha256: hash(rows) }]));
    await check('Existing purchased message, three historical media facts, money, target and queued job are populated before upgrade', async () => {
      assert.equal(before.CreatorSale.length, 1); assert.equal(before.CreatorMediaUsageFact.length, 3);
      assert.equal(before.CreatorMediaAsset.length, 3); assert.equal(before.DialogReconciliationTarget.length, 1);
      const sum = await oldDb.creatorMediaAsset.aggregate({ where: own, _sum: { revenueCents: true } });
      assert.equal(sum._sum.revenueCents, 803);
      return { rows: Object.values(before).reduce((sum, rows) => sum + rows.length, 0), tables: tables.length, revenueCents: 803 };
    });
    await oldDb.$disconnect();
    await check('Two concurrent production installers and a repeat install all complete successfully', async () => {
      await Promise.all([install('upgrade-concurrent-a'), install('upgrade-concurrent-b')]); await install('upgrade-repeat');
      return { successfulInstallers: evidence.installers.length };
    });
    await check('All existing migration receipts retain their exact rows and only the47th receipt is added', async () => {
      const after = await currentDb.$queryRawUnsafe('SELECT migration_name, checksum, to_jsonb(t)::text AS row FROM "_prisma_migrations" t ORDER BY migration_name');
      assert.equal(after.length, 47);
      for (const row of receipts) assert.deepEqual(after.find(next => next.migration_name === row.migration_name), row);
      const added = after.filter(row => !receipts.some(old => old.migration_name === row.migration_name));
      assert.equal(added.length, 1); assert.equal(added[0].migration_name, '20261128090000_vault_message_media_evidence');
      return { preserved: receipts.length, added: added.map(({ migration_name, checksum }) => ({ migration_name, checksum })) };
    });
    await check('All populated creator facts, annotations, targets and jobs remain byte-for-byte identical across installation', async () => {
      const after = await snapshot(currentDb, scope.creatorId); assert.deepEqual(after, before);
      evidence.after = Object.fromEntries(Object.entries(after).map(([table, rows]) => [table, { count: rows.length, sha256: hash(rows) }]));
      assert.equal(await currentDb.creatorMediaMessageEvidence.count(), 0, 'Upgrade must not invent source evidence for old rows');
      assert.equal((await currentLoad('./src/services/database-contract-service').readDatabaseContract(currentDb)).ready, true);
      return { tables: tables.length, matchingSnapshotSha256: hash(after), inventedEvidence: 0 };
    });
    await check('Old v2 replay after upgrade remains idempotent and preserves historical money before fresh evidence', async () => {
      const replay = await currentLoad('./src/services/media-library-service').replaceUsageSources({ ...own, db: currentDb, sources: [source] });
      const sum = await currentDb.creatorMediaAsset.aggregate({ where: own, _sum: { revenueCents: true } });
      assert.equal(sum._sum.revenueCents, 803); assert.equal(await currentDb.creatorMediaUsageFact.count({ where: own }), 3);
      assert.equal(await currentDb.creatorMediaMessageEvidence.count(), 0);
      return { revenueCents: 803, retainedFacts: 3, replayAccepted: replay.ok };
    });
    evidence.ok = true; save(); return evidence;
  } finally { await oldDb.$disconnect(); await currentDb.$disconnect(); save(); }
};
