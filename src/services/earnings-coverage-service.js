"use strict";
async function advanceDelivered(db, creatorIds) {
  if (!creatorIds.length) return;
  await db.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
  return db.$executeRawUnsafe(`UPDATE "CreatorEarningsLedgerProof" p SET "confirmedThroughAt"=l."lastDeliveredAt"
    FROM "CreatorLiveSync" l WHERE l."creatorId"=p."creatorId" AND p."creatorId"=ANY($1::text[])
      AND l."lastDeliveredAt">GREATEST(p."throughAt",p."confirmedThroughAt")
      AND (l."shortGapTo" IS NULL OR l."shortGapTo"<=p."throughAt")
      AND NOT EXISTS(SELECT 1 FROM "CreatorRecoveryIntent" i WHERE i."creatorId"=p."creatorId" AND i.stream='financial' AND i.status<>'COMPLETE')
      AND NOT EXISTS(SELECT 1 FROM "CreatorMoneyObservation" m WHERE m."creatorId"=p."creatorId" AND m.status='PENDING'
        AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" g WHERE g.id=m."coveredGeneration" AND g."publishedAt" IS NOT NULL))`,creatorIds);
}
module.exports={advanceDelivered};
