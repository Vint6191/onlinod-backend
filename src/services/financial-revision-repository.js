"use strict";

// Capture the exact canonical revision in the same money-owner transaction as
// its ledger write. Repair never combines an old amount with a newer row's
// fan, tax, classification or provenance. COPY carries this value unchanged.
async function capture({db,agencyId,creatorId,transactionIds,observedAt,generations=null}) {
  if (!transactionIds.length) return;
  if (transactionIds.length>500) throw Error("FINANCIAL_REVISION_PAGE_CAPACITY");
  const common = `f."agencyId"=$1 AND f."creatorId"=$2 AND f."externalTransactionId"=ANY($3::text[])
    AND f."sourceUpdatedAt"=$4 AND e."transactionId"=f."externalTransactionId" AND e."observedAt"=$4
    AND e."netCents"=f."netCents" AND e.status=f."transactionStatus"`;
  await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGenerationEntry" e
    SET "financialFact"=jsonb_build_object('version',1,'value',to_jsonb(f)),"fanOnlyFansUserId"=f."fanOnlyFansUserId"
    FROM "CreatorFinancialTransaction" f WHERE ${common}
      AND e.generation IN (SELECT g.id FROM "CreatorEarningsGeneration" g WHERE g."creatorId"=$2 AND g."agencyId"=$1
        AND (($5::text[] IS NOT NULL AND g.id=ANY($5::text[])) OR ($5::text[] IS NULL AND g.state IN ('ACTIVE','BUILDING','READY'))))`,agencyId,creatorId,transactionIds,observedAt,generations);
  if (!generations) await db.$executeRawUnsafe(`UPDATE "CreatorEarningsLedgerEntry" e
    SET "financialFact"=jsonb_build_object('version',1,'value',to_jsonb(f)),"fanOnlyFansUserId"=f."fanOnlyFansUserId"
    FROM "CreatorFinancialTransaction" f WHERE ${common} AND e."agencyId"=$1 AND e."creatorId"=$2`,agencyId,creatorId,transactionIds,observedAt);
}
async function resolveInvalidTime({db,agencyId,creatorId,transactionId,capturedAt,now}) {
  // Identity and a later accepted observation are both required. Keep the old
  // timestamp/reason as evidence; only its unresolved obligation is superseded.
  return db.$executeRawUnsafe(`UPDATE "CreatorMoneyObservation" m SET status='COVERED',"resolvedAt"=$5,
      "resolutionError"='SOURCE_TIME_INVALID_SUPERSEDED_BY_EXACT_IDENTITY'
    WHERE m."agencyId"=$1 AND m."creatorId"=$2 AND m."transactionId"=$3 AND m.status='PENDING'
      AND m.reason='SOURCE_TIME_INVALID' AND m."capturedAt"<=$4
      AND EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" f WHERE f."agencyId"=$1 AND f."creatorId"=$2
        AND f."externalTransactionId"=$3 AND f."occurredAt">='2016-01-01' AND f."occurredAt"<=$5
        AND f."sourceUpdatedAt">=m."capturedAt" AND f."sourceUpdatedAt"<=$5+interval '30 seconds'
        AND EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" p JOIN "CreatorEarningsGenerationEntry" e ON e.generation=p."activeGeneration"
          WHERE p."creatorId"=$2 AND e."transactionId"=$3 AND e."observedAt"=f."sourceUpdatedAt" AND e."financialFact" IS NOT NULL
          AND e."occurredAt"=f."occurredAt" AND e."netCents"=f."netCents" AND e.status=f."transactionStatus"
          UNION ALL SELECT 1 FROM "CreatorEarningsLedgerEntry" e WHERE e."creatorId"=$2 AND e."transactionId"=$3
          AND e."observedAt"=f."sourceUpdatedAt" AND e."financialFact" IS NOT NULL AND e."occurredAt"=f."occurredAt"
          AND e."netCents"=f."netCents" AND e.status=f."transactionStatus"
          AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" p WHERE p."creatorId"=$2 AND p."activeGeneration" IS NOT NULL))
        AND f."netCents" IS NOT NULL AND f.currency='USD'  AND f."transactionStatus" IN ('done','loading','undo'))`,agencyId,creatorId,transactionId,capturedAt,now);
}
module.exports={capture,resolveInvalidTime};
