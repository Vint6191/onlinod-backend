"use strict";

// One bounded upgrade pass. Published earnings identities are authoritative;
// a canonical row left by an old failed scan supplies no monetary proof.
const { createHash } = require("node:crypto");
const { lockCreatorFacts } = require("./creator-fact-write-authority");
const PAGE = 100;
async function repairPage({ db, agencyId, creatorId, afterId = "", throughId = null, repairingGenerationId = null, now }) {
  // A verified snapshot applies canonical pages before its final pointer swap.
  // Never restore those pages from the preceding active generation in between.
  // The caller holds the same earnings lock as preparePage/publish/live.
  if (!repairingGenerationId) {
    const generations=require("./earnings-generation-service");
    const builds = await db.$queryRawUnsafe(`SELECT g.id,g.state,${generations.unpublishedGenerationOwnedSql()} AS pending
      FROM "CreatorEarningsGeneration" g WHERE g."creatorId"=$1 AND g."agencyId"=$2
        AND g.state IN ('BUILDING','READY','REPAIRING') ORDER BY g.id LIMIT 1`, creatorId, agencyId);
    const build=builds[0];
    if (build?.state!=="REPAIRING" && build?.pending) return { waiting: true, processed: 0, complete: false, afterId, reason: "FINANCIAL_PUBLICATION_IN_PROGRESS" };
    if (build) {
      const retired=await generations.retireUnpublished(db,build.id);
      if (retired?.state==="REPAIRING") {
        const restored=await generations.repairUnpublishedPage(db,build.id);
        return { waiting:true,processed:restored.processed,complete:false,afterId,reason:"FINANCIAL_CANONICAL_REPAIR_IN_PROGRESS" };
      }
    }
  }
  await lockCreatorFacts(db, agencyId, creatorId);
  const rows = await db.$queryRawUnsafe(`SELECT f.*,
      COALESCE(e."netCents",l."netCents") AS "verifiedNet",COALESCE(e.status,l.status) AS "verifiedStatus",
      COALESCE(e.category,l.category) AS "verifiedCategory",
      COALESCE(e."financialFact",l."financialFact") AS "verifiedFact",
      COALESCE(e."fanOnlyFansUserId",l."fanOnlyFansUserId") AS "verifiedFan",
      CASE WHEN e."observedAt"=active."snapshotAt" THEN (SELECT o.value FROM "FinancialObservedFact" o
        WHERE o."runId"=active."runId" AND o."windowIndex"=0 AND o."externalId"=e."transactionId") END AS "verifiedReceipt",
      (SELECT r."jobId" FROM "FinancialReceiptRun" r WHERE r.id=active."runId") AS "verifiedReceiptJobId",
      (SELECT r.generation FROM "FinancialReceiptRun" r WHERE r.id=active."runId") AS "verifiedReceiptGeneration",
      COALESCE(e."grossCents",l."grossCents") AS "verifiedGross",
      COALESCE(e."occurredAt",l."occurredAt") AS "verifiedOccurredAt",
      COALESCE(e."observedAt",l."observedAt") AS "verifiedObservedAt",
      active."snapshotAt" AS "activeSnapshotAt",active."fromAt" AS "activeFromAt",active."throughAt" AS "activeThroughAt",
      active."fullScan" AS "activeFullScan",active."publishedAt" AS "activePublishedAt",active."proofPolicyVersion" AS "activeProofPolicyVersion"
    FROM "CreatorFinancialTransaction" f
    LEFT JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=f."creatorId" AND p."agencyId"=f."agencyId"
    LEFT JOIN "CreatorEarningsGenerationEntry" e ON e.generation=p."activeGeneration" AND e."transactionId"=f."externalTransactionId"
    LEFT JOIN "CreatorEarningsGeneration" active ON active.id=p."activeGeneration"
    LEFT JOIN "CreatorEarningsLedgerEntry" l ON p."activeGeneration" IS NULL AND l."creatorId"=f."creatorId"
      AND l."agencyId"=f."agencyId" AND l."transactionId"=f."externalTransactionId"
    WHERE f."agencyId"=$1 AND f."creatorId"=$2 AND f.id>$3 AND ($5::text IS NULL OR f.id<=$5)
    ORDER BY f.id LIMIT $4`, agencyId, creatorId, afterId, PAGE, throughId);
  if (!rows.length) return { processed: 0, complete: true, afterId };
  // Absence from the current ledger is expected for a withdrawn FULL member.
  // Keep its snapshot revision fence; replacing it with an unverified fact at
  // `now` would reject a valid later provider revision between those clocks.
  const values = rows.filter(row=>!(row.verifiedNet==null && row.transactionStatus==="superseded"
    && row.reasonCode==="VERIFIED_SNAPSHOT_ABSENT" && row.activePublishedAt
    && row.activeProofPolicyVersion===require("./earnings-coverage-service").FINANCIAL_PROOF_POLICY_VERSION
    && row.sourceUpdatedAt && row.sourceUpdatedAt<=row.activeSnapshotAt && row.occurredAt>=row.activeFromAt && row.occurredAt<=row.activeThroughAt))
    .map(row => ({ id: row.id, transactionId: row.externalTransactionId,
    status: row.verifiedStatus || "unverified", net: row.verifiedNet == null ? null : Number(row.verifiedNet),
    gross: row.verifiedGross == null ? null : Number(row.verifiedGross),
    occurredAt: row.verifiedOccurredAt || row.occurredAt, observedAt: row.verifiedObservedAt || (repairingGenerationId?null:now),
    reason: row.verifiedNet == null ? "LEGACY_FINANCIAL_UNVERIFIED" : row.verifiedGross == null ? "GROSS_UNAVAILABLE" : null }));
  const unverifiedValues=values.filter(row=>row.reason==="LEGACY_FINANCIAL_UNVERIFIED");
  const input = JSON.stringify(unverifiedValues);
  const fields = 'id text,"transactionId" text,status text,net integer,gross integer,"occurredAt" timestamp,"observedAt" timestamp,reason text';
  const sales=[],tips=[];
  if(unverifiedValues.length){
    await db.$executeRawUnsafe(`UPDATE "CreatorFinancialTransaction" f SET "netCents"=v.net,"amountCents"=v.gross,
      "transactionStatus"=v.status,"occurredAt"=v."occurredAt","sourceUpdatedAt"=v."observedAt","reasonCode"=v.reason,
      "feeCents"=NULL,"taxCents"=NULL,"vatCents"=NULL,"mediaTaxCents"=NULL,
      "fanId"=NULL,"fanOnlyFansUserId"=NULL,"fanUsernameAtEvent"=NULL,"fanDisplayNameAtEvent"=NULL,"fanAvatarUrlAtEvent"=NULL,
      "sourceDeviceId"=NULL,"sourceJobId"=NULL,"scanRunId"=NULL,
      "projectionStatus"=CASE WHEN v.status='unverified' THEN 'STORED_ONLY'::"CreatorFinancialTransactionProjectionStatus" ELSE f."projectionStatus" END,"updatedAt"=$2
    FROM jsonb_to_recordset($1::jsonb) v(${fields}) WHERE f.id=v.id`, input, now);
    sales.push(...await db.$queryRawUnsafe(`UPDATE "CreatorSale" f SET "netCents"=v.net,"amountCents"=v.gross,
      "feeCents"=NULL,"taxCents"=NULL,"vatCents"=NULL,"mediaTaxCents"=NULL,
      "transactionStatus"=v.status,"purchasedAt"=v."occurredAt","sourceUpdatedAt"=v."observedAt","updatedAt"=$4
    FROM jsonb_to_recordset($1::jsonb) v(${fields}) WHERE f."creatorId"=$2 AND f."agencyId"=$3 AND f."externalTransactionId"=v."transactionId" RETURNING f.id`, input, creatorId, agencyId, now));
    tips.push(...await db.$queryRawUnsafe(`UPDATE "CreatorTip" f SET "netCents"=v.net,"amountCents"=v.gross,
      "feeCents"=NULL,"taxCents"=NULL,"vatCents"=NULL,"mediaTaxCents"=NULL,
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
  let revisionUnavailable=false;
  const verified=rows.filter(row=>row.verifiedNet!=null).map((row,index)=>{
    let source=row.verifiedFact?.version===1?row.verifiedFact.value:null;
    const receipt=row.verifiedReceipt;
    if (!source && receipt && Number(receipt.netCents)===Number(row.verifiedNet)
      && receipt.transactionStatus===row.verifiedStatus && +new Date(receipt.occurredAt)===+row.verifiedOccurredAt
      && category.earningsCategory(receipt)===row.verifiedCategory
      && (receipt.amountCents==null?null:Number(receipt.amountCents))===(row.verifiedGross==null?null:Number(row.verifiedGross))) source={...receipt,
        sourceJobId:row.verifiedReceiptJobId,scanRunId:row.verifiedReceiptGeneration,collectedAt:row.verifiedObservedAt};
    if(!source) revisionUnavailable=true;
    const transactionType=source?.transactionType||categoryTypes[row.verifiedCategory];
    if(!transactionType)throw new Error("LEGACY_FINANCIAL_CATEGORY_INVALID");
    const normalized=require("./financial-transactions-service").normalizeTransaction({...(source||{}),
      externalTransactionId:row.externalTransactionId,transactionType,
      amountCents:row.verifiedGross==null?null:Number(row.verifiedGross),netCents:Number(row.verifiedNet),
      transactionStatus:row.verifiedStatus,occurredAt:row.verifiedOccurredAt,currency:"USD",
      fanOnlyFansUserId:source?.fanOnlyFansUserId??row.verifiedFan,
      fanUsername:source?.fanUsername??source?.fanUsernameAtEvent??null,
      fanDisplayName:source?.fanDisplayName??source?.fanDisplayNameAtEvent??null,
      fanAvatarUrl:source?.fanAvatarUrl??source?.fanAvatarUrlAtEvent??null},index,source?.page||1);
    if(normalized.rejected)throw new Error("LEGACY_FINANCIAL_VERIFIED_FACT_INVALID");
    return {...normalized,sourceUpdatedAt:row.verifiedObservedAt,
      sourceDeviceId:source?.sourceDeviceId||null,sourceJobId:source?.sourceJobId||null,scanRunId:source?.scanRunId||null,
      collectedAt:source?.collectedAt?new Date(source.collectedAt):row.verifiedObservedAt,
      ...(!source?{reasonCode:"FINANCIAL_REVISION_REVERIFY_REQUIRED"}:{})};
  });
  if(revisionUnavailable) await require("./financial-recovery-intent-service").requestFull({db,agencyId,creatorId,now,
    reason:"FINANCIAL_REVISION_REVERIFY_REQUIRED",identity:repairingGenerationId||"legacy-financial-revision-v3"});
  if(verified.length){
    // Retention may have removed a source job/device. Its original identity
    // remains in financialFact; nullable relational links must reference a
    // still-retained row, never an unrelated newer publication.
    const jobIds=[...new Set(verified.map(row=>row.sourceJobId).filter(Boolean))];
    const deviceIds=[...new Set(verified.map(row=>row.sourceDeviceId).filter(Boolean))];
    const keptJobs=new Set((jobIds.length?await db.jobInstance.findMany({where:{id:{in:jobIds}},select:{id:true}}):[]).map(row=>row.id));
    const keptDevices=new Set((deviceIds.length?await db.workerDevice.findMany({where:{id:{in:deviceIds}},select:{id:true}}):[]).map(row=>row.id));
    for(const row of verified){if(!keptJobs.has(row.sourceJobId))row.sourceJobId=null;if(!keptDevices.has(row.sourceDeviceId))row.sourceDeviceId=null;}
    const restored=await require("./financial-canonical-publication-repository").publish({db,job:{agencyId,creatorId},rows:verified,
      existing,participants:await require("./financial-transactions-service").resolveFans(db,{agencyId,creatorId},verified,now),deviceId:null,observedAt:now,now,catchup:true,restoringVerifiedLedger:true});
    sales.push(...restored.SALE.map(id=>({id})));tips.push(...restored.TIP.map(id=>({id})));
  }
  const unverified = unverifiedValues.map(row => ({
    id: createHash("sha256").update(JSON.stringify([creatorId,row.transactionId,"legacy-financial-repair-172",...(repairingGenerationId?[repairingGenerationId]:[])])).digest("hex"),
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
