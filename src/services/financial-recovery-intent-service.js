"use strict";
const {createHash}=require("node:crypto");
// A semantic repair is needed even when the current proof already has the
// current policy. The immutable cause identity survives retries and STOPPED
// episodes; heartbeats cannot spend a new retry budget for the same cause.
async function requestFull({db,agencyId,creatorId,now,reason,identity,targetAt=now}) {
  const id=createHash("sha256").update(JSON.stringify(["financial-integrity-v3",agencyId,creatorId,reason,identity])).digest("hex");
  const rows=await db.$queryRawUnsafe(`WITH stopped AS (SELECT EXISTS(
    SELECT 1 FROM "CreatorRecoveryIntent" i WHERE i."agencyId"=$2 AND i."creatorId"=$3 AND i.stream='financial'
      AND (i.status='STOPPED' OR (i.status IN ('PENDING','RUNNING') AND EXISTS(
        SELECT 1 FROM "JobInstance" j WHERE j.id=i."jobId" AND j.status IN ('FAILED','CANCELLED'))))) AS blocked)
    INSERT INTO "CreatorRecoveryIntent"
    (id,"agencyId","creatorId",stream,reason,"gapFrom","targetAt","policyVersion",status,"stoppedAt","lastError")
    SELECT $1,$2,$3,'financial','FINANCIAL_PROOF_ADOPTION_FULL',$4,$5,2,
      CASE WHEN blocked THEN 'STOPPED' ELSE 'PENDING' END,
      CASE WHEN blocked THEN $6::timestamp END,
      CASE WHEN blocked THEN 'BLOCKED_BY_STOPPED_FINANCIAL_RECOVERY' END
    FROM stopped ON CONFLICT(id) DO NOTHING RETURNING status`,
    id,agencyId,creatorId,require("./financial-receipt-authority").FLOOR,targetAt,now);
  if(rows[0]?.status==='PENDING') await require("./domain-work-authority-service").publishDomainWork({db,agencyId,creatorId,
    workClass:"CREATOR_RECURRING_PLANNING",objectType:"CreatorAccount",objectId:creatorId,partitionKey:creatorId});
  return {id,created:rows.length>0,status:rows[0]?.status||null};
}
module.exports={requestFull};
