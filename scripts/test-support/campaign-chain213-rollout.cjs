'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { capabilities, createCampaignHarness } = require('./campaign-chain213-backend.cjs');

async function runCampaignRollout213({ db, desktopRoot, baselineBackendRoot, baselineDesktopRoot, output = null }) {
  const h = await createCampaignHarness({ db, desktopRoot });
  const legacy = await createCampaignHarness({ db, desktopRoot: baselineDesktopRoot, backendRoot: baselineBackendRoot });
  const cases = [];
  const run = async (name, work) => cases.push({ name, ...await work() });
  const empty = { list: [], hasMore: false };
  const provider = (campaignId, fanId = null) => request => request.source.endsWith('.list')
    ? { list: [{ id: campaignId, name: 'Retained source', is_active: true }], hasMore: false }
    : { list: fanId ? [{ id: 'claim-' + fanId, user: { id: fanId } }] : [], hasMore: false };
  async function untilDue(jobId) {
    const row = await db.jobInstance.findUnique({ where: { id: jobId }, select: { nextRunAt: true } });
    const remaining = +row.nextRunAt - Date.now();
    assert.ok(remaining <= 2100, 'Protocol repair must become claimable promptly');
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining + 10));
  }
  async function receipts(jobId) {
    return db.analyticsIngestBatch.findMany({ where: { sourceJobId: jobId },
      select: { id: true, idempotencyKey: true, payloadChecksum: true, status: true }, orderBy: { id: 'asc' } });
  }
  try {
    await run('Old capability cannot claim; an untouched old command safely adopts the validator and rejects wrong page markers', async () => {
      const s = await h.scope('campaign213_rollout_untouched');
      const scheduled = await legacy.control.startManualCampaignScan({ db, creator: s.creator, intent: 'source' });
      const oldGeneration = scheduled.job.params.collectionGeneration;
      assert.equal(scheduled.job.params.sourceValidationVersion, undefined);
      await h.write(tx => tx.jobInstance.update({ where: { id: scheduled.job.id }, data: { params: {
        ...scheduled.job.params, campaignDirectoryReuseVersion: 1, campaignDirectoryReuseGeneration: 'legacy-unvalidated',
        campaignDirectoryReuseRequestedAt: scheduled.job.params.collectionRequestedAt,
        campaignDirectoryReuseRevision: 1, campaignDirectoryReuseCampaignCount: 0,
      } } }));
      const oldCapabilities = { ...capabilities }; delete oldCapabilities.campaignSourceValidationV1;
      const denied = await h.lease.claimJob({ userId: s.userId, deviceId: s.deviceId,
        jobKeys: ['fetch_campaigns'], capabilities: oldCapabilities });
      assert.equal(denied.job, null);
      assert.equal((await db.jobInstance.findUnique({ where: { id: scheduled.job.id } })).status, 'SCHEDULED');
      const r = await h.claim(s, scheduled.job.id);
      assert.equal(r.job.params.collectionGeneration, oldGeneration);
      assert.equal(r.job.params.sourceValidationVersion, 1);
      assert.equal(r.job.params.campaignDirectoryReuseGeneration, undefined);
      assert.equal(r.checkpoint, null);
      const first = await h.produce(r, empty);
      first.chunkResult.sourceValidationVersion = 2;
      await assert.rejects(h.progress(r, first), /CAMPAIGN_SOURCE_VALIDATION_REQUIRED/);
      assert.equal((await receipts(r.job.id)).length, 0);
      assert.equal((await db.jobInstance.findUnique({ where: { id: r.job.id } })).continuation, null);
      first.chunkResult.sourceValidationVersion = 1;
      await h.progress(r, first);
      await h.exhaust(r, empty);
      const finished = await h.finish(r);
      assert.equal(finished.state.membershipBaselineSourceValidationVersion, 1);
      assert.equal(finished.state.campaignDirectorySourceValidationVersion, 1);
      return { legacyClaimBlocked: true, generationRetainedOnlyBeforeStart: true, wrongMarkerRows: 0, baselineVersion: 1 };
    });

    await run('A live old lease rotates before its next write; held reads, old callbacks and duplicate ACKs cannot relabel old pages', async () => {
      const s = await h.scope('campaign213_rollout_live');
      const old = await legacy.start(s), body = provider('41302');
      const directory = await legacy.turn(old, body);
      await legacy.turn(old, body);
      await legacy.lease.acquireJobFanObservationReadLease({ ...old.credentials, purpose: 'campaign_claimers_page',
        requestId: 'old-in-flight-provider-read', campaignPage: { externalCampaignId: '41302', pageNumber: 1, sourceOffset: 0 } });
      assert.equal(await db.fanObservationReadLease.count({ where: { jobId: old.job.id } }), 1);
      const oldReceipts = await receipts(old.job.id);
      await assert.rejects(h.lease.renewLease(old.credentials), /new collection generation/);
      const rotated = await db.jobInstance.findUnique({ where: { id: old.job.id } });
      assert.equal(rotated.status, 'SCHEDULED');
      assert.equal(rotated.attempts, 0);
      assert.equal(rotated.continuation, null);
      assert.notEqual(rotated.params.collectionGeneration, old.job.params.collectionGeneration);
      assert.ok(Date.parse(rotated.params.collectionAuthorityRequestedAt) > Date.parse(old.job.params.collectionAuthorityRequestedAt));
      assert.equal(await db.fanObservationReadLease.count({ where: { jobId: old.job.id } }), 0);
      assert.deepEqual(await receipts(old.job.id), oldReceipts);
      await assert.rejects(h.lease.progressJob({ ...old.credentials, expectedContinuation: directory.expected,
        continuation: old.checkpoint, chunkResult: directory.step.chunkResult }), /not claimed|stale|revision|status is SCHEDULED/i);
      const replay = await h.ledger.ingestCampaignChunk({ db, job: old.job, deviceId: s.deviceId, chunk: directory.step.chunkResult });
      assert.equal(replay.replay, true);
      assert.deepEqual(await receipts(old.job.id), oldReceipts);
      const r = await h.claim(s, old.job.id);
      assert.equal(r.job.params.collectionGeneration, rotated.params.collectionGeneration);
      assert.equal(r.checkpoint, null);
      await h.exhaust(r, body);
      const finished = await h.finish(r);
      assert.equal(finished.state.membershipBaselineSourceValidationVersion, 1);
      assert.equal(await db.creatorCampaign.count({ where: { creatorId: s.creatorId } }), 1);
      for (const receipt of oldReceipts) assert.deepEqual((await receipts(old.job.id)).find(row => row.id === receipt.id), receipt);
      return { oldReceiptsRetained: oldReceipts.length, oldProviderReadReleased: true, oldCallbackRejected: true,
        newGeneration: true, newProviderReads: r.calls.length, baselineVersion: 1 };
    });

    await run('A released old traversal rotates at claim without consuming retry attempts', async () => {
      const s = await h.scope('campaign213_rollout_reclaim');
      const old = await legacy.start(s);
      await legacy.turn(old, provider('41303'));
      await legacy.lease.releaseJob({ ...old.credentials, reason: 'synthetic process restart', runAfterMs: 1000 });
      await untilDue(old.job.id);
      const r = await h.claim(s, old.job.id);
      assert.notEqual(r.job.params.collectionGeneration, old.job.params.collectionGeneration);
      assert.equal(r.job.params.sourceValidationVersion, 1);
      assert.equal(r.checkpoint, null);
      assert.equal((await db.jobInstance.findUnique({ where: { id: r.job.id } })).attempts, 0);
      await h.exhaust(r, provider('41303'));
      await h.finish(r);
      return { newGeneration: true, discardedLegacyCheckpoint: true, attempts: 0 };
    });

    await run('A durable unmarked completion is retired before the completion shortcut can accept a publication', async () => {
      const s = await h.scope('campaign213_rollout_complete');
      const old = await legacy.start(s);
      await legacy.exhaust(old, empty);
      assert.equal(old.checkpoint.result.sourceValidationVersion, undefined);
      await assert.rejects(h.lease.completeJob({ ...old.credentials, result: old.checkpoint.result }), /new collection generation/);
      assert.equal(await db.analyticsPublication.count({ where: { jobId: old.job.id } }), 0);
      const rotated = await db.jobInstance.findUnique({ where: { id: old.job.id } });
      assert.equal(rotated.status, 'SCHEDULED');
      assert.notEqual(rotated.params.collectionGeneration, old.job.params.collectionGeneration);
      const r = await h.claim(s, old.job.id);
      await h.exhaust(r, empty);
      const finished = await h.finish(r);
      assert.equal(finished.state.membershipBaselineSourceValidationVersion, 1);
      return { oldCompletionAccepted: false, newCompletionValidated: true };
    });

    await run('An already accepted legacy publication stays immutable, cannot certify current proof and recovers in a fresh process', async () => {
      const s = await h.scope('campaign213_rollout_publishing');
      await h.observeValue(s, '22304', 'AVAILABLE', 0);
      const old = await legacy.start(s), body = provider('41304', '22304');
      await legacy.exhaust(old, body);
      const before = await receipts(old.job.id);
      const membership = await db.creatorCampaignFan.findFirst({ where: { creatorId: s.creatorId } });
      assert.ok(membership);
      const accepted = await legacy.lease.completeJob({ ...old.credentials, result: old.checkpoint.result });
      const originalPublication = await db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } });
      let result;
      for (let i = 0; i < 20; i++) {
        await db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { availableAt: new Date(0) } });
        result = await h.publisher.runAnalyticsPublicationUnit({ db, publicationId: accepted.publicationId });
        if (!result.publicationPending) break;
      }
      assert.equal(result.protocolSuperseded, true);
      assert.equal(result.job.status, 'SCHEDULED');
      const current = await db.jobInstance.findUnique({ where: { id: old.job.id } });
      assert.equal(current.attempts, 0);
      assert.equal(current.params.sourceValidationVersion, 1);
      assert.notEqual(current.params.collectionGeneration, old.job.params.collectionGeneration);
      const partial = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: s.creatorId } });
      assert.equal(partial.membershipBaselineGeneration, null);
      assert.equal(partial.membershipBaselineSourceValidationVersion, 0);
      const replay = await h.lease.completeJob({ ...old.credentials, result: old.checkpoint.result });
      assert.equal(replay.protocolSuperseded, true);
      const rejected = await db.analyticsPublication.findUnique({ where: { id: accepted.publicationId } });
      assert.equal(rejected.state, 'REJECTED');
      assert.deepEqual(rejected.payload, originalPublication.payload);
      assert.equal(rejected.payloadHash, originalPublication.payloadHash);
      for (const receipt of before) assert.deepEqual((await receipts(old.job.id)).find(row => row.id === receipt.id), receipt);
      assert.equal((await db.creatorCampaignFan.findFirst({ where: { creatorId: s.creatorId } })).id, membership.id);
      await untilDue(old.job.id);
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign213-restart-'));
      const proofFile = path.join(temporary, 'restart.json');
      const backendRoot = path.resolve(__dirname, '../..');
      const script = `
        const fs=require('node:fs'),assert=require('node:assert/strict');
        const {PrismaClient}=require('@prisma/client');
        const {createCampaignHarness}=require('./scripts/test-support/campaign-chain213-backend.cjs');
        (async()=>{const db=new PrismaClient();let h;try{h=await createCampaignHarness({db,desktopRoot:process.env.NOD_CAMPAIGN_DESKTOP_ROOT});
          const s=JSON.parse(process.env.NOD_CAMPAIGN_RESTART_SCOPE),r=await h.claim(s,process.env.NOD_CAMPAIGN_RESTART_JOB);
          assert.equal(r.checkpoint,null);assert.equal(r.job.params.sourceValidationVersion,1);
          await h.exhaust(r,request=>request.source.endsWith('.list')?{list:[{id:'41304',name:'Retained source',is_active:true}],hasMore:false}
            :{list:[{id:'claim-22304',user:{id:'22304'}}],hasMore:false});
          const done=await h.finish(r);assert.equal(done.state.membershipBaselineSourceValidationVersion,1);
          fs.writeFileSync(process.env.NOD_CAMPAIGN_RESTART_OUTPUT,JSON.stringify({status:done.job.status,generation:r.job.params.collectionGeneration,
            sourceValidationVersion:done.state.membershipBaselineSourceValidationVersion,providerReads:r.calls.length,pid:process.pid}));
        }finally{if(h)await h.close();await db.$disconnect();}})().catch(e=>{console.error(e.stack);process.exitCode=1});`;
      try {
        const child = spawn(process.execPath, ['-e', script], { cwd: backendRoot, env: { ...process.env,
          NOD_CAMPAIGN_DESKTOP_ROOT: desktopRoot, NOD_CAMPAIGN_RESTART_SCOPE: JSON.stringify(s),
          NOD_CAMPAIGN_RESTART_JOB: old.job.id, NOD_CAMPAIGN_RESTART_OUTPUT: proofFile }, stdio: ['ignore', 'pipe', 'pipe'] });
        let diagnostic = ''; child.stdout.on('data', data => { diagnostic += data; }); child.stderr.on('data', data => { diagnostic += data; });
        const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(exit, 0, diagnostic);
        const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
        assert.notEqual(proof.pid, process.pid);
        assert.equal(proof.generation, current.params.collectionGeneration);
        assert.equal(proof.status, 'DONE');
        assert.equal((await db.creatorCampaignFan.findFirst({ where: { creatorId: s.creatorId } })).id, membership.id);
        for (const receipt of before) assert.deepEqual((await receipts(old.job.id)).find(row => row.id === receipt.id), receipt);
        return { legacyPublication: 'REJECTED', protocolSuperseded: true, attempts: 0, oldReceiptsRetained: before.length,
          sameMembershipRetained: true, freshProcess: true, sourceValidationVersion: proof.sourceValidationVersion, providerReads: proof.providerReads };
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    });

    const result = { ok: true, nativePostgres: true, immutableBaselineProducer: true, cases };
    if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally { await legacy.close(); await h.close(); }
}

module.exports = { runCampaignRollout213 };
