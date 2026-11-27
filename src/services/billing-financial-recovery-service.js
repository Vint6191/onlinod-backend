"use strict";
const DAY=86400000;
const receipts=require("./financial-receipt-authority");
const fail=code=>Object.assign(new Error(code),{code,status:409});
function targeted(job){return job?.jobKey==="financial_transactions_scan"&&job.params?.billingRecoveryVersion===1;}
function windowValid(params,now) {
  return params?.billingRecoveryVersion===1 && params.financialReceiptVersion===1 && params.financialTraversalVersion===2
    && params.collectionContractVersion===1 && params.collectionType==="FINANCIAL" && params.collectionMode==="catchup"
    && require("./billing-execution-access-service").recoveryWindow(params,now)
    && Date.parse(params.scanTo)-Date.parse(params.scanFrom)===29*DAY
    && +receipts.date(params.startDate)===Date.parse(params.scanFrom)
    && +receipts.date(params.endDate)===Date.parse(params.scanTo)+DAY-1000;
}
function assertCommand(job) {
  if(!targeted(job)||!windowValid(job.params,receipts.date(job.params.collectionRequestedAt)))throw fail("BILLING_FINANCIAL_WINDOW_INVALID");
  receipts.windowsFor(job);
  return true;
}
async function plan({db,agencyId,creatorId,now}) {
  const control=require("./analytics-collector-control-service");
  return control.withCollectorStateLock({db,type:control.COLLECTOR_TYPES.FINANCIAL,creatorId,work:async tx=>{
    const today=Math.floor(+now/DAY)*DAY,scanFrom=new Date(today-30*DAY).toISOString().slice(0,10),scanTo=new Date(today-DAY).toISOString().slice(0,10);
    const existing=await tx.jobInstance.findFirst({where:{agencyId,creatorId,jobKey:"financial_transactions_scan",
      status:{in:["SCHEDULED","CLAIMED","PUBLISHING","PAUSED"]},AND:[
        {params:{path:["billingRecoveryVersion"],equals:1}},{params:{path:["scanFrom"],equals:scanFrom}},{params:{path:["scanTo"],equals:scanTo}}]},orderBy:{createdAt:"desc"}});
    if(existing){
      const resumed=existing.status==="PAUSED"?await require("./job-planning-repository").reschedulePlannedJob({db:tx,job:existing,
        params:existing.params,priority:100,scheduledAt:now,nextRunAt:now,continuation:existing.continuation,resetAttempts:false,protectedStatuses:[]}):null;
      return {job:resumed?.job||existing,created:false,scanFrom,scanTo};
    }
    const params=control.stampCollectionAuthorityParams({
      ...control.buildCollectionCommand({collectorType:"FINANCIAL",collectionMode:"catchup",reason:"BILLING_RECOVERY",now}),
      billingRecoveryVersion:1,financialReceiptVersion:1,financialTraversalVersion:2,
      analyticsContractVersion:1,sourceTimezone:"UTC",scanFrom,scanTo,
      startDate:scanFrom+"T00:00:00.000Z",endDate:scanTo+"T23:59:59.000Z",schemaVersion:1,collectorVersion:receipts.COLLECTOR,
    },now);
    const planned=await require("./job-planning-repository").createPlannedJobIfAbsent({db:tx,agencyId,creatorId,
      jobKey:"financial_transactions_scan",scope:"creator",params,priority:100,scheduledAt:now,nextRunAt:now,
      idempotencyKey:`billing-recovery:${creatorId}:${params.collectionGeneration}`});
    return {job:planned.job,created:planned.created,scanFrom,scanTo};
  }});
}
async function publish({db,job,receipt,now}) {
  assertCommand(job);
  const run=receipt.row,window=run?.windows?.[0],proof=run?.proof?.windows?.[0];
  if(!receipt.complete||run?.jobId!==job.id||run.agencyId!==job.agencyId||run.creatorId!==job.creatorId
    ||window?.kind!=="BILLING"||!proof?.exhausted||!proof.matched||proof.rejected!==0||run.proof.semanticsVersion!==3)
    throw fail("BILLING_FINANCIAL_PROOF_INCOMPLETE");
  const totals=receipts.earningsTotals(proof),observedAt=require("./analytics-observation-time").observationStartForJob(job);
  if(!observedAt||!Number.isSafeInteger(totals.netCents)||totals.netCents<0)throw fail("BILLING_FINANCIAL_PROOF_INVALID");
  await receipts.enter(db);
  // The price snapshot owns only its closed 30-day interval. It cannot advance
  // the historical money ledger, resolve global debt, or grant paid execution.
  await db.$executeRawUnsafe(`INSERT INTO "CreatorBillingRecoverySnapshot"
    ("creatorId","agencyId","fromDay","toDay","netCents","transactionsCount","observedAt","publishedAt","receiptId",proof)
    VALUES($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT("creatorId") DO UPDATE SET "fromDay"=EXCLUDED."fromDay","toDay"=EXCLUDED."toDay",
      "netCents"=EXCLUDED."netCents","transactionsCount"=EXCLUDED."transactionsCount","observedAt"=EXCLUDED."observedAt",
      "publishedAt"=EXCLUDED."publishedAt","receiptId"=EXCLUDED."receiptId",proof=EXCLUDED.proof
    WHERE "CreatorBillingRecoverySnapshot"."agencyId"=EXCLUDED."agencyId"
      AND "CreatorBillingRecoverySnapshot"."observedAt"<=EXCLUDED."observedAt"`,job.creatorId,job.agencyId,
    job.params.scanFrom,job.params.scanTo,totals.netCents,totals.transactionsCount,observedAt,now,run.id,
    JSON.stringify({version:1,semanticsVersion:3,windows:run.windows,proof:run.proof}));
  return {ok:true,complete:true,protocolCurrent:true,type:"billing_financial_recovery",traversalComplete:true,
    verification:"VERIFIED",published:true,historyRead:false,scanRunId:run.generation};
}
module.exports={targeted,windowValid,assertCommand,plan,publish};
