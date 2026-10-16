'use strict';
// Real current-schema SQL + Prisma + Desktop payout collector. Provider data is
// synthetic; no production database, credentials or local message archive.
const assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { fixture, scope } = require('./analytics-traffic/fixture.cjs');
const root = path.resolve(__dirname, '../..'), desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT || path.join(root, '../desktop'));
const keepAlive = setInterval(() => {}, 1000), deadline = setTimeout(() => { console.error('CATCHUP_PROOF_DEADLINE'); process.exit(2); }, 300000);
const checks = [], pass = name => { checks.push(name); console.log('PASS', name); };
(async () => {
  const { financialTransactionsHandler } = await import(pathToFileURL(path.join(desktop, 'apps/desktop/dist/electron/main/services/backend-jobs/handlers/financial-transactions-handler.js')));
  const f = await fixture();
  try {
    const { db } = f, s = await scope(db), now = new Date(Math.floor(Date.now()/1000)*1000), day = 86400000, ago = n => new Date(+now-n*day);
    require.cache[require.resolve(path.join(root, 'src/prisma'))] = { exports: db };
    const kernel = require(path.join(root, 'src/services/db-commit-kernel'));
    const collection = require(path.join(root, 'src/services/analytics-collector-control-service'));
    const authority = require(path.join(root, 'src/services/financial-receipt-authority'));
    const publication = require(path.join(root, 'src/services/analytics-publication-service'));
    const lease = require(path.join(root, 'src/services/job-lease-service'));
    const projection = require(path.join(root, 'src/services/campaign-read-projection-service'));
    const read = require(path.join(root, 'src/services/campaign-read-repository'));
    const write = fn => kernel.runRootCommit(db, async ({tx}) => {
      await require(path.join(root, 'src/services/campaign-causal-activation-service')).enterCampaignWriterGeneration({db:tx});
      await authority.enter(tx);
      return fn(tx);
    }, {profile:'JOB_CHUNK'});
    await db.agency.update({where:{id:s.agencyId},data:{trialEndsAt:new Date(+now+day)}});
    const deviceId='catchup-device';
    await db.workerDevice.create({data:{id:deviceId,agencyId:s.agencyId,userId:s.userId,lastSeenAt:now}});
    const member=await db.agencyMember.findUnique({where:{id:'member-'+s.agencyId}});
    const source=[
      {id:'before-offline',createdAt:ago(120).toISOString(),amount:25,net:20,type:'message',status:'done',user:{id:'42',username:'fixture_fan'}},
      {id:'during-offline',createdAt:ago(45).toISOString(),amount:100,net:80,type:'tip',status:'done',user:{id:'42',username:'fixture_fan'}},
      {id:'recent',createdAt:ago(1).toISOString(),amount:50,net:40,type:'message',status:'loading',user:{id:'42',username:'fixture_fan'}},
    ];
    let sequence=0;
    async function collect(mode, observedAt, {mismatch=false}={}) {
      const id='financial-proof-'+(++sequence), previous=await db.creatorFinancialCollectionState.findUnique({where:{creatorId:s.creatorId}});
      let job={id,agencyId:s.agencyId,creatorId:s.creatorId,jobKey:'financial_transactions_scan',scope:'CREATOR',
        params:collection.stampCollectionAuthorityParams({...collection.buildCollectionCommand({collectorType:'FINANCIAL',collectionMode:mode,now:observedAt}),startDate:'2016-01-01 00:00:00'},observedAt,previous?.activeRequestedAt)};
      job.params=await authority.claimParams(db,job);
      const token='token-'+id;
      job=await write(tx=>tx.jobInstance.create({data:{...job,status:'CLAIMED',startedAt:observedAt,claimedAt:new Date(),claimedByDeviceId:deviceId,
        leaseUntil:new Date(Date.now()+600000),leaseRevision:1,leaseTokenHash:crypto.createHash('sha256').update(token).digest('hex'),
        leaseMemberId:member.id,leaseAccessEpoch:member.accessEpoch,continuation:authority.envelope(job,authority.initialCursor(job))}}));
      const transport={jobId:id,userId:s.userId,deviceId,leaseToken:token,leaseRevision:1};
      for(let turn=0;turn<30;turn++) {
        const expected=structuredClone(job.continuation), cursor=expected.jobContinuation, window=job.params.financialWindows[cursor.windowIndex];
        const rows=source.filter(row=>Date.parse(row.createdAt)>=Date.parse(window.from)&&Date.parse(row.createdAt)<=Date.parse(window.to));
        const chunk=await financialTransactionsHandler.runChunk({job,creatorId:s.creatorId,continuation:structuredClone(cursor),signal:new AbortController().signal,
          ofApi:{request:async request=>{
            if(request.source.endsWith('.payouts'))return{ok:true,status:200,data:{list:rows,hasMore:false}};
            const category=request.source.split('.').at(-1),key=category==='messages'?'chat_messages':category;
            const accepted=rows.filter(row=>row.status!=='undo'&&(category==='total'||(category==='messages'&&row.type==='message')||(category==='tips'&&row.type==='tip')));
            return{ok:true,status:200,data:{[key]:{gross:accepted.reduce((sum,row)=>sum+row.amount,0),total:accepted.reduce((sum,row)=>sum+row.net,0)+(mismatch&&category==='total'?1:0),count:accepted.length}}};
          }}});
        const input={...transport,expectedContinuation:expected,chunkResult:chunk.chunkResult,continuation:chunk.continuation,progress:chunk.progress};
        const committed=await lease.progressJob(input);
        if(turn===0) {
          const count=await db.creatorFinancialTransaction.count();
          const duplicate=await lease.progressJob(input);assert.equal(duplicate.sideEffect.staleProgress,true);assert.equal(await db.creatorFinancialTransaction.count(),count);
          assert.deepEqual(await authority.restoreContinuation(db,job),committed.continuation);
        }
        job=await db.jobInstance.findUnique({where:{id}});
        if(chunk.outcome==='done') {
          const receipt=await lease.completeJob({...transport,result:chunk.result,progress:chunk.progress});
          for(let publishTurn=0;publishTurn<30;publishTurn++) {
            await publication.runAnalyticsPublicationUnit({db,publicationId:receipt.publicationId});
            const row=await db.analyticsPublication.findUnique({where:{id:receipt.publicationId}});
            if(row.state!=='PENDING') {
              const completed=await db.jobInstance.findUnique({where:{id}});
              return{result:completed.result.completionSideEffect,job};
            }
            await new Promise(resolve=>setTimeout(resolve,30));
          }
          throw Error('financial publication did not finish');
        }
      }
      throw Error('collector did not finish');
    }
    async function drain() {
      for(let i=0;i<100;i++) {
        const result=await projection.runCampaignProjectionSweep({db});assert.equal(result.ok,true);
        if((await read.readiness(db,s.creatorId,new Date())).ready)return;
      }
      throw Error('projection did not drain');
    }
    const page=rangeKey=>read.readCampaignPage({db,creatorId:s.creatorId,rangeKey,now:new Date()});
    assert.equal((await collect('full',ago(90))).result.complete,true);
    const fan=await db.creatorFan.findUnique({where:{creatorId_onlyFansUserId:{creatorId:s.creatorId,onlyFansUserId:'42'}}});assert(fan);
    await write(async tx=>{
      await tx.creatorCampaign.create({data:{id:'campaign',agencyId:s.agencyId,creatorId:s.creatorId,externalCampaignId:'source-campaign',name:'Recovery fixture'}});
      await tx.creatorCampaignFan.create({data:{id:'membership',agencyId:s.agencyId,creatorId:s.creatorId,campaignId:'campaign',fanRecordId:fan.id,attributedAt:ago(150)}});
      await require('../test-support/campaign-read-coverage-fixture.cjs').seedCoverage(tx,s,{kind:'CAMPAIGNS',now});
    });
    await drain();assert.equal((await page('all')).totals.netCents,2000);assert.equal((await page('30d')).totals.netCents,null);
    pass('Desktop payout -> leased page -> canonical fan -> campaign revenue works without a message database');
    let turns=0;
    do {
      const {result,job}=await collect('catchup',now);assert.equal(result.complete,true);assert.equal(job.params.financialWindows[1].kind,'GAP');turns++;
      await drain();
      if(turns===1) {
        const incomplete=await page('30d');assert.equal(incomplete.totals.netCents,null);assert.equal(incomplete.totals.knownNetCents,4000);
        assert.equal(incomplete.sourceCoverage.revenue.reason,'FINANCIAL_RANGE_GAP');assert.equal((await page('7d')).totals.netCents,4000);
        pass('new head after 90 offline days never claims the uncollected 30-day gap is complete');
      }
      const state=await db.creatorFinancialCollectionState.findUnique({where:{creatorId:s.creatorId}});
      if(authority.coverageView(state,new Date()).continuous)break;
      assert(turns<5);
    }while(true);
    assert.equal(turns,3);assert.equal(await db.creatorFinancialTransaction.count(),3);
    const complete=await page('all');assert.equal(complete.totals.netCents,14000);assert.equal(complete.totals.payingFans,1);
    assert.equal((await page('90d')).totals.netCents,12000);assert.equal((await page('30d')).totals.netCents,4000);
    pass('three bounded catch-up segments close the whole gap with exact cents and no replay duplicates');
    const before=await db.creatorFinancialCollectionState.findUnique({where:{creatorId:s.creatorId}});
    assert.equal((await collect('catchup',now,{mismatch:true})).result.complete,false);
    const failed=await db.creatorFinancialCollectionState.findUnique({where:{creatorId:s.creatorId}});
    assert.equal(+failed.coverageThrough,+before.coverageThrough);assert.equal(+failed.lastCatchupObservedAt,+before.lastCatchupObservedAt);
    await drain();assert.equal((await page('all')).totals.netCents,14000);
    pass('chart mismatch cannot move verified coverage or erase the collected campaign subtotal');
    source[2].status='undo';assert.equal((await collect('catchup',now)).result.complete,true);await drain();
    assert.equal((await page('30d')).totals.netCents,0);assert.equal((await page('30d')).totals.payingFans,0);
    assert.equal((await page('all')).totals.netCents,10000);assert.equal(await db.creatorFinancialTransaction.count(),3);
    pass('re-observed refund retracts NET and payer once; genuine zero remains distinguishable from missing data');
    console.log(JSON.stringify({ok:true,checks:checks.length,catchupSegments:turns,runtime:process.version,provider:'synthetic',sql:'PGlite + Prisma'}));
  } finally {await f.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{clearInterval(keepAlive);clearTimeout(deadline);});
