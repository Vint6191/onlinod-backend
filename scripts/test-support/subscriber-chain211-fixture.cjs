'use strict';

// Only the provider boundary is synthetic. Admission, observation ownership,
// leases, receipts, canonical facts, publication, and reads use production SQL.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function loadSubscriberHandler(desktopRoot) {
  const load = createRequire(path.join(desktopRoot, 'package.json'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'subscriber-chain211-'));
  const bundle = path.join(temporary, 'handler.cjs');
  try {
    await load('esbuild').build({
      entryPoints: [path.join(desktopRoot, 'apps/desktop/electron/main/services/backend-jobs/handlers/subscriber-directory-handler.ts')],
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    });
    return { handler: require(bundle).subscriberDirectoryHandler,
      close: () => fs.rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
}

async function loadSubscriberWorker(desktopRoot) {
  const load = createRequire(path.join(desktopRoot, 'package.json'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'subscriber-chain211-worker-'));
  const electron = path.join(temporary, 'electron.cjs'), bundle = path.join(temporary, 'worker.cjs');
  fs.writeFileSync(electron, 'exports.app={getVersion:()=>"fixture",getPath:()=>'+JSON.stringify(temporary)+'};');
  const services = path.join(desktopRoot, 'apps/desktop/electron/main/services');
  try {
    await load('esbuild').build({
      stdin: { contents: 'export { BackendReadonlyJobWorker } from ' + JSON.stringify(path.join(services, 'backend-jobs/backend-readonly-job-worker.ts'))
        + '; export { BackendRequestError } from ' + JSON.stringify(path.join(services, 'backend/backend-http-client.ts')) + ';',
        resolveDir: desktopRoot, sourcefile: 'subscriber-fixture.ts', loader: 'ts' },
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      alias: { electron, '@nod/shared': path.join(desktopRoot, 'packages/shared/src/index.ts') },
      external: ['better-sqlite3'],
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(desktopRoot, 'package.json')).href) },
    });
    const loaded = require(bundle);
    return { Worker: loaded.BackendReadonlyJobWorker, BackendRequestError: loaded.BackendRequestError,
      close: () => fs.rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
}

async function createSubscriberHarness({ db, backendRoot = path.resolve(__dirname, '../..'), desktopRoot = null }) {
  if (!db || typeof db.$transaction !== 'function') throw new Error('EXPLICIT_POSTGRES_FIXTURE_REQUIRED');
  const load = createRequire(path.join(backendRoot, 'package.json'));
  const singleton = load.resolve('./src/prisma'), priorSingleton = require.cache[singleton];
  require.cache[singleton] = { id: singleton, filename: singleton, loaded: true, exports: db };
  const { runRootCommit } = load('./src/services/db-commit-kernel');
  const write = cb => runRootCommit(db, ({ tx }) => cb(tx));
  const subs = load('./src/services/subscriber-directory-service');
  const lease = load('./src/services/job-lease-service');
  const signals = load('./src/services/subscriber-directory-maintenance-signal-service');
  const desktop = desktopRoot ? await loadSubscriberHandler(desktopRoot) : null;
  const calls = [];

  async function scope(name, { releasePredecessors = true } = {}) {
    const prefix = 'aud211_' + name.replace(/[^a-z0-9]/ig, '_') + '_' + crypto.randomBytes(5).toString('hex');
    return write(async tx => {
      const authority = load('./src/services/database-write-contract-service');
      await authority.assertTeamControlPlaneWriteAdmission(tx);
      await authority.authorizeCreatorAccountWrite(tx);
      const user = await tx.user.create({ data: { email: prefix + '@example.test', passwordHash: 'synthetic' } });
      const agency = await tx.agency.create({ data: { id: prefix + '_agency', name: 'Synthetic subscriber chain', trialEndsAt: new Date(Date.now() + 86400000) } });
      const member = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: 'OWNER', roleKey: 'owner' } });
      const creator = await tx.creatorAccount.create({ data: { id: prefix + '_creator', agencyId: agency.id, displayName: name, remoteId: prefix, status: 'READY' } });
      const device = await tx.workerDevice.create({ data: { agencyId: agency.id, userId: user.id, lastSeenAt: new Date() } });
      await tx.deviceCreatorBinding.create({ data: { agencyId: agency.id, creatorId: creator.id, deviceId: device.id,
        status: 'ACTIVE', sessionReadReady: true, accessEpoch: member.accessEpoch, lastSeenAt: new Date() } });
      if (releasePredecessors) {
        // Explicit test precondition: preceding independent collectors have
        // stopped, which releases subscriber admission. This is not a fabricated
        // financial/campaign baseline and contributes no subscriber/FanData rows.
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
      jobKeys: ['subscriber_directory_scan'], capabilities: { creatorEventDrivenSyncV2: true } });
    assert.ok(response.job, JSON.stringify(response));
    if (expectedId) assert.equal(response.job.id, expectedId);
    const job = response.job;
    return { scope: s, job, checkpoint: job.continuation ?? null, calls: [], credentials: {
      jobId: job.id, userId: s.userId, deviceId: s.deviceId, leaseToken: job.leaseToken, leaseRevision: job.leaseRevision } };
  }
  async function start(s, options = {}) {
    const scheduled = await subs.scheduleSubscriberScan({ db, agencyId: s.agencyId, creatorId: s.creatorId,
      userId: s.userId, manual: true, force: true, ...options });
    assert.equal(scheduled.created, true, JSON.stringify(scheduled));
    return { ...await claim(s, scheduled.job.id), run: scheduled.run };
  }
  async function produce(run, body, expected = run.checkpoint) {
    if (!desktop) throw new Error('ONLINOD_DESKTOP_ROOT_REQUIRED');
    return desktop.handler.runChunk({ job: run.job, creatorId: run.scope.creatorId,
      continuation: structuredClone(expected?.jobContinuation ?? null), signal: new AbortController().signal,
      ofApi: { request: async request => {
        assert.equal(request.endpoint.method, 'GET');
        const call = { creatorId: request.creatorId, jobId: run.job.id, source: request.source, path: request.endpoint.path };
        run.calls.push(call); calls.push(call);
        return { ok: true, status: 200, data: typeof body === 'function' ? await body(request) : body };
      } },
      acquireObservationReadLease: input => lease.acquireJobFanObservationReadLease({ ...run.credentials, ...input, requestId: crypto.randomUUID() }),
      releaseObservationReadLease: readLeaseToken => lease.releaseJobObservationReadLease({ ...run.credentials, readLeaseToken }),
      acquireObservationToken: input => lease.issueFanObservationToken({ ...run.credentials, ...input }),
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
    const step = await produce(run, body || { list: rows, hasMore }, expected);
    const result = await progress(run, step, expected);
    return { step, result, expected, chunk: step.chunkResult };
  }
  // Server-boundary tests can supply intentionally malformed compact messages.
  // Provider/worker proofs use page()/produce(), never this compact test helper.
  async function acceptPage(run, items, hasMore = false) {
    const expected = structuredClone(run.checkpoint);
    const state = expected?.jobContinuation || {}, offset = state.offset || 0;
    const nextOffset = offset + (hasMore ? 20 : items.length);
    let token;
    if (items.length) {
      const read = await lease.acquireJobFanObservationReadLease({ ...run.credentials,
        purpose: 'subscriber_directory_page', requestId: crypto.randomUUID() });
      assert.equal(read.acquired, true, JSON.stringify(read));
      token = await lease.issueFanObservationToken({ ...run.credentials, readLeaseToken: read.token,
        purpose: 'subscriber_directory_page', subjects: [...new Set(items.map(i => String(i.fanId)))] });
    }
    const chunk = { kind: 'subscriber_directory_page', scanRunId: run.job.params.scanRunId, offset, nextOffset,
      hasMore, items, pagination: { contract: 'of_subscribers_offset_v2', limit: 20 }, ...(token ? { observationToken: token.token } : {}) };
    const workProgress = { current: (state.scanned || 0) + items.length, percent: hasMore ? 0 : 99 };
    const step = hasMore ? { outcome: 'continue', continuation: { offset: nextOffset, pages: (state.pages || 0) + 1,
      scanned: workProgress.current }, progress: workProgress, chunkResult: chunk }
      : { outcome: 'done', result: { scanRunId: run.job.params.scanRunId }, progress: workProgress, chunkResult: chunk };
    return { result: await progress(run, step, expected), chunk, expected, step };
  }
  const complete = run => lease.completeJob({ ...run.credentials, result: run.checkpoint.result, progress: run.checkpoint.progress });
  const fail = (run, error = 'SYNTHETIC_PROVIDER_FAILURE') => lease.failJob({ ...run.credentials,
    expectedContinuation: run.checkpoint, retryable: false, error });
  const scopeState = async s => ({
    state: await db.subscriberDirectoryState.findUnique({ where: { creatorId: s.creatorId } }),
    runs: await db.subscriberScanRun.findMany({ where: { creatorId: s.creatorId }, orderBy: { publicationGeneration: 'asc' } }),
    pages: await db.subscriberScanPage.count({ where: { run: { creatorId: s.creatorId } } }),
    items: await db.subscriberScanItem.count({ where: { creatorId: s.creatorId } }),
    signals: await db.subscriberDirectoryMaintenanceSignal.findMany({ where: { creatorId: s.creatorId } }),
  });
  async function finish(run) {
    assert.equal(run.checkpoint?.driverPhase, 'complete');
    const accepted = await complete(run);
    for (let turn = 0; turn < 50; turn++) {
      const job = await db.jobInstance.findUnique({ where: { id: run.job.id } });
      if (job.status === 'DONE') return { accepted, job, ...await scopeState(run.scope) };
      assert.equal(job.status, 'PUBLISHING');
      await subs.recoverSubscriberPublicationDebt({ db, agencyId: run.scope.agencyId, creatorId: run.scope.creatorId,
        maxRuns: 4, maxStepsPerRun: 20, maxRuntimeMs: 30000 });
    }
    throw new Error('SUBSCRIBER_FIXTURE_PUBLICATION_DID_NOT_SETTLE');
  }
  return { db, load, write, subs, lease, signals, scope, claim, start, produce, progress, page, acceptPage, desktopRoot,
    complete, fail, finish, scopeState, calls,
    close: async () => { desktop?.close(); if (priorSingleton) require.cache[singleton] = priorSingleton; else delete require.cache[singleton]; } };
}

async function openSubscriberChainFixture() {
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
      to_regclass('public."SubscriberScanRun"')::text AS subscriber_schema`);
    if (database.name !== name || !database.version.startsWith('PostgreSQL ') || !database.subscriber_schema) {
      throw new Error('MIGRATED_NATIVE_POSTGRES_FIXTURE_REQUIRED');
    }
    const harness = await createSubscriberHarness({ db, desktopRoot });
    return { ...harness, desktopRoot, close: async () => { await harness.close(); await db.$disconnect(); } };
  } catch (error) { await db.$disconnect(); throw error; }
}
module.exports = { createSubscriberHarness, openSubscriberChainFixture, loadSubscriberHandler, loadSubscriberWorker };
