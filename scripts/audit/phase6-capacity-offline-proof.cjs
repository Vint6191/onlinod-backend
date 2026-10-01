"use strict";
// ONLY in-memory PostgreSQL WASM. Never reads DATABASE_URL or contacts a server.
// ONLINOD_PGLITE_MODULE=/path/to/@electric-sql/pglite node --test scripts/audit/phase6-capacity-offline-proof.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require(process.env.ONLINOD_PGLITE_MODULE || "@electric-sql/pglite");
const debt = require("../../src/services/provider-capacity-debt-authority-service");
const projection = require("../../src/services/provider-capacity-projection-service");
const ROOT = path.resolve(__dirname, "../..");
const migration = fs.readFileSync(path.join(ROOT, "prisma/migrations/20260929150000_phase6_capacity_incremental_v1/migration.sql"), "utf8");
const baseline = fs.readFileSync(path.join(ROOT, "test/fixtures/phase6-capacity-I7-baseline.sql"), "utf8");
const normalize = (values) => values.map((v) => typeof v === "bigint" ? String(v) : v);
async function fixture(t, beforeMigration) {
  const pg = new PGlite(); await pg.waitReady;
  t.after(() => pg.close());
  await pg.exec(baseline);
  if (beforeMigration) await beforeMigration(pg);
  await pg.exec(migration);
  await pg.exec(fs.readFileSync(path.join(ROOT, "prisma/migrations/20261001003000_capacity_catalog_traffic_retirement_v1/migration.sql"), "utf8"));
  const calls = [];
  const db = { async $transaction(work) { return pg.transaction(async (client) => {
    const tx = {
      async $queryRawUnsafe(sql, ...params) { calls.push({ sql, params }); return (await client.query(sql, normalize(params))).rows; },
      async $executeRawUnsafe(sql, ...params) { calls.push({ sql, params }); return (await client.query(sql, normalize(params))).affectedRows || 0; },
    };
    return work(tx);
  }); }};
  const refresh = (options = {}) => debt.refreshProviderCapacityDebtSnapshot({ db, ...options });
  const snapshot = async () => (await pg.query('SELECT * FROM "ProviderCapacityDebtState"')).rows[0];
  return { pg, db, calls, refresh, snapshot };
}
async function fan(pg, id, requested = 1, satisfied = 0) {
  await pg.query(`INSERT INTO "CreatorFanRefreshDemand" (id,"agencyId","creatorId","onlyFansUserId","requestedFreshnessCutoffAt","requestedRevision","satisfiedRevision","updatedAt") VALUES ($1::text,'a','c',$1::text,clock_timestamp(),$2,$3,clock_timestamp())`, [id, requested, satisfied]);
}
async function directory(pg, id, dueAt, count = 100) {
  await pg.query(`INSERT INTO "CreatorCampaignCollectionState" (id,"agencyId","creatorId","baselineVerifiedAt","campaignDirectoryDiscoveryDueAt","campaignDirectoryCampaignCount","updatedAt") VALUES ($1,'a',$1,clock_timestamp(),$2,$3,clock_timestamp())`, [id, dueAt, count]);
}
async function job(pg, id, key, status) {
  await pg.query(`INSERT INTO "JobInstance" (id,"jobKey",scope,status,"updatedAt") VALUES ($1,$2,'creator',$3,clock_timestamp())`, [id,key,status]);
}
async function drain(fx, batchSize = 96, max = 200) {
  for (let n=1;n<=max;n++) { const r=await fx.refresh({batchSize}); if(r.projectionComplete) return {turns:n,result:r}; }
  throw Error("fixture did not converge");
}
function lower(row) { return [row.campaignDirectoryDueCreators, row.campaignDirectoryOverdueCreators, String(row.campaignDirectoryRequiredCalls), String(row.fanDataUnsatisfiedDemands), row.fanDataPendingJobs, row.backgroundOtherPendingJobs, row.backgroundOtherPendingJobClasses]; }

test("B1 SQL: populated I7 upgrade; bounded restartable bootstrap stays conservative", async (t) => {
  const fx = await fixture(t, async (pg) => {
    for (let i=0;i<17;i++) await fan(pg,`f${String(i).padStart(3,'0')}`);
    await directory(pg,'d','2000-01-01T00:00:00Z'); await job(pg,'j1','fetch_earnings','PAUSED');
  });
  const first = await fx.refresh({batchSize:6});
  assert.equal(first.projectionComplete,false); assert.equal(first.computed.status,'UNKNOWN');
  assert.equal(first.computed.controlMode,'CONSERVATIVE'); assert.ok(first.scanned<=6); assert.ok(first.processed<=6);
  await fan(fx.pg,'f-older-than-cursor'); await drain(fx,6);
  const saved=await fx.snapshot(); assert.equal(String(saved.fanDataUnsatisfiedDemands),'18');
  assert.equal(saved.backgroundOtherPendingJobs,1); assert.equal(saved.projectionCoverageStatus,'COMPLETE_AT_SAMPLE');
  assert.equal(saved.status,'UNKNOWN'); // other jobs' call cardinality is still unknown
  assert.ok(fx.calls.filter(c=>/^SELECT "id" FROM/.test(c.sql)).every(c=>/LIMIT/.test(c.sql)));
});

test("B1 SQL: duplicate repair, satisfaction, deletion and job-class changes apply exact deltas", async (t) => {
  const fx=await fixture(t); await fan(fx.pg,'f'); await job(fx.pg,'j','fetch_earnings','SCHEDULED');
  await drain(fx); assert.equal(String((await fx.snapshot()).fanDataUnsatisfiedDemands),'1');
  await fx.pg.exec(`UPDATE "CreatorFanRefreshDemand" SET "requestedRevision"="requestedRevision" WHERE id='f'; UPDATE "JobInstance" SET "jobKey"='dialog_intelligence_scan' WHERE id='j'`);
  await drain(fx); const second=await fx.snapshot(); assert.equal(String(second.fanDataUnsatisfiedDemands),'1'); assert.equal(second.backgroundOtherPendingJobs,1); assert.equal(second.backgroundOtherPendingJobClasses,1);
  await fx.pg.exec(`UPDATE "CreatorFanRefreshDemand" SET "satisfiedRevision"=1 WHERE id='f'; DELETE FROM "JobInstance" WHERE id='j'`);
  await drain(fx); const third=await fx.snapshot(); assert.equal(String(third.fanDataUnsatisfiedDemands),'0'); assert.equal(third.backgroundOtherPendingJobs,0); assert.equal(third.status,'HEALTHY');
  assert.equal((await fx.pg.query('SELECT * FROM "ProviderCapacityContribution"')).rows.length,0);
});

test("B1 SQL: canonical+dirty rollback together; id rewrite retracts old identity", async (t) => {
  const fx=await fixture(t); await fan(fx.pg,'f'); await drain(fx);
  await assert.rejects(fx.pg.transaction(async(tx)=>{await tx.query(`UPDATE "CreatorFanRefreshDemand" SET "requestedRevision"=99 WHERE id='f'`);throw Error('rollback');}),/rollback/);
  assert.equal((await fx.pg.query('SELECT * FROM "ProviderCapacityDirty"')).rows.length,0);
  await fx.pg.exec(`UPDATE "CreatorFanRefreshDemand" SET id='f-new' WHERE id='f'`); await drain(fx);
  assert.equal(String((await fx.snapshot()).fanDataUnsatisfiedDemands),'1');
  assert.deepEqual((await fx.pg.query('SELECT "sourceId" FROM "ProviderCapacityContribution"')).rows.map(r=>r.sourceId),['f-new']);
});

test("B1 SQL: publication failure rolls back projection, dirty deletion and cursor", async (t) => {
  const fx=await fixture(t); await fan(fx.pg,'f');
  await assert.rejects(projection.runProviderCapacityProjectionBatch({db:fx.db,publish:async()=>{throw Error('publication-failed');}}),/publication-failed/);
  assert.equal((await fx.pg.query('SELECT * FROM "ProviderCapacityDirty"')).rows.length,1);
  assert.equal((await fx.pg.query('SELECT * FROM "ProviderCapacityBucket"')).rows.length,0);
  assert.equal(String((await fx.pg.query('SELECT revision FROM "ProviderCapacityProjectionState"')).rows[0].revision),'1');
  assert.equal(await fx.snapshot(),undefined); await drain(fx); assert.equal(String((await fx.snapshot()).fanDataUnsatisfiedDemands),'1');
});

test("B1 SQL: time index wakes a due contribution without an event key", async (t) => {
  const fx=await fixture(t); await directory(fx.pg,'d','2099-01-01T00:00:00Z'); await drain(fx);
  assert.equal((await fx.snapshot()).campaignDirectoryDueCreators,0);
  // Controlled passage of time, not a physical clock/latency test: make both
  // durable timestamps past, remove event key, leave only indexed time wakeup.
  await fx.pg.exec(`UPDATE "CreatorCampaignCollectionState" SET "campaignDirectoryDiscoveryDueAt"='2000-01-01' WHERE id='d'; UPDATE "ProviderCapacityContribution" SET "nextDueAt"='2000-01-01' WHERE "sourceId"='d'; DELETE FROM "ProviderCapacityDirty"`);
  await fx.refresh(); const saved=await fx.snapshot(); assert.equal(saved.campaignDirectoryDueCreators,1); assert.equal(saved.campaignDirectoryOverdueCreators,1);
  assert.equal((await fx.pg.query('SELECT "nextDueAt" FROM "ProviderCapacityContribution"')).rows[0].nextDueAt,null);
});

test("B1 SQL: incremental totals equal the canonical diagnostic query", async (t) => {
  const fx=await fixture(t); for(let i=0;i<37;i++) await fan(fx.pg,`f${i}`,i%3+1,i%2);
  for(let i=0;i<13;i++) await directory(fx.pg,`d${i}`,i%2?'2000-01-01':'2099-01-01',i*50);
  await job(fx.pg,'j0','fan_data_point_refresh','SCHEDULED'); await job(fx.pg,'j1','fan_data_point_refresh','PAUSED'); await job(fx.pg,'j2','dialog_intelligence_scan','PAUSED'); await job(fx.pg,'j3','fetch_earnings','DONE');
  await drain(fx,12); const saved=await fx.snapshot();
  const inputs=await debt.readCanonicalCapacityInputs({db:{$queryRawUnsafe:async(s,...a)=>(await fx.pg.query(s,normalize(a))).rows}, now:saved.sampledAt});
  assert.deepEqual(lower(saved),lower(debt.deriveProviderCapacityDebtSnapshot({now:saved.sampledAt,...inputs})));
});

test("B1 SQL: old writers cannot overwrite; unowned and stale publication reject", async (t) => {
  const fx=await fixture(t); await drain(fx); const original=await fx.snapshot();
  await fx.pg.exec(`UPDATE "ProviderCapacityDebtState" SET "sourceVersion"='phase3_provider_capacity_debt_v4_a18',status='OVERLOADED'`);
  assert.equal((await fx.snapshot()).status,original.status);
  await assert.rejects(fx.pg.exec(`UPDATE "ProviderCapacityDebtState" SET status='OVERLOADED'`),/CAPACITY_PUBLICATION_OWNER_REQUIRED/);
  await assert.rejects(fx.pg.transaction(async(tx)=>{ await tx.query(`SELECT set_config('onlinod.capacity_projection_revision',$1,true)`,[String(original.projectionRevision)]); await tx.query(`UPDATE "ProviderCapacityDebtState" SET "sampledAt"='2000-01-01'`); }),/CAPACITY_PUBLICATION_STALE/);
  assert.equal(String((await fx.snapshot()).projectionRevision),String(original.projectionRevision));
  await assert.rejects(debt.persistProviderCapacityDebtSnapshot({db:fx.db,snapshot:original}),{code:'CAPACITY_PUBLICATION_OWNER_REQUIRED'});
});

test("B1 SQL: projection revision differs from OF-gate revision; host now ignored", async (t) => {
  const fx=await fixture(t); await fx.pg.exec(`INSERT INTO "OfProviderRequestGateState" (id,revision,"updatedAt") VALUES ('of-global',99999,CURRENT_TIMESTAMP)`);
  await fx.refresh({now:new Date('2099-01-01')}); const saved=await fx.snapshot();
  assert.equal(String(saved.projectionRevision),'2'); assert.ok(new Date(saved.sampledAt)<new Date('2099-01-01'));
});

test("B1 SQL: changed catalog fails closed and retains queued work", async (t) => {
  const fx=await fixture(t); await fan(fx.pg,'f'); await fx.pg.exec(`UPDATE "ProviderCapacityProjectionState" SET "jobKeys"=ARRAY['unknown']`);
  await assert.rejects(fx.refresh(),{code:'CAPACITY_PROJECTION_CATALOG_CHANGED'});
  assert.equal((await fx.pg.query('SELECT * FROM "ProviderCapacityDirty"')).rows.length,1);
});

test("B1 SQL: indexes support dirty order, keyset, due and minimum probes", async (t) => {
  const fx=await fixture(t); await fx.pg.exec('SET enable_seqscan=off');
  const probes=[
    [`SELECT * FROM "ProviderCapacityDirty" ORDER BY "touchedAt",kind,"sourceId" LIMIT 96`,'ProviderCapacityDirty_turn_idx'],
    [`SELECT * FROM "ProviderCapacityContribution" WHERE "nextDueAt"<=CURRENT_TIMESTAMP ORDER BY "nextDueAt",kind,"sourceId" LIMIT 96`,'ProviderCapacityContribution_due_idx'],
    [`SELECT "oldestAt" FROM "ProviderCapacityContribution" WHERE bucket='fan' AND "oldestAt" IS NOT NULL ORDER BY "oldestAt" LIMIT 1`,'ProviderCapacityContribution_oldest_idx'],
    [`SELECT id FROM "CreatorFanRefreshDemand" WHERE id>'f' ORDER BY id LIMIT 32`,'CreatorFanRefreshDemand_pkey'],
  ];
  for(const [sql,index] of probes) assert.match(JSON.stringify((await fx.pg.query('EXPLAIN (FORMAT JSON) '+sql)).rows),new RegExp(index));
});

test("B1 SQL: controlled deadlock retry does not double count; oversized batch is clamped", async(t)=>{
 const fx=await fixture(t);await fan(fx.pg,'f');let attempts=0;
 await projection.runProviderCapacityProjectionBatch({db:fx.db,batchSize:999999,publish:async({db,row,now})=>{
   attempts++;if(attempts===1)throw Object.assign(Error('controlled deadlock'),{code:'40P01'});
   const snapshot=debt.deriveProviderCapacityDebtSnapshot({now,fanData:{unsatisfiedDemands:row.unsatisfiedDemands},projection:{complete:row.projectionComplete,revision:row.revision}});
   return debt.persistProviderCapacityDebtSnapshot({db,snapshot});
 }});
 assert.equal(attempts,2);assert.equal(String((await fx.snapshot()).fanDataUnsatisfiedDemands),'1');
 assert.equal(String((await fx.snapshot()).projectionRevision),'2');
 assert.ok(fx.calls.filter(c=>/LIMIT \$1 FOR UPDATE SKIP LOCKED/.test(c.sql)).every(c=>c.params[0]===128));
});
