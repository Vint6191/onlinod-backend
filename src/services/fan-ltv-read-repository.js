"use strict";
const { normalizeCreatorOverviewRangeKey, displayRangeBounds, utcDay }=require('./analytics-range-contract');
const { sourceKey }=require('./fan-ltv-projection-service');
const { readLiveEarningsCoverage }=require('./earnings-live-read-sql');

// This read never asks the provider for a scan, creates work, or reads financial
// history/fan lists. Its data is one committed snapshot and bounded debt probes.
async function readFanLtv({db,creatorId,rangeKey='30d',now=new Date()}) {
 const range=normalizeCreatorOverviewRangeKey(rangeKey),today=utcDay(now).toISOString().slice(0,10);
 const [row]=await db.$queryRawUnsafe(`SELECT p.*,s.snapshot,s.stage,s."sourceKey",
  EXISTS(SELECT 1 FROM "FanLtvChange" x WHERE x."creatorId"=c.id) AS dirty,
  EXISTS(SELECT 1 FROM "FanLtvReceipt" x WHERE x."creatorId"=c.id AND x."nextDueAt"<=$2) AS due,
  EXISTS(SELECT 1 FROM "DomainWorkItem" w WHERE w."creatorId"=c.id AND w."workClass"='FAN_LTV_PROJECTION'
    AND w."isOutstanding" AND w.state='RECONCILE_REQUIRED') AS failed
 FROM "CreatorAccount" c JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=c.id AND p."agencyId"=c."agencyId"
 LEFT JOIN "FanLtvState" s ON s."creatorId"=c.id AND s."agencyId"=c."agencyId"
 WHERE c.id=$1 AND c."deletedAt" IS NULL`,creatorId,now);
 const snapshot=row?.snapshot?.version===1?row.snapshot:null;
 const available=Boolean(snapshot),sameSource=Boolean(snapshot&&snapshot.sourceKey===sourceKey(row));
 const pending=!snapshot||!sameSource||row.stage!=='LIVE'||row.dirty||row.due||snapshot.windowDay!==today
  ||snapshot.proofGeneration!==row.generation||snapshot.throughAt!==row.throughAt.toISOString();
 const coverage=row?await readLiveEarningsCoverage(db,creatorId,now):null;
 const bounds=displayRangeBounds(range,now),periodAvailable=sameSource&&snapshot.windowDay===today;
 const allTime=snapshot?{...snapshot.ranges.all,medianCents:snapshot.medianCents,
  historyComplete:snapshot.historyComplete,complete:snapshot.historyComplete&&snapshot.ranges.all.attributionComplete}:null;
 const period=periodAvailable?{...snapshot.ranges[range],rangeKey:range,startAt:bounds.startAt.toISOString(),endAt:bounds.endAt.toISOString(),
  historyComplete:snapshot.historyComplete||(new Date(snapshot.fromAt)<=bounds.startAt&&new Date(snapshot.throughAt)>=bounds.endDay)}:null;
 return {version:1,available,pending:Boolean(pending),fresh:available&&!pending&&coverage?.fresh===true,
  state:row?.failed?'NEEDS_ATTENTION':!available?'PREPARING':pending?'UPDATING':'READY',
  asOf:snapshot?.asOf||null,fromAt:snapshot?.fromAt||null,throughAt:snapshot?.throughAt||null,allTime,period};
}
module.exports={readFanLtv};
