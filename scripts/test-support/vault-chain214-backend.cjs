'use strict';

const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module'), { spawn } = require('node:child_process');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function sourceFixture(load, sourceKey, revision, facts, evidence, options = {}) {
  const at = '2026-11-28T12:00:00.000Z', current = evidence !== undefined;
  return { protocolVersion: 2, sourceKey, sourceRevision: revision, capturedAt: at,
    coverage: { version: 1, complete: true, localRevision: revision, messageCount: options.messageCount || 1,
      oldestMessageAt: at, newestMessageAt: at }, facts,
    ...(current ? { messageMediaEvidence: evidence } : {}),
    factPage: { runId: hash(current ? [sourceKey, revision, 'media-message-evidence-v1'] : [sourceKey, revision]),
      pageNumber: options.pageNumber || 1, previousHash: options.previousHash || null,
      pageHash: load('./src/services/realtime-receipt-hash').hashCanonicalJson(facts),
      ...(current ? { mediaEvidenceHash: load('./src/services/realtime-receipt-hash').hashCanonicalJson(evidence) } : {}),
      done: options.done !== false, ...(options.done === false ? {} : { totalFacts: options.totalFacts ?? facts.length }) } };
}
const fact = (messageId, mediaId, count, index) => ({ messageId, mediaId, sentCount: 1, soldCount: 1,
  notOpenedCount: 0, freeCount: 0, revenueCents: 0, uniqueBuyers: 1, lastSoldAt: '2026-11-28T12:00:00.000Z',
  allocationCount: count, allocationIndex: index, purchaseEvidence: 'PROVIDER' });
const evidence = (dialogId, messageId, creatorMediaIds, excludedMediaIds = []) => ({ version: 1, complete: true,
  dialogId, messageId, creatorMediaIds: [...creatorMediaIds].sort(), excludedMediaIds: [...excludedMediaIds].sort() });

async function services(db, backendRoot) {
  const load = createRequire(path.join(backendRoot, 'package.json'));
  require.cache[load.resolve('./src/prisma')] = { exports: db };
  const { runRootCommit } = load('./src/services/db-commit-kernel');
  const write = fn => runRootCommit(db, ({ tx }) => fn(tx));
  const media = load('./src/services/media-library-service'), projection = load('./src/services/media-financial-projection-service');
  const feed = load('./src/services/creator-entity-change-service'), dialog = load('./src/services/dialog-intelligence-service');
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      const result = await projection.runSweep({ db, limit: 8, maxRuntimeMs: 15000 });
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!await db.domainWorkItem.count({ where: { workClass: projection.WORK_CLASS, isOutstanding: true } })) return;
    }
    throw Error('VAULT214_PROJECTION_DID_NOT_QUIESCE');
  };
  return { load, write, media, projection, feed, dialog, drain };
}

async function restartPhase({ db, backendRoot, data }) {
  const s = await services(db, backendRoot), { own } = data;
  if (data.source) await s.media.replaceUsageSources({ ...own, db, sources: [data.source] });
  await s.drain();
  const asset = await db.creatorMediaAsset.findUnique({ where: { creatorId_mediaId: { creatorId: own.creatorId, mediaId: data.mediaId } } });
  const state = await s.projection.financialProjectionState(db, own.creatorId);
  return { ok: true, pid: process.pid, asset, state };
}

async function runVaultBackend214({ db, backendRoot = path.resolve(__dirname, '../..'), databaseUrl, output = null }) {
  const s = await services(db, backendRoot), { load, write, media, projection, feed, dialog, drain } = s;
  const cases = [], observations = {};
  const check = async (name, fn) => { await fn(); cases.push({ name, ok: true }); console.log('PASS', name); };
  const { scope } = load('./scripts/audit/analytics-traffic/fixture.cjs');
  const scoped = await scope(db, { agencyId: 'vault214-agency', creatorId: 'vault214-creator', userId: 'vault214-user' });
  const own = { agencyId: scoped.agencyId, creatorId: scoped.creatorId };
  const asset = mediaId => db.creatorMediaAsset.findUnique({ where: { creatorId_mediaId: { creatorId: own.creatorId, mediaId } } });
  const submit = (...sources) => media.replaceUsageSources({ ...own, db, sources });
  async function publish(messageId, netCents, extra = {}) {
    const id = 'vault214-sale-' + messageId;
    await write(async tx => {
      await load('./src/services/creator-fact-write-authority').lockCreatorFacts(tx, own.agencyId, own.creatorId);
      const data = { fanOnlyFansUserIdAtEvent: '99', saleType: 'MESSAGE', messageId,
        amountCents: 10000, netCents, transactionStatus: 'done', currency: 'USD', purchasedAt: new Date('2026-11-28T12:00:00Z'), ...extra };
      await tx.creatorSale.upsert({ where: { id }, create: { ...own, id, externalTransactionId: 'vault214-tx-' + messageId,
        eventFingerprint: hash(id), ...data }, update: data });
      await feed.publishCanonicalSales({ db: tx, ...own, saleIds: [id] });
    });
    return id;
  }
  const sourceKey = projection.sourceKey(own.creatorId, '99');
  const make = (revision, facts, manifests, options) => sourceFixture(load, sourceKey, revision, facts, manifests, options);
  async function restart(data) {
    const entry = path.join(__dirname, '../audit/vault-chain214-postgres-proof.cjs');
    const child = spawn(process.execPath, [entry, '--restart', JSON.stringify({ ...data, own })], { cwd: backendRoot,
      env: { ...process.env, ONLINOD_POSTGRES_INTEGRATION: '1', ONLINOD_NATIVE_TEST_DATABASE_URL: databaseUrl,
        ONLINOD_VAULT_BACKEND_ROOT: backendRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr + stdout);
    const result = JSON.parse(stdout.trim().split('\n').at(-1)); assert.notEqual(result.pid, process.pid); return result;
  }
  const target = (dialogId, messageId = '11') => write(tx => dialog.scheduleDialogScanTx(tx,
    { ...own, dialogId, mode: 'targeted', targetMessageId: messageId, source: 'vault214_native' }));
  const chunk = (job, more = {}) => ({ kind: 'dialog_message_page', runId: job.params.scanRunId, dialogId: job.params.dialogId,
    mode: 'targeted', chunkKey: 'target-' + crypto.randomUUID(), targetMessageId: '11', targetReceiptId: job.continuation.targetReceiptId,
    messageIds: ['11'], messageCount: 1, hasMore: false, continuation: { mode: 'targeted' }, ...more });

  try {
    await check('leased purchase target rejects another dialog and another run before changing either target', async () => {
      const a = await target('42'), b = await target('43');
      for (const extra of [{ dialogId: '43' }, { runId: b.run.id }, { runId: b.run.id, dialogId: '43' }]) {
        await assert.rejects(write(tx => dialog.applyDialogIntelligenceChunk({ db: tx, job: a.job, chunkResult: chunk(a.job, extra) })), { code: 'DIALOG_CHUNK_SCOPE_MISMATCH' });
      }
      assert.equal(await db.dialogScanChunkCommit.count({ where: { creatorId: own.creatorId } }), 0);
      assert.equal(await db.dialogReconciliationTarget.count({ where: { creatorId: own.creatorId, status: 'PENDING' } }), 2);
    });
    await check('403 and contradictory missing-message claims preserve pending work; exact local commit replays once', async () => {
      const t = await target('44');
      for (const extra of [{ targetMissing: true, progress: { status: 403 } }, { targetMissing: true, progress: { status: 404 } },
        { targetMissing: true, progress: { status: 403 }, messageIds: [] }]) {
        await assert.rejects(write(tx => dialog.applyDialogIntelligenceChunk({ db: tx, job: t.job, chunkResult: chunk(t.job, extra) })), { code: 'DIALOG_TARGET_COMMIT_PROOF_MISSING' });
      }
      const page = chunk(t.job), first = await write(tx => dialog.applyDialogIntelligenceChunk({ db: tx, job: t.job, chunkResult: page }));
      const replay = await write(tx => dialog.applyDialogIntelligenceChunk({ db: tx, job: t.job, chunkResult: page }));
      assert.equal(replay.duplicate, true); assert.equal(first.chunkId, replay.chunkId);
      assert.equal(await db.dialogScanChunkCommit.count({ where: { runId: t.run.id } }), 1);
      const missing = await target('45');
      await write(tx => dialog.applyDialogIntelligenceChunk({ db: tx, job: missing.job,
        chunkResult: chunk(missing.job, { targetMissing: true, progress: { status: 410 }, messageIds: [], messageCount: 0 }) }));
      assert.equal((await db.dialogReconciliationTarget.findUnique({ where: { creatorId_dialogId_messageId: {
        creatorId: own.creatorId, dialogId: '45', messageId: '11' } } })).lastError, 'target_message_unavailable');
    });
    await check('legacy two-attachment package conserves803cents; partial denominator overwrite and reused ordinal roll back', async () => {
      await publish('100', 803);
      await submit(make('legacy-two', [fact('100', 'a', 2, 0), fact('100', 'b', 2, 1)])); await drain();
      assert.equal((await asset('a')).revenueCents, 402); assert.equal((await asset('b')).revenueCents, 401);
      for (const [revision, rows] of [['legacy-partial', [fact('100', 'a', 1, 0)]], ['legacy-reused', [fact('100', 'c', 2, 0)]]]) {
        await assert.rejects(submit(make(revision, rows)), { code: 'MEDIA_USAGE_ALLOCATION_CONFLICT' });
      }
      assert.equal((await asset('a')).revenueCents + (await asset('b')).revenueCents, 803); assert.equal(await asset('c'), null);
    });
    await check('complete creator/fan evidence corrects the entire old package without deleting raw historical facts', async () => {
      await submit(make('complete-creator-owner', [fact('100', 'a', 1, 0)], [evidence('99', '100', ['a'], ['b'])]));
      const pending = await projection.financialProjectionState(db, own.creatorId);
      assert.deepEqual(pending, { available: false, ready: false, pending: true });
      await drain(); assert.equal((await asset('a')).revenueCents, 803);
      assert.equal((await asset('b')).revenueCents, 0); assert.equal((await asset('b')).sentCount, 0); assert.equal((await asset('b')).soldCount, 0);
      assert.equal(await db.creatorMediaUsageFact.count({ where: { creatorId: own.creatorId, sourceMessageId: '100' } }), 2);
      assert.equal((await db.creatorSale.findUnique({ where: { id: 'vault214-sale-100' } })).netCents, 803);
    });
    await check('new process plus late oldDesktop replay cannot restore fan sales or shrink the validated denominator', async () => {
      const replay = await restart({ source: make('old-pc-after-restart', [fact('100', 'a', 2, 0), fact('100', 'b', 2, 1)]), mediaId: 'b' });
      assert.equal(replay.asset.sentCount, 0); assert.equal(replay.asset.revenueCents, 0); assert.equal(replay.state.ready, true);
      assert.equal((await asset('a')).revenueCents, 803); observations.restartPid = replay.pid;
      await assert.rejects(submit(make('conflicting-ownership', [fact('100', 'b', 1, 0)], [evidence('99', '100', ['b'])])), { code: 'MEDIA_USAGE_MEDIA_OWNERSHIP_CONFLICT' });
      assert.equal((await asset('b')).sentCount, 0);
    });
    await check('canonical money correction and refund preserve eligible creator allocation and withdrawn ownership', async () => {
      await publish('100', 601); await drain(); assert.equal((await asset('a')).revenueCents, 601); assert.equal((await asset('b')).revenueCents, 0);
      await publish('100', 0, { transactionStatus: 'undo' }); await drain(); assert.equal((await asset('a')).soldCount, 1); assert.equal((await asset('a')).revenueCents, 0);
      await publish('100', 803); await drain();
    });
    await check('two overlapping Desktop publishers and a canonical correction serialize without duplicate sales or stale fan revival', async () => {
      await Promise.all([
        submit(make('parallel-old-pc', [fact('100', 'a', 2, 0), fact('100', 'b', 2, 1)])),
        submit(make('parallel-current-pc', [fact('100', 'a', 1, 0)], [evidence('99', '100', ['a'], ['b'])])),
        publish('100', 607),
      ]);
      await drain(); assert.equal((await asset('a')).soldCount, 1); assert.equal((await asset('a')).revenueCents, 607);
      assert.equal((await asset('b')).sentCount, 0); assert.equal((await asset('b')).revenueCents, 0);
      await publish('100', 803); await drain();
    });
    await check('fan-only evidence survives a nonfinal zero-fact page and a new protocol run at the same old revision', async () => {
      await publish('200', 777);
      await submit(make('legacy-only-fan', [fact('200', 'only-fan', 1, 0)])); await drain();
      const legacy = make('fan-only-proof', []); await submit(legacy);
      const page = make('fan-only-proof', [], [evidence('99', '200', [], ['only-fan'])], { done: false });
      assert.notEqual(legacy.factPage.runId, page.factPage.runId, 'new authority cannot relabel the old receipt');
      await submit(page); await drain(); assert.equal((await asset('only-fan')).sentCount, 0);
      assert.equal((await db.creatorSale.findUnique({ where: { id: 'vault214-sale-200' } })).netCents, 777);
      await submit(make('fan-only-proof', [], [], { pageNumber: 2, previousHash: page.factPage.pageHash, totalFacts: 0 }));
      const replay = await submit(page); assert.equal(replay.staleSources, 1);
      await submit(make('old-fan-only-replay', [fact('200', 'only-fan', 1, 0)])); assert.equal((await asset('only-fan')).sentCount, 0);
    });
    await check('omitted uncertain historical IDs remain counted with unknown money until explicit ownership evidence', async () => {
      await publish('300', 901);
      await submit(make('legacy-uncertain', [fact('300', 'known', 2, 0), fact('300', 'uncertain', 2, 1)]));
      await submit(make('known-only-proof', [fact('300', 'known', 1, 0)], [evidence('99', '300', ['known'])])); await drain();
      assert.equal((await asset('known')).revenueCents, 901); assert.equal((await asset('uncertain')).soldCount, 1);
      assert.equal((await asset('uncertain')).revenueCents, 0); assert.equal((await asset('uncertain')).revenueUnknownCount, 1);
      await submit(make('uncertain-owner-resolved', [], [evidence('99', '300', ['known'], ['uncertain'])])); await drain();
      assert.equal((await asset('uncertain')).soldCount, 0); assert.equal((await asset('uncertain')).revenueUnknownCount, 0);
    });
    const ids = Array.from({ length: 501 }, (_, i) => 'bulk-' + String(i).padStart(4, '0'));
    const rows = ids.map((id, i) => fact('400', id, ids.length, i));
    await check('complete manifest split acrossfactpages remains unavailable while any eligible fact is missing', async () => {
      await publish('400', 1001);
      const manifests = [evidence('99', '400', ids)], first = make('split-501', rows.slice(0, 400), manifests, { done: false });
      await submit(first); await drain(); assert.deepEqual(await projection.financialProjectionState(db, own.creatorId), { available: false, ready: false, pending: true });
      assert.equal(await db.domainWorkItem.count({ where: { workClass: projection.WORK_CLASS, isOutstanding: true } }), 0, 'missing source facts must not spin the owner queue');
      await submit(make('split-501', rows.slice(400), manifests, { pageNumber: 2, previousHash: first.factPage.pageHash, totalFacts: 501 }));
      await drain(); assert.equal((await projection.financialProjectionState(db, own.creatorId)).ready, true);
      const sum = await db.creatorMediaAsset.aggregate({ where: { ...own, mediaId: { startsWith: 'bulk-' } }, _sum: { revenueCents: true } });
      assert.equal(sum._sum.revenueCents, 1001);
    });
    await check('501-attachment ownership correction spans500-row commits, hides intermediate money, resumes in new process', async () => {
      await submit(make('bulk-owner-correction', [], [evidence('99', '400', ids.slice(1), [ids[0]])]));
      const work = load('./src/services/domain-work-authority-service');
      const claim = await work.claimDomainWorkBatch({ db, workClass: projection.WORK_CLASS, limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 120000 });
      assert.equal(claim.items.length, 1);
      const step = await projection.processPage({ db, item: claim.items[0], ownerToken: claim.ownerToken });
      assert.equal(step.completed, false); assert.deepEqual(await projection.financialProjectionState(db, own.creatorId), { available: false, ready: false, pending: true });
      const restarted = await restart({ mediaId: ids[0] }); assert.equal(restarted.asset.sentCount, 0); assert.equal(restarted.state.ready, true);
      const sum = await db.creatorMediaAsset.aggregate({ where: { ...own, mediaId: { startsWith: 'bulk-' } }, _sum: { revenueCents: true, sentCount: true } });
      assert.deepEqual(sum._sum, { revenueCents: 1001, sentCount: 500 });
    });
    await check('message evidence is bound to its creator/dialog source and page hash; rejected corrections leave facts unchanged', async () => {
      await assert.rejects(submit(make('wrong-dialog-evidence', [], [evidence('another-dialog', '100', ['a'])])), { code: 'MEDIA_USAGE_MEDIA_EVIDENCE_SCOPE_MISMATCH' });
      const bad = make('wrong-evidence-hash', [], [evidence('99', '100', ['a'])]); bad.factPage.mediaEvidenceHash = '0'.repeat(64);
      await assert.rejects(submit(bad), { code: 'MEDIA_USAGE_FACT_INVALID' });
      assert.equal((await asset('a')).revenueCents, 803);
    });
    await check('outer transaction rollback contains evidence, facts, durable work and reverse-feed invalidation', async () => {
      const before = await db.creatorMediaMessageEvidence.count({ where: own });
      const normalized = load('./src/services/media-usage-fact-service').normalizeUsageFactSource(make('rolled-back-proof', [], [evidence('99', 'rollback', ['not-committed'])]));
      await assert.rejects(write(async tx => { await projection.lock(tx, own.agencyId, own.creatorId);
        await load('./src/services/media-usage-fact-service').mergeUsageFactSourceTx(tx, { ...own, source: normalized }); throw Error('ROLLBACK_VAULT214'); }), /ROLLBACK_VAULT214/);
      assert.equal(await db.creatorMediaMessageEvidence.count({ where: own }), before);
      assert.equal(await db.creatorMediaUsageSourceState.count({ where: { ...own, sourceRevision: 'rolled-back-proof' } }), 0);
      assert.equal((await projection.financialProjectionState(db, own.creatorId)).ready, true);
    });
    await check('ready-state lookup uses the partial evidence-debt index instead of walking completed message history', async () => {
      const plan = await write(async tx => { await tx.$executeRawUnsafe('SET LOCAL enable_seqscan=off');
        return tx.$queryRawUnsafe('EXPLAIN SELECT 1 FROM "CreatorMediaMessageEvidence" WHERE "creatorId"=$1 AND (dirty OR "pendingFacts") LIMIT 1', own.creatorId); });
      assert.match(JSON.stringify(plan), /CreatorMediaMessageEvidence_pending_idx/);
    });
    const result = { ok: true, nativePostgres: true, cases, observations, productionAccessed: false };
    if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (error) {
    if (output) fs.writeFileSync(output, JSON.stringify({ ok: false, cases, observations, error: { message: error.message, code: error.code, stack: error.stack } }, null, 2) + '\n');
    throw error;
  }
}

module.exports = { runVaultBackend214, restartPhase, sourceFixture, fact, evidence };
