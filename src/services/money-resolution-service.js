"use strict";
// This queue is created by incomplete money events. Its timer reads durable work
// only: it never invents a source scan for a healthy, idle creator.
const work = require("./domain-work-authority-service");
const { runRootCommit } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const control = require("./analytics-collector-control-service");
const WORK_CLASS = "MONEY_RESOLUTION", MAX_ATTEMPTS = 6;
const unresolved = `m.status='PENDING' AND m."resolutionBlockedAt" IS NULL
  AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" g WHERE g.id=m."coveredGeneration" AND g."publishedAt" IS NOT NULL)`;

async function enqueue({ db, agencyId, creatorId, now }) {
  const rows = await db.$queryRawUnsafe(`INSERT INTO "CreatorMoneyResolutionRequest"("creatorId","agencyId","updatedAt")
    VALUES($1,$2,$3) ON CONFLICT("creatorId") DO UPDATE SET queued=true,"updatedAt"=$3
    WHERE NOT "CreatorMoneyResolutionRequest".queued RETURNING "creatorId"`,creatorId,agencyId,now);
  if (rows.length) await work.publishDomainWork({ db, agencyId, creatorId, workClass:WORK_CLASS,
    objectType:"CreatorAccount",objectId:creatorId,partitionKey:creatorId,availableAt:new Date(+now+5000) });
  require("./analytics-hot-executor").wakeAfterCommit();
}

async function adoptPage(db) {
  return runRootCommit(db,async({tx})=>{
    const [state]=await tx.$queryRawUnsafe(`SELECT * FROM "MoneyResolutionAdoption" WHERE id='v7' AND NOT complete FOR UPDATE SKIP LOCKED`);
    if(!state)return 0;
    const rows=await tx.$queryRawUnsafe(`SELECT m.id,m."agencyId",m."creatorId",EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" g WHERE g.id=m."coveredGeneration" AND g."publishedAt" IS NOT NULL) AS covered FROM "CreatorMoneyObservation" m
      WHERE m.id>$1 AND m.status='PENDING' AND m."resolutionBlockedAt" IS NULL ORDER BY m.id LIMIT 100`,state.cursor);
    const now=await dbAuthorityNow({db:tx});
    const creators=[...new Map(rows.filter(x=>!x.covered).map(x=>[x.creatorId,x])).values()].sort((a,b)=>a.creatorId.localeCompare(b.creatorId));
    for(const row of creators) { const life=await lockAgencyLifecycleBarrier({db:tx,agencyId:row.agencyId}); if(life.row && !life.row.deletedAt) await enqueue({db:tx,...row,now}); }
    await tx.$executeRawUnsafe(`UPDATE "MoneyResolutionAdoption" SET cursor=$1,complete=$2 WHERE id='v7'`,rows.at(-1)?.id||state.cursor,rows.length<100);
    return rows.length;
  },{profile:"JOB_CHUNK",authority:{kind:"MONEY_RESOLUTION_ADOPTION"}});
}
function owned(value) { if(!value || value.lost) throw Object.assign(Error("MONEY_RESOLUTION_CLAIM_LOST"),{code:"MONEY_RESOLUTION_CLAIM_LOST"}); }
async function processRequest({db,item,ownerToken}) {
  if(item.workClass!==WORK_CLASS || item.creatorId!==item.objectId)throw Error("MONEY_RESOLUTION_SCOPE_INVALID");
  return runRootCommit(db,async({tx})=>{
    const lifecycle=await lockAgencyLifecycleBarrier({db:tx,agencyId:item.agencyId});
    const [creator]=await tx.$queryRawUnsafe(`SELECT id FROM "CreatorAccount" WHERE id=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE`,item.creatorId,item.agencyId);
    // Same admission lock as every financial planner. Never wait on a job row
    // while holding it: completion takes job -> collector, in that order.
    const [gate]=await tx.$queryRawUnsafe("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS owned",`analytics-collector:financial:${item.creatorId}`);
    if(!gate.owned) {
      await work.yieldDomainWorkClaim({db:tx,item,ownerToken,availableAt:new Date(+await dbAuthorityNow({db:tx})+1000)});
      return {waiting:true};
    }
    // Delivery holds the creator money gate before observation -> request.
    // Resolution also needs that gate BEFORE request -> observation, including
    // cancellation/exhaustion. Otherwise a duplicate pending delivery can form
    // a row-lock cycle with this worker. Busy money yields durable work instead
    // of waiting while holding collector admission.
    if(!await require("./earnings-generation-service").tryLock(tx,item.creatorId)) {
      owned(await work.yieldDomainWorkClaim({db:tx,item,ownerToken,availableAt:new Date(+await dbAuthorityNow({db:tx})+1000)}));
      return {waiting:true,reason:"MONEY_BUSY"};
    }
    const [request]=await tx.$queryRawUnsafe(`SELECT * FROM "CreatorMoneyResolutionRequest" WHERE "creatorId"=$1 AND "agencyId"=$2 FOR UPDATE SKIP LOCKED`,item.creatorId,item.agencyId);
    owned(await work.lockDomainWorkClaimForCommit({db:tx,item,ownerToken}));
    const now=await dbAuthorityNow({db:tx});
    const wait=async(reason,ms=30000)=>{
      if(request)await tx.$executeRawUnsafe(`UPDATE "CreatorMoneyResolutionRequest" SET "lastError"=$2,"updatedAt"=$3 WHERE "creatorId"=$1`,item.creatorId,reason,now);
      owned(await work.yieldDomainWorkClaim({db:tx,item,ownerToken,availableAt:new Date(+now+ms)}));
      return {waiting:true,reason};
    };
    if(!lifecycle.row || lifecycle.row.deletedAt || !creator) {
      owned(await work.ackDomainWorkClaim({db:tx,item,ownerToken}));return {retired:true};
    }
    if(!request)return wait("REQUEST_BUSY",1000);
    const [target]=await tx.$queryRawUnsafe(`SELECT m.* FROM "CreatorMoneyObservation" m WHERE m."creatorId"=$1 AND ${unresolved}
      ORDER BY m."occurredAt",m.id LIMIT 1`,item.creatorId);
    if(!target) {
      await tx.$executeRawUnsafe(`UPDATE "CreatorMoneyResolutionRequest" SET queued=false,"targetId"=NULL,attempts=0,"jobId"=NULL,"lastError"=NULL,"updatedAt"=$2 WHERE "creatorId"=$1`,item.creatorId,now);
      owned(await work.ackDomainWorkClaim({db:tx,item,ownerToken}));return {idle:true};
    }
    const active=await tx.jobInstance.findFirst({where:{creatorId:item.creatorId,jobKey:"financial_transactions_scan",status:{in:["SCHEDULED","CLAIMED","PUBLISHING","PAUSED"]}},select:{id:true,status:true}});
    if(active)return wait(`FINANCIAL_${active.status}`,active.status==="PAUSED"?300000:30000);
    const [proof]=await tx.$queryRawUnsafe(`SELECT "activeGeneration" FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1`,item.creatorId);
    if(!proof?.activeGeneration)return wait("BASELINE_REQUIRED",300000);
    const prior=request.jobId?await tx.jobInstance.findUnique({where:{id:request.jobId},select:{status:true,lastError:true}}):null;
    const attempts=request.targetId===target.id?request.attempts:0;
    if(attempts>=MAX_ATTEMPTS || (request.targetId===target.id && prior?.status==="CANCELLED")) {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
      await tx.$executeRawUnsafe(`UPDATE "CreatorMoneyObservation" SET "resolutionBlockedAt"=$2,"resolutionError"=$3 WHERE id=$1`,target.id,now,prior?.status==="CANCELLED"?"RESOLUTION_CANCELLED":prior?.lastError||"RESOLUTION_ATTEMPTS_EXHAUSTED");
      return wait("RESOLUTION_REVIEW_REQUIRED",1000);
    }
    if(+target.capturedAt>+now-5000)return wait("SOURCE_SETTLING",Math.min(300000,Math.max(1000,+target.capturedAt+5000-now)));
    let occurred=target.occurredAt;
    if(target.transactionId) {
      const exact=await require("./earnings-generation-service").activeEntry(tx,item.creatorId,target.transactionId);
      if(exact)occurred=exact.occurredAt;
    }
    const from=new Date(Math.floor(+occurred/3600000)*3600000),to=new Date(Math.min(+from+3600000,Math.floor(+now/1000)*1000));
    if(+from>+to || +from<+new Date("2016-01-01T00:00:00Z"))return wait("SOURCE_TIME_INVALID",300000);
    const state=await tx.creatorFinancialCollectionState.findUnique({where:{creatorId:item.creatorId}});
    const params=control.stampCollectionAuthorityParams({
      ...control.buildCollectionCommand({collectorType:"FINANCIAL",collectionMode:"catchup",reason:"LIVE_MONEY_RESOLUTION",now}),
      financialMode:"catchup",moneyResolutionVersion:1,moneyResolutionObservationId:target.id,
      startDate:from.toISOString(),endDate:to.toISOString(),schemaVersion:1,
      collectorVersion:require("./financial-receipt-authority").COLLECTOR,
    },now,state?.activeRequestedAt);
    const planned=await require("./job-planning-repository").createPlannedJobIfAbsent({db:tx,
      jobKey:"financial_transactions_scan",scope:"creator",agencyId:item.agencyId,creatorId:item.creatorId,
      idempotencyKey:`money-resolution:${target.id}:${attempts+1}`,params,priority:40,scheduledAt:now,
      nextRunAt:new Date(+now+(attempts?Math.min(300000,10000*2**(attempts-1)):0))});
    await tx.$executeRawUnsafe(`UPDATE "CreatorMoneyResolutionRequest" SET "targetId"=$2,attempts=$3,"jobId"=$4,"lastError"=NULL,"updatedAt"=$5 WHERE "creatorId"=$1`,item.creatorId,target.id,attempts+1,planned.job.id,now);
    owned(await work.yieldDomainWorkClaim({db:tx,item,ownerToken,availableAt:new Date(+now+30000)}));
    return {created:planned.created,jobId:planned.job.id};
  },{profile:"JOB_CHUNK",authority:{kind:WORK_CLASS,agencyId:item.agencyId,creatorId:item.creatorId}});
}
async function runSweep({db,limit=2,maxRuntimeMs=2000}={}) {
  const report={ok:true,processed:0,created:0,failed:0,adopted:await adoptPage(db)},start=performance.now();
  const claim=await work.claimDomainWorkBatch({db,workClass:WORK_CLASS,limit:Math.min(8,limit),perAgencyQuantum:2,perPartitionQuantum:1});
  for(const item of claim.items||[]) {
    if(performance.now()-start>=maxRuntimeMs) {await work.yieldDomainWorkClaim({db,item,ownerToken:claim.ownerToken});continue;}
    try {const result=await processRequest({db,item,ownerToken:claim.ownerToken});report.processed++;report.created+=result.created?1:0;}
    catch(error){report.ok=false;report.failed++;await work.failDomainWorkClaim({db,item,ownerToken:claim.ownerToken,error});}
  }
  return report;
}
module.exports={WORK_CLASS,MAX_ATTEMPTS,enqueue,adoptPage,processRequest,runSweep};
