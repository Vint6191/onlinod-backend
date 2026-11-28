'use strict';

// Only the physical provider response is synthetic. Planning, claim admission,
// read leases, tokens, page receipts, publication and canonical facts use the
// repository implementations against an explicitly supplied PostgreSQL client.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createEarningsHarness } = require('./earnings-chain210-fixture.cjs');

const capabilities = Object.fromEntries([
  'creatorEventDrivenSyncV2', 'campaignCausalObservationV1', 'campaignServerFanRefreshV1',
  'campaignResumablePaginationV1', 'campaignFreshnessCoverageV1', 'campaignOrderIndependentTraversalV1',
  'campaignSegmentedFairTraversalV1', 'campaignFrontierSchedulingV1', 'campaignDirectoryReuseV1',
  'campaignBoundedTraversalV1', 'campaignTraversalAuthorityV1', 'campaignFairPagesV1',
  'campaignSourceValidationV1',
].map(key => [key, true]));

async function createCampaignHarness({ db, desktopRoot, scope = null, backendRoot }) {
  const h = await createEarningsHarness({ db, desktopRoot, backendRoot });
  const desktopLoad = createRequire(path.join(desktopRoot, 'package.json'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-chain213-'));
  const bundle = path.join(temporary, 'campaigns.cjs');
  await desktopLoad('esbuild').build({
    entryPoints: [path.join(desktopRoot, 'apps/desktop/electron/main/services/backend-jobs/handlers/campaigns-handler.ts')],
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  const { campaignsHandler } = require(bundle);
  const control = h.load('./src/services/campaign-scan-control-service');
  const publisher = h.load('./src/services/analytics-publication-service');
  const ledger = h.load('./src/services/creator-analytics-ledger-service');
  const calls = [];
  async function campaignScope(name) {
    const s = await (scope || h.scope)(name);
    // The independent Financial predecessor is explicitly stopped in this
    // focused fixture. This releases ordinary admission without inventing any
    // successful earnings proof, Campaign fact or membership receipt.
    if (!await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: s.creatorId } })) {
      await h.write(tx => tx.creatorFinancialCollectionState.create({ data: {
        agencyId: s.agencyId, creatorId: s.creatorId, status: 'FAILED',
        lastErrorCode: 'FIXTURE_INDEPENDENT_PREDECESSOR_STOPPED',
      } }));
    }
    return s;
  }
  async function claim(s, expectedId) {
    const claimed = await h.lease.claimJob({ userId: s.userId, deviceId: s.deviceId, jobKeys: ['fetch_campaigns'], capabilities });
    assert.ok(claimed.job, JSON.stringify(claimed));
    if (expectedId) assert.equal(claimed.job.id, expectedId);
    return { scope: s, job: claimed.job, checkpoint: claimed.job.continuation ?? null, calls: [], credentials: {
      jobId: claimed.job.id, userId: s.userId, deviceId: s.deviceId,
      leaseToken: claimed.job.leaseToken, leaseRevision: claimed.job.leaseRevision,
    } };
  }
  async function start(s) {
    const scheduled = await control.startManualCampaignScan({ db, creator: s.creator, requestedByUserId: s.userId, intent: 'source' });
    return claim(s, scheduled.job.id);
  }
  async function produce(run, body, expected = run.checkpoint) {
    return campaignsHandler.runChunk({
      creatorId: run.scope.creatorId, job: run.job, continuation: structuredClone(expected?.jobContinuation ?? null),
      signal: new AbortController().signal,
      ofApi: { request: async request => {
        assert.equal(request.endpoint.method, 'GET');
        const call = { source: request.source, path: request.endpoint.path, creatorId: request.creatorId };
        calls.push(call); run.calls.push(call);
        return { ok: true, status: 200, data: typeof body === 'function' ? await body(request) : body };
      } },
      acquireObservationReadLease: request => h.lease.acquireJobFanObservationReadLease({ ...run.credentials,
        purpose: request.purpose, requestId: request.requestKey, campaignPage: request.campaignPage }),
      acquireObservationToken: request => h.lease.issueFanObservationToken({ ...run.credentials, ...request }),
      releaseObservationReadLease: request => h.lease.releaseJobObservationReadLease({ ...run.credentials,
        readLeaseToken: typeof request === 'string' ? request : request.readLeaseToken ?? request.token }),
    });
  }
  async function progress(run, step, expected = run.checkpoint) {
    const continuation = step.outcome === 'done'
      ? { driverPhase: 'complete', result: step.result, progress: step.progress }
      : { driverPhase: 'execute', jobContinuation: step.continuation };
    const result = await h.lease.progressJob({ ...run.credentials, expectedContinuation: expected,
      continuation, progress: step.progress, chunkResult: step.chunkResult });
    run.checkpoint = result.continuation;
    return result;
  }
  async function turn(run, body) {
    const expected = structuredClone(run.checkpoint);
    const step = await produce(run, body, expected);
    return { expected, step, result: await progress(run, step, expected) };
  }
  async function exhaust(run, body) {
    for (let i = 0; i < 100 && run.checkpoint?.driverPhase !== 'complete'; i++) await turn(run, body);
    assert.equal(run.checkpoint?.driverPhase, 'complete', 'Campaign traversal did not reach its bounded final checkpoint');
  }
  async function finish(run, expectedStatus = 'DONE') {
    assert.equal(run.checkpoint?.driverPhase, 'complete');
    const accepted = await h.lease.completeJob({ ...run.credentials, result: run.checkpoint.result, progress: run.checkpoint.progress });
    assert.ok(accepted.publicationId, JSON.stringify(accepted));
    let result;
    for (let i = 0; i < 20; i++) {
      await db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { availableAt: new Date(0) } });
      result = await publisher.runAnalyticsPublicationUnit({ db, publicationId: accepted.publicationId });
      if (!result.publicationPending) break;
    }
    assert.equal(result.job?.status, expectedStatus, JSON.stringify(result));
    return { accepted, result, job: await db.jobInstance.findUnique({ where: { id: run.job.id } }),
      state: await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: run.scope.creatorId } }),
      publication: await db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } }) };
  }
  async function observeValue(s, fanId, availability, value = null) {
    const observedAt = new Date();
    return h.write(tx => h.load('./src/services/fan-data-authority-service').projectFanObservationBatch(tx, {
      agencyId: s.agencyId, creatorId: s.creatorId, sourceDeviceId: s.deviceId,
      allowedSources: ['USER_PROFILE'], observedAtPolicy: 'TRUSTED_INPUT', receivedAt: observedAt,
      items: [{ onlyFansUserId: fanId,
        identity: { observedAt, source: 'USER_PROFILE', username: 'fan_' + fanId },
        value: { observedAt, source: 'USER_PROFILE', availability, ...(value == null ? {} : { totalSpentCents: value }) } }],
    }));
  }
  return { ...h, ledger, control, publisher, scope: campaignScope, start, claim, produce, progress, turn, exhaust, finish, observeValue,
    calls, close: async () => { fs.rmSync(temporary, { recursive: true, force: true }); await h.close(); } };
}

async function runCampaignBackend213({ db, scope = null, desktopRoot, output = null, backendRoot, check = null }) {
  const h = await createCampaignHarness({ db, scope, desktopRoot, backendRoot });
  const results = [];
  const run = check || (async (name, work) => { const details = await work(); results.push({ name, ...(details || {}) }); });
  try {
    await run('Unavailable FanData preserves partial money coverage, complete membership and a DONE provider job after lost ACK', async () => {
      const s = await h.scope('campaign213_unavailable');
      await h.observeValue(s, '21301', 'UNAVAILABLE');
      const r = await h.start(s);
      const provider = request => request.source.endsWith('.list')
        ? { list: [{ id: '31301', name: 'Unavailable source', is_active: true }], hasMore: false }
        : { list: [{ id: 'claim-unavailable', user: { id: '21301' } }], hasMore: false };
      await h.turn(r, provider);
      await h.turn(r, provider);
      const page = await h.turn(r, provider);
      assert.equal(page.step.chunkResult.kind, 'campaign_claimers_page');
      const beforeReplay = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
      assert.equal(beforeReplay.fanValueUnavailable, 1);
      assert.equal(beforeReplay.fanValueFreshnessStatus, 'PARTIAL');
      const replay = await h.progress(r, page.step, page.expected);
      assert.equal(replay.sideEffect.staleProgress, true);
      const lateFailure = await h.lease.failJob({ ...r.credentials, expectedContinuation: page.expected,
        retryable: false, error: 'Synthetic failure from the older local Campaign checkpoint' });
      assert.equal(lateFailure.staleFailure, true);
      assert.equal(lateFailure.status, 'CLAIMED');
      assert.deepEqual(lateFailure.continuation, r.checkpoint);
      assert.equal((await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } })).fanValueUnavailable, 1);
      assert.equal(await db.creatorCampaignFan.count({ where: { creatorId: s.creatorId } }), 1);
      await h.exhaust(r, () => { throw Error('A completed Campaign was read again'); });
      const completed = await h.finish(r);
      assert.equal(completed.publication.state, 'COMMITTED');
      assert.equal(completed.state.status, 'PARTIAL');
      assert.equal(completed.state.fanValueFreshnessStatus, 'PARTIAL');
      assert.equal(completed.state.membershipCoverageStatus, 'COMPLETE');
      assert.equal(completed.state.membershipBaselineGeneration, r.job.params.collectionGeneration);
      assert.equal(completed.state.baselineGeneration, null);
      assert.equal(completed.job.result.completionSideEffect.completion.proof.fanValuesComplete, false);
      assert.equal(r.calls.length, 2);
      assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: s.creatorId } }), 0,
        'A fresh unavailable receipt must not create an automatic retry loop');
      const second = await h.publisher.runAnalyticsPublicationUnit({ db, publicationId: completed.accepted.publicationId });
      assert.equal(second.job.status, 'DONE');
      assert.equal(r.calls.length, 2);
      return { providerReads: r.calls.length, unavailable: completed.state.fanValueUnavailable,
        membership: completed.state.membershipCoverageStatus, coverage: completed.state.status, job: completed.job.status };
    });

    await run('Nonempty Campaign directory with zero claimers publishes exact empty FanData coverage', async () => {
      const s = await h.scope('campaign213_empty_membership');
      const r = await h.start(s);
      await h.exhaust(r, request => request.source.endsWith('.list')
        ? { list: [{ id: '31304', name: 'Empty membership', is_active: true }], hasMore: false }
        : { list: [], hasMore: false });
      const completed = await h.finish(r);
      assert.equal(completed.state.status, 'COMPLETE');
      assert.equal(completed.state.membershipCoverageStatus, 'COMPLETE');
      assert.equal(completed.state.fanValueExpected, 0);
      assert.equal(completed.state.fanValueFreshnessStatus, 'COMPLETE');
      assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: s.creatorId } }), 0);
      const read = await h.control.readManualCampaignScan({ db, creator: s.creator });
      assert.equal(read.status, 'COMPLETE');
      assert.equal(read.fanValuesComplete, true);
      return { campaigns: 1, fans: 0, coverage: completed.state.fanValueFreshnessStatus, presentation: read.status };
    });

    await run('Backend rejects coerced Campaign directory IDs and preserves the exact rejected receipt', async () => {
      const s = await h.scope('campaign213_bad_campaign_ids');
      const previous = await h.start(s);
      await h.exhaust(previous, request => request.source.endsWith('.list')
        ? { list: [{ id: '31302', name: 'Previous source', is_active: true }], hasMore: false }
        : { list: [], hasMore: false });
      await h.finish(previous);
      const r = await h.start(s);
      const step = await h.produce(r, { list: [{ id: '31302', name: 'Source' }], hasMore: false });
      step.chunkResult.campaigns[0].id = { id: '31302' };
      const applied = await h.progress(r, step);
      assert.equal(applied.sideEffect.rejected, 1);
      assert.equal(await db.creatorCampaign.count({ where: { creatorId: s.creatorId } }), 1);
      const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
      assert.equal(state.campaignProofRejectedRows, 1);
      assert.equal(state.campaignDirectoryGeneration, previous.job.params.collectionGeneration);
      await assert.rejects(() => h.turn(r, () => { throw Error('Segment selection must be provider-free'); }),
        /CAMPAIGN_DIRECTORY_PROOF_INCOMPLETE|not fully durable/);
      assert.equal((await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } })).membershipBaselineGeneration,
        previous.job.params.collectionGeneration, 'The older seal cannot certify the rejected new directory');
      assert.equal((await db.creatorCampaign.findFirst({ where: { creatorId: s.creatorId } })).isActive, true,
        'Rejected new directory must not retire the previously observed Campaign');
      await h.control.stopManualCampaignScan({ db, creatorId: s.creatorId });
      return { rejected: state.campaignProofRejectedRows, inventedCampaigns: 0, retainedPreviousSeal: true };
    });

    await run('Ambiguous nested claimer identity cannot create a phantom fan or complete membership', async () => {
      const s = await h.scope('campaign213_bad_claimer_ids');
      await h.observeValue(s, '21304', 'AVAILABLE', 0);
      await h.observeValue(s, '21305', 'AVAILABLE', 0);
      const r = await h.start(s);
      await h.turn(r, { list: [{ id: '31303', name: 'Malformed membership' }, { id: '31305', name: 'Long valid membership' }], hasMore: false });
      await h.turn(r, () => { throw Error('Segment selection must be provider-free'); });
      const expected = structuredClone(r.checkpoint);
      const step = await h.produce(r, { list: [{ id: 'claim-source', user: { id: 'phantom-claim' } }], hasMore: false });
      step.chunkResult.claimers = [{ id: 'phantom-claim', user: {} }];
      const applied = await h.progress(r, step, expected);
      assert.equal(applied.sideEffect.rejected, 1);
      assert.equal(applied.sideEffect.campaignComplete, false);
      assert.equal(await db.creatorFan.count({ where: { creatorId: s.creatorId, onlyFansUserId: 'phantom-claim' } }), 0);
      assert.equal(await db.creatorCampaignFan.count({ where: { creatorId: s.creatorId } }), 0);
      const secondHead = await h.turn(r, { list: [{ id: 'long-head', user: { id: '21304' } }], hasMore: true });
      assert.equal(secondHead.step.chunkResult.externalCampaignId, '31305');
      await h.exhaust(r, request => {
        assert.equal(request.source, 'backend.readonly.fetch_campaigns.claimers');
        const url = new URL(request.endpoint.path, 'https://provider.fixture');
        assert.equal(url.pathname.split('/').at(-2), '31305');
        assert.equal(url.searchParams.get('offset'), '1');
        return { list: [{ id: 'long-tail', user: { id: '21305' } }], hasMore: false };
      });
      const other = await db.creatorCampaign.findUnique({ where: { creatorId_externalCampaignId: {
        creatorId: s.creatorId, externalCampaignId: '31305' } } });
      assert.equal(other.claimersLastVerifiedRunId, r.job.params.collectionGeneration);
      assert.equal(await db.creatorCampaignFan.count({ where: { creatorId: s.creatorId } }), 2);
      const completed = await h.finish(r, 'SCHEDULED');
      assert.equal(completed.publication.state, 'REJECTED');
      assert.equal(completed.state.membershipBaselineGeneration, null);
      assert.equal(completed.state.campaignProofRejectedRows, 1);
      await h.control.stopManualCampaignScan({ db, creatorId: s.creatorId });
      return { rejected: 1, phantomFans: 0, membershipProof: null, job: completed.job.status,
        otherCampaignCompleted: true, otherCampaignMembers: 2, providerReads: r.calls.length };
    });

    await run('A rejected source claimer keeps its Campaign partial while another Campaign finishes later fair pages', async () => {
      const s = await h.scope('campaign213_fair_rejected_source');
      await h.observeValue(s, '21306', 'AVAILABLE', 0);
      await h.observeValue(s, '21307', 'AVAILABLE', 0);
      const r = await h.start(s);
      await h.exhaust(r, request => {
        if (request.source.endsWith('.list')) return { list: [
          { id: '31306', name: 'Rejected source row' }, { id: '31307', name: 'Long healthy source' },
        ], hasMore: false };
        const url = new URL(request.endpoint.path, 'https://provider.fixture');
        const campaign = url.pathname.split('/').at(-2), offset = Number(url.searchParams.get('offset'));
        if (campaign === '31306') return { list: [{ id: 'missing-user', user: {} }], hasMore: false };
        assert.equal(campaign, '31307');
        return offset === 0 ? { list: [{ id: 'healthy-head', user: { id: '21306' } }], hasMore: true }
          : { list: [{ id: 'healthy-tail', user: { id: '21307' } }], hasMore: false };
      });
      const campaigns = await db.creatorCampaign.findMany({ where: { creatorId: s.creatorId }, orderBy: { externalCampaignId: 'asc' } });
      assert.equal(campaigns[0].claimersLastVerifiedRunId, null);
      assert.equal(campaigns[1].claimersLastVerifiedRunId, r.job.params.collectionGeneration);
      const completed = await h.finish(r, 'SCHEDULED');
      assert.equal(completed.state.campaignProofRejectedRows, 1);
      assert.equal(completed.state.membershipBaselineGeneration, null);
      assert.equal(completed.state.campaignFrontierCompletedCount, 1);
      assert.equal(r.calls.length, 4);
      await h.control.stopManualCampaignScan({ db, creatorId: s.creatorId });
      return { providerReads: r.calls.length, completedCampaigns: 1, rejectedRows: 1, completeMembershipProof: false };
    });
    if (output) fs.writeFileSync(output, JSON.stringify({ ok: true, nativePostgres: true, cases: results }, null, 2) + '\n');
    return results;
  } finally { await h.close(); }
}

module.exports = { capabilities, createCampaignHarness, runCampaignBackend213 };
