'use strict';

// Explicit disposable PostgreSQL only. Start this after the v39 installer and
// keep the database owner alive for the entire run. The physical provider
// response is synthetic; both collectors, leases, page receipts, publication,
// Traffic projection, cost command and installers are production code.
//
// ONLINOD_POSTGRES_INTEGRATION=1 \
// NOD_CAMPAIGN_UPGRADE_DATABASE_FILE=/absolute/disposable-urls.json \
// NOD_CAMPAIGN_V39_BACKEND_ROOT=/absolute/v39/backend \
// NOD_CAMPAIGN_V39_DESKTOP_ROOT=/absolute/v39/desktop \
// ONLINOD_DESKTOP_ROOT=/absolute/current/desktop \
// node scripts/audit/campaign-chain213-upgrade-proof.cjs
// The connection file must explicitly supply url, dialogsUrl and crmUrl.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash, randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createCampaignHarness } = require('../test-support/campaign-chain213-backend.cjs');

const CURRENT_ROOT = path.resolve(__dirname, '../..');
const VALIDATION_COLUMNS = [
  'campaignDirectorySourceValidationVersion',
  'membershipBaselineSourceValidationVersion',
  'membershipCatchupSourceValidationVersion',
];
const TABLES = [
  'CreatorCampaign', 'CreatorCampaignFan', 'CreatorCampaignFrontierFan',
  'CreatorFan', 'CreatorFanIdentityHead', 'CreatorFanRelationshipCurrent', 'CreatorFanValueCurrent',
  'CreatorCampaignCollectionState', 'CreatorSubscriptionEvent', 'CreatorSubscriptionLedger',
  'TrafficSource', 'TrafficSourceMember', 'TrafficMetric', 'TrafficFanProjection', 'TrafficReceiptProjection',
  'AnalyticsIngestBatch', 'AnalyticsScanProof', 'AnalyticsCoverage', 'AnalyticsPublication', 'JobInstance',
];
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';

function fixtureUrl(value, name) {
  if (!value) throw Error('EXPLICIT_DISPOSABLE_DATABASE_REQUIRED:' + name);
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !/^(?:onlinod_test_|onlinod_fixture_|audit[0-9]+_)[a-z0-9_]+$/.test(url.pathname.slice(1))) {
    throw Error('LOCAL_DISPOSABLE_DATABASE_REQUIRED:' + name);
  }
  return url.toString();
}

async function snapshot(db, scope) {
  const tables = {};
  for (const table of TABLES) {
    const removed = table === 'CreatorCampaignCollectionState' ? VALIDATION_COLUMNS : [];
    const rows = await db.$queryRawUnsafe(`SELECT (to_jsonb(t)-$2::text[])::text AS row
      FROM ${quote(table)} t WHERE "creatorId"=$1 ORDER BY (to_jsonb(t)-$2::text[])::text`, scope.creatorId, removed);
    tables[table] = rows.map(row => row.row);
  }
  const commands = await db.$queryRawUnsafe(`SELECT to_jsonb(t)::text AS row
    FROM "ManagementCommandReceipt" t WHERE "agencyId"=$1 ORDER BY "id"`, scope.agencyId);
  tables.ManagementCommandReceipt = commands.map(row => row.row);
  return tables;
}

async function migrationSnapshot(db) {
  return db.$queryRawUnsafe('SELECT migration_name,checksum,to_jsonb(t)::text AS row FROM "_prisma_migrations" t ORDER BY migration_name');
}

async function drainTraffic(h, scope) {
  for (let turn = 0; turn < 100; turn++) {
    const result = await h.load('./src/services/traffic-projection-service').runTrafficProjectionSweep({ db: h.db, limit: 8 });
    assert.equal(result.ok, true, json(result));
    const count = await h.db.domainWorkItem.count({ where: { creatorId: scope.creatorId,
      workClass: { in: ['TRAFFIC_FACT', 'TRAFFIC_FAN', 'TRAFFIC_BACKFILL'] }, isOutstanding: true } });
    if (!count) return turn + 1;
  }
  throw Error('TRAFFIC_PROJECTION_DID_NOT_CONVERGE');
}

async function identities(db, scope) {
  const where = { creatorId: scope.creatorId };
  return {
    campaigns: await db.creatorCampaign.findMany({ where, orderBy: { id: 'asc' }, select: { id: true, externalCampaignId: true } }),
    fans: await db.creatorFan.findMany({ where, orderBy: { id: 'asc' }, select: { id: true, onlyFansUserId: true } }),
    memberships: await db.creatorCampaignFan.findMany({ where, orderBy: { id: 'asc' }, select: { id: true, campaignId: true, fanRecordId: true, externalClaimerId: true } }),
    sources: await db.trafficSource.findMany({ where, orderBy: { id: 'asc' }, select: { id: true, canonicalCampaignId: true, externalId: true, costCents: true, currency: true, costRevision: true } }),
    sourceMembers: await db.trafficSourceMember.findMany({ where, orderBy: { id: 'asc' }, select: { id: true, sourceId: true, fanId: true } }),
    receipts: await db.creatorSubscriptionLedger.findMany({ where, orderBy: { id: 'asc' }, select: { id: true, eventHash: true, fanId: true, sourceId: true, amountCents: true, currency: true } }),
  };
}

async function runCampaignUpgradeProof(options) {
  if (process.env.ONLINOD_POSTGRES_INTEGRATION !== '1') throw Error('ONLINOD_POSTGRES_INTEGRATION_1_REQUIRED');
  const urls = {
    DATABASE_URL: fixtureUrl(options.url, 'core'),
    DIALOGS_DATABASE_URL: fixtureUrl(options.dialogsUrl, 'dialogs'),
    CRM_DATABASE_URL: fixtureUrl(options.crmUrl, 'crm'),
  };
  assert.equal(new Set(Object.values(urls).map(value => new URL(value).pathname)).size, 3, 'Three isolated fixture databases are required');
  const baselineRoot = path.resolve(options.baselineBackendRoot || 'MISSING_BASELINE_ROOT');
  const baselineDesktopRoot = path.resolve(options.baselineDesktopRoot || 'MISSING_BASELINE_DESKTOP_ROOT');
  const desktopRoot = path.resolve(options.desktopRoot || 'MISSING_CURRENT_DESKTOP_ROOT');
  assert.notEqual(baselineRoot, CURRENT_ROOT, 'The baseline must be an independent checkout and generated Prisma client');
  for (const root of [baselineRoot, CURRENT_ROOT, baselineDesktopRoot, desktopRoot]) assert.ok(fs.existsSync(path.join(root, 'package.json')), root);
  for (const root of [baselineDesktopRoot, desktopRoot]) assert.ok(fs.existsSync(path.join(root, 'apps/desktop/package.json')), root);
  const oldLoad = createRequire(path.join(baselineRoot, 'package.json'));
  const currentLoad = createRequire(path.join(CURRENT_ROOT, 'package.json'));
  const oldContract = oldLoad('./src/services/database-migration-chain').currentContract();
  const currentContract = currentLoad('./src/services/database-migration-chain').currentContract();
  assert.match(oldContract.version, /^nod_current_v39_/);
  assert.match(currentContract.version, /^nod_current_v40_/);
  const oldPrisma = oldLoad('@prisma/client'), newPrisma = currentLoad('@prisma/client');
  const oldFields = oldPrisma.Prisma.dmmf.datamodel.models.find(model => model.name === 'CreatorCampaignCollectionState').fields.map(field => field.name);
  const newFields = newPrisma.Prisma.dmmf.datamodel.models.find(model => model.name === 'CreatorCampaignCollectionState').fields.map(field => field.name);
  assert.ok(VALIDATION_COLUMNS.every(name => !oldFields.includes(name) && newFields.includes(name)), 'Independent v39/v40 Prisma clients required');
  const output = path.resolve(options.output || path.join(process.cwd(), 'campaign-chain213-upgrade-proof'));
  fs.mkdirSync(output, { recursive: true });
  const evidence = { ok: false, node: process.version, nativePostgres: true, syntheticProvider: true, liveProvider: false,
    from: oldContract.version, to: currentContract.version, checks: [], installers: [], snapshots: {}, limits: [
      'A disposable local PostgreSQL database and controlled provider responses are used; no live provider or Windows behavior is inferred.',
      'Snapshot equality covers the populated creator tables listed in snapshots; installation-owned global control metadata is verified by the database contract.',
    ] };
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), json(evidence));
  const check = async (name, fn) => {
    try {
      const detail = await fn(); evidence.checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
      console.log('PASS', name); save(); return detail;
    } catch (error) {
      evidence.checks.push({ name, ok: false, error: String(error.stack || error) }); save(); throw error;
    }
  };
  const childEnv = { ...process.env, ...urls, DIRECT_URL: urls.DATABASE_URL, CHECKPOINT_DISABLE: '1',
    JWT_SECRET: randomBytes(48).toString('hex'), SNAPSHOT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  // Explicit fixture URLs replace any ambient application connection before a
  // production module or child installer is allowed to resolve its singleton.
  Object.assign(process.env, urls);
  async function install(label, expectedCode = 0) {
    const log = path.join(output, label + '.log'), fd = fs.openSync(log, 'w');
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/database/install-all.js'], { cwd: CURRENT_ROOT, env: childEnv, stdio: ['ignore', fd, fd] });
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    }).finally(() => fs.closeSync(fd));
    evidence.installers.push({ label, ...result, elapsedMs: Date.now() - started, log: path.basename(log) }); save();
    if (expectedCode === 0) assert.equal(result.code, 0, label + ': ' + fs.readFileSync(log, 'utf8').slice(-8000));
    else assert.notEqual(result.code, 0, label + ' unexpectedly accepted the invalid schema');
    return { ...result, log };
  }
  let oldDb, currentDb, oldHarness, currentHarness;
  try {
    oldDb = new oldPrisma.PrismaClient({ datasources: { db: { url: urls.DATABASE_URL } } });
    evidence.engine = (await oldDb.$queryRawUnsafe('SELECT version() AS version'))[0].version;
    const migrationsBefore = await migrationSnapshot(oldDb);
    fs.writeFileSync(path.join(output, 'v39-migration-receipts.json'), json(migrationsBefore));
    await check('The populated-upgrade fixture begins at the real v39 schema and 45 complete migration receipts', async () => {
      assert.equal(migrationsBefore.length, 45);
      assert.equal((await oldLoad('./src/services/database-contract-service').readDatabaseContract(oldDb)).ready, true);
      const columns = await oldDb.$queryRawUnsafe('SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=\'CreatorCampaignCollectionState\'');
      assert.ok(VALIDATION_COLUMNS.every(name => !columns.some(row => row.column_name === name)));
      return { migrations: migrationsBefore.length, independentPrismaClients: true };
    });
    oldHarness = await createCampaignHarness({ db: oldDb, desktopRoot: baselineDesktopRoot, backendRoot: baselineRoot });
    const scope = await oldHarness.scope('campaign213_v39_upgrade');
    evidence.creatorId = scope.creatorId;
    const fanIds = ['9007199254740993', 'fan-213-😀'];
    const campaignIds = ['source-213-a', 'source-213-b'];
    const claimedAt = new Date(Date.now() - 2 * 86400000).toISOString();
    const provider = request => request.source.endsWith('.list')
      ? { list: campaignIds.map((id, index) => ({ id, name: index ? 'История B 😀' : 'История A', is_active: true })), hasMore: false }
      : { list: fanIds.map((id, index) => ({ id: 'claimer-' + index, user: { id }, createdAt: claimedAt })), hasMore: false };
    await oldHarness.observeValue(scope, fanIds[0], 'AVAILABLE', 12300);
    await oldHarness.observeValue(scope, fanIds[1], 'AVAILABLE', 45600);
    const legacyRun = await oldHarness.start(scope);
    await oldHarness.exhaust(legacyRun, provider);
    const legacyCompleted = await oldHarness.finish(legacyRun);
    await drainTraffic(oldHarness, scope);
    const legacySources = await oldDb.trafficSource.findMany({ where: { creatorId: scope.creatorId }, orderBy: { externalId: 'asc' } });
    assert.equal(legacySources.length, 2);
    const command = { commandId: randomUUID(), action: 'traffic.cost', targetId: scope.creatorId,
      payload: { sourceId: legacySources[0].id, expectedRevision: 0, costCents: 2675, currency: 'EUR' } };
    const oldManagement = oldHarness.load('./src/services/management-command-service');
    const costResult = await oldManagement.executeManagementCommand({ db: oldDb, agencyId: scope.agencyId, userId: scope.userId,
      actorMember: scope.member, deviceId: scope.deviceId, input: command });
    assert.equal(costResult.result.source.costRevision, 1);
    const receipt = await oldHarness.load('./src/services/subscription-receipt-projection-service').projectCanonicalSubscriptionReceipt({
      db: oldDb, job: { agencyId: scope.agencyId, creatorId: scope.creatorId, params: {} }, fact: {
        eventHash: 'upgrade213-paid-' + scope.creatorId, eventType: 'paid_subscribed', fanId: fanIds[0],
        amountCents: 2345, currency: 'USD', subscribedAt: new Date(Date.now() - 86400000).toISOString(),
      },
    });
    assert.ok(receipt.ledgerId);
    await drainTraffic(oldHarness, scope);
    const before = await snapshot(oldDb, scope), beforeIds = await identities(oldDb, scope);
    fs.writeFileSync(path.join(output, 'v39-populated-snapshot.json'), json(before));
    evidence.snapshots.before = Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, { count: rows.length, sha256: hash(rows) }]));
    evidence.snapshots.beforeSha256 = hash(before);
    evidence.snapshots.migrationsBeforeSha256 = hash(migrationsBefore);
    await check('The actual v39 collector publishes Campaigns, shared memberships, values, paid receipt and manual cost', async () => {
      assert.equal(legacyCompleted.job.status, 'DONE'); assert.equal(legacyCompleted.state.membershipCoverageStatus, 'COMPLETE');
      assert.equal(legacyCompleted.state.status, 'COMPLETE');
      assert.equal(legacyRun.job.params.sourceValidationVersion, undefined);
      assert.equal(beforeIds.campaigns.length, 2); assert.equal(beforeIds.fans.length, 2); assert.equal(beforeIds.memberships.length, 4);
      assert.equal(before.CreatorFanValueCurrent.length, 2); assert.equal(before.CreatorSubscriptionLedger.length, 1);
      assert.equal(before.ManagementCommandReceipt.length, 1);
      assert.equal(beforeIds.sources[beforeIds.sources.findIndex(row => row.id === legacySources[0].id)].costCents, 2675);
      assert.ok(legacyCompleted.state.campaignDirectoryVerifiedAt); assert.ok(legacyCompleted.state.membershipBaselineVerifiedAt);
      return { sourceRequests: legacyRun.calls.length, campaigns: 2, fans: 2, memberships: 4, paidReceiptCents: 2345, costCents: 2675, costCurrency: 'EUR' };
    });
    const indexes = currentLoad('./scripts/database/analytics-traffic-indexes');
    await check('The current runtime refuses the old schema and its missing currency index contracts before installation', async () => {
      const contract = await currentLoad('./src/services/database-contract-service').readDatabaseContract(oldDb);
      assert.equal(contract.ready, false);
      assert.ok(contract.problems.includes('BASELINE_REQUIRED'));
      await assert.rejects(indexes.ensureIndexes(oldDb), { code: 'ANALYTICS_TRAFFIC_INDEX_REQUIRED' });
      return { problems: contract.problems, indexContracts: indexes.definitions.length };
    });
    await oldHarness.close(); oldHarness = null;
    await oldDb.$disconnect(); oldDb = null;
    await check('Two simultaneous current installers upgrade v39 successfully and serialize concurrent index creation', async () => {
      // Intentional concurrency exercises the production deployment/index lock.
      const results = await Promise.allSettled([install('upgrade-concurrent-a'), install('upgrade-concurrent-b')]);
      for (const result of results) if (result.status !== 'fulfilled') throw result.reason;
      return { successfulInstallers: results.length };
    });
    currentDb = new newPrisma.PrismaClient({ datasources: { db: { url: urls.DATABASE_URL } } });
    const after = await snapshot(currentDb, scope);
    const migrationsAfter = await migrationSnapshot(currentDb);
    fs.writeFileSync(path.join(output, 'v40-populated-snapshot.json'), json(after));
    fs.writeFileSync(path.join(output, 'v40-migration-receipts.json'), json(migrationsAfter));
    const upgradedState = await currentDb.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    await check('Upgrade preserves every historical snapshot row and every byte of the 45 original migration receipts', async () => {
      assert.deepEqual(after, before);
      assert.equal(migrationsAfter.length, 46);
      for (const previous of migrationsBefore) assert.deepEqual(migrationsAfter.find(row => row.migration_name === previous.migration_name), previous);
      const added = migrationsAfter.filter(row => !migrationsBefore.some(old => old.migration_name === row.migration_name));
      assert.equal(added.length, 1); assert.equal(added[0].migration_name, '20261128080000_campaign_source_validation');
      assert.ok(VALIDATION_COLUMNS.every(name => upgradedState[name] === 0));
      evidence.snapshots.upgradeSha256 = hash(after);
      return { tablesCompared: TABLES.length + 1, rowsCompared: Object.values(before).reduce((sum, rows) => sum + rows.length, 0),
        previousReceiptsUnchanged: 45, migrations: 46, addedMigration: { name: added[0].migration_name, checksum: added[0].checksum },
        newColumnDefaults: Object.fromEntries(VALIDATION_COLUMNS.map(name => [name, upgradedState[name]])) };
    });
    await check('A sequential repeat is idempotent and the v40 guard verifies all 53 installed index contracts', async () => {
      await install('upgrade-repeat');
      assert.deepEqual(await snapshot(currentDb, scope), before);
      assert.deepEqual(await migrationSnapshot(currentDb), migrationsAfter);
      const contract = await currentLoad('./src/services/database-contract-service').readDatabaseContract(currentDb);
      assert.equal(contract.ready, true); assert.equal(contract.version, currentContract.version);
      assert.deepEqual(await indexes.ensureIndexes(currentDb), { ready: true, contracts: 53 });
      return { version: contract.version, contracts: 53, migrationReceiptsUnchanged: 46 };
    });
    await check('Historical marker 0 keeps facts readable but cannot certify current membership or reuse its directory', async () => {
      const membership = currentLoad('./src/services/campaign-membership-proof-service').membershipProofState(upgradedState);
      const freshness = currentLoad('./src/services/campaign-freshness-service');
      assert.equal(membership.baselineVerifiedAt, null); assert.equal(membership.baselineGeneration, null);
      assert.ok(membership.legacyBaselineVerifiedAt);
      assert.equal(freshness.directoryDue(upgradedState, new Date()), true);
      assert.equal(freshness.evaluateCampaignCollectionState(upgradedState, new Date()).providerFresh, false);
      const oldReuse = { campaignDirectoryReuseVersion: 1, campaignDirectoryReuseGeneration: upgradedState.campaignDirectoryGeneration,
        campaignDirectoryReuseRevision: upgradedState.campaignDirectoryRevision, campaignDirectoryReuseRequestedAt: upgradedState.campaignDirectoryRequestedAt.toISOString(),
        campaignDirectoryReuseCampaignCount: upgradedState.campaignDirectoryCampaignCount };
      const upgradedParams = currentLoad('./src/services/campaign-source-validation-authority-service').claimParams(oldReuse);
      assert.deepEqual(upgradedParams, { sourceValidationVersion: 1 });
      assert.deepEqual(await snapshot(currentDb, scope), before, 'Read-only old-proof checks must not mutate historical facts');
      return { historicalMembership: upgradedState.membershipCoverageStatus, currentProofAccepted: false, directoryReuseAccepted: false };
    });
    currentHarness = await createCampaignHarness({ db: currentDb, desktopRoot, backendRoot: CURRENT_ROOT });
    // The installer can take longer than normal presence admission. Renew only
    // this synthetic device's heartbeat, without changing job/proof authority.
    await currentDb.workerDevice.update({ where: { id: scope.deviceId }, data: { lastSeenAt: new Date() } });
    await currentDb.deviceCreatorBinding.update({ where: { deviceId_creatorId: { deviceId: scope.deviceId, creatorId: scope.creatorId } }, data: { lastSeenAt: new Date() } });
    const currentRun = await currentHarness.start(scope);
    assert.notEqual(currentRun.job.params.collectionGeneration, legacyRun.job.params.collectionGeneration);
    assert.equal(currentRun.job.params.sourceValidationVersion, 1);
    // Claim advertises support for reuse even on a full source scan. Only an
    // actual generation/revision binding could authorize skipping discovery.
    assert.equal(currentRun.job.params.campaignDirectoryReuseGeneration ?? null, null);
    assert.equal(currentRun.job.params.campaignDirectoryReuseRevision ?? null, null);
    await currentHarness.exhaust(currentRun, provider);
    const revalidated = await currentHarness.finish(currentRun);
    await drainTraffic(currentHarness, scope);
    await check('The actual current collector revalidates a fresh generation while preserving canonical identities, money and manual cost', async () => {
      assert.equal(revalidated.job.status, 'DONE'); assert.equal(revalidated.state.membershipCoverageStatus, 'COMPLETE');
      assert.equal(revalidated.state.campaignDirectorySourceValidationVersion, 1);
      assert.equal(revalidated.state.membershipBaselineSourceValidationVersion, 1);
      assert.equal(revalidated.state.membershipCatchupSourceValidationVersion, 0);
      assert.equal(revalidated.state.membershipBaselineGeneration, currentRun.job.params.collectionGeneration);
      assert.equal(currentRun.checkpoint.result.sourceValidationVersion, 1);
      assert.equal(currentRun.calls.filter(call => call.source.endsWith('.list')).length, 1, 'The old directory must actually be reread');
      assert.deepEqual(await identities(currentDb, scope), beforeIds);
      const oldPublication = await currentDb.analyticsPublication.findUnique({ where: { id: legacyCompleted.publication.id } });
      assert.equal(oldPublication.payload.sourceValidationVersion, undefined, 'Historical evidence must not be relabelled');
      const currentPublication = await currentDb.analyticsPublication.findUnique({ where: { id: revalidated.publication.id } });
      assert.equal(currentPublication.payload.sourceValidationVersion, 1);
      return { previousGeneration: legacyRun.job.params.collectionGeneration, currentGeneration: currentRun.job.params.collectionGeneration,
        sourceRequests: currentRun.calls.length, preservedCanonicalIds: beforeIds, currentMarker: 1, historicalMarker: null };
    });
    await check('The old manual cost command replays after upgrade without another charge or revision', async () => {
      const replayed = await currentHarness.load('./src/services/management-command-service').executeManagementCommand({ db: currentDb,
        agencyId: scope.agencyId, userId: scope.userId, actorMember: scope.member, deviceId: scope.deviceId, input: command });
      assert.equal(replayed.ok, true);
      assert.equal(replayed.replayed, true);
      // The whole Traffic source digest changes after new projection facts.
      // Its old command receipt still commits once; current state is read
      // independently when that historical response is no longer available.
      if (replayed.resultUnavailable) assert.equal(replayed.result, null);
      const source = await currentDb.trafficSource.findUnique({ where: { id: command.payload.sourceId } });
      assert.equal(source.costCents, 2675); assert.equal(source.currency, 'EUR');
      assert.equal(source.costRevision, 1);
      const table = await snapshot(currentDb, scope);
      assert.deepEqual(table.ManagementCommandReceipt, before.ManagementCommandReceipt);
      assert.deepEqual(table.CreatorSubscriptionLedger, before.CreatorSubscriptionLedger);
      assert.deepEqual(await migrationSnapshot(currentDb), migrationsAfter);
      return { replayed: true, historicalResponseUnavailable: replayed.resultUnavailable, costRevision: 1, paidReceiptUnchanged: true };
    });
    await check('An existing wrong currency index is rejected by both runtime verification and installer without rewriting user rows', async () => {
      const beforeInvalid = await snapshot(currentDb, scope);
      const name = 'TrafficSource_cost_currency_v213';
      await currentDb.$executeRawUnsafe(`DROP INDEX ${quote(name)}`);
      await currentDb.$executeRawUnsafe(`CREATE INDEX ${quote(name)} ON "TrafficSource" ("creatorId")`);
      try {
        await assert.rejects(indexes.ensureIndexes(currentDb), { code: 'ANALYTICS_TRAFFIC_INDEX_INVALID', index: name });
        const failed = await install('invalid-index-fails-closed', 1);
        assert.match(fs.readFileSync(failed.log, 'utf8'), /ANALYTICS_TRAFFIC_INDEX_INVALID/);
        assert.deepEqual(await snapshot(currentDb, scope), beforeInvalid);
        assert.deepEqual(await migrationSnapshot(currentDb), migrationsAfter);
      } finally {
        await currentDb.$executeRawUnsafe(`DROP INDEX ${quote(name)}`);
      }
      await install('restore-missing-index');
      assert.deepEqual(await indexes.ensureIndexes(currentDb), { ready: true, contracts: 53 });
      assert.equal((await currentLoad('./src/services/database-contract-service').readDatabaseContract(currentDb)).ready, true);
      assert.deepEqual(await snapshot(currentDb, scope), beforeInvalid);
      return { rejectedIndex: name, repairedOnlyAfterExplicitFixtureDrop: true, finalContracts: 53 };
    });
    evidence.ok = evidence.checks.every(item => item.ok); save();
    return evidence;
  } catch (error) {
    evidence.error = String(error.stack || error); save(); throw error;
  } finally {
    if (currentHarness) await currentHarness.close();
    if (oldHarness) await oldHarness.close();
    if (currentDb) await currentDb.$disconnect();
    if (oldDb) await oldDb.$disconnect();
  }
}

if (require.main === module) {
  (async () => {
    const file = process.env.NOD_CAMPAIGN_UPGRADE_DATABASE_FILE;
    if (!file) throw Error('NOD_CAMPAIGN_UPGRADE_DATABASE_FILE_REQUIRED');
    const connection = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = await runCampaignUpgradeProof({ ...connection,
      baselineBackendRoot: process.env.NOD_CAMPAIGN_V39_BACKEND_ROOT,
      baselineDesktopRoot: process.env.NOD_CAMPAIGN_V39_DESKTOP_ROOT,
      desktopRoot: process.env.ONLINOD_DESKTOP_ROOT,
      output: process.env.NOD_CAMPAIGN_UPGRADE_OUTPUT,
    });
    console.log(json({ ok: result.ok, checks: result.checks.length, from: result.from, to: result.to }));
  })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

module.exports = { runCampaignUpgradeProof };
