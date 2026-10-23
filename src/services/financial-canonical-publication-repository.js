"use strict";
const crypto = require("node:crypto");
const { retainKnownFan } = require("./creator-fact-write-authority");
const COMMON = ["agencyId","creatorId","fanId","fanOnlyFansUserIdAtEvent","fanUsernameAtEvent","fanDisplayNameAtEvent","fanAvatarUrlAtEvent",
  "externalTransactionId","amountCents","feeCents","netCents","taxCents","vatCents","mediaTaxCents","transactionStatus","currency",
  "source","sourceUpdatedAt","collectedAt","sourceDeviceId","sourceJobId","updatedAt"];
const FINANCIAL = ["agencyId","creatorId","fanId","fanOnlyFansUserId","fanUsernameAtEvent","fanDisplayNameAtEvent","fanAvatarUrlAtEvent",
  "externalTransactionId","transactionType","factType","projectionStatus","amountCents","feeCents","netCents","taxCents","vatCents","mediaTaxCents",
  "currency","occurredAt","transactionStatus","sourceUpdatedAt","collectedAt","sourceDeviceId","reasonCode","updatedAt","sourceJobId","scanRunId","page","ordinal"];
function wire(row) { const out = {...row,fanId:row.fanRecordId??null}; delete out.fanRecordId; return out; }
async function upsert(db,table,records,columns,extra=[]) {
  if(!records.length)return;
  if(!["CreatorFinancialTransaction","CreatorSale","CreatorTip"].includes(table))throw Error("FINANCIAL_PUBLICATION_TABLE_INVALID");
  const all=["id",...columns,"createdAt",...extra], quote=key=>'"'+key+'"';
  await db.$executeRawUnsafe(`INSERT INTO "${table}"(${all.map(quote).join(",")})
    SELECT ${all.map(key=>'v.'+quote(key)).join(",")} FROM jsonb_populate_recordset(NULL::"${table}",$1::jsonb) v ORDER BY v.id
    ON CONFLICT(id) DO UPDATE SET ${columns.map(key=>quote(key)+'=EXCLUDED.'+quote(key)).join(",")}`,
    JSON.stringify(records.map(wire),(_,value)=>typeof value==="bigint"?value.toString():value));
}
async function legacyCandidates(db,job,rows,kind) {
  if(!rows.length)return new Map();
  const table=kind==="SALE"?"CreatorSale":"CreatorTip",time=kind==="SALE"?"purchasedAt":"tippedAt";
  const records=rows.filter(row=>row.fanRecordId && row.amountCents!=null && row.amountCents>0).map(row=>({
    incomingId:row.externalTransactionId,fanId:row.fanRecordId,amountCents:row.amountCents,currency:row.currency,occurredAt:row.occurredAt,saleType:row.saleType||"OTHER"}));
  if(!records.length)return new Map();
  const found=await db.$queryRawUnsafe(`SELECT r."incomingId",f.* FROM jsonb_to_recordset($2::jsonb)
    r("incomingId" text,"fanId" text,"amountCents" integer,currency text,"occurredAt" timestamp,"saleType" text)
    CROSS JOIN LATERAL (SELECT * FROM "${table}" f WHERE f."creatorId"=$1 AND f."fanId"=r."fanId"
      AND f."externalTransactionId" IS NULL AND f."amountCents"=r."amountCents" AND f.currency=r.currency
      AND f."${time}" BETWEEN r."occurredAt"-interval '5 seconds' AND r."occurredAt"+interval '5 seconds'
      ${kind==="SALE"?'AND f."saleType"::text=r."saleType"':""} ORDER BY f."${time}",f.id LIMIT 2) f`,job.creatorId,JSON.stringify(records));
  const groups=new Map();for(const row of found){const group=groups.get(row.incomingId)||[];group.push({...row,fanRecordId:row.fanId});groups.set(row.incomingId,group);}
  return new Map([...groups].filter(([,group])=>group.length===1).map(([id,group])=>[id,group[0]]));
}
// A provider transaction has one current classification. An exact correction
// may move that identity to a different projection (or to a known zero). Keep
// the old row as historical evidence, but withdraw its contribution atomically.
// This is a verified replacement, not uncertain money requiring another scan.
async function supersede({db,job,rows,observedAt,now,restoringVerifiedLedger=false}) {
  if(rows.length>500)throw Error("FINANCIAL_PUBLICATION_PAGE_TOO_LARGE");
  const ids={SALE:[],TIP:[]};
  if(!rows.length)return ids;
  const input=JSON.stringify(rows.map(row=>({externalTransactionId:row.externalTransactionId,factType:row.factType,
    projected:row.projectionStatus==="PROJECTED",observedAt:row.sourceUpdatedAt||observedAt})));
  for(const [kind,table] of [["SALE","CreatorSale"],["TIP","CreatorTip"]]){
    const changed=await db.$queryRawUnsafe(`UPDATE "${table}" f SET "transactionStatus"='superseded',
      "amountCents"=NULL,"netCents"=NULL,"feeCents"=NULL,"taxCents"=NULL,"vatCents"=NULL,"mediaTaxCents"=NULL,
      "sourceUpdatedAt"=r."observedAt","updatedAt"=$4
      FROM jsonb_to_recordset($3::jsonb) r("externalTransactionId" text,"factType" text,projected boolean,"observedAt" timestamp)
      WHERE f."agencyId"=$1 AND f."creatorId"=$2 AND f."externalTransactionId"=r."externalTransactionId"
        AND (r."factType"<>$5 OR NOT r.projected)
        AND ($6 OR f."sourceUpdatedAt" IS NULL OR f."sourceUpdatedAt"<=r."observedAt")
        AND (f."transactionStatus" IS DISTINCT FROM 'superseded' OR f."amountCents" IS NOT NULL OR f."netCents" IS NOT NULL
          OR f."sourceUpdatedAt" IS DISTINCT FROM r."observedAt") RETURNING f.id`,job.agencyId,job.creatorId,input,now,kind,restoringVerifiedLedger);
    ids[kind]=changed.map(row=>row.id);
  }
  return ids;
}
async function publish({db,job,rows,existing,participants,deviceId,observedAt,now,scanRunId,catchup,restoringVerifiedLedger=false}) {
  if(rows.length>500)throw Error("FINANCIAL_PUBLICATION_PAGE_TOO_LARGE");
  const financial=rows.map(row=>{
    const previous=existing.get(row.externalTransactionId),fan=participants.fans.get(`${job.creatorId}\u0000${row.fanOnlyFansUserId}`);
    return retainKnownFan(previous,{...previous,id:previous?.id||crypto.randomUUID(),createdAt:previous?.createdAt||now,
      agencyId:job.agencyId,creatorId:job.creatorId,fanRecordId:fan?.id||null,fanOnlyFansUserId:row.fanOnlyFansUserId,
      fanUsernameAtEvent:row.fanUsername,fanDisplayNameAtEvent:row.fanDisplayName,fanAvatarUrlAtEvent:row.fanAvatarUrl,
      externalTransactionId:row.externalTransactionId,transactionType:row.transactionType,factType:row.factType,projectionStatus:row.projectionStatus,
      amountCents:row.amountCents,feeCents:row.feeCents,netCents:row.netCents,taxCents:row.taxCents,vatCents:row.vatCents,mediaTaxCents:row.mediaTaxCents,
      currency:row.currency,occurredAt:row.occurredAt,transactionStatus:row.transactionStatus,sourceUpdatedAt:row.sourceUpdatedAt||observedAt,collectedAt:now,
      sourceDeviceId:deviceId,reasonCode:row.reasonCode,updatedAt:now,
      ...(!previous||!catchup?{sourceJobId:job.id,scanRunId,page:row.page,ordinal:row.ordinal}:{})});
  });
  await upsert(db,"CreatorFinancialTransaction",financial,FINANCIAL);
  const ids=await supersede({db,job,rows,observedAt,now,restoringVerifiedLedger}), financialById=new Map(financial.map(row=>[row.externalTransactionId,row]));
  for(const kind of ["SALE","TIP"]){
    const model=kind==="SALE"?"creatorSale":"creatorTip",table=kind==="SALE"?"CreatorSale":"CreatorTip",time=kind==="SALE"?"purchasedAt":"tippedAt";
    const candidates=rows.filter(row=>row.factType===kind&&row.projectionStatus==="PROJECTED").map(row=>({...row,fanRecordId:financialById.get(row.externalTransactionId).fanRecordId}));
    if(!candidates.length)continue;
    const prior=await db[model].findMany({where:{creatorId:job.creatorId,externalTransactionId:{in:candidates.map(row=>row.externalTransactionId)}}});
    const byTransaction=new Map(prior.map(row=>[row.externalTransactionId,row]));
    const legacy=await legacyCandidates(db,job,candidates.filter(row=>!byTransaction.has(row.externalTransactionId)),kind),used=new Set(),records=[];
    for(const row of candidates){
      let previous=byTransaction.get(row.externalTransactionId)||legacy.get(row.externalTransactionId);
      if(previous && used.has(previous.id))previous=null;
      const revision=row.sourceUpdatedAt||observedAt;
      if(!restoringVerifiedLedger && previous?.sourceUpdatedAt && +previous.sourceUpdatedAt>+revision)continue;
      if(previous)used.add(previous.id);
      records.push(retainKnownFan(previous,{...previous,id:previous?.id||crypto.randomUUID(),createdAt:previous?.createdAt||now,
        eventFingerprint:previous?.eventFingerprint||crypto.createHash("sha256").update(`payout-transaction|${job.creatorId}|${row.externalTransactionId}`).digest("hex"),
        agencyId:job.agencyId,creatorId:job.creatorId,fanRecordId:row.fanRecordId,fanOnlyFansUserIdAtEvent:row.fanOnlyFansUserId,
        fanUsernameAtEvent:row.fanUsername,fanDisplayNameAtEvent:row.fanDisplayName,fanAvatarUrlAtEvent:row.fanAvatarUrl,
        externalTransactionId:row.externalTransactionId,amountCents:row.amountCents,feeCents:row.feeCents,netCents:row.netCents,taxCents:row.taxCents,
        vatCents:row.vatCents,mediaTaxCents:row.mediaTaxCents,transactionStatus:row.transactionStatus,currency:row.currency,
        source:"ONLYFANS_API",sourceUpdatedAt:revision,collectedAt:now,sourceDeviceId:deviceId,
        sourceJobId:job.id??financialById.get(row.externalTransactionId)?.sourceJobId??previous?.sourceJobId??null,updatedAt:now,
        [time]:row.occurredAt,...(kind==="SALE"?{saleType:row.saleType||"OTHER"}:{})}));
    }
    await upsert(db,table,records,[...COMMON,time,...(kind==="SALE"?["saleType"]:[])],["eventFingerprint"]);
    ids[kind].push(...records.map(row=>row.id));
  }
  return ids;
}
module.exports={publish,supersede};
