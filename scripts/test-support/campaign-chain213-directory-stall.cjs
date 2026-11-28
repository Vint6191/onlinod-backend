'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { createCampaignHarness } = require('./campaign-chain213-backend.cjs');

async function runCampaignDirectoryStall213({ db, desktopRoot, output = null }) {
  const h = await createCampaignHarness({ db, desktopRoot }), cases = [];
  const same = { list: [{ id: 'same-source', name: 'Repeated directory' }], hasMore: true };
  async function releaseAndWait(r) {
    const released = await h.lease.releaseJob({ ...r.credentials, reason: 'provider quantum yield', runAfterMs: 1000 });
    const delay = +new Date(released.retryAt) - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay + 10));
  }
  try {
    const s = await h.scope('campaign213_directory_stall'), r = await h.start(s);
    await h.turn(r, same);
    const repeated = await h.turn(r, same);
    assert.equal(r.checkpoint.jobContinuation.directoryNoProgressPages, 1);
    const replay = await h.progress(r, repeated.step, repeated.expected);
    assert.equal(replay.sideEffect.staleProgress, true);
    assert.equal(r.checkpoint.jobContinuation.directoryNoProgressPages, 1);
    for (const forged of [undefined, 0, 999]) {
      const checkpoint = structuredClone(r.checkpoint);
      if (forged === undefined) delete checkpoint.jobContinuation.directoryNoProgressPages;
      else checkpoint.jobContinuation.directoryNoProgressPages = forged;
      const response = await h.lease.progressJob({ ...r.credentials, expectedContinuation: r.checkpoint, continuation: checkpoint });
      r.checkpoint = response.continuation;
      assert.equal(r.checkpoint.jobContinuation.directoryNoProgressPages, 1);
    }
    const reset = structuredClone(r.checkpoint); reset.jobContinuation.directoryNoProgressPages = 0;
    await assert.rejects(h.lease.renewLease({ ...r.credentials, continuation: reset }),
      error => error.code === 'CAMPAIGN_PROGRESS_ENDPOINT_REQUIRED');
    await h.lease.renewLease(r.credentials);
    assert.equal((await db.jobInstance.findUnique({ where: { id: r.job.id } })).continuation.jobContinuation.directoryNoProgressPages, 1);
    await releaseAndWait(r);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign213-directory-restart-')), proofFile = path.join(temporary, 'proof.json');
    try {
      const script = `
        const assert=require('node:assert/strict'),fs=require('node:fs'),{PrismaClient}=require('@prisma/client');
        const {createCampaignHarness}=require('./scripts/test-support/campaign-chain213-backend.cjs');
        (async()=>{const db=new PrismaClient();let h;try{h=await createCampaignHarness({db,desktopRoot:process.env.NOD_CAMPAIGN_DESKTOP_ROOT});
          const s=JSON.parse(process.env.NOD_CAMPAIGN_SCOPE),r=await h.claim(s,process.env.NOD_CAMPAIGN_JOB);
          assert.equal(r.job.params.collectionGeneration,process.env.NOD_CAMPAIGN_GENERATION);
          assert.equal(r.checkpoint.jobContinuation.directoryNoProgressPages,1);
          const body={list:[{id:'same-source',name:'Repeated directory'}],hasMore:true};await h.turn(r,body);
          assert.equal(r.checkpoint.jobContinuation.directoryNoProgressPages,2);
          const before=structuredClone(r.checkpoint),step=await h.produce(r,body);
          await assert.rejects(h.progress(r,step),e=>e.code==='CAMPAIGN_DIRECTORY_STALLED'&&e.retryable===false&&e.status===409);
          const saved=await db.jobInstance.findUnique({where:{id:r.job.id}});assert.deepEqual(saved.continuation,before);
          assert.equal(await db.analyticsIngestBatch.count({where:{sourceJobId:r.job.id}}),3);
          assert.equal(await db.creatorCampaign.count({where:{creatorId:s.creatorId}}),1);
          const failed=await h.lease.failJob({...r.credentials,expectedContinuation:before,retryable:false,error:'CAMPAIGN_DIRECTORY_STALLED'});
          assert.equal(failed.status,'FAILED');assert.equal(await db.analyticsPublication.count({where:{jobId:r.job.id}}),0);
          const state=await db.creatorCampaignCollectionState.findUnique({where:{creatorId:s.creatorId}});
          assert.equal(state.membershipBaselineGeneration,null);assert.equal(state.campaignDirectoryGeneration,null);
          fs.writeFileSync(process.env.NOD_CAMPAIGN_OUTPUT,JSON.stringify({freshProcess:true,retainedPages:3,retainedCampaigns:1,
            rejectedPageRolledBack:true,sourceComplete:false,status:failed.status,childProviderReads:r.calls.length,pid:process.pid}));
        }finally{if(h)await h.close();await db.$disconnect();}})().catch(e=>{console.error(e.stack);process.exitCode=1});`;
      const child = spawn(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env,
        NOD_CAMPAIGN_DESKTOP_ROOT: desktopRoot, NOD_CAMPAIGN_SCOPE: JSON.stringify(s), NOD_CAMPAIGN_JOB: r.job.id,
        NOD_CAMPAIGN_GENERATION: r.job.params.collectionGeneration, NOD_CAMPAIGN_OUTPUT: proofFile }, stdio: ['ignore', 'pipe', 'pipe'] });
      let diagnostic = ''; child.stdout.on('data', data => { diagnostic += data; }); child.stderr.on('data', data => { diagnostic += data; });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 0, diagnostic);
      const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8')); assert.notEqual(proof.pid, process.pid);
      cases.push({ name: 'Repeated directory pages stay bounded across lost ACK, forged counters, renew, yield and fresh-process reclaim',
        ...proof, providerReads: r.calls.length + proof.childProviderReads });
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }

    const terminalScope = await h.scope('campaign213_directory_terminal'), terminal = await h.start(terminalScope);
    for (let i = 0; i < 3; i++) await h.turn(terminal, same);
    assert.equal(terminal.checkpoint.jobContinuation.directoryNoProgressPages, 2);
    await h.turn(terminal, { list: [], hasMore: false });
    await h.exhaust(terminal, { list: [], hasMore: false });
    const completed = await h.finish(terminal);
    assert.equal(completed.state.membershipBaselineSourceValidationVersion, 1);
    cases.push({ name: 'An explicit exhausted empty page remains valid after tolerated directory overlap', status: completed.job.status,
      directoryCount: completed.state.campaignDirectoryCampaignCount, sourceValidationVersion: 1 });

    const longScope = await h.scope('campaign213_directory_many_unique'); let long = await h.start(longScope);
    const generation = long.job.params.collectionGeneration;
    for (let i = 0; i < 42; i++) {
      if (i && i % 14 === 0) { await releaseAndWait(long); long = await h.claim(longScope, long.job.id); }
      const page = { list: [{ id: String(50000 + i), name: 'Unique source ' + i }], hasMore: true };
      await h.turn(long, page);
      assert.equal(long.checkpoint.jobContinuation.directoryNoProgressPages, 0);
      if (i === 0) {
        await h.turn(long, page); await h.turn(long, page);
        assert.equal(long.checkpoint.jobContinuation.directoryNoProgressPages, 2);
      }
      assert.equal(long.job.params.collectionGeneration, generation);
    }
    await h.turn(long, { list: [], hasMore: false });
    await h.turn(long, () => { throw Error('Directory seal must be provider-free'); });
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: longScope.creatorId } });
    assert.equal(state.campaignDirectoryCampaignCount, 42);
    assert.equal(state.campaignDirectorySourceValidationVersion, 1);
    assert.equal(state.membershipBaselineGeneration, null);
    await h.control.stopManualCampaignScan({ db, creatorId: longScope.creatorId });
    cases.push({ name: 'New identities reset the overlap counter; 42 unique pages across lease handoffs have no catalog cap',
      uniqueCampaigns: 42, directoryPages: state.campaignProofCampaignBatches, directoryValidated: true, membershipInvented: false });
    const result = { ok: true, nativePostgres: true, cases };
    if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally { await h.close(); }
}

module.exports = { runCampaignDirectoryStall213 };
