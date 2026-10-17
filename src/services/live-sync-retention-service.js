"use strict";
const {runRootCommit}=require("./db-commit-kernel");
const PAGE=500, KEEP_DAYS=30;
const options={maxWait:1500,timeout:5000,deadlineMs:7000,lockTimeoutMs:1000,statementTimeoutMs:3000,maxAttempts:2};
// Each category receives a turn even when a previous table has continuous debt.
// SKIP LOCKED and bounded deletes keep active devices/publications independent.
async function page(db,kind) {
  return runRootCommit(db,async({tx})=>{
    await tx.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
    let result;
    if(kind==="receipts") result=await tx.$executeRawUnsafe(`WITH old AS (
      SELECT r."sessionId",r.seq FROM "CreatorRealtimeReceipt" r JOIN "CreatorRealtimeSession" s ON s.id=r."sessionId"
      WHERE r."capturedAt"<clock_timestamp()-interval '30 days' AND r.seq<=s."ackedSeq"
      ORDER BY r."capturedAt",r."sessionId",r.seq LIMIT $1 FOR UPDATE OF r SKIP LOCKED)
      DELETE FROM "CreatorRealtimeReceipt" r USING old WHERE r."sessionId"=old."sessionId" AND r.seq=old.seq`,PAGE);
    else if(kind==="covered") result=await tx.$executeRawUnsafe(`WITH ready AS (
      SELECT m.id FROM "CreatorMoneyObservation" m JOIN "CreatorEarningsGeneration" g ON g.id=m."coveredGeneration"
      WHERE m.status='PENDING' AND g."publishedAt" IS NOT NULL ORDER BY m."coveredGeneration",m.id LIMIT $1 FOR UPDATE OF m SKIP LOCKED)
      UPDATE "CreatorMoneyObservation" m SET status='COVERED',"resolvedAt"=clock_timestamp() FROM ready WHERE m.id=ready.id`,PAGE);
    else if(kind==="money") result=await tx.$executeRawUnsafe(`WITH old AS (
      SELECT id FROM "CreatorMoneyObservation" WHERE status IN ('APPLIED','COVERED') AND "capturedAt"<clock_timestamp()-interval '30 days'
      ORDER BY "capturedAt",id LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM "CreatorMoneyObservation" m USING old WHERE m.id=old.id`,PAGE);
    else if(kind==="intents") {
      const rows=await tx.$queryRawUnsafe(`SELECT id,"creatorId",stream,"targetAt" FROM "CreatorRecoveryIntent"
        WHERE status='COMPLETE' AND "completedAt"<clock_timestamp()-interval '30 days' ORDER BY "completedAt",id LIMIT $1 FOR UPDATE SKIP LOCKED`,PAGE);
      if(rows.length) {
        await tx.$executeRawUnsafe(`INSERT INTO "CreatorRecoveryWatermark"("creatorId",stream,"throughAt")
          SELECT "creatorId",stream,max(at) FROM jsonb_to_recordset($1::jsonb) x("creatorId" text,stream text,at timestamp)
          GROUP BY "creatorId",stream ORDER BY "creatorId",stream ON CONFLICT("creatorId",stream) DO UPDATE SET
          "throughAt"=GREATEST("CreatorRecoveryWatermark"."throughAt",EXCLUDED."throughAt")`,JSON.stringify(rows.map(x=>({creatorId:x.creatorId,stream:x.stream,at:x.targetAt}))));
        await tx.$executeRawUnsafe('DELETE FROM "CreatorRecoveryIntent" WHERE id=ANY($1::text[])',rows.map(x=>x.id));
      }
      result=rows.length;
    } else if(kind==="frontiers") result=await tx.$executeRawUnsafe(`WITH old AS (
      SELECT p."creatorId",p.generation,p.page FROM "CreatorNotificationFrontierPage" p
      WHERE p."createdAt"<clock_timestamp()-interval '30 days'
        AND NOT EXISTS(SELECT 1 FROM "JobInstance" j WHERE j."creatorId"=p."creatorId" AND j."jobKey"='catchup_notifications_scan'
          AND j.status IN ('SCHEDULED','CLAIMED','PUBLISHING','PAUSED') AND j.params->>'collectionGeneration'=p.generation)
      ORDER BY p."createdAt",p."creatorId",p.generation,p.page LIMIT $1 FOR UPDATE OF p SKIP LOCKED)
      DELETE FROM "CreatorNotificationFrontierPage" p USING old WHERE (p."creatorId",p.generation,p.page)=(old."creatorId",old.generation,old.page)`,PAGE);
    else if(kind==="sessions") result=await tx.$executeRawUnsafe(`WITH old AS (
      SELECT id FROM "CreatorRealtimeSession" WHERE "retiredAt" IS NULL AND "updatedAt"<clock_timestamp()-interval '30 days'
        AND "capturedSeq"<="ackedSeq" AND NOT loss ORDER BY "updatedAt",id LIMIT $1 FOR UPDATE SKIP LOCKED)
      UPDATE "CreatorRealtimeSession" s SET "retiredAt"=clock_timestamp() FROM old WHERE s.id=old.id`,PAGE);
    else if(kind==="abandoned") {
      const [g]=await tx.$queryRawUnsafe(`SELECT g.id,g."creatorId" FROM "CreatorEarningsGeneration" g
        WHERE state IN ('BUILDING','READY') AND "createdAt"<clock_timestamp()-interval '1 day'
        AND NOT EXISTS(SELECT 1 FROM "FinancialReceiptRun" r JOIN "JobInstance" j ON j.id=r."jobId"
          WHERE r.id=g."runId" AND j.status IN ('SCHEDULED','CLAIMED','PUBLISHING','PAUSED') AND j.params->>'collectionGeneration'=r.generation)
        ORDER BY "createdAt",id LIMIT 1`);
      result=0;
      if(g) {
        const [owner]=await tx.$queryRawUnsafe("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS owned",`live-earnings:${g.creatorId}`);
        if(owner.owned) result=await tx.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET state='RETIRED',"retiredAt"=clock_timestamp()
          WHERE id=$1 AND state IN ('BUILDING','READY')`,g.id);
      }
    } else if(kind==="legacy") {
      // Legacy tables become unreachable only after the first successful switch.
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
      const [p]=await tx.$queryRawUnsafe(`SELECT id,"creatorId" FROM "CreatorEarningsGeneration"
        WHERE "legacyPending" AND "publishedAt" IS NOT NULL ORDER BY "publishedAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      result=0;
      if(p) {
        result=await tx.$executeRawUnsafe(`WITH old AS (SELECT "transactionId" FROM "CreatorEarningsLedgerEntry"
          WHERE "creatorId"=$1 ORDER BY "transactionId" LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM "CreatorEarningsLedgerEntry" e USING old WHERE e."creatorId"=$1 AND e."transactionId"=old."transactionId"`,p.creatorId,PAGE);
        if(!result)result=await tx.$executeRawUnsafe(`WITH old AS (SELECT hour,category FROM "CreatorEarningsLedgerHour"
          WHERE "creatorId"=$1 ORDER BY hour,category LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM "CreatorEarningsLedgerHour" e USING old WHERE e."creatorId"=$1 AND (e.hour,e.category)=(old.hour,old.category)`,p.creatorId,PAGE);
        if(!result)await tx.$executeRawUnsafe('UPDATE "CreatorEarningsGeneration" SET "legacyPending"=false WHERE id=$1',p.id);
      }
    } else if(kind==="generations") {
      const [g]=await tx.$queryRawUnsafe(`SELECT g.* FROM "CreatorEarningsGeneration" g WHERE g.state='RETIRED'
        AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" p WHERE p."activeGeneration"=g.id)
        AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" b WHERE b."baseGeneration"=g.id AND b.state IN ('BUILDING','READY'))
        ORDER BY g."retiredAt",g.id LIMIT 1 FOR UPDATE OF g SKIP LOCKED`);
      result=0;
      if(g) {
        for(const [table,keys] of [["CreatorEarningsGenerationEntry",["transactionId"]],["CreatorEarningsGenerationHour",["hour","category"]],["CreatorEarningsGenerationDay",["date","category"]]]) {
          const columns=keys.map(x=>`"${x}"`).join(",");
          result=await tx.$executeRawUnsafe(`WITH old AS (SELECT ${columns} FROM "${table}" WHERE generation=$1 ORDER BY ${columns} LIMIT $2)
            DELETE FROM "${table}" e USING old WHERE e.generation=$1 AND ${keys.map(x=>`e."${x}"=old."${x}"`).join(" AND ")}`,g.id,PAGE);
          if(result) break;
        }
        if(!result) result=await tx.$executeRawUnsafe(`DELETE FROM "CreatorEarningsGeneration" g WHERE id=$1 AND (NOT "legacyPending" OR "publishedAt" IS NULL)
          AND NOT EXISTS(SELECT 1 FROM "CreatorMoneyObservation" m WHERE m."coveredGeneration"=g.id AND m.status='PENDING' AND g."publishedAt" IS NOT NULL)`,g.id);
      }
    } else throw Error("LIVE_RETENTION_KIND_INVALID");
    return Number(result);
  },options);
}
async function runSweep({db=require("../prisma"),kind="covered",maxPages=8,maxRuntimeMs=4000}={}) {
  // Admission gives every category its own durable fair turn. Each transaction
  // remains bounded; several pages let cleanup keep up with sustained traffic.
  const report={ok:true,processed:0,kind,failures:[]},start=performance.now();
  for(let i=0;i<Math.min(32,Math.max(1,maxPages));i++) {
    try {
      const count=await page(db,kind);report.processed+=count;
      if(!count || performance.now()-start>=maxRuntimeMs)break;
    } catch(error) {
      report.ok=false;report.failures.push({kind,code:String(error.code||error.message)});break;
    }
  }
  return report;
}
module.exports={runSweep,page,PAGE,KEEP_DAYS};
