"use strict";
// Offline PostgreSQL WASM only. No external DB, production schema or credentials.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.ONLINOD_PGLITE_MODULE||'@electric-sql/pglite');
const repo=require('../../src/services/home-read-repository'),scope=require('../../src/services/home-scope-repository');
const {displayRangeBounds,previousDisplayRange}=require('../../src/services/analytics-range-contract');
const root=path.resolve(__dirname,'../..'),now=new Date('2026-09-29T12:00:00Z');
function input(db,member,rangeKey='7d',money=true){return {db,agencyId:'a',member,billing:true,now,range:displayRangeBounds(rangeKey,now),previous:previousDisplayRange(rangeKey,now),money};}
const member={id:'m',userId:'u',agencyId:'a',accessEpoch:1,broad:false}, small={...member,id:'small',userId:'us'};
test('A2 PostgreSQL Home read/permission/pagination proof',async t=>{
 const pg=new PGlite();await pg.waitReady;t.after(()=>pg.close());
 await pg.exec(fs.readFileSync(path.join(root,'test/fixtures/phase6-home-I7-baseline.sql'),'utf8'));
 await pg.exec('ALTER TABLE "AnalyticsScanProof" ADD COLUMN "proofVersion" INTEGER NOT NULL DEFAULT 1');
 await pg.exec(`INSERT INTO "AnalyticsCollectionDemand"(key,"agencyId","rangeKey","coverageFrom","coverageTo",reason,"creatorIds","requestedByMemberId","requestedAccessEpoch","requestedAt","updatedAt")
 VALUES ('preexisting','preexisting','7d','2026-09-01','2026-09-29','test','["historical-creator"]','old-member',7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
 await pg.exec(fs.readFileSync(path.join(root,'prisma/migrations/20260929170000_phase6_home_member_scope_v1/migration.sql'),'utf8'));
 const calls=[];const db={$queryRawUnsafe:async(sql,...params)=>{const r=await pg.query(sql,params);calls.push({rows:r.rows.length,paramBytes:JSON.stringify(params).length,sql});return r.rows;}};
 async function insert(table,data){const fields=Object.keys(data);return pg.query(`INSERT INTO "${table}" (${fields.map(f=>`"${f}"`).join(',')}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(data));}
 await pg.exec(`INSERT INTO "Agency"(id,name,"trialEndsAt","updatedAt") VALUES ('a','Agency','2099-01-01',CURRENT_TIMESTAMP),('foreign','Other','2099-01-01',CURRENT_TIMESTAMP);
 INSERT INTO "User"(id,email,"passwordHash","updatedAt") VALUES ('u','u@test','x',CURRENT_TIMESTAMP),('us','s@test','x',CURRENT_TIMESTAMP);
 INSERT INTO "AgencyMember"(id,"agencyId","userId",role,"roleKey","assignedCreators","updatedAt") VALUES
 ('m','a','u','OPERATOR','operator','[]',CURRENT_TIMESTAMP),('small','a','us','OPERATOR','operator','[]',CURRENT_TIMESTAMP);
 INSERT INTO "DomainWorkClaimTopologyState"(id,generation,"activationState","updatedAt") VALUES ('phase3_domain_work_claim_topology_a36_v1','phase3_domain_work_claim_topology_a36_v1','ACTIVE',CURRENT_TIMESTAMP);
 INSERT INTO "CreatorAccount"(id,"agencyId","displayName",status,"updatedAt") SELECT 'c'||lpad(i::text,5,'0'),'a','Creator '||i,'READY',CURRENT_TIMESTAMP FROM generate_series(1,16000)i;
 INSERT INTO "CreatorAccount"(id,"agencyId","displayName",status,"updatedAt") VALUES ('foreign','foreign','hidden','READY',CURRENT_TIMESTAMP);
 INSERT INTO "AgencyMemberCreatorAccessCurrent"("agencyId","memberId","creatorId","accessEpoch","claimShard","updatedAt") SELECT 'a','m',id,1,0,CURRENT_TIMESTAMP FROM "CreatorAccount" WHERE "agencyId"='a';
 INSERT INTO "AgencyMemberCreatorAccessCurrent"("agencyId","memberId","creatorId","accessEpoch","claimShard","updatedAt") VALUES ('a','small','c00001',1,0,CURRENT_TIMESTAMP),('a','small','c00002',1,0,CURRENT_TIMESTAMP);
 UPDATE "AgencyMember" SET "assignedCreators"=(SELECT jsonb_agg("creatorId") FROM "AgencyMemberCreatorAccessCurrent" WHERE "memberId"="AgencyMember".id);`);
 await t.test('restricted 16000 creators: every keyset page continues; no id-array transport or 5000 cutoff',async()=>{
  const authority=await scope.readHomeAuthority({db,agencyId:'a',member,billing:true});assert.equal(authority.broad,false);assert.equal(authority.assignedCreators,undefined);
  const totals=await repo.readHomeTotals(input(db,member,'7d',false));assert.equal(totals.totalCreators,16000);assert.equal(totals.totalCents,null);
  let after='',n=0,last='';do{const p=await repo.readHomeCreatorPage({...input(db,member,'7d',false),after,limit:100});assert.ok(p.creators.length<=100);for(const c of p.creators){assert.ok(c.id>last);last=c.id;n++;}after=p.nextCursor;}while(after);
  assert.equal(n,16000);assert.equal(last,'c16000');assert.ok(calls.every(c=>c.rows<=100&&c.paramBytes<600));
  const one=await repo.readHomeCreatorPage({...input(db,member,'7d',false),limit:50});console.log(JSON.stringify({fixtureCreators:16000,pageRows:50,pageBytes:Buffer.byteLength(JSON.stringify(one)),maxReturnedRows:Math.max(...calls.map(c=>c.rows)),maxParameterBytes:Math.max(...calls.map(c=>c.paramBytes))}));
 });
 await t.test('keyset query plan uses existing creator/member indexes (forced-index diagnostic)',async()=>{
  await pg.exec('ANALYZE "CreatorAccount";ANALYZE "AgencyMemberCreatorAccessCurrent";SET enable_seqscan=off');
  await repo.readHomeCreatorPage({...input(db,member,'7d',false),after:'c15900',limit:50});
  const q=calls.at(-1); // Recreate compact parameters; SQL shape is the production page.
  const params=[...repo.__test.revenueParams(input(db,member,'7d',false)),'c15900',51,50];
  const plan=(await pg.query('EXPLAIN (FORMAT JSON) '+q.sql,params)).rows;
  const text=JSON.stringify(plan);assert.match(text,/AgencyMemberCreatorAccessCurrent_(?:identity_key|claim_idx|creator_idx)/);assert.match(text,/CreatorAccount_(?:pkey|agencyId_id_key)/);
  const indexes=[];function visit(v){if(v&&typeof v==='object'){if(v['Index Name'])indexes.push({index:v['Index Name'],condition:v['Index Cond']});Object.values(v).forEach(visit);}}visit(plan);
  console.log('HOME_KEYSET_INDEX_PLAN '+JSON.stringify(indexes));await pg.exec('SET enable_seqscan=on');
 });
 await t.test('owner broad scope pages the whole live agency and excludes foreign creators',async()=>{
  await pg.exec(`UPDATE "AgencyMember" SET role='OWNER',"roleKey"='owner' WHERE id='m'`);
  const owner={...member,broad:true};assert.equal((await scope.readHomeAuthority({db,agencyId:'a',member:owner})).broad,true);
  const p=await repo.readHomeCreatorPage({...input(db,owner,'today',false),limit:50});assert.equal(p.creators.length,50);assert.equal(p.nextCursor,'c00050');
  assert.equal((await repo.readHomeTotals(input(db,owner,'today',false))).totalCreators,16000);
  await pg.exec(`UPDATE "AgencyMember" SET role='OPERATOR',"roleKey"='operator' WHERE id='m'`);
 });
 await t.test('stale epoch, deactivation, disabled user, and missing projection fail closed',async()=>{
  await assert.rejects(scope.readHomeAuthority({db,agencyId:'a',member:{...member,accessEpoch:2}}),{code:'HOME_ACCESS_CHANGED'});
  await pg.exec(`UPDATE "User" SET "disabledAt"=CURRENT_TIMESTAMP WHERE id='u'`);await assert.rejects(scope.readHomeAuthority({db,agencyId:'a',member}),{code:'HOME_ACCESS_CHANGED'});await pg.exec(`UPDATE "User" SET "disabledAt"=NULL WHERE id='u'`);
  await pg.exec(`UPDATE "AgencyMember" SET "deactivatedAt"=CURRENT_TIMESTAMP WHERE id='m'`);await assert.rejects(scope.readHomeAuthority({db,agencyId:'a',member}),{code:'HOME_ACCESS_CHANGED'});await pg.exec(`UPDATE "AgencyMember" SET "deactivatedAt"=NULL WHERE id='m'`);
  await pg.exec(`UPDATE "DomainWorkClaimTopologyState" SET "activationState"='BUILDING'`);await assert.rejects(scope.readHomeAuthority({db,agencyId:'a',member}),{code:'HOME_SCOPE_PROJECTION_NOT_READY'});await pg.exec(`UPDATE "DomainWorkClaimTopologyState" SET "activationState"='ACTIVE'`);
 });
 await t.test('billing expiration and hold narrow both count and page; foreign projected rows never leak',async()=>{
  await pg.exec(`INSERT INTO "AgencyMemberCreatorAccessCurrent"("agencyId","memberId","creatorId","accessEpoch","claimShard","updatedAt") VALUES ('a','m','foreign',1,0,CURRENT_TIMESTAMP);UPDATE "Agency" SET "trialEndsAt"='2000-01-01' WHERE id='a'`);
  assert.equal((await repo.readHomeTotals(input(db,member,'today',false))).totalCreators,0);
  await insert('CreatorBillingEntitlement',{id:'ent',agencyId:'a',creatorId:'c00001',coreValidUntil:new Date('2099-01-01'),updatedAt:now});
  assert.deepEqual((await repo.readHomeCreatorPage({...input(db,member,'today',false),limit:50})).creators.map(c=>c.id),['c00001']);
  await pg.exec(`UPDATE "Agency" SET "billingSupportHold"=true WHERE id='a'`);assert.equal((await repo.readHomeTotals(input(db,member,'today',false))).totalCreators,0);
  await pg.exec(`UPDATE "Agency" SET "trialEndsAt"='2099-01-01',"billingSupportHold"=false WHERE id='a'`);
 });
 for(const id of ['c00001','c00002']){
  await insert('AnalyticsScanProof',{id:'proof-'+id,agencyId:'a',creatorId:id,dataType:'EARNINGS',scanRunId:'scan-'+id,sourceTimezone:'UTC',scanFrom:'2026-04-03',scanTo:'2026-09-29',requestedAt:now,serverReceivedAt:now,committedAt:now,proofVersion:2,status:'COMMITTED',collectorVersion:'fixture',schemaVersion:1,scanGeneration:'fixture',collectionReason:'fixture',payloadChecksum:'fixture',updatedAt:now});
  await pg.query(`INSERT INTO "AnalyticsCoverage"(id,"agencyId","creatorId","scanProofId","dataType","coverageDate","sourceTimezone",status,"lastVerifiedAt","updatedAt") SELECT $1||day::text,'a',$1,$2,'EARNINGS',day,'UTC',CASE WHEN day='2026-09-29'::date THEN 'PARTIAL'::"AnalyticsCoverageStatus" ELSE 'COMPLETE'::"AnalyticsCoverageStatus" END,$3,$3 FROM generate_series('2026-04-03'::date,'2026-09-29'::date,'1 day')day`,[id,'proof-'+id,now]);
  await pg.query(`INSERT INTO "CreatorEarningsDaily"(id,"agencyId","creatorId","scanProofId","sourceScanRunId",date,"totalCents","collectedAt","updatedAt") SELECT $1||day::text,'a',$1,$2,'scan-'||$1,day,100,$3,$3 FROM generate_series('2026-04-03'::date,'2026-09-29'::date,'1 day')day`,[id,'proof-'+id,now]);
 }
 await t.test('all four ranges: exact complete total, previous delta, bounded UTC chart; today PARTIAL is usable',async()=>{
  for(const [key,days] of [['today',1],['7d',7],['30d',30],['90d',90]]){
   const r=await repo.readHomeTotals(input(db,small,key));assert.equal(r.totalCents,days*200);assert.equal(r.reportingCreators,2);assert.equal(r.deltaPct,0);assert.equal(r.points.length,days);assert.equal(r.points.reduce((n,p)=>n+p.valueCents,0),r.totalCents);
  }
 });
 await t.test('missing daily fact despite COMPLETE coverage blocks agency KPI/chart and that creator row',async()=>{
  await pg.exec(`DELETE FROM "CreatorEarningsDaily" WHERE "creatorId"='c00002' AND date='2026-09-28'`);
  const r=await repo.readHomeTotals(input(db,small));assert.equal(r.totalCents,null);assert.equal(r.reportingCreators,1);assert.deepEqual(r.points,[]);assert.equal(r.deltaPct,null);
  const p=await repo.readHomeCreatorPage({...input(db,small),limit:50});assert.equal(p.creators[0].revenueCents,700);assert.equal(p.creators[1].revenueCents,null);
  await pg.exec(`INSERT INTO "CreatorEarningsDaily"(id,"agencyId","creatorId","scanProofId","sourceScanRunId",date,"totalCents","collectedAt","updatedAt") VALUES ('restored','a','c00002','proof-c00002','scan-c00002','2026-09-28',100,'2026-09-29 12:00:00',CURRENT_TIMESTAMP)`);
 });
 await t.test('uncommitted proof, stale/future verification and missing previous facts preserve UNKNOWN and freshness semantics',async()=>{
  await pg.exec(`UPDATE "AnalyticsScanProof" SET status='RECEIVED' WHERE id='proof-c00002'`);
  assert.equal((await repo.readHomeTotals(input(db,small))).totalCents,null);
  await pg.exec(`UPDATE "AnalyticsScanProof" SET status='COMMITTED' WHERE id='proof-c00002';UPDATE "AnalyticsCoverage" SET "lastVerifiedAt"='2099-01-01' WHERE "creatorId"='c00002' AND "coverageDate"='2026-09-29'`);
  let r=await repo.readHomeTotals(input(db,small));assert.equal(r.totalCents,1400);assert.equal(r.staleCreators,1);assert.equal(r.deltaPct,null);
  await pg.exec(`UPDATE "AnalyticsCoverage" SET "lastVerifiedAt"='2026-09-29 12:00:00';DELETE FROM "CreatorEarningsDaily" WHERE "creatorId"='c00001' AND date='2026-09-16'`);
  r=await repo.readHomeTotals(input(db,small));assert.equal(r.totalCents,1400);assert.equal(r.deltaPct,null);
 });
 await t.test('pending demand uses current requester scope, no first-50 horizon; stale member revision ignored',async()=>{
  for(let i=0;i<61;i++)await insert('AnalyticsCollectionDemand',{key:'d'+i,agencyId:'a',rangeKey:'7d',coverageFrom:'2026-09-01',coverageTo:'2026-09-29',reason:'test',creatorIds:i===60?null:JSON.stringify(['foreign']),requestedByMemberId:'small',requestedAccessEpoch:1,requestedAt:now,updatedAt:now,scopeMode:i===60?'MEMBER_CURRENT':'LEGACY'});
  assert.equal((await repo.readHomeTotals(input(db,member))).pendingCount,2);
  await pg.exec(`UPDATE "AnalyticsCollectionDemand" SET "requestedAccessEpoch"=2`);assert.equal((await repo.readHomeTotals(input(db,member))).pendingCount,0);
  await insert('JobInstance',{id:'j',jobKey:'fetch_earnings',scope:'creator',agencyId:'a',creatorId:'c00003',updatedAt:now});assert.equal((await repo.readHomeTotals(input(db,member))).pendingCount,1);
 });
 await t.test('demand page bounds READY creators, advances after deletion, excludes expired scope rows',async()=>{
  const rows=await scope.readDemandCreatorPage({db,agencyId:'a',member,cursor:'c15995',take:4,billing:true});assert.deepEqual(rows.map(r=>r.id),['c15996','c15997','c15998','c15999']);
  await pg.exec(`UPDATE "CreatorAccount" SET "deletedAt"=CURRENT_TIMESTAMP WHERE id='c15999';UPDATE "AgencyMemberCreatorAccessCurrent" SET "accessEpoch"=2 WHERE "memberId"='m' AND "creatorId"='c16000'`);
  assert.deepEqual(await scope.readDemandCreatorPage({db,agencyId:'a',member,cursor:'c15998',take:4,billing:true}),[]);
 });
 await t.test('negative, oversized and malformed pages reject before SQL',async()=>{
  const before=calls.length;for(const x of [{limit:101},{limit:0},{limit:1.5},{after:'x'.repeat(181)},{after:'a\nb'}])await assert.rejects(repo.readHomeCreatorPage({...input(db,small),...x}));assert.equal(calls.length,before);
 });
 await t.test('mixed rollout: old workers cannot claim new member-scope demands; marker is transaction local',async()=>{
  await assert.rejects(pg.exec(`UPDATE "AnalyticsCollectionDemand" SET "claimToken"='old-worker',"claimedRevision"=1 WHERE key='d60'`),/HOME_MEMBER_SCOPE_WORKER_UPGRADE_REQUIRED/);
  await pg.transaction(async tx=>{await tx.query("SELECT set_config('onlinod.home_member_scope_version','1',true)");await tx.query(`UPDATE "AnalyticsCollectionDemand" SET "claimToken"='new-worker',"claimedRevision"=1 WHERE key='d60'`);});
  await assert.rejects(pg.exec(`UPDATE "AnalyticsCollectionDemand" SET "claimToken"='old-worker' WHERE key='d60'`),/HOME_MEMBER_SCOPE_WORKER_UPGRADE_REQUIRED/);
  await pg.exec(`UPDATE "AnalyticsCollectionDemand" SET "claimToken"='legacy-worker',"claimedRevision"=1 WHERE key='d0'`);
 });
 await t.test('migration preserves legacy scope; new mode rejects invalid values',async()=>{
  await assert.rejects(pg.exec(`UPDATE "AnalyticsCollectionDemand" SET "scopeMode"='BOGUS'`),/scopeMode_check/);
  await assert.rejects(pg.exec(`UPDATE "AnalyticsCollectionDemand" SET "creatorIds"='[]'::jsonb WHERE "scopeMode"='MEMBER_CURRENT'`),/member_scope_shape_check/);
  const old=(await pg.query(`SELECT "scopeMode","creatorIds" FROM "AnalyticsCollectionDemand" WHERE key='preexisting'`)).rows[0];assert.equal(old.scopeMode,'LEGACY');assert.deepEqual(old.creatorIds,['historical-creator']);
  const constraints=(await pg.query(`SELECT convalidated FROM pg_constraint WHERE conname IN ('AnalyticsCollectionDemand_scopeMode_check','AnalyticsCollectionDemand_member_scope_shape_check')`)).rows;assert.equal(constraints.length,2);assert.ok(constraints.every(x=>x.convalidated===false));
  const r=(await pg.query(`SELECT column_default FROM information_schema.columns WHERE table_name='AnalyticsCollectionDemand' AND column_name='scopeMode'`)).rows[0];assert.match(r.column_default,/LEGACY/);
 });
});
