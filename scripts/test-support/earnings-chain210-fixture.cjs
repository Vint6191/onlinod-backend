'use strict';

// Synthetic provider boundary; every receipt, lease, publication, and read is
// executed by the selected repository's production implementation on real SQL.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

async function createEarningsHarness({ db, backendRoot = path.resolve(__dirname, '../..'), desktopRoot }) {
  if (!db || typeof db.$transaction !== 'function') throw new Error('EXPLICIT_POSTGRES_FIXTURE_REQUIRED');
  if (!desktopRoot) throw new Error('ONLINOD_DESKTOP_ROOT_REQUIRED');
  const load = createRequire(path.resolve(backendRoot, 'package.json'));
  const singletonId = load.resolve('./src/prisma');
  const priorSingleton = require.cache[singletonId];
  require.cache[singletonId] = { id: singletonId, filename: singletonId, loaded: true, exports: db };
  const { runRootCommit } = load('./src/services/db-commit-kernel');
  const control = load('./src/services/analytics-collector-control-service');
  const manual = load('./src/services/financial-transaction-scan-control-service');
  const receipts = load('./src/services/financial-receipt-authority');
  const lease = load('./src/services/job-lease-service');
  const publication = load('./src/services/analytics-publication-service');
  const gen = load('./src/services/earnings-generation-service');
  const desktop = await load('./scripts/test-support/desktop-financial-handler.cjs').loadDesktopFinancialHandler(desktopRoot);
  const capabilities = { creatorEventDrivenSyncV2: true, financialWindowReceiptsV1: true,
    financialMoneyResolutionV1: true, financialTraversalV2: true, billingFinancialRecoveryV1: true };
  const calls = [];
  const write = work => runRootCommit(db, ({ tx }) => work(tx));
  async function scope(name) {
    const prefix = 'earn210_' + name.replace(/[^a-z0-9]/ig, '_') + '_' + crypto.randomBytes(5).toString('hex');
    return write(async tx => {
      const writes = load('./src/services/database-write-contract-service');
      await writes.assertTeamControlPlaneWriteAdmission(tx);
      await writes.authorizeCreatorAccountWrite(tx);
      const user = await tx.user.create({ data: { email: prefix + '@example.test', passwordHash: 'synthetic' } });
      const agency = await tx.agency.create({ data: { id: prefix + '_agency', name: 'Synthetic earnings chain', trialEndsAt: new Date(Date.now() + 86400000) } });
      const member = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: 'OWNER', roleKey: 'owner' } });
      const creator = await tx.creatorAccount.create({ data: { id: prefix + '_creator', agencyId: agency.id, displayName: name, remoteId: prefix, status: 'READY' } });
      const device = await tx.workerDevice.create({ data: { agencyId: agency.id, userId: user.id, lastSeenAt: new Date() } });
      await tx.deviceCreatorBinding.create({ data: { deviceId: device.id, creatorId: creator.id, agencyId: agency.id,
        status: 'ACTIVE', sessionReadReady: true, accessEpoch: member.accessEpoch, lastSeenAt: new Date() } });
      return { agency, user, member, creator, device, agencyId: agency.id, creatorId: creator.id, userId: user.id, deviceId: device.id };
    });
  }
  async function refreshDevice(s) {
    const at = new Date();
    await db.workerDevice.update({ where: { id: s.deviceId }, data: { lastSeenAt: at } });
    await db.deviceCreatorBinding.update({ where: { deviceId_creatorId: { deviceId: s.deviceId, creatorId: s.creatorId } }, data: { lastSeenAt: at } });
  }
  async function claim(s, expectedId = null) {
    if (expectedId) {
      const planned = await db.jobInstance.findUnique({ where: { id: expectedId }, select: { nextRunAt: true, status: true } });
      const remaining = +planned?.nextRunAt - Date.now();
      // Bootstrap freezes its provider end at the next whole second. Respect
      // that admission time instead of mutating production scheduling authority.
      if (planned?.status === 'SCHEDULED' && remaining > 0) {
        assert.ok(remaining <= 2000, 'Fixture unexpectedly scheduled beyond its source-boundary wait');
        await new Promise(resolve => setTimeout(resolve, remaining + 10));
      }
    }
    await refreshDevice(s);
    const response = await lease.claimJob({ userId: s.userId, deviceId: s.deviceId, jobKeys: ['financial_transactions_scan'], capabilities });
    assert.ok(response.job, JSON.stringify(response));
    if (expectedId) assert.equal(response.job.id, expectedId);
    const job = response.job;
    assert.equal(job.params.financialTraversalVersion, 2);
    return { scope: s, job, checkpoint: job.continuation ?? null, calls: [], credentials: {
      jobId: job.id, userId: s.userId, deviceId: s.deviceId, leaseToken: job.leaseToken, leaseRevision: job.leaseRevision } };
  }
  async function start(s, { mode = 'full', endAt = null, gapFrom = null } = {}) {
    let job;
    if (mode === 'full' && !endAt) {
      job = (await manual.startManualFinancialTransactionScan({ db, creator: s.creator, requestedByUserId: s.userId })).job;
    } else {
      const end = endAt || new Date(Math.floor(Date.now() / 1000) * 1000);
      const state = await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: s.creatorId } });
      const command = control.buildCollectionCommand({ collectorType: 'FINANCIAL', collectionMode: mode, reason: 'MANUAL_CHAIN_PROOF', now: new Date() });
      job = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, scope: 'creator',
        jobKey: 'financial_transactions_scan', status: 'SCHEDULED', params: { ...command, endDate: end.toISOString(), earningsLedgerVersion: 1,
          ...(mode === 'catchup' ? { financialMode: mode, financialFrontierVersion: 2,
            recoveryGapFrom: (gapFrom || state.coverageThrough).toISOString() } : {}) } } });
    }
    return claim(s, job.id);
  }
  async function produce(run, body, expected = run.checkpoint) {
    assert.equal(expected.driverPhase, 'execute');
    return desktop.handler.runChunk({ job: run.job, creatorId: run.scope.creatorId,
      continuation: structuredClone(expected.jobContinuation), signal: new AbortController().signal,
      ofApi: { request: async request => {
        assert.equal(request.endpoint.method, 'GET');
        const call = { creatorId: request.creatorId, jobId: run.job.id, source: request.source, path: request.endpoint.path };
        run.calls.push(call); calls.push(call);
        return { ok: true, status: 200, data: typeof body === 'function' ? await body(request) : body };
      } } });
  }
  async function progress(run, step, expected = run.checkpoint) {
    const next = step.outcome === 'done' ? { driverPhase: 'complete', result: step.result, progress: step.progress }
      : { driverPhase: 'execute', jobContinuation: step.continuation };
    const result = await lease.progressJob({ ...run.credentials, expectedContinuation: expected,
      progress: step.progress, continuation: next, chunkResult: step.chunkResult });
    run.checkpoint = result.continuation;
    return result;
  }
  async function page(run, rows, { hasMore = false, nextMarker = null } = {}) {
    const expected = structuredClone(run.checkpoint);
    const step = await produce(run, { list: rows, hasMore, ...(nextMarker ? { nextMarker } : {}) }, expected);
    const result = await progress(run, step, expected);
    return { step, result, expected };
  }
  async function charts(run, rows, { override = null } = {}) {
    const keys = run.job.params.collectionMode === 'full' ? ['total', 'subscribes', 'tips', 'messages', 'post', 'stream'] : ['total'];
    for (const category of keys) {
      const from = Date.parse(run.checkpoint.jobContinuation.comparisonFrom);
      const through = Date.parse(run.job.params.financialWindows[0].to);
      const types = { subscribes: ['subscribes', 'subscribe', 'subscription'], tips: ['tip'], messages: ['message'], post: ['post'], stream: ['stream'] };
      const selected = rows.filter(row => row.status !== 'undo' && Date.parse(row.createdAt) >= from && Date.parse(row.createdAt) <= through
        && (category === 'total' || types[category].includes(row.descriptionDetails?.type || row.type)));
      const count = selected.length, grossKnown = selected.every(row => typeof row.amount === 'number');
      const value = { total: selected.reduce((n, row) => n + row.net, 0), count,
        ...(grossKnown ? { gross: selected.reduce((n, row) => n + row.amount, 0) } : {}) };
      const key = category === 'messages' ? 'chat_messages' : category;
      const step = await produce(run, { [key]: override ? override(category, value) : value });
      await progress(run, step);
    }
    assert.equal(run.checkpoint.driverPhase, 'complete');
  }
  async function finish(run, expectedStatus = 'DONE') {
    assert.equal(run.checkpoint.driverPhase, 'complete');
    const accepted = await lease.completeJob({ ...run.credentials, result: run.checkpoint.result, progress: run.checkpoint.progress });
    assert.ok(accepted.publicationId, JSON.stringify(accepted));
    let result;
    for (let turn = 0; turn < 100; turn++) {
      await db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { availableAt: new Date(0) } });
      result = await publication.runAnalyticsPublicationUnit({ db, publicationId: accepted.publicationId });
      if (!result.publicationPending) break;
    }
    assert.equal(result.job?.status, expectedStatus, JSON.stringify(result));
    return { accepted, result, job: await db.jobInstance.findUnique({ where: { id: run.job.id } }),
      proof: await db.creatorEarningsLedgerProof.findUnique({ where: { creatorId: run.scope.creatorId } }),
      state: await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: run.scope.creatorId } }),
      run: await db.financialReceiptRun.findUnique({ where: { id: receipts.runId(run.job) } }) };
  }
  const summary = (s, from, to) => load('./src/services/published-financial-read-repository').readPublishedFinancialSummary({ db, creatorId: s.creatorId, from, to });
  return { db, load, scope, start, claim, produce, page, charts, progress, finish, summary, lease, receipts, gen, manual, write,
    calls, close: async () => {
      desktop.close();
      if (priorSingleton) require.cache[singletonId] = priorSingleton;
      else delete require.cache[singletonId];
    } };
}

// The standalone gate never discovers an application DATABASE_URL. Its caller
// supplies an already migrated, disposable local PostgreSQL test database.
async function openEarningsChainFixture() {
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
  const backendRoot = path.resolve(__dirname, '../..');
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: explicit } } });
  try {
    const [database] = await db.$queryRawUnsafe(`SELECT current_database() AS name, version() AS version,
      to_regclass('public."FinancialReceiptRun"')::text AS receipt_schema`);
    if (database.name !== name || !database.version.startsWith('PostgreSQL ') || !database.receipt_schema) {
      throw new Error('MIGRATED_NATIVE_POSTGRES_FIXTURE_REQUIRED');
    }
    const harness = await createEarningsHarness({ db, backendRoot, desktopRoot });
    return { ...harness, backendRoot, desktopRoot, close: async () => {
      await harness.close(); await db.$disconnect();
    } };
  } catch (error) { await db.$disconnect(); throw error; }
}

async function loadDesktopReadonlyWorker(desktopRoot) {
  const desktopLoad = createRequire(path.join(desktopRoot, 'package.json'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'earnings-chain210-worker-'));
  const electron = path.join(temporary, 'electron.cjs'), bundle = path.join(temporary, 'worker.cjs');
  fs.writeFileSync(electron, 'exports.app={getVersion:()=>"fixture",getPath:()=>'+JSON.stringify(temporary)+'};');
  try {
    await desktopLoad('esbuild').build({
      entryPoints: [path.join(desktopRoot, 'apps/desktop/electron/main/services/backend-jobs/backend-readonly-job-worker.ts')],
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      alias: { electron, '@nod/shared': path.join(desktopRoot, 'packages/shared/src/index.ts') },
      external: ['better-sqlite3'],
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(desktopRoot, 'package.json')).href) },
    });
    return { Worker: require(bundle).BackendReadonlyJobWorker,
      close: () => fs.rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
}

module.exports = { createEarningsHarness, openEarningsChainFixture, loadDesktopReadonlyWorker };
