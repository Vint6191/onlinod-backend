"use strict";
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const work = require('./domain-work-authority-service');
const { runRootCommit } = require('./db-commit-kernel');
const { dbAuthorityNow } = require('./db-time-authority-service');
const { lockAgencyLifecycleBarrier } = require('./agency-lifecycle-barrier-service');
const { pauseDeletedAgencyProjection } = require('./analytics-projection-lifecycle-service');
const earnings = require('./earnings-generation-service');
const { earningsCategory } = require('./financial-transaction-category');
const { utcDay, DAY_MS } = require('./analytics-range-contract');
const { RANGES, FIELDS, fail, integer, fanId, contribution, prefixes, rangeDto } = require('./fan-ltv-model');
const WORK_CLASS='FAN_LTV_PROJECTION', ADOPTION_KEY='fan_ltv178_adoption', PAGE=100;
// Keep the change inbox throughout a rebuild. A new fact can arrive above the
// frozen seed upper bound while old derived rows are still being removed.
const RESET_TABLES=['FanLtvReceipt','FanLtvBalance','FanLtvMetric','FanLtvDistribution'];
const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const key=(...parts)=>JSON.stringify(parts);
const own=result=>{if(!result||result.lost||result.current===false)throw fail('FAN_LTV_CLAIM_LOST');return result;};
function sourceKey(proof){return proof.activeGeneration?'generation:'+proof.activeGeneration:'ledger:'+proof.creatorId;}

async function sourceRows(db,proof,{ids,after='',upper=''}) {
 const generated=Boolean(proof.activeGeneration),table=generated?'CreatorEarningsGenerationEntry':'CreatorEarningsLedgerEntry';
 const values=[generated?proof.activeGeneration:proof.creatorId,proof.creatorId];
 const clause=ids?(values.push(ids),'e."transactionId"=ANY($3::text[])'):(values.push(after,upper,PAGE),'e."transactionId">$3 AND e."transactionId"<=$4 ORDER BY e."transactionId" LIMIT $5');
 const rows=await db.$queryRawUnsafe(`WITH page AS MATERIALIZED (
  SELECT e.* FROM "${table}" e WHERE e."${generated?'generation':'creatorId'}"=$1 AND ${clause}
 ) SELECT e.*,f."fanOnlyFansUserId" AS "legacyFanId",f."transactionType",f."factType"
 FROM page e LEFT JOIN "CreatorFinancialTransaction" f ON f."creatorId"=$2 AND f."externalTransactionId"=e."transactionId"
  AND e."fanOnlyFansUserId" IS NULL AND f.currency='USD' AND f."netCents"=e."netCents"
  AND f."occurredAt"=e."occurredAt" AND f."transactionStatus"=e.status AND f."sourceUpdatedAt"=e."observedAt"
 ORDER BY e."transactionId"`,...values);
 return rows.map(row=>({...row,fanOnlyFansUserId:fanId(row.fanOnlyFansUserId)
  || (earningsCategory(row)===row.category?fanId(row.legacyFanId):null)}));
}
async function sourceUpper(db,proof) {
 const generated=Boolean(proof.activeGeneration);
 const [row]=await db.$queryRawUnsafe(`SELECT "transactionId" FROM "${generated?'CreatorEarningsGenerationEntry':'CreatorEarningsLedgerEntry'}"
  WHERE "${generated?'generation':'creatorId'}"=$1 ORDER BY "transactionId" DESC LIMIT 1`,generated?proof.activeGeneration:proof.creatorId);
 return row?.transactionId||'';
}

// Apply a bounded page by subtracting its old receipt and adding its current
// contribution. Replay, reassignment, reversal and a moved date use this path.
async function applyRows(db,creatorId,ids,source,now) {
 const previous=await db.$queryRawUnsafe('SELECT "transactionId",value FROM "FanLtvReceipt" WHERE "creatorId"=$1 AND "transactionId"=ANY($2::text[])',creatorId,ids);
 const old=new Map(previous.map(row=>[row.transactionId,row.value])),current=new Map(source.map(row=>[row.transactionId,row]));
 const balances=new Map(),metrics=new Map(),updates=[];
 const metric=(rangeKey,category,field,delta)=>{
  const id=key(rangeKey,category),row=metrics.get(id)||{rangeKey,category,values:{}};
  row.values[field]=(row.values[field]||0)+delta;metrics.set(id,row);
 };
 for(const id of ids){
  const before=old.get(id)||null,after=contribution(current.get(id),now);
  if(isDeepStrictEqual(before,after))continue;
  updates.push({transactionId:id,value:after,nextDueAt:after?.nextDueAt||null});
  for(const [value,sign] of [[before,-1],[after,1]])if(value)for(const rangeKey of value.ranges){
   for(const category of ['*',value.category]){
    metric(rangeKey,category,'netCents',sign*value.netCents);
    metric(rangeKey,category,value.fanId?'knownPayments':'unknownPayments',sign);
    if(value.fanId)metric(rangeKey,category,'knownNetCents',sign*value.netCents);
   }
   if(value.fanId){
    const id=key(rangeKey,value.fanId),row=balances.get(id)||{rangeKey,fanId:value.fanId,net:0,payments:0};
    row.net+=sign*value.netCents;row.payments+=sign;balances.set(id,row);
   }
  }
 }
 const balanceChanges=[...balances.values()].filter(row=>row.net||row.payments);
 const histogram=new Map();
 if(balanceChanges.length){
  const before=await db.$queryRawUnsafe(`SELECT b.* FROM "FanLtvBalance" b JOIN jsonb_to_recordset($2::jsonb) r("rangeKey" text,"fanId" text)
   ON b."rangeKey"=r."rangeKey" AND b."fanId"=r."fanId" WHERE b."creatorId"=$1`,creatorId,json(balanceChanges));
  const byKey=new Map(before.map(row=>[key(row.rangeKey,row.fanId),row]));
  const writes=balanceChanges.map(row=>{
   const prior=byKey.get(key(row.rangeKey,row.fanId)),net=integer(integer(prior?.netCents)+row.net),payments=integer(integer(prior?.payments)+row.payments);
   const was=integer(prior?.payments)>0,is=payments>0;
   if(!is&&net!==0)throw fail('FAN_LTV_BALANCE_INVALID');
   metric(row.rangeKey,'*','payingFans',Number(is)-Number(was));
   if(row.rangeKey==='all'){
    if(was)for(const p of prefixes(prior.netCents))histogram.set(p,(histogram.get(p)||0)-1);
    if(is)for(const p of prefixes(net))histogram.set(p,(histogram.get(p)||0)+1);
   }
   return {...row,netCents:net,payments};
  });
  await db.$executeRawUnsafe(`INSERT INTO "FanLtvBalance"("creatorId","rangeKey","fanId","netCents",payments)
   SELECT $1,r."rangeKey",r."fanId",r."netCents",r.payments FROM jsonb_to_recordset($2::jsonb) r("rangeKey" text,"fanId" text,"netCents" bigint,payments bigint)
   ON CONFLICT("creatorId","rangeKey","fanId") DO UPDATE SET "netCents"=EXCLUDED."netCents",payments=EXCLUDED.payments`,creatorId,json(writes));
  await db.$executeRawUnsafe(`DELETE FROM "FanLtvBalance" b USING jsonb_to_recordset($2::jsonb) r("rangeKey" text,"fanId" text)
   WHERE b."creatorId"=$1 AND b."rangeKey"=r."rangeKey" AND b."fanId"=r."fanId" AND b.payments=0`,creatorId,json(writes));
 }
 const changes=[...histogram].filter(([,delta])=>delta);
 if(changes.length){
  const prior=await db.$queryRawUnsafe('SELECT prefix,count FROM "FanLtvDistribution" WHERE "creatorId"=$1 AND prefix=ANY($2::text[])',creatorId,changes.map(([p])=>p));
  const counts=new Map(prior.map(row=>[row.prefix,integer(row.count)]));
  const writes=changes.map(([prefix,delta])=>({prefix,count:integer((counts.get(prefix)||0)+delta)}));
  await db.$executeRawUnsafe(`INSERT INTO "FanLtvDistribution"("creatorId",prefix,count)
   SELECT $1,r.prefix,r.count FROM jsonb_to_recordset($2::jsonb) r(prefix text,count bigint)
   ON CONFLICT("creatorId",prefix) DO UPDATE SET count=EXCLUDED.count`,creatorId,json(writes));
  await db.$executeRawUnsafe('DELETE FROM "FanLtvDistribution" WHERE "creatorId"=$1 AND prefix=ANY($2::text[]) AND count=0',creatorId,writes.map(row=>row.prefix));
 }
 const changedMetrics=[...metrics.values()];
 if(changedMetrics.length){
  const prior=await db.$queryRawUnsafe(`SELECT m.* FROM "FanLtvMetric" m JOIN jsonb_to_recordset($2::jsonb) r("rangeKey" text,category text)
   ON m."rangeKey"=r."rangeKey" AND m.category=r.category WHERE m."creatorId"=$1`,creatorId,json(changedMetrics));
  const byKey=new Map(prior.map(row=>[key(row.rangeKey,row.category),row.values]));
  const writes=changedMetrics.map(row=>({...row,values:Object.fromEntries(FIELDS.map(field=>[field,
   integer(integer(byKey.get(key(row.rangeKey,row.category))?.[field])+(row.values[field]||0))]))}));
  await db.$executeRawUnsafe(`INSERT INTO "FanLtvMetric"("creatorId","rangeKey",category,"values")
   SELECT $1,r."rangeKey",r.category,r."values" FROM jsonb_to_recordset($2::jsonb) r("rangeKey" text,category text,"values" jsonb)
   ON CONFLICT("creatorId","rangeKey",category) DO UPDATE SET "values"=EXCLUDED."values"`,creatorId,json(writes));
 }
 if(updates.length){
  await db.$executeRawUnsafe('DELETE FROM "FanLtvReceipt" WHERE "creatorId"=$1 AND "transactionId"=ANY($2::text[])',creatorId,updates.filter(row=>!row.value).map(row=>row.transactionId));
  const writes=updates.filter(row=>row.value);
  if(writes.length)await db.$executeRawUnsafe(`INSERT INTO "FanLtvReceipt"("creatorId","transactionId",value,"nextDueAt")
   SELECT $1,r."transactionId",r.value,r."nextDueAt" FROM jsonb_to_recordset($2::jsonb) r("transactionId" text,value jsonb,"nextDueAt" timestamp)
   ON CONFLICT("creatorId","transactionId") DO UPDATE SET value=EXCLUDED.value,"nextDueAt"=EXCLUDED."nextDueAt"`,creatorId,json(writes));
 }
 return updates.length;
}

async function median(db,creatorId,count) {
 if(!count)return null;
 const ranks=[Math.floor((count+1)/2),Math.floor(count/2)+1].map(rank=>({rank,prefix:''}));
 for(let depth=0;depth<7;depth++){
  const paths=[...new Set(ranks.flatMap(row=>Array.from({length:256},(_,i)=>row.prefix+i.toString(16).padStart(2,'0'))))];
  const rows=await db.$queryRawUnsafe('SELECT prefix,count FROM "FanLtvDistribution" WHERE "creatorId"=$1 AND prefix=ANY($2::text[])',creatorId,paths);
  const found=new Map(rows.map(row=>[row.prefix,integer(row.count)]));
  for(const row of ranks){let selected=false;
   for(let n=0;n<256;n++){const prefix=row.prefix+n.toString(16).padStart(2,'0'),size=found.get(prefix)||0;
    if(row.rank<=size){row.prefix=prefix;selected=true;break;}row.rank-=size;}
   if(!selected)throw fail('FAN_LTV_DISTRIBUTION_INVALID');
  }
 }
 return Number((BigInt('0x'+ranks[0].prefix)+BigInt('0x'+ranks[1].prefix)+1n)/2n);
}
async function publishSnapshot(db,proof,state,now) {
 const rows=await db.$queryRawUnsafe('SELECT "rangeKey",category,"values" FROM "FanLtvMetric" WHERE "creatorId"=$1',proof.creatorId);
 const ranges=Object.fromEntries(RANGES.map(range=>[range,rangeDto(rows.find(row=>row.rangeKey===range&&row.category==='*')?.values,
  rows.filter(row=>row.rangeKey===range&&row.category!=='*'))]));
 const snapshot={version:1,sourceKey:sourceKey(proof),proofGeneration:proof.generation,fromAt:proof.fromAt.toISOString(),throughAt:proof.throughAt.toISOString(),
  historyComplete:proof.fullScan===true&&Boolean(proof.publishedAt),windowDay:utcDay(now).toISOString().slice(0,10),
  medianCents:await median(db,proof.creatorId,ranges.all.payingFans),ranges,asOf:now.toISOString()};
 // Idle daily wakes update period boundaries, but do not manufacture a fresh
 // financial observation: freshness is still read from the money authority.
 await db.$executeRawUnsafe('UPDATE "FanLtvState" SET snapshot=$2::jsonb,"updatedAt"=$3 WHERE "creatorId"=$1',proof.creatorId,json(snapshot),now);
 const { hashCanonicalJson }=require('./realtime-receipt-hash');
 await require('./creator-entity-change-service').publishEntityChanges({db,agencyId:proof.agencyId,creatorId:proof.creatorId,
  changes:[{entityType:'HOME',entityId:proof.creatorId,sourceIdentity:'FanLtvProjection',sourceVersion:hashCanonicalJson(snapshot),payload:{reason:'FAN_LTV_PUBLISHED'}}]});
 return snapshot;
}

async function processPage({db,item,ownerToken}) {
 if(item.workClass!==WORK_CLASS||item.objectId!==item.creatorId)throw fail('FAN_LTV_SCOPE_INVALID');
 return runRootCommit(db,async({tx})=>{
  const lifecycle=await lockAgencyLifecycleBarrier({db:tx,agencyId:item.agencyId});
  if(await pauseDeletedAgencyProjection({db:tx,lifecycle,item,ownerToken}))return {processed:0,paused:true};
  // Writers lock money before their wake. Never wait for money while holding
  // the durable work row in the reverse order.
  if(!await earnings.tryLock(tx,item.creatorId)){own(await work.yieldDomainWorkClaim({db:tx,item,ownerToken,availableAt:new Date(Date.now()+1000)}));return {processed:0,busy:true};}
  own(await work.lockDomainWorkClaimForCommit({db:tx,item,ownerToken}));
  const [proof]=await tx.$queryRawUnsafe(`SELECT p.*,g."fullScan",g."publishedAt" FROM "CreatorEarningsLedgerProof" p
   JOIN "CreatorAccount" c ON c.id=p."creatorId" AND c."agencyId"=p."agencyId" AND c."deletedAt" IS NULL
   LEFT JOIN "CreatorEarningsGeneration" g ON g.id=p."activeGeneration"
   WHERE p."creatorId"=$1 AND p."agencyId"=$2`,item.creatorId,item.agencyId);
  if(!proof||!lifecycle.row||lifecycle.row.deletedAt){own(await work.ackDomainWorkClaim({db:tx,item,ownerToken}));return {processed:0,completed:true};}
  await tx.$executeRawUnsafe("SELECT set_config('onlinod.fan_ltv_writer','178',true)");
  const now=await dbAuthorityNow({db:tx});
  let [state]=await tx.$queryRawUnsafe('SELECT * FROM "FanLtvState" WHERE "creatorId"=$1 FOR UPDATE',item.creatorId);
  if(!state)throw fail('FAN_LTV_STATE_MISSING');
  const current=sourceKey(proof);let processed=0;
  if(state.sourceKey!==current){
   state={...state,sourceKey:current,stage:'RESET',resetStage:0,cursor:'',upperId:await sourceUpper(tx,proof)};
   await tx.$executeRawUnsafe('UPDATE "FanLtvState" SET "sourceKey"=$2,stage=\'RESET\',"resetStage"=0,cursor=\'\',"upperId"=$3 WHERE "creatorId"=$1',item.creatorId,current,state.upperId);
  }
  if(state.stage==='RESET'){
   for(let turn=state.resetStage;turn<RESET_TABLES.length;turn++){
    const table=RESET_TABLES[turn];
    const deleted=await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ctid IN (SELECT ctid FROM "${table}" WHERE "creatorId"=$1 LIMIT $2)`,item.creatorId,PAGE);
    processed+=deleted;if(deleted===PAGE){state.resetStage=turn;break;}state.resetStage=turn+1;
   }
   if(state.resetStage===RESET_TABLES.length)state.stage='SEED';
   await tx.$executeRawUnsafe('UPDATE "FanLtvState" SET stage=$2,"resetStage"=$3 WHERE "creatorId"=$1',item.creatorId,state.stage,state.resetStage);
  }else if(state.stage==='SEED'){
   const rows=await sourceRows(tx,proof,{after:state.cursor,upper:state.upperId});
   processed=await applyRows(tx,item.creatorId,rows.map(row=>row.transactionId),rows,now);
   state.cursor=rows.at(-1)?.transactionId||state.cursor;if(rows.length<PAGE)state.stage='LIVE';
   await tx.$executeRawUnsafe('UPDATE "FanLtvState" SET stage=$2,cursor=$3 WHERE "creatorId"=$1',item.creatorId,state.stage,state.cursor);
  }else if(state.stage==='LIVE'){
   const changes=await tx.$queryRawUnsafe('SELECT "transactionId" FROM "FanLtvChange" WHERE "creatorId"=$1 ORDER BY "transactionId" LIMIT $2',item.creatorId,PAGE);
   const due=changes.length?[]:await tx.$queryRawUnsafe('SELECT "transactionId" FROM "FanLtvReceipt" WHERE "creatorId"=$1 AND "nextDueAt"<=$2 ORDER BY "nextDueAt","transactionId" LIMIT $3',item.creatorId,now,PAGE);
   const ids=(changes.length?changes:due).map(row=>row.transactionId);
   if(ids.length)processed=await applyRows(tx,item.creatorId,ids,await sourceRows(tx,proof,{ids}),now);
   if(changes.length)await tx.$executeRawUnsafe('DELETE FROM "FanLtvChange" WHERE "creatorId"=$1 AND "transactionId"=ANY($2::text[])',item.creatorId,ids);
  }else throw fail('FAN_LTV_STAGE_INVALID');
  const [remaining]=await tx.$queryRawUnsafe('SELECT "transactionId" FROM "FanLtvChange" WHERE "creatorId"=$1 LIMIT 1',item.creatorId);
  const [next]=await tx.$queryRawUnsafe('SELECT "nextDueAt" FROM "FanLtvReceipt" WHERE "creatorId"=$1 AND "nextDueAt" IS NOT NULL ORDER BY "nextDueAt","transactionId" LIMIT 1',item.creatorId);
  const drained=state.stage==='LIVE'&&!remaining&&(!next||next.nextDueAt>now);
  if(drained)await publishSnapshot(tx,proof,state,now);
  const wake=drained?new Date(Math.min(+utcDay(now)+DAY_MS,next?+next.nextDueAt:Infinity)):now;
  own(await work.yieldDomainWorkClaim({db:tx,item,ownerToken,availableAt:wake,progressCursor:{stage:state.stage,cursor:state.cursor}}));
  return {processed,completed:drained,stage:state.stage,nextAt:wake.toISOString()};
 },{profile:'JOB_CHUNK',timeout:15000,authority:{kind:WORK_CLASS,agencyId:item.agencyId,creatorId:item.creatorId}});
}

async function enumerateAdoption({db}) {
 return runRootCommit(db,async({tx})=>{
  await tx.$executeRawUnsafe(`INSERT INTO "MaintenanceLaneState"(key,generation,cursor,"updatedAt")
   VALUES($1,$1,jsonb_build_object('afterId','','upperId',COALESCE((SELECT id FROM "CreatorAccount" ORDER BY id DESC LIMIT 1),'')),CURRENT_TIMESTAMP)
   ON CONFLICT(key) DO NOTHING`,ADOPTION_KEY);
  const [state]=await tx.$queryRawUnsafe('SELECT cursor,"completedAt" FROM "MaintenanceLaneState" WHERE key=$1 FOR UPDATE SKIP LOCKED',ADOPTION_KEY);
  if(!state||state.completedAt)return {visited:0,completed:Boolean(state?.completedAt)};
  const rows=await tx.$queryRawUnsafe(`WITH page AS MATERIALIZED (SELECT id,"agencyId" FROM "CreatorAccount" WHERE id>$1 AND id<=$2 ORDER BY id LIMIT 25)
   SELECT c.*,p."creatorId" AS relevant FROM page c LEFT JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=c.id ORDER BY c.id`,state.cursor.afterId,state.cursor.upperId);
  for(const row of rows)if(row.relevant){await lockAgencyLifecycleBarrier({db:tx,agencyId:row.agencyId});
   await tx.$executeRawUnsafe('SELECT onlinod_fan_ltv_wake178($1,$2)',row.agencyId,row.id);}
  const completed=rows.length<25||rows.at(-1)?.id===state.cursor.upperId;
  await tx.maintenanceLaneState.update({where:{key:ADOPTION_KEY},data:{cursor:{afterId:rows.at(-1)?.id||state.cursor.afterId,upperId:state.cursor.upperId},completedAt:completed?await dbAuthorityNow({db:tx}):null}});
  return {visited:rows.length,completed};
 },{profile:'JOB_CHUNK'});
}
async function runSweep({db=require('../prisma'),limit=4,maxRuntimeMs=4000}={}) {
 const started=performance.now(),report={ok:true,seed:await enumerateAdoption({db}),processed:0,completed:0,errors:[]};
 for(let i=0;i<Math.min(8,Math.max(1,limit))&&(i===0||performance.now()-started<maxRuntimeMs);i++){
  const claim=await work.claimDomainWorkBatch({db,workClass:WORK_CLASS,limit:1,perAgencyQuantum:1,perPartitionQuantum:1,leaseMs:120000});
  if(claim.skipped&&!['creator_lifecycle_contended','none_due'].includes(claim.reason)){report.ok=false;report.errors.push(claim.reason);break;}
  const item=claim.items?.[0];if(!item)break;
  try{const result=await processPage({db,item,ownerToken:claim.ownerToken});report.processed++;if(result.completed)report.completed++;}
  catch(error){await work.failDomainWorkClaim({db,item,ownerToken:claim.ownerToken,error});report.ok=false;report.errors.push(error.code||error.message);}
 }
 return report;
}
module.exports={WORK_CLASS,ADOPTION_KEY,PAGE,sourceKey,sourceRows,applyRows,median,publishSnapshot,processPage,enumerateAdoption,runSweep};
