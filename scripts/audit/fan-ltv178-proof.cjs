"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createScaleSqlRuntime}=require('../test-support/scale-sql-runtime.cjs');
const {scope}=require('./analytics-traffic/fixture.cjs');
const {runRootCommit}=require('../../src/services/db-commit-kernel');
const earnings=require('../../src/services/earnings-generation-service');
const projection=require('../../src/services/fan-ltv-projection-service');
const work=require('../../src/services/domain-work-authority-service');
const {readFanLtv}=require('../../src/services/fan-ltv-read-repository');
const {readPublishedFinancialSummary}=require('../../src/services/published-financial-read-repository');
const {readDatabaseContract}=require('../../src/services/database-contract-service');
const pass=label=>console.log('PASS',label),keep=setInterval(()=>{},1000),deadline=setTimeout(()=>{console.error('FAN_LTV_PROOF_DEADLINE');process.exit(2)},600000);
(async()=>{const runtime=await createScaleSqlRuntime();try{
 const {db}=runtime,now=new Date(Math.floor(Date.now()/1000)*1000),day=new Date(now.toISOString().slice(0,10));
 const s=await scope(db,{agencyId:'ltv178-a',creatorId:'ltv178-c',userId:'ltv178-u'});
 const other=await scope(db,{agencyId:'ltv178-b',creatorId:'ltv178-foreign',userId:'ltv178-other'});
 const write=fn=>runRootCommit(db,async({tx})=>{await earnings.lock(tx,s.creatorId);return fn(tx);},{profile:'JOB_CHUNK'});
 let generation='ltv178-active';
 const read=(rangeKey='30d')=>readFanLtv({db,creatorId:s.creatorId,rangeKey,now});
 const fact=(transactionId,netCents,fanOnlyFansUserId,age=0,category='messages',status='done')=>({transactionId,netCents,fanOnlyFansUserId,
  occurredAt:new Date(+now-age*86400000),category,status,observedAt:now,grossCents:null});
 async function drain(){for(let i=0;i<240;i++){
  const result=await projection.runSweep({db,limit:4,maxRuntimeMs:10000});assert.equal(result.ok,true,JSON.stringify(result));
  const state=await read();if(state.available&&!state.pending)return state;
 }throw Error('FAN_LTV_NOT_DRAINED');}
 const initial=await read();assert.equal(initial.available,false);assert.equal(initial.allTime,null);
 assert.equal((await readDatabaseContract(db)).ready,true);
 pass('current installation contract and initial unknown state');
 await write(async tx=>{
  await tx.creatorEarningsGeneration.create({data:{id:generation,agencyId:s.agencyId,creatorId:s.creatorId,runId:'ltv178-run',state:'ACTIVE',phase:'READY',
   fullScan:true,fromAt:new Date('2016-01-01'),throughAt:now,snapshotAt:now,publishedAt:now}});
  await tx.creatorEarningsLedgerProof.create({data:{agencyId:s.agencyId,creatorId:s.creatorId,fromAt:new Date('2016-01-01'),throughAt:now,generation:'ltv178-proof',activeGeneration:generation}});
  await earnings.upsert(tx,generation,[fact('a1',1000,'fan-a',20,'subscriptions'),fact('a2',2000,'fan-a'),fact('b',9000,'fan-b',40,'tips'),
   fact('c',1000,'fan-c'),fact('refunded',5000,'fan-refunded',0,'tips','undo'),fact('unknown',2000,null),fact('zero',0,'fan-zero')]);
 });
 const beforeJobs=await db.jobInstance.count();
 let state=await drain();
 assert.equal(state.allTime.payingFans,3);assert.equal(state.allTime.knownNetCents,13000);assert.equal(state.allTime.averageCents,4333);assert.equal(state.allTime.medianCents,3000);
 assert.equal(state.allTime.netCents,15000);assert.equal(state.allTime.unknownPayments,1);assert.equal(state.allTime.complete,false);
 assert.equal(state.period.payingFans,2);assert.equal(state.period.averageCents,2000);
 assert.equal((await read('7d')).allTime.averageCents,4333);assert.equal((await read('7d')).period.averageCents,1500);
 const pending=await write(async tx=>{await earnings.upsert(tx,generation,[{...fact('b',9000,'fan-b',40,'tips','undo'),observedAt:new Date(+now+1)}]);});
 const saved=await read();assert.equal(saved.pending,true);assert.equal(saved.allTime.averageCents,4333);
 pass('unique fans, median, per-period mean, unknown attribution and saved values while updating');
 const original=state;
 state=await drain();assert.equal(state.allTime.payingFans,2);assert.equal(state.allTime.knownNetCents,4000);assert.equal(state.allTime.averageCents,2000);assert.equal(state.allTime.medianCents,2000);
 await write(tx=>earnings.upsert(tx,generation,[{...fact('b',9000,'fan-b',40,'tips','undo'),observedAt:new Date(+now+1)}]));
 state=await drain();assert.equal(state.allTime.payingFans,2);assert.equal(state.allTime.knownNetCents,4000);
 await write(tx=>earnings.upsert(tx,generation,[{...fact('unknown',2000,'fan-new'),observedAt:new Date(+now+2)}]));
 state=await drain();assert.equal(state.allTime.unknownPayments,0);assert.equal(state.allTime.payingFans,3);assert.equal(state.allTime.complete,true);
 await write(tx=>earnings.upsert(tx,generation,[{...fact('a2',2000,'fan-c',50),observedAt:new Date(+now+3)}]));
 state=await drain();assert.equal(state.allTime.knownNetCents,6000);assert.equal(state.allTime.medianCents,2000);assert.equal(state.period.knownNetCents,4000);
 const corrected=state,sevenDays=await read('7d');
 pass('refund, replay, attribution correction and moved transaction date retract exact previous contributions');
 const display=await readPublishedFinancialSummary({db,creatorId:s.creatorId,from:new Date(+now-365*86400000),to:now});
 assert.equal(display.finance.netCents,state.allTime.netCents);
 const q=runtime.queries.length;
 for(let i=0;i<6;i++)await read(i%2?'7d':'365d');
 const queries=runtime.queries.slice(q).map(row=>row.query);
 assert(!queries.some(sql=>/\b(INSERT|UPDATE|DELETE)\b|"CreatorFinancialTransaction"|"CreatorEarningsGenerationEntry"|"FanLtvBalance"|"FanLtvDistribution"/.test(sql)));
 assert.equal(await db.jobInstance.count(),beforeJobs);
 assert.equal((await readFanLtv({db,creatorId:other.creatorId,now})).allTime,null);
 pass('Home/Overview money agreement, constant-size read path, no provider jobs and creator isolation');
 // A process dying after its writes but before settlement must leave neither
 // a partially published amount nor an acknowledged inbox item.
 await write(tx=>earnings.upsert(tx,generation,[{...fact('c',1100,'fan-c'),observedAt:new Date(+now+4)}]));
 const claim=await work.claimDomainWorkBatch({db,workClass:projection.WORK_CLASS,limit:1});
 assert.equal(claim.items.length,1);
 const savedState=await db.fanLtvState.findUnique({where:{creatorId:s.creatorId}});
 const savedBalances=await db.fanLtvBalance.findMany({where:{creatorId:s.creatorId},orderBy:[{rangeKey:'asc'},{fanId:'asc'}]});
 const savedYield=work.yieldDomainWorkClaim;
 try{work.yieldDomainWorkClaim=async()=>{throw Error('SIMULATED_CRASH_BEFORE_SETTLEMENT')};
  await assert.rejects(projection.processPage({db,item:claim.items[0],ownerToken:claim.ownerToken}),/SIMULATED_CRASH/);
 }finally{work.yieldDomainWorkClaim=savedYield;}
 assert.deepEqual(await db.fanLtvState.findUnique({where:{creatorId:s.creatorId}}),savedState);
 assert.deepEqual(await db.fanLtvBalance.findMany({where:{creatorId:s.creatorId},orderBy:[{rangeKey:'asc'},{fanId:'asc'}]}),savedBalances);
 assert.equal(await db.fanLtvChange.count({where:{creatorId:s.creatorId,transactionId:'c'}}),1);
 await db.domainWorkItem.update({where:{id:claim.items[0].id},data:{leaseUntil:new Date(0)}});
 const takeover=await work.claimDomainWorkBatch({db,workClass:projection.WORK_CLASS,limit:1});assert.equal(takeover.items.length,1);
 await assert.rejects(projection.processPage({db,item:claim.items[0],ownerToken:claim.ownerToken}),/FAN_LTV_CLAIM_LOST/);
 await projection.processPage({db,item:takeover.items[0],ownerToken:takeover.ownerToken});
 assert.equal((await read()).allTime.netCents,6100);
 await write(tx=>earnings.upsert(tx,generation,[{...fact('c',1000,'fan-c'),observedAt:new Date(+now+5)}]));await drain();
 pass('mid-commit crash rolls back balances, snapshot and inbox; restarted worker rejects the expired owner and resumes once');
 // Exercise the same expiry reducer and publication with a fixture clock,
 // without changing the application's authoritative database clock.
 const future=new Date(+day+120*86400000);
 assert.equal((await readFanLtv({db,creatorId:s.creatorId,now:future})).period,null);
 async function publishAt(at){return write(async tx=>{
  await tx.$executeRawUnsafe("SELECT set_config('onlinod.fan_ltv_writer','178',true)");
  const [proof]=await tx.$queryRawUnsafe('SELECT p.*,g."fullScan",g."publishedAt" FROM "CreatorEarningsLedgerProof" p LEFT JOIN "CreatorEarningsGeneration" g ON g.id=p."activeGeneration" WHERE p."creatorId"=$1',s.creatorId);
  const rows=await projection.sourceRows(tx,proof,{after:'',upper:'zzzz'});
  await projection.applyRows(tx,s.creatorId,rows.map(row=>row.transactionId),rows,at);
  await projection.publishSnapshot(tx,proof,{},at);
 });}
 await publishAt(future);
 const aged=await readFanLtv({db,creatorId:s.creatorId,now:future});
 assert.equal(aged.allTime.netCents,6000);assert.equal(aged.period.averageCents,null);assert.equal(aged.period.payingFans,0);
 await publishAt(now);assert.equal((await read()).period.knownNetCents,4000);
 const clockWork=await db.domainWorkItem.findFirst({where:{creatorId:s.creatorId,workClass:projection.WORK_CLASS}});
 assert(clockWork.availableAt>now&&clockWork.availableAt<=new Date(+day+86400000));
 pass('period expiry removes only expired contributions; lifetime totals persist and the durable clock wakes even without a new payment');
 // A failed build must not replace the published LTV identity or amount.
 await write(async tx=>{
  await tx.creatorEarningsGeneration.create({data:{id:'ltv178-failed',agencyId:s.agencyId,creatorId:s.creatorId,runId:'failed',state:'BUILDING',fullScan:true,fromAt:day,throughAt:now,snapshotAt:now}});
  await earnings.upsert(tx,'ltv178-failed',[fact('bad',99000000,'fan-wrong')]);
 });
 assert.equal((await read()).allTime.netCents,6000);assert.equal((await read()).pending,false);
 pass('unpublished and failed financial generations cannot enter Fan LTV');
 // Active pointer replacement is rebuilt in bounded units; saved all-time
 // figures remain explicitly old, and selected-period data waits for cutover.
 await write(async tx=>{
  await tx.creatorEarningsGeneration.update({where:{id:generation},data:{state:'RETIRED',retiredAt:now}});
  await tx.creatorEarningsGeneration.update({where:{id:'ltv178-failed'},data:{state:'ACTIVE',publishedAt:now}});
  await tx.creatorEarningsLedgerProof.update({where:{creatorId:s.creatorId},data:{activeGeneration:'ltv178-failed',generation:'replaced'}});
 });generation='ltv178-failed';
 const replacing=await read();assert.equal(replacing.pending,true);assert.equal(replacing.allTime.netCents,6000);assert.equal(replacing.period,null);
 state=await drain();assert.equal(state.allTime.netCents,99000000);assert.equal(state.allTime.payingFans,1);
 pass('generation replacement preserves the last saved result and cuts over without mixing versions');
 // Deterministic large population: test the real median and inspect the hot
 // query shape; no fixture can prove production latency on a different host.
 const count=Number(process.env.ONLINOD_LTV_SCALE_FANS||5000);
 await write(tx=>earnings.upsert(tx,generation,[{...fact('bad',99000000,'fan-wrong',0,'messages','undo'),observedAt:new Date(+now+4)}]));
 for(let offset=0;offset<count;offset+=100)await write(tx=>earnings.upsert(tx,generation,Array.from({length:Math.min(100,count-offset)},(_,j)=>{
   const i=offset+j+1;return fact('scale-'+String(i).padStart(8,'0'),i,'scale-fan-'+i,400,'tips');})));
 state=await drain();assert.equal(state.allTime.payingFans,count);assert.equal(state.allTime.medianCents,Math.floor((count+2)/2));
 assert.equal(state.allTime.knownNetCents,count*(count+1)/2);assert.equal(state.period.payingFans,0);assert.equal(state.period.averageCents,null);
 const medianStart=runtime.queries.length;assert.equal(await projection.median(db,s.creatorId,count),state.allTime.medianCents);
 assert.equal(runtime.queries.length-medianStart,7);
 pass(count+' fans: exact median uses seven bounded prefix queries, empty period has no invented average');
 const scale=state;
 // Enough old receipts force RESET to span several commits. A fact arriving
 // above the frozen seed boundary must survive that cleanup and a reconnect.
 await write(async tx=>{
  await tx.creatorEarningsGeneration.update({where:{id:generation},data:{state:'RETIRED',retiredAt:now}});
  await tx.creatorEarningsGeneration.create({data:{id:'ltv178-rebuild',agencyId:s.agencyId,creatorId:s.creatorId,runId:'rebuild',state:'ACTIVE',fullScan:true,fromAt:day,throughAt:now,snapshotAt:now,publishedAt:now}});
  await earnings.upsert(tx,'ltv178-rebuild',[fact('first',400,'fan-first')]);
  await tx.creatorEarningsLedgerProof.update({where:{creatorId:s.creatorId},data:{activeGeneration:'ltv178-rebuild',generation:'rebuild'}});
 });generation='ltv178-rebuild';
 await projection.runSweep({db,limit:1});
 const rebuilding=await db.fanLtvState.findUnique({where:{creatorId:s.creatorId}});assert.equal(rebuilding.stage,'RESET');assert.equal(rebuilding.upperId,'first');
 await write(tx=>earnings.upsert(tx,generation,[fact('zz-late',600,'fan-late')]));
 await db.$disconnect();
 state=await drain();assert.equal(state.allTime.netCents,1000);assert.equal(state.allTime.payingFans,2);assert.equal(state.allTime.medianCents,500);
 assert.equal(await db.fanLtvChange.count({where:{creatorId:s.creatorId}}),0);
 pass('a payment above the frozen seed bound survives multi-page reset, connection restart and generation cutover');
 if(process.env.ONLINOD_LTV_EVIDENCE){const directory=path.resolve(process.env.ONLINOD_LTV_EVIDENCE);fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'fan-ltv178.json'),JSON.stringify({partial:original,pending:saved,corrected,sevenDays,scale},null,2));}
 console.log('FAN_LTV178_PROOF_OK',runtime.native?'native PostgreSQL':'PGlite PostgreSQL engine');
}finally{await runtime.close();}})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{clearInterval(keep);clearTimeout(deadline)});
