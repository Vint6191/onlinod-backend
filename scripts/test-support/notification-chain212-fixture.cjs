'use strict';

// Synthetic provider responses; real Desktop producers, server admission,
// leases, source receipts, canonical facts and PostgreSQL commit boundaries.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function loadNotificationProducer(desktopRoot) {
  const load = createRequire(path.join(desktopRoot, 'package.json'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-chain212-'));
  const bundle = path.join(directory, 'producer.cjs'), electron = path.join(directory, 'electron.cjs');
  const services = path.join(desktopRoot, 'apps/desktop/electron/main/services');
  fs.writeFileSync(electron, 'exports.app={getVersion:()=>"fixture",getPath:()=>'+JSON.stringify(directory)+'};');
  try {
    const modules = ['notifications/notification-source-normalizer.ts',
      'creator-runtime/creator-runtime-normalizer.ts', 'creator-analytics/creator-analytics-live-service.ts',
      'creator-analytics/creator-analytics-live-outbox.ts', '../infrastructure/storage/sqlite-connection-factory.ts',
      'backend-jobs/handlers/notifications-catchup-handler.ts'];
    await load('esbuild').build({
      stdin: { contents: modules.map(name => 'export * from '+JSON.stringify(path.join(services, name))+';').join('\n'),
        resolveDir: desktopRoot, sourcefile: 'notification-fixture.ts', loader: 'ts' },
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      alias: { electron, '@nod/shared': path.join(desktopRoot, 'packages/shared/src/index.ts') }, external: ['better-sqlite3'],
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(desktopRoot, 'package.json')).href) },
    });
    return { ...require(bundle), close: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

// The generic worker and BackendJobClient are the same production classes for
// every collector. Reuse their source bundler; no subscriber test logic runs.
const { loadSubscriberWorker: loadNotificationWorker } = require('./subscriber-chain211-fixture.cjs');

async function createNotificationHarness({ db, backendRoot = path.resolve(__dirname, '../..'), desktopRoot = null }) {
  if (!db || typeof db.$transaction !== 'function') throw new Error('EXPLICIT_POSTGRES_FIXTURE_REQUIRED');
  const load = createRequire(path.join(backendRoot, 'package.json'));
  const singleton = load.resolve('./src/prisma'), priorSingleton = require.cache[singleton];
  require.cache[singleton] = { id: singleton, filename: singleton, loaded: true, exports: db };
  const { runRootCommit } = load('./src/services/db-commit-kernel');
  const write = cb => runRootCommit(db, ({ tx }) => cb(tx));
  const lease = load('./src/services/job-lease-service');
  const control = load('./src/services/notification-scan-control-service');
  const facts = load('./src/services/notification-facts-service');
  const sourceLedger = load('./src/services/notification-source-ledger-service');
  const desktop = desktopRoot ? await loadNotificationProducer(desktopRoot) : null;
  const calls = [];

  async function scope(name, { releasePredecessors = true } = {}) {
    const prefix = 'notif212_' + name.replace(/[^a-z0-9]/ig, '_') + '_' + crypto.randomBytes(5).toString('hex');
    return write(async tx => {
      const authority = load('./src/services/database-write-contract-service');
      await authority.assertTeamControlPlaneWriteAdmission(tx);
      await authority.authorizeCreatorAccountWrite(tx);
      const user = await tx.user.create({ data: { email: prefix + '@example.test', passwordHash: 'synthetic' } });
      const agency = await tx.agency.create({ data: { id: prefix + '_agency', name: 'Synthetic notification chain', trialEndsAt: new Date(Date.now() + 86400000) } });
      const member = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: 'OWNER', roleKey: 'owner' } });
      const creator = await tx.creatorAccount.create({ data: { id: prefix + '_creator', agencyId: agency.id, displayName: name, remoteId: prefix, status: 'READY' } });
      const device = await tx.workerDevice.create({ data: { agencyId: agency.id, userId: user.id, lastSeenAt: new Date() } });
      await tx.deviceCreatorBinding.create({ data: { agencyId: agency.id, creatorId: creator.id, deviceId: device.id,
        status: 'ACTIVE', sessionReadReady: true, accessEpoch: member.accessEpoch, lastSeenAt: new Date() } });
      if (releasePredecessors) {
        // Explicit stopped independent predecessors release notification admission.
        // This does not create successful financial/campaign coverage or facts.
        await tx.creatorFinancialCollectionState.create({ data: { agencyId: agency.id, creatorId: creator.id,
          status: 'FAILED', lastErrorCode: 'FIXTURE_INDEPENDENT_PREDECESSOR_STOPPED' } });
        await tx.creatorCampaignCollectionState.create({ data: { agencyId: agency.id, creatorId: creator.id,
          status: 'FAILED', lastErrorCode: 'FIXTURE_INDEPENDENT_PREDECESSOR_STOPPED' } });
      }
      return { agencyId: agency.id, creatorId: creator.id, userId: user.id, deviceId: device.id, agency, creator, member, user, device };
    });
  }
  async function claim(s, expectedId = null) {
    const at = new Date();
    await db.workerDevice.update({ where: { id: s.deviceId }, data: { lastSeenAt: at } });
    await db.deviceCreatorBinding.update({ where: { deviceId_creatorId: { deviceId: s.deviceId, creatorId: s.creatorId } }, data: { lastSeenAt: at } });
    const response = await lease.claimJob({ userId: s.userId, deviceId: s.deviceId,
      jobKeys: ['catchup_notifications_scan'], capabilities: { creatorEventDrivenSyncV2: true } });
    assert.ok(response.job, JSON.stringify(response));
    if (expectedId) assert.equal(response.job.id, expectedId);
    const job = response.job;
    return { scope: s, job, checkpoint: job.continuation ?? null, calls: [], credentials: {
      jobId: job.id, userId: s.userId, deviceId: s.deviceId, leaseToken: job.leaseToken, leaseRevision: job.leaseRevision } };
  }
  const schedule = (s, options = {}) => control.startManualNotificationScan({ db, creator: s.creator,
    requestedByUserId: s.userId, ...options });
  async function start(s, options = {}) {
    const scheduled = await schedule(s, options);
    return { ...await claim(s, scheduled.job.id), scheduled };
  }
  const stop = s => control.stopManualNotificationScan({ db, creatorId: s.creatorId });
  const resume = (s, options = {}) => start(s, options);
  async function produce(run, body, expected = run.checkpoint, options = {}) {
    if (!desktop) throw new Error('ONLINOD_DESKTOP_ROOT_REQUIRED');
    return desktop.notificationsCatchupHandler.runChunk({ job: run.job, creatorId: run.scope.creatorId,
      continuation: structuredClone(expected?.jobContinuation ?? null), signal: options.signal || new AbortController().signal,
      ofApi: { request: async request => {
        assert.equal(request.endpoint.method, 'GET');
        const call = { creatorId: request.creatorId, jobId: run.job.id, source: request.source, path: request.endpoint.path };
        run.calls.push(call); calls.push(call);
        const data = typeof body === 'function' ? await body(request) : body;
        return options.response === true ? data : { ok: true, status: 200, data };
      } },
    });
  }
  async function progress(run, step, expected = run.checkpoint) {
    const continuation = step.outcome === 'done'
      ? { driverPhase: 'complete', result: step.result, progress: step.progress }
      : { driverPhase: 'execute', jobContinuation: step.continuation };
    const result = await lease.progressJob({ ...run.credentials, expectedContinuation: expected,
      continuation, progress: step.progress, chunkResult: step.chunkResult });
    run.checkpoint = result.continuation;
    return result;
  }
  async function page(run, rows, { hasMore = false, body = null } = {}) {
    const expected = structuredClone(run.checkpoint);
    const step = await produce(run, body ?? { list: rows, hasMore }, expected);
    const result = await progress(run, step, expected);
    return { step, result, expected, chunk: step.chunkResult };
  }
  const complete = (run, result = run.checkpoint?.result) => lease.completeJob({ ...run.credentials,
    result, progress: run.checkpoint?.progress });
  const fail = (run, error = 'SYNTHETIC_PROVIDER_FAILURE') => lease.failJob({ ...run.credentials,
    expectedContinuation: run.checkpoint, retryable: false, error });
  const jobRow = run => db.jobInstance.findUnique({ where: { id: run.job.id } });
  const scopeState = async s => ({
    state: await db.creatorNotificationSyncState.findUnique({ where: { creatorId: s.creatorId } }),
    events: await db.creatorNotificationEvent.findMany({ where: { creatorId: s.creatorId }, orderBy: { identityKey: 'asc' } }),
    audits: await db.creatorNotificationScanItem.findMany({ where: { creatorId: s.creatorId }, orderBy: [{ page: 'asc' }, { ordinal: 'asc' }] }),
    frontiers: await db.creatorNotificationFrontierPage.findMany({ where: { creatorId: s.creatorId }, orderBy: { page: 'asc' } }),
  });
  async function finish(run) {
    assert.equal(run.checkpoint?.driverPhase, 'complete');
    const accepted = await complete(run);
    return { accepted, job: await jobRow(run), ...await scopeState(run.scope) };
  }
  async function full(s, rowsByType = {}) {
    const run = await start(s, { forceFull: true });
    for (const type of ['subscriptions', 'purchases', 'tips', 'comments', 'likes', 'all_reconciliation']) {
      await page(run, rowsByType[type] || []);
    }
    if (run.checkpoint?.driverPhase !== 'complete') {
      const terminal = await produce(run, () => { throw new Error('EXHAUSTED_NOTIFICATION_SOURCE_WAS_READ_AGAIN'); });
      assert.equal(terminal.outcome, 'done'); assert.equal(terminal.chunkResult, undefined);
      // Match the actual Desktop no-source completion protocol. Page-bearing
      // catch-up completion uses progress; exhausted FULL finishes through renew.
      const accepted = await lease.renewLease({ ...run.credentials, progress: terminal.progress,
        continuation: { driverPhase: 'complete', result: terminal.result, progress: terminal.progress } });
      run.checkpoint = accepted.continuation;
    }
    return { run, ...await finish(run) };
  }
  function live(s, source) {
    if (!desktop) throw new Error('ONLINOD_DESKTOP_ROOT_REQUIRED');
    const runtime = desktop.normalizeRuntimeWsFrame({ direction: 'in', data: JSON.stringify({ new_message: source }) }, { accountId: s.creatorId })[0];
    return { runtime, canonical: desktop.canonicalRuntimeEvent({ creatorId: s.creatorId, event: runtime }) };
  }
  return { db, load, write, lease, control, facts, sourceLedger, desktop, scope, claim, schedule, start, stop, resume,
    produce, progress, page, complete, fail, finish, full, jobRow, scopeState, live, calls, desktopRoot,
    close: async () => { desktop?.close(); if (priorSingleton) require.cache[singleton] = priorSingleton; else delete require.cache[singleton]; } };
}

async function openNotificationChainFixture() {
  if (process.env.ONLINOD_POSTGRES_INTEGRATION !== '1') throw new Error('ONLINOD_POSTGRES_INTEGRATION_1_REQUIRED');
  const explicit = process.env.ONLINOD_NATIVE_TEST_DATABASE_URL;
  if (!explicit) throw new Error('ONLINOD_NATIVE_TEST_DATABASE_URL_REQUIRED');
  const url = new URL(explicit), name = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^(?:onlinod_test_|onlinod_fixture_|audit[0-9]+_)[a-z0-9_]+$/.test(name)) {
    throw new Error('ISOLATED_LOCAL_POSTGRES_TEST_DATABASE_REQUIRED');
  }
  if (!process.env.ONLINOD_DESKTOP_ROOT) throw new Error('ONLINOD_DESKTOP_ROOT_REQUIRED');
  const desktopRoot = path.resolve(process.env.ONLINOD_DESKTOP_ROOT);
  if (!fs.existsSync(path.join(desktopRoot, 'apps/desktop/package.json'))) throw new Error('DESKTOP_SOURCE_ROOT_REQUIRED');
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: explicit } } });
  try {
    const [database] = await db.$queryRawUnsafe(`SELECT current_database() AS name, version() AS version,
      to_regclass('public."CreatorNotificationEvent"')::text AS notification_schema`);
    if (database.name !== name || !database.version.startsWith('PostgreSQL ') || !database.notification_schema) {
      throw new Error('MIGRATED_NATIVE_POSTGRES_FIXTURE_REQUIRED');
    }
    const harness = await createNotificationHarness({ db, desktopRoot });
    return { ...harness, desktopRoot, close: async () => { await harness.close(); await db.$disconnect(); } };
  } catch (error) { await db.$disconnect(); throw error; }
}
module.exports = { createNotificationHarness, openNotificationChainFixture, loadNotificationProducer, loadNotificationWorker };
