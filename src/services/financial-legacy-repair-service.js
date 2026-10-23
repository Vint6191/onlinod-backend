"use strict";

// One bounded upgrade pass. Published earnings identities are authoritative;
// a canonical row left by an old failed scan supplies no monetary proof.
const { createHash } = require("node:crypto");
const { lockCreatorFacts } = require("./creator-fact-write-authority");
const PAGE = 100;
async function repairPage({ db, agencyId, creatorId, afterId = "", now }) {
  // A verified snapshot applies canonical pages before its final pointer swap.
  // Never restore those pages from the preceding active generation in between.
  // The caller holds the same earnings lock as preparePage/publish/live.
  const builds = await db.$queryRawUnsafe(`SELECT g.id,
      EXISTS(SELECT 1 FROM "FinancialReceiptRun" r JOIN "JobInstance" j ON j.id=r."jobId"
        JOIN "AnalyticsPublication" p ON p."jobId"=j.id AND p."agencyId"=g."agencyId" AND p."creatorId"=g."creatorId"
        WHERE r.id=g."runId" AND r."creatorId"=g."creatorId" AND r."agencyId"=g."agencyId"
          AND j.status='PUBLISHING' AND j.params->>'collectionGeneration'=r.generation
          AND p.state='PENDING' AND p.payload->>'scanRunId'=r.generation) AS pending
    FROM "CreatorEarningsGeneration" g WHERE g."creatorId"=$1 AND g."agencyId"=$2
      AND g.state IN ('BUILDING','READY') ORDER BY g.id LIMIT 10`, creatorId, agencyId);
  if (builds.some(row => row.pending)) return { waiting: true, processed: 0, complete: false, afterId, reason: "FINANCIAL_PUBLICATION_IN_PROGRESS" };
  if (builds.length) await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET state='RETIRED',"retiredAt"=$2
    WHERE id=ANY($1::text[]) AND state IN ('BUILDING','READY')`, builds.map(row=>row.id), now);
  if (builds.length === 10) return { waiting: true, processed: 0, complete: false, afterId, reason: "FINANCIAL_ORPHAN_GENERATIONS_RETIRING" };
  await lockCreatorFacts(db, agencyId, creatorId);
  const rows = await db.$queryRawUnsafe(`SELECT f.*,
      COALESCE(e."netCents",l."netCents") AS "verifiedNet",COALESCE(e.status,l.status) AS "verifiedStatus",
      COALESCE(e.category,l.category) AS "verifiedCategory",
      COALESCE(e."grossCents",l."grossCents") AS "verifiedGross",
      COALESCE(e."occurredAt",l."occurredAt") AS "verifiedOccurredAt",
      COALESCE(e."observedAt",l."observedAt") AS "verifiedObservedAt"
    FROM "CreatorFinancialTransaction" f
    LEFT JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=f."creatorId" AND p."agencyId"=f."agencyId"
    LEFT JOIN "CreatorEarningsGenerationEntry" e ON e.generation=p."activeGeneration" AND e."transactionId"=f."externalTransactionId"
    LEFT JOIN "CreatorEarningsLedgerEntry" l ON p."activeGeneration" IS NULL AND l."creatorId"=f."creatorId"
      AND l."agencyId"=f."agencyId" AND l."transactionId"=f."externalTransactionId"
    WHERE f."agencyId"=$1 AND f."creatorId"=$2 AND f.id>$3 ORDER BY f.id LIMIT $4`, agencyId, creatorId, afterId, PAGE);
  if (!rows.length) return { processed: 0, complete: true, afterId };
  const values = rows.map(row => ({ id: row.id, transactionId: row.externalTransactionId,
    status: row.verifiedStatus || "unverified", net: row.verifiedNet == null ? null : Number(row.verifiedNet),
    gross: row.verifiedGross == null ? null : Number(row.verifiedGross),
    occurredAt: row.verifiedOccurredAt || row.occurredAt, observedAt: row.verifiedObservedAt || now,
    reason: row.verifiedNet == null ? "LEGACY_FINANCIAL_UNVERIFIED" : row.verifiedGross == null ? "GROSS_UNAVAILABLE" : null }));
  const unverifiedValues=values.filter(row=>row.reason==="LEGACY_FINANCIAL_UNVERIFIED");
  const input = JSON.stringify(unverifiedValues);
  const fields = 'id text,"transactionId" text,status text,net integer,gross integer,"occurredAt" timestamp,"observedAt" timestamp,reason text';
  const sales=[],tips=[];
  if(unverifiedValues.length){
    await db.$executeRawUnsafe(`UPDATE "CreatorFinancialTransaction" f SET "netCents"=v.net,"amountCents"=v.gross,
      "transactionStatus"=v.status,"occurredAt"=v."occurredAt","sourceUpdatedAt"=v."observedAt","reasonCode"=v.reason,
      "projectionStatus"=CASE WHEN v.status='unverified' THEN 'STORED_ONLY'::"CreatorFinancialTransactionProjectionStatus" ELSE f."projectionStatus" END,"updatedAt"=$2
    FROM jsonb_to_recordset($1::jsonb) v(${fields}) WHERE f.id=v.id`, input, now);
    sales.push(...await db.$queryRawUnsafe(`UPDATE "CreatorSale" f SET "netCents"=v.net,"amountCents"=v.gross,
      "transactionStatus"=v.status,"purchasedAt"=v."occurredAt","sourceUpdatedAt"=v."observedAt","updatedAt"=$4
    FROM jsonb_to_recordset($1::jsonb) v(${fields}) WHERE f."creatorId"=$2 AND f."agencyId"=$3 AND f."externalTransactionId"=v."transactionId" RETURNING f.id`, input, creatorId, agencyId, now));
    tips.push(...await db.$queryRawUnsafe(`UPDATE "CreatorTip" f SET "netCents"=v.net,"amountCents"=v.gross,
      "transactionStatus"=v.status,"tippedAt"=v."occurredAt","sourceUpdatedAt"=v."observedAt","updatedAt"=$4
    FROM jsonb_to_recordset($1::jsonb) v(${fields}) WHERE f."creatorId"=$2 AND f."agencyId"=$3 AND f."externalTransactionId"=v."transactionId" RETURNING f.id`, input, creatorId, agencyId, now));
  }
  // A failed old scan may also have changed the classification, leaving both
  // a Sale and a Tip for one identity. Restore the verified category and use
  // the same canonical publisher as new verified facts, including withdrawal
  // of the opposite projection and recreation of a missing correct one.
  const category=require("./financial-transaction-category");
  const categoryTypes={messages:"message",posts:"post",streams:"stream",tips:"tip",subscriptions:"subscription",other:"other"};
  const existing=new Map(rows.map(row=>[row.externalTransactionId,{...row,fanRecordId:row.fanId}]));
  const verified=rows.filter(row=>row.verifiedNet!=null).map((row,index)=>{
    const transactionType=category.categoryForTransactionType(row.transactionType)===row.verifiedCategory
      ?row.transactionType:categoryTypes[row.verifiedCategory];
    if(!transactionType)throw new Error("LEGACY_FINANCIAL_CATEGORY_INVALID");
    const normalized=require("./financial-transactions-service").normalizeTransaction({...row,transactionType,
      amountCents:row.verifiedGross==null?null:Number(row.verifiedGross),netCents:Number(row.verifiedNet),
      transactionStatus:row.verifiedStatus,occurredAt:row.verifiedOccurredAt,currency:"USD",
      fanUsername:row.fanUsernameAtEvent,fanDisplayName:row.fanDisplayNameAtEvent,fanAvatarUrl:row.fanAvatarUrlAtEvent},index,row.page||1);
    if(normalized.rejected)throw new Error("LEGACY_FINANCIAL_VERIFIED_FACT_INVALID");
    return {...normalized,sourceUpdatedAt:row.verifiedObservedAt};
  });
  if(verified.length){
    const restored=await require("./financial-canonical-publication-repository").publish({db,job:{agencyId,creatorId},rows:verified,
      existing,participants:{fans:new Map()},deviceId:null,observedAt:now,now,catchup:true,restoringVerifiedLedger:true});
    sales.push(...restored.SALE.map(id=>({id})));tips.push(...restored.TIP.map(id=>({id})));
  }
  const unverified = unverifiedValues.map(row => ({
    id: createHash("sha256").update(JSON.stringify([creatorId,row.transactionId,"legacy-financial-repair-172"])).digest("hex"),
    transactionId: row.transactionId, occurredAt: row.occurredAt,
  }));
  if (unverified.length) {
    await db.$executeRawUnsafe(`INSERT INTO "CreatorMoneyObservation"(id,"agencyId","creatorId","transactionId","occurredAt","capturedAt",status,reason)
      SELECT v.id,$1,$2,v."transactionId",v."occurredAt",$4,'PENDING','LEGACY_FINANCIAL_UNVERIFIED'
      FROM jsonb_to_recordset($3::jsonb) v(id text,"transactionId" text,"occurredAt" timestamp) ON CONFLICT(id) DO NOTHING`, agencyId, creatorId, JSON.stringify(unverified), now);
    await require("./money-resolution-service").enqueue({ db, agencyId, creatorId, now });
  }
  // SQL triggers publish Team/campaign/analytics debt atomically; reverse
  // client/media corrections use the existing canonical publication owner.
  if (sales.length) await require("./creator-entity-change-service").publishCanonicalSales({ db, agencyId, creatorId, saleIds: sales.map(row => row.id) });
  if (tips.length) await require("./creator-entity-change-service").publishCanonicalFactInvalidations({ db, agencyId, creatorId, model: "creatorTip", ids: tips.map(row => row.id) });
  return { processed: rows.length, quarantined: unverified.length, complete: rows.length < PAGE, afterId: rows.at(-1).id };
}
module.exports = { repairPage, PAGE };
