'use strict';
// Execute production functions. Database/clock adapters are explicit doubles;
// this is not a PostgreSQL integration test.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = process.env.ONLINOD_CAMPAIGN_TEST_SOURCE || __dirname;
const test = require('node:test');
const freshness = require('./campaign-freshness-service');
function load(name, mocks = {}) {
  const file = path.join(root, name + '.js'), native = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : native(id), Date, Buffer, console, process }, { filename: file });
  return module.exports;
}
const now = new Date('2026-10-02T12:00:00Z'), observed = new Date(+now - 3 * 3600000);
const clock = { dbAuthorityNow: async () => now };
const control = load('analytics-collector-control-service', { '../prisma': {}, './db-time-authority-service': clock });
const shared = { '../prisma': {}, './db-time-authority-service': clock, './analytics-collector-control-service': control };
const scheduled = [];
const orchestrator = load('creator-analytics-sync-orchestrator', { ...shared,
  './notification-sync-state-service': { loadNotificationSyncState: async () => ({ fullBackfillVerifiedAt: now, fullBackfillObservedAt: now }) },
  './financial-transactions-service': { JOB_KEY: 'financial_transactions_scan' },
  './job-scheduler': { scheduleJobNow: async input => { scheduled.push(input); return { created: true }; } },
});
function state(overrides = {}) { return {
  id: 'state', agencyId: 'agency', creatorId: 'creator', status: 'COMPLETE', mode: 'catchup',
  activeGeneration: 'old', activeRequestedAt: observed, baselineGeneration: 'baseline', baselineVerifiedAt: observed,
  baselineObservedAt: observed, lastCatchupCompletedAt: observed, lastCatchupObservedAt: observed,
  membershipCoverageStatus: 'COMPLETE', membershipObservedAt: observed,
  campaignDirectoryGeneration: 'directory', campaignDirectoryRequestedAt: observed,
  campaignDirectoryVerifiedAt: observed, campaignDirectoryRevision: 1, campaignDirectoryCampaignCount: 1,
  campaignDirectoryDiscoveryDueAt: new Date(+observed + 72 * 3600000),
  campaignFrontierPlanRunId: 'old', campaignFrontierFreshnessStatus: 'COMPLETE',
  campaignFrontierObservationVersion: 1,
  campaignFrontierNextDueAt: new Date(+observed + 6 * 3600000),
  campaignFrontierDueCount: 1, campaignFrontierTargetCount: 1, campaignFrontierCompletedCount: 1,
  campaignFrontierDeferredCount: 0, fanValueCoverageScanRunId: 'old', fanValueExpected: 0,
  fanValueFreshnessStatus: 'COMPLETE', fanValueFailed: 0, fanValueOutstanding: 0,
  campaignProofScanRunId: 'old', campaignProofCollectorVersion: 'campaigns-v13',
  campaignProofCampaignBatches: 1, campaignProofClaimerBatches: 1,
  ...overrides,
}; }
const financial = { status: 'COMPLETE', baselineGeneration: 'financial', baselineVerifiedAt: now, baselineObservedAt: now };
const read = load('campaign-read-repository');
async function comparison(legacy) {
  scheduled.length = 0;
  const current = state(legacy ? { baselineObservedAt: null, lastCatchupObservedAt: null, campaignFrontierObservationVersion: 0 } : {});
  const db = { creatorCampaignCollectionState: { findUnique: async () => structuredClone(current) },
    creatorFinancialCollectionState: { findUnique: async () => financial },
    creatorCampaign: { findMany: async () => [] }, jobInstance: { findFirst: async () => null, findMany: async () => [] },
    $queryRawUnsafe: async () => [{ empty: true }], $executeRawUnsafe: async () => 1 };
  db.$transaction = async work => { const tx = { ...db }; delete tx.$transaction; return work(tx); };
  const page = await read.readCampaignPage({ db, creatorId: 'creator', now });
  const plan = await orchestrator.ensureRecurringCreatorAnalyticsCatchups({ db, creatorId: 'creator', agencyId: 'agency', now });
  return { legacy, coverage: page.sourceCoverage.campaigns, skipped: plan.skipped, scheduled: scheduled.map(j => j.jobKey), commands: scheduled.map(j => j.params) };
}

function matches(row, where = {}) {
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'OR') return wanted.some(item => matches(row, item));
    if (key.includes('_') && !Object.hasOwn(row, key)) return matches(row, wanted);
    const value = row[key];
    if (wanted instanceof Date) return +value === +wanted;
    if (wanted && typeof wanted === 'object') return Object.entries(wanted).every(([op, v]) => {
      if (op === 'in') return v.includes(value);
      if (op === 'lte') return value != null && value <= v;
      if (op === 'lt') return value != null && value < v;
      if (op === 'gt') return value != null && value > v;
      throw new Error('Unsupported predicate: ' + op);
    });
    return value === wanted;
  });
}
function fixture({ versions = [1], count = versions.length, budget = 50 } = {}) {
  let current = state({ campaignDirectoryCampaignCount: count }), at = new Date(now);
  const batches = [], operations = [];
  const rows = versions.map((version, i) => ({ id: 'campaign-' + i, agencyId: 'agency', creatorId: 'creator',
    externalCampaignId: String(i + 1), isActive: true, claimerRevision: 1, claimerVerifiedRevision: 1,
    claimersObservationVersion: version, claimersVerifiedAt: observed, claimersNextDueAt: new Date(+observed + 6 * 3600000),
    sourceScanRunId: 'directory', sourceScanStartedAt: observed, claimersTargetRunId: null }));
  const query = ({ where = {}, orderBy = [], take = Infinity } = {}) => {
    const selected = rows.filter(row => matches(row, where));
    selected.sort((a,b) => {
      for (const order of (Array.isArray(orderBy)?orderBy:[orderBy])) for (const [key, direction] of Object.entries(order)) {
        const av=a[key], bv=b[key];
        const n=av==null?(bv==null?0:1):bv==null?-1:av<bv?-1:av>bv?1:0;
        if(n)return direction==='desc'?-n:n;
      }
      return 0;
    });
    return selected.slice(0,take);
  };
  const tx = { $executeRawUnsafe: async sql => { operations.push(String(sql)); return 1; }, $queryRawUnsafe: async () => [],
    creatorCampaignCollectionState: {
      findUnique: async () => structuredClone(current),
      upsert: async ({ update }) => { Object.assign(current, update); return structuredClone(current); },
      update: async ({ data }) => { Object.assign(current, data); return structuredClone(current); },
    },
    creatorCampaign: {
      count: async args => query(args).length,
      findMany: async args => { if(args.where.OR) assert(args.take<=budget); return structuredClone(query(args)); },
      findFirst: async args => structuredClone(query(args)[0] || null),
      findUnique: async ({where}) => structuredClone(rows.find(row=>matches(row,where)) || null),
      update: async ({where,data}) => { const row=rows.find(r=>matches(r,where)); assert(row); Object.assign(row,data); return structuredClone(row); },
      updateMany: async ({where,data}) => { const found=rows.filter(r=>matches(r,where)); found.forEach(r=>Object.assign(r,data)); return {count:found.length}; },
    },
    creatorCampaignFrontierFan: { findMany: async () => [], deleteMany: async () => ({count:0}), createMany: async () => ({count:0}) },
    analyticsIngestBatch: {
      findUnique: async ({where}) => structuredClone(batches.find(b=>matches(b,where)) || null),
      create: async ({data}) => { const row={id:'batch-'+batches.length,...structuredClone(data)}; batches.push(row); return structuredClone(row); },
      update: async ({where,data}) => { const row=batches.find(b=>matches(b,where)); assert(row); Object.assign(row,structuredClone(data)); return structuredClone(row); },
    },
  };
  const db = { ...tx, $transaction: async work => work(tx) };
  const localClock = { dbAuthorityNow: async () => new Date(at) };
  const localControl = load('analytics-collector-control-service', { '../prisma': {}, './db-time-authority-service': localClock });
  const activation = load('campaign-causal-activation-service', {'../prisma': {}});
  const queue = load('campaign-fan-refresh-queue-service', {'../prisma': {}});
  const modules = {...shared, './analytics-collector-control-service':localControl, './db-time-authority-service':localClock,
    './creator-analytics-projection-service': {}, './fan-data-authority-service': {}, './fan-observation-token-service': {},
    './campaign-causal-activation-service':activation, './campaign-fan-refresh-queue-service':queue};
  const ledger = () => load('creator-analytics-ledger-service',modules);
  const params = {...localControl.buildCollectionCommand({collectorType:'CAMPAIGNS',collectionMode:'catchup',now}),
    ...orchestrator.campaignDirectoryReuseBinding(current,now), campaignMode:'catchup',campaignFrontierSchedulingVersion:1,
    campaignDirectoryReuseVersion:1, campaignFrontierBudget:budget, analyticsObservationStartedAt:now.toISOString()};
  const job = {id:'job',jobKey:'fetch_campaigns',agencyId:'agency',creatorId:'creator',params,
    continuation:{driverPhase:'execute',jobContinuation:{collectorVersion:'campaigns-v13',scanRunId:params.collectionGeneration,
      phase:'segment',directorySourceExhausted:true,campaignPagesComplete:true,truncated:false,
      campaignBatchCount:0,claimerBatchCount:0,segmentCursor:null}}};
  const segment = () => ledger().loadCampaignDirectorySegment({db,job,chunk:{kind:'campaign_directory_segment',schemaVersion:4,
    collectorVersion:'campaigns-v13',scanRunId:params.collectionGeneration,cursor:null}});
  const completion = override => ledger().completeCampaignScan({db,job,result:{schemaVersion:4,collectorVersion:'campaigns-v13',
    scanRunId:params.collectionGeneration,campaignBatchCount:0,claimerBatchCount:0,campaignCount:count,
    campaignPagesComplete:true,claimersComplete:true,truncated:false,...override}});
  const page = (externalCampaignId='1') => ({kind:'campaign_claimers_page',schemaVersion:4,collectorVersion:'campaigns-v13',
    scanRunId:params.collectionGeneration,batchKey:`run:${params.collectionGeneration}:claimers:${externalCampaignId}:1`,
    externalCampaignId,pageNumber:1,campaignMode:'catchup',campaignComplete:true,sourceHasMore:false,scannerRejected:0,claimers:[]});
  return {db,job,rows,batches,operations,ledger,segment,completion,page,get state(){return current;},
    restart(){current=structuredClone(current);},setClock(value){at=new Date(value);}};
}

test('Campaign reader and planner share the independent directory/frontier deadlines',async()=>{
  const r=await comparison(false);
  assert.equal(r.coverage.fresh,true);assert(r.skipped.includes('campaigns_catchup:fresh'));assert.equal(r.scheduled.length,0);
});
test('Legacy complete state stays usable and requests bounded reuse instead of FULL',async()=>{
  const r=await comparison(true);
  assert.equal(r.coverage.proven,true);assert.equal(r.coverage.fresh,false);assert.equal(r.coverage.due,true);
  assert.deepEqual(r.scheduled,['fetch_campaigns']);
  assert.equal(r.commands[0].collectionMode,'catchup');assert.equal(r.commands[0].campaignDirectoryReuseGeneration,'directory');
  assert.equal(r.commands[0].campaignFrontierBudget,50);
});
for(const [label,patch] of [
  ['deadline',{campaignFrontierNextDueAt:now}],['missing deadline',{campaignFrontierNextDueAt:null}],
  ['generation',{campaignFrontierPlanRunId:'another'}],['legacy',{campaignFrontierObservationVersion:0}],
  ['unfinished tranche',{campaignFrontierCompletedCount:0}],['deferred tranche',{campaignFrontierDeferredCount:1}],
])test('Reader and planner both reject '+label,()=>{
  const row=state(patch),e=freshness.evaluateCampaignCollectionState(row,now);
  assert.equal(e.fresh,false);assert.equal(e.due,true);assert.equal(orchestrator.campaignFrontierWorkDue(row,now),true);
});
test('Empty directory can lack a frontier deadline but still expires at the directory boundary',()=>{
  const row=state({campaignDirectoryCampaignCount:0,campaignFrontierNextDueAt:null});
  assert.equal(freshness.evaluateCampaignCollectionState(row,now).fresh,true);
  assert.equal(freshness.evaluateCampaignCollectionState(row,new Date(+observed+72*3600000)).fresh,false);
});
test('Delegated debt suppresses duplicate provider work and never reads as fresh',()=>{
  const row=state({fanValueExpected:2,fanValueOutstanding:1,fanValueFreshnessStatus:'QUEUED'});
  const e=freshness.evaluateCampaignCollectionState(row,now);
  assert.equal(e.fresh,false);assert.equal(e.due,false);assert.equal(e.fanRefreshPending,true);
});
for(const count of [0,1])test('Server-planned zero-target reuse survives restart/replay without renewing observation, count='+count,async()=>{
  const f=fixture({versions:count?[1]:[]});
  await f.segment();f.restart();const first=await f.completion();
  assert.equal(first.complete,true);assert.equal(first.providerTraversalComplete,true);
  assert.equal(+f.state.lastCatchupObservedAt,+observed);assert.equal(+f.state.membershipObservedAt,+observed);
  assert.equal(+f.state.campaignDirectoryVerifiedAt,+observed);
  const bounds=['lastCatchupCompletedAt','lastCatchupObservedAt','membershipObservedAt','campaignDirectoryVerifiedAt','campaignFrontierNextDueAt'];
  const before=bounds.map(key=>f.state[key]?.toISOString()||null);
  f.restart();f.setClock(new Date(+now+3600000));await f.completion();
  assert.deepEqual(bounds.map(key=>f.state[key]?.toISOString()||null),before);
});
test('A client zero-page completion without the server plan is not proof',async()=>{
  const f=fixture();const r=await f.completion();assert.equal(r.providerTraversalComplete,false);
  assert.equal(r.complete,false);assert.equal(+f.state.lastCatchupObservedAt,+observed);
});
test('Wrong page counters cannot borrow the server empty proof',async()=>{
  const f=fixture();await f.segment();const r=await f.completion({claimerBatchCount:1});
  assert.equal(r.providerTraversalComplete,false);assert.equal(+f.state.lastCatchupObservedAt,+observed);
});
test('Revision change after segment prevents publication',async()=>{
  const f=fixture();await f.segment();f.state.campaignDirectoryRevision=2;
  const r=await f.completion();assert.equal(r.providerTraversalComplete,false);assert.equal(+f.state.lastCatchupObservedAt,+observed);
});
test('Legacy rows with future receipt deadlines consume only one frontier budget',async()=>{
  const f=fixture({versions:[0,0,0,1],budget:2});const r=await f.segment();
  assert.equal(f.state.campaignFrontierDueCount,3);assert.equal(f.state.campaignFrontierTargetCount,2);
  assert.equal(f.state.campaignFrontierDeferredCount,1);assert.equal(r.campaignDirectorySegment.campaigns.filter(c=>c.scanClaimers).length,2);
  f.state.campaignProofClaimerBatches=1;const selected=f.rows.map(row=>row.claimersTargetRunId);
  f.restart();await f.segment();assert.deepEqual(f.rows.map(row=>row.claimersTargetRunId),selected);
  assert.equal(f.state.campaignProofClaimerBatches,1);
});
test('A verified claimer terminal-page replay works after the target is cleared',async()=>{
  const f=fixture({versions:[0]});f.rows[0].claimersNextDueAt=new Date(now);await f.segment();const chunk=f.page();
  const first=await f.ledger().ingestCampaignChunk({db:f.db,job:f.job,chunk});
  assert.equal(first.campaignComplete,true);
  if(!process.env.ONLINOD_CAMPAIGN_TEST_SOURCE)assert.equal(f.rows[0].claimersObservationVersion,1);
  assert.equal(+f.rows[0].claimersVerifiedAt,+now);assert.equal(f.rows[0].claimersTargetRunId,null);
  const count=f.state.campaignFrontierCompletedCount,proof=f.state.campaignProofClaimerBatches;
  f.restart();const replay=await f.ledger().ingestCampaignChunk({db:f.db,job:f.job,chunk});
  assert.equal(replay.replay,true);assert.equal(f.state.campaignFrontierCompletedCount,count);
  assert.equal(f.state.campaignProofClaimerBatches,proof);
  await assert.rejects(()=>f.ledger().ingestCampaignChunk({db:f.db,job:f.job,chunk:{...chunk,scannerRejected:1}}),/idempotency conflict/);
  const completed=await f.completion({claimerBatchCount:1});assert.equal(completed.complete,true);
});
test('Delayed claimer completion carries its original age into planner and reader',async()=>{
  const f=fixture({versions:[0]});await f.segment();f.setClock(new Date(+now+7*3600000));
  await f.ledger().ingestCampaignChunk({db:f.db,job:f.job,chunk:f.page()});
  const r=await f.completion({claimerBatchCount:1});assert.equal(r.complete,true);
  const late=new Date(+now+7*3600000);assert.equal(freshness.evaluateCampaignCollectionState(f.state,late).fresh,false);
  assert.equal(orchestrator.campaignFrontierWorkDue(f.state,late),true);
  assert.equal(+f.rows[0].claimersNextDueAt,+now+6*3600000);
});

test('Replay after a newer generation acknowledges only its receipt and cannot reactivate old state',async()=>{
  const f=fixture({versions:[0]});await f.segment();const chunk=f.page();
  await f.ledger().ingestCampaignChunk({db:f.db,job:f.job,chunk});
  Object.assign(f.state,{activeGeneration:'new-generation',activeRequestedAt:new Date(+now+3600000),campaignDirectoryRevision:2});
  const before=JSON.stringify(f.state);f.restart();
  const replay=await f.ledger().ingestCampaignChunk({db:f.db,job:f.job,chunk});
  assert.equal(replay.replay,true);assert.equal(JSON.stringify(f.state),before);
  f.batches[0].agencyId='foreign-agency';
  await assert.rejects(()=>f.ledger().ingestCampaignChunk({db:f.db,job:f.job,chunk}),/RECEIPT_SCOPE_MISMATCH/);
});
test('A 4000-campaign legacy directory keeps the same 50-target/50-segment bounds',async()=>{
  const f=fixture({versions:Array(4000).fill(0)});const r=await f.segment();
  assert.equal(f.state.campaignFrontierDueCount,4000);assert.equal(f.state.campaignFrontierTargetCount,50);
  assert.equal(f.state.campaignFrontierDeferredCount,3950);
  assert.equal(f.rows.filter(row=>row.claimersTargetRunId).length,50);
  assert.equal(r.campaignDirectorySegment.campaigns.length,50);assert.equal(r.campaignDirectorySegment.hasMore,true);
});
test('Observation marker does not acquire an activation-row lock inside a Campaign segment',async()=>{
  const f=fixture();await f.segment();
  assert(f.operations.includes("SELECT set_config('onlinod.campaign_observation_version', '1', true)"));
  const activation=load('campaign-causal-activation-service',{'../prisma':{}}),calls=[];
  await activation.enterCampaignObservationWriter({db:{$executeRawUnsafe:async sql=>calls.push(sql),
    $queryRawUnsafe:async()=>{throw new Error('Activation lock order reversed');}}});
  assert.deepEqual(calls,["SELECT set_config('onlinod.campaign_observation_version', '1', true)"]);
});
test('Postflight rejects missing, disabled and mismatched rolling-deploy guards',async()=>{
  const {verify,SPECS}=require('../../scripts/database/campaign-observation-postflight');
  const rows=SPECS.map(s=>({name:s.fn+'_trg',table:s.table,fn:s.fn,enabled:'O',columns:[...s.columns],
    definition:'BEFORE INSERT OR UPDATE OF fields FOR EACH ROW',body:`IF current_setting('onlinod.campaign_observation_version', true) IS DISTINCT FROM '1' THEN NEW."${s.column}" := 0; END IF;`}));
  assert.equal((await verify({$queryRawUnsafe:async()=>rows})).ready,true);
  for(const invalid of [[],[{...rows[0],enabled:'D'},rows[1]],[{...rows[0],columns:[]},rows[1]],
    [{...rows[0],body:'RETURN NEW;'},rows[1]],[{...rows[0],table:'foreign'},rows[1]]]){
    await assert.rejects(()=>verify({$queryRawUnsafe:async()=>invalid}),/CAMPAIGN_OBSERVATION_FENCE_INVALID/);
  }
});
