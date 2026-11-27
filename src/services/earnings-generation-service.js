"use strict";

// One creator money lock orders live revisions, bounded build pages and the
// pointer swap. No provider/network work, whole-run scan, or historical delete
// is permitted in the final commit.
const PAGE = 500;
// Canonical publication invokes business projections and their durable work
// triggers. Keep that fan-out bounded to one provider page per transaction;
// copying verified ledger entries and resolving hints retain the larger budget.
const APPLY_PAGE = 100;
const { earningsCategory } = require("./financial-transaction-category");
const { FINANCIAL_PROOF_POLICY_VERSION } = require("./earnings-coverage-service");
const fail = (code) => Object.assign(new Error(code), { code });
async function lock(db, creatorId) {
  await db.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v9',true), pg_advisory_xact_lock(hashtextextended($1,0))", `live-earnings:${creatorId}`);
}
async function tryLock(db, creatorId) {
  const [row] = await db.$queryRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v9',true), pg_try_advisory_xact_lock(hashtextextended($1,0)) AS owned", `live-earnings:${creatorId}`);
  return row?.owned === true;
}
async function upsert(db, generation, rows) {
  if (!rows.length) return [];
  return db.$queryRawUnsafe(`INSERT INTO "CreatorEarningsGenerationEntry"
    (generation,"transactionId","occurredAt",category,"netCents","grossCents",status,"observedAt","fanOnlyFansUserId","financialFact")
    SELECT $1,x."transactionId",x."occurredAt",x.category,x."netCents",x."grossCents",x.status,x."observedAt",x."fanOnlyFansUserId",x."financialFact"
    FROM jsonb_to_recordset($2::jsonb) x("transactionId" text,"occurredAt" timestamp,category text,"netCents" bigint,"grossCents" bigint,status text,"observedAt" timestamp,"fanOnlyFansUserId" text,"financialFact" jsonb)
    ORDER BY x."transactionId"
    ON CONFLICT(generation,"transactionId") DO UPDATE SET "occurredAt"=EXCLUDED."occurredAt",category=EXCLUDED.category,
      "netCents"=EXCLUDED."netCents","grossCents"=EXCLUDED."grossCents",status=EXCLUDED.status,"observedAt"=EXCLUDED."observedAt",
      "fanOnlyFansUserId"=COALESCE(EXCLUDED."fanOnlyFansUserId","CreatorEarningsGenerationEntry"."fanOnlyFansUserId"),
      "financialFact"=EXCLUDED."financialFact"
    WHERE "CreatorEarningsGenerationEntry"."observedAt"<=EXCLUDED."observedAt" RETURNING "transactionId"`, generation,
    JSON.stringify(rows, (_, v) => typeof v === "bigint" ? v.toString() : v));
}
async function activeEntry(db, creatorId, transactionId) {
  const [row] = await db.$queryRawUnsafe(`SELECT e."transactionId",e."occurredAt",e.category,e."netCents",e."grossCents",e.status,e."observedAt",e."fanOnlyFansUserId",e."financialFact",e.generation FROM "CreatorEarningsLedgerProof" p
    JOIN "CreatorEarningsGenerationEntry" e ON e.generation=p."activeGeneration"
    WHERE p."creatorId"=$1 AND e."transactionId"=$2
    UNION ALL SELECT e.* FROM (SELECT "transactionId","occurredAt",category,"netCents","grossCents",status,"observedAt","fanOnlyFansUserId","financialFact",NULL::text AS generation
      FROM "CreatorEarningsLedgerEntry" WHERE "creatorId"=$1 AND "transactionId"=$2) e
    WHERE NOT EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1 AND "activeGeneration" IS NOT NULL)`, creatorId, transactionId);
  return row || null;
}
async function snapshotAbsence(db, creatorId, transactionId, occurredAt) {
  // Membership of an active generation is durable even after its source
  // details retire. A build uses retained, verified receipt membership until
  // the pointer swap. Pending observations covered by a build remain pending
  // unless that exact generation is eventually published.
  const [row]=await db.$queryRawUnsafe(`SELECT g.id,g."snapshotAt",g."publishedAt" FROM "CreatorEarningsGeneration" g
    WHERE g."creatorId"=$1 AND g.mode='SNAPSHOT' AND g."proofPolicyVersion"=$4
      AND g.state IN ('ACTIVE','BUILDING','READY') AND $3 BETWEEN g."fromAt" AND g."throughAt"
      AND ((g.state='ACTIVE' AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsGenerationEntry" e WHERE e.generation=g.id AND e."transactionId"=$2))
        OR (g.state IN ('BUILDING','READY') AND NOT EXISTS(SELECT 1 FROM "FinancialObservedFact" f
          WHERE f."runId"=g."runId" AND f."windowIndex"=0 AND f."externalId"=$2)))
    ORDER BY g."snapshotAt" DESC,g.id LIMIT 1`,creatorId,transactionId,occurredAt,FINANCIAL_PROOF_POLICY_VERSION);
  return row||null;
}
async function writeLive(db, scope, row) {
  // Caller owns lock(). The at-most-two targets are read after that lock.
  const targets = await db.$queryRawUnsafe(`SELECT id,state FROM "CreatorEarningsGeneration"
    WHERE "creatorId"=$1 AND mode='SNAPSHOT' AND state IN ('ACTIVE','BUILDING','READY') ORDER BY id`, scope.creatorId);
  if (!targets.some(x => x.state === "ACTIVE")) {
    await db.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerEntry"
      ("agencyId","creatorId","transactionId","occurredAt",category,"netCents",status,"observedAt","grossCents","fanOnlyFansUserId","financialFact")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT("creatorId","transactionId") DO UPDATE SET
      "occurredAt"=EXCLUDED."occurredAt",category=EXCLUDED.category,"netCents"=EXCLUDED."netCents",
      "grossCents"=EXCLUDED."grossCents",status=EXCLUDED.status,"observedAt"=EXCLUDED."observedAt",
      "fanOnlyFansUserId"=COALESCE(EXCLUDED."fanOnlyFansUserId","CreatorEarningsLedgerEntry"."fanOnlyFansUserId"),"financialFact"=EXCLUDED."financialFact"`, scope.agencyId,scope.creatorId,row.transactionId,
      row.occurredAt,row.category,row.netCents,row.status,row.observedAt,row.grossCents ?? null,row.fanOnlyFansUserId ?? null,row.financialFact?JSON.stringify(row.financialFact):null);
  }
  for (const target of targets) await upsert(db,target.id,[row]);
}
function supported(run) {
  return run?.proof?.complete && (run.windows?.length === 1 && ["FULL","RESOLUTION"].includes(run.windows[0].kind) || ["FRONTIER_PLUS_ONE", "FRONTIER_PLUS_TWO_AND_CHART"].includes(run.proof.kind));
}
async function publicationGenerationId(db, run, requested) {
  if (requested!==run.id) return requested;
  const [old]=await db.$queryRawUnsafe('SELECT "proofPolicyVersion","publishedAt" FROM "CreatorEarningsGeneration" WHERE id=$1',run.id);
  if (!old || old.publishedAt || old.proofPolicyVersion===FINANCIAL_PROOF_POLICY_VERSION) return requested;
  // An accepted pre-upgrade build can resume from the same immutable receipt.
  // Its partially copied membership cannot be relabelled as the new policy.
  return require("node:crypto").createHash("sha256").update(`earnings-policy:${FINANCIAL_PROOF_POLICY_VERSION}:${run.id}`).digest("hex");
}
function unpublishedGenerationOwnedSql(g="g") {
  return `(EXISTS(SELECT 1 FROM "FinancialReceiptRun" r JOIN "JobInstance" j ON j.id=r."jobId"
      WHERE r.id=${g}."runId" AND r."creatorId"=${g}."creatorId" AND r."agencyId"=${g}."agencyId"
        AND j.status IN ('SCHEDULED','CLAIMED','PUBLISHING','PAUSED') AND j.params->>'collectionGeneration'=r.generation)
    OR EXISTS(SELECT 1 FROM "SystemSetting" s WHERE s.key='repair:financial-snapshot:v3'
      AND s.value->'current'->>'generationId'=${g}.id AND s."updatedAt">clock_timestamp()-interval '1 day'))`;
}
// Callers hold the creator earnings lock. Canonical pages are visible to
// secondary projections before the pointer swap, so abandoning a dirty build
// must retain a durable read fence until those pages match the active ledger.
async function retireUnpublished(db, generationId) {
  const [g]=await db.$queryRawUnsafe('SELECT * FROM "CreatorEarningsGeneration" WHERE id=$1',generationId);
  if (!g || g.publishedAt || !["BUILDING","READY","REPAIRING"].includes(g.state)) return g||null;
  if (g.state==="REPAIRING") return g;
  const dirty=g.mode==="SNAPSHOT" && g.phase!=="COPY" && !(g.phase==="APPLY" && !g.cursor);
  if (!dirty) {
    const [retired]=await db.$queryRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET state='RETIRED',"retiredAt"=clock_timestamp()
      WHERE id=$1 AND "publishedAt" IS NULL RETURNING *`,g.id);
    return retired;
  }
  const [repairing]=await db.$queryRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET state='REPAIRING',
    "canonicalRepairCursor"='',"canonicalRepairThroughId"=COALESCE((SELECT max(f.id) FROM "CreatorFinancialTransaction" f
      WHERE f."creatorId"=$2 AND f."agencyId"=$3),'')
    WHERE id=$1 AND "publishedAt" IS NULL RETURNING *`,g.id,g.creatorId,g.agencyId);
  return repairing;
}
async function repairUnpublishedPage(db, generationId) {
  const [g]=await db.$queryRawUnsafe('SELECT * FROM "CreatorEarningsGeneration" WHERE id=$1 AND state=\'REPAIRING\'',generationId);
  if (!g) return {complete:true,processed:0};
  const now=new Date();
  const result=await require("./financial-legacy-repair-service").repairPage({db,agencyId:g.agencyId,creatorId:g.creatorId,
    afterId:g.canonicalRepairCursor,throughId:g.canonicalRepairThroughId,repairingGenerationId:g.id,now});
  await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET "canonicalRepairCursor"=$2,
    state=CASE WHEN $3 THEN 'RETIRED' ELSE 'REPAIRING' END,
    "retiredAt"=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE id=$1 AND state='REPAIRING'`,g.id,result.afterId,result.complete);
  if (result.complete) await require("./creator-entity-change-service").publishEntityChanges({db,agencyId:g.agencyId,creatorId:g.creatorId,
    changes:["HOME","TEAM","CAMPAIGN","AUDIENCE","TRAFFIC"].map(entityType=>({entityType,entityId:g.creatorId,
      sourceIdentity:`financial-canonical-repair:${g.id}`,sourceVersion:g.id,payload:{reason:"FINANCIAL_CANONICAL_REPAIRED",dataVersion:g.id}}))});
  return result;
}
async function preparePage(db, job, run, { generationId = run.id, repair = false } = {}) {
  if (!supported(run)) return { ready: false, unsupported: true };
  if (run.proof.semanticsVersion !== 3) throw fail("FINANCIAL_PROOF_POLICY_REVERIFY_REQUIRED");
  // Chart comparison proves the requested empty hours too. The oldest payment
  // bounds observed facts; it must not shorten the accepted verification window.
  const reconcilesMembership = run.windows[0].kind !== "RESOLUTION";
  const from = verifiedWindowFrom(run), through = new Date(run.windows[0].to), snapshot = require("./analytics-observation-time").observationStartForJob(job);
  if (![from,through,snapshot].every(x=>Number.isFinite(+x))) throw fail("EARNINGS_PUBLICATION_TIME_INVALID");
  await lock(db,job.creatorId);
  generationId=await publicationGenerationId(db,run,generationId);
  let [g] = await db.$queryRawUnsafe('SELECT * FROM "CreatorEarningsGeneration" WHERE id=$1', generationId);
  if (!g) {
    const [previous]=await db.$queryRawUnsafe(`SELECT id FROM "CreatorEarningsGeneration"
      WHERE "creatorId"=$1 AND state IN ('BUILDING','READY','REPAIRING') ORDER BY id LIMIT 1`,job.creatorId);
    if (previous) {
      const retired=await retireUnpublished(db,previous.id);
      if (retired?.state==="REPAIRING") {
        const restored=await repairUnpublishedPage(db,previous.id);
        return {ready:false,generation:generationId,repairing:true,visited:restored.processed};
      }
    }
    [g] = await db.$queryRawUnsafe(`INSERT INTO "CreatorEarningsGeneration"
      (id,"agencyId","creatorId","runId","baseGeneration","fromAt","throughAt","snapshotAt","fullScan","legacyPending",mode,phase,"proofPolicyVersion","ltvDeltaVersion")
      VALUES($1,$2,$3,$8,(SELECT "activeGeneration" FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$3),$4,$5,$6,$7,NOT EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$3 AND "activeGeneration" IS NOT NULL),
      CASE WHEN NOT $10 AND EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$3 AND "activeGeneration" IS NOT NULL) THEN 'DELTA' ELSE 'SNAPSHOT' END,
      CASE WHEN NOT $10 AND EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$3 AND "activeGeneration" IS NOT NULL) THEN 'APPLY' ELSE 'COPY' END,$9,1) RETURNING *`,
      generationId,job.agencyId,job.creatorId,from,through,snapshot,run.windows[0].kind === "FULL",run.id,FINANCIAL_PROOF_POLICY_VERSION,reconcilesMembership);
  }
  if (g.agencyId !== job.agencyId || g.creatorId !== job.creatorId || +g.snapshotAt !== +snapshot) throw fail("EARNINGS_GENERATION_SCOPE_MISMATCH");
  if (g.publishedAt) return { ready:true, generation:g.id };
  if (g.state==="REPAIRING") {
    const restored=await repairUnpublishedPage(db,g.id);
    return {ready:false,generation:g.id,repairing:true,visited:restored.processed};
  }
  if (g.proofPolicyVersion !== FINANCIAL_PROOF_POLICY_VERSION) throw fail("EARNINGS_GENERATION_REBUILD_REQUIRED");
  if (+g.fromAt !== +from) {
    await db.$executeRawUnsafe('UPDATE "CreatorEarningsGeneration" SET "fromAt"=$2 WHERE id=$1 AND "publishedAt" IS NULL',g.id,from);
    g.fromAt = from;
  }
  if (g.state === "RETIRED") throw fail("EARNINGS_GENERATION_RETIRED");
  if (g.mode === "DELTA" || repair) {
    const [base] = await db.$queryRawUnsafe('SELECT "activeGeneration" FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1',job.creatorId);
    if (base?.activeGeneration !== g.baseGeneration) throw fail("EARNINGS_DELTA_BASE_SUPERSEDED");
  }
  if (g.state === "READY" || g.state === "ACTIVE") return { ready:true, generation:g.id };
  let rows;
  if (g.phase === "COPY") {
    rows = g.baseGeneration
      ? await db.$queryRawUnsafe(`SELECT * FROM "CreatorEarningsGenerationEntry" WHERE generation=$1 AND "transactionId">$2 ORDER BY "transactionId" LIMIT $3`,g.baseGeneration,g.cursor,PAGE)
      : await db.$queryRawUnsafe(`SELECT * FROM "CreatorEarningsLedgerEntry" WHERE "creatorId"=$1 AND "transactionId">$2 ORDER BY "transactionId" LIMIT $3`,job.creatorId,g.cursor,PAGE);
    // A verified FULL snapshot owns membership within its proven interval.
    // Immutable source receipts survive; only derived snapshot membership is
    // replaced. Later live/catch-up revisions and facts outside the interval
    // remain authoritative and are copied unchanged.
    let retained = rows;
    if (reconcilesMembership && rows.length) {
      const present = new Set((await db.$queryRawUnsafe(`SELECT "externalId" FROM "FinancialObservedFact"
        WHERE "runId"=$1 AND "windowIndex"=0 AND "externalId"=ANY($2::text[])`,run.id,rows.map(row=>row.transactionId))).map(row=>row.externalId));
      retained = rows.filter(row=>row.occurredAt<from || row.occurredAt>through || row.observedAt>snapshot || present.has(row.transactionId));
      const retainedIds=new Set(retained.map(row=>row.transactionId));
      const removed=rows.filter(row=>!retainedIds.has(row.transactionId)).map(row=>row.transactionId);
      if(removed.length)await db.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGenerationChange"(generation,"transactionId")
        SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING`,g.id,removed);
    }
    await upsert(db,g.id,retained);
    await advance(db,g,rows,rows.at(-1)?.transactionId,"APPLY");
  } else if (g.phase === "APPLY") {
    rows = await db.$queryRawUnsafe(`SELECT "externalId","occurredAt",value FROM "FinancialObservedFact"
      WHERE "runId"=$1 AND "windowIndex"=0 AND "externalId">$2 ORDER BY "externalId" LIMIT $3`,run.id,g.cursor,APPLY_PAGE);
    let invalid = 0, oldest = g.oldestAt;
    const values = [];
    for (const f of rows) {
      const v=f.value, net=Number(v.netCents);
      if (v.netCents == null || !Number.isSafeInteger(net) || net<0 || v.currency!=="USD" || !["done","loading","undo"].includes(v.transactionStatus)) { invalid++; continue; }
      if (!oldest || +f.occurredAt<+oldest) oldest=f.occurredAt;
      values.push({transactionId:f.externalId,occurredAt:f.occurredAt,netCents:net,grossCents:v.amountCents ?? null,status:v.transactionStatus,observedAt:snapshot,
        category:earningsCategory(v),fanOnlyFansUserId:require("./fan-ltv-model").fanId(v.fanOnlyFansUserId)});
    }
    // The complete immutable receipt is checked before preparation. Each delta
    // is already an exact financial fact; only the range proof waits for finalization.
    const accepted = new Set((await upsert(db,g.mode === "DELTA" ? g.baseGeneration : g.id,values)).map(row=>row.transactionId));
    await require("./financial-transactions-service").publishVerifiedFinancialFactsPage({ db, job: { ...job, financialReceiptRunId: run.id }, facts: rows.filter(row=>accepted.has(row.externalId)), now: new Date() });
    await require("./financial-revision-repository").capture({db, ...job, transactionIds:[...accepted], observedAt:snapshot,
      generations:[g.mode === "DELTA" ? g.baseGeneration : g.id]});
    await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET "observedCount"="observedCount"+$2,
      "invalidCount"="invalidCount"+$3,"oldestAt"=$4 WHERE id=$1`,g.id,rows.length,invalid,oldest);
    if (rows.length<APPLY_PAGE && (Number(g.observedCount)+rows.length !== run.proof.windows[0].count || Number(g.invalidCount)+invalid))
      throw fail("EARNINGS_GENERATION_PROOF_MISMATCH");
    await advance(db,g,rows,rows.at(-1)?.externalId,reconcilesMembership?"WITHDRAW":"RESOLVE",APPLY_PAGE);
  } else if (g.phase === "WITHDRAW") {
    // Page the canonical identities before testing absence. A sparse omitted
    // set must not turn one publication unit into an unbounded history scan.
    rows = await db.creatorFinancialTransaction.findMany({where:{creatorId:job.creatorId,externalTransactionId:{gt:g.cursor}},
      orderBy:{externalTransactionId:"asc"},take:APPLY_PAGE,
      select:{externalTransactionId:true,occurredAt:true,sourceUpdatedAt:true,transactionStatus:true}});
    const candidates=rows.filter(row=>row.occurredAt>=from && row.occurredAt<=through
      && (!row.sourceUpdatedAt || row.sourceUpdatedAt<=snapshot) && row.transactionStatus!=="superseded");
    const present=new Set(candidates.length?(await db.$queryRawUnsafe(`SELECT "externalId" FROM "FinancialObservedFact"
      WHERE "runId"=$1 AND "windowIndex"=0 AND "externalId"=ANY($2::text[])`,run.id,candidates.map(row=>row.externalTransactionId))).map(row=>row.externalId):[]);
    await require("./financial-transactions-service").withdrawVerifiedFinancialFactsPage({db,job,
      transactionIds:candidates.filter(row=>!present.has(row.externalTransactionId)).map(row=>row.externalTransactionId),observedAt:snapshot,now:new Date()});
    await advance(db,g,rows,rows.at(-1)?.externalTransactionId,"RESOLVE",APPLY_PAGE);
  } else if (g.phase === "RESOLVE") {
    if (run.windows[0].kind === "RESOLUTION" && !g.cursor) {
      // A bounded resolution cannot silently retain a transaction absent from
      // the verified source window. Keep the debt visible if this invariant
      // needs a full snapshot reconciliation; never manufacture a refund.
      const extras=await db.$queryRawUnsafe(`SELECT e."transactionId" FROM "CreatorEarningsGenerationEntry" e
        WHERE e.generation=$1 AND e."occurredAt" BETWEEN $2 AND $3 AND e."observedAt"<=$4 AND e.status<>'undo'
        AND NOT EXISTS(SELECT 1 FROM "FinancialObservedFact" f WHERE f."runId"=$5 AND f."windowIndex"=0 AND f."externalId"=e."transactionId") LIMIT 1`,g.baseGeneration,from,through,snapshot,run.id);
      if(extras.length)throw fail("MONEY_RESOLUTION_LEDGER_DIVERGED");
    }
    // These hints are invisible until the generation pointer commit. A failed
    // or superseded build cannot declare ambiguous live money covered.
    rows = await db.$queryRawUnsafe(`SELECT id FROM "CreatorMoneyObservation" WHERE "creatorId"=$1
      AND status='PENDING' AND id>$2
      AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" old WHERE old.id="CreatorMoneyObservation"."coveredGeneration" AND old."publishedAt" IS NOT NULL) AND ("occurredAt" BETWEEN $3 AND $4 OR (($7 OR "reason"='SOURCE_TIME_INVALID') AND EXISTS(SELECT 1 FROM "FinancialObservedFact" f WHERE f."runId"=$8 AND f."windowIndex"=0 AND f."externalId"="CreatorMoneyObservation"."transactionId")))
      AND (NOT $7 OR "transactionId" IS NULL OR EXISTS(SELECT 1 FROM "FinancialObservedFact" f WHERE f."runId"=$8 AND f."windowIndex"=0 AND f."externalId"="CreatorMoneyObservation"."transactionId"))
      AND "capturedAt"<=$5 ORDER BY id LIMIT $6`,
      job.creatorId,g.cursor,(g.fullScan || run.windows[0].kind === "RESOLUTION")?from:g.oldestAt,through,snapshot,PAGE,run.windows[0].kind === "RESOLUTION",run.id);
    if (rows.length) await db.$executeRawUnsafe(`UPDATE "CreatorMoneyObservation" SET "coveredGeneration"=$1 WHERE id=ANY($2::text[])`,g.id,rows.map(x=>x.id));
    await advance(db,g,rows,rows.at(-1)?.id,"READY");
    if (rows.length<PAGE) await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET state='READY' WHERE id=$1`,g.id);
  } else throw fail("EARNINGS_GENERATION_STAGE_INVALID");
  return { ready:g.phase==="RESOLVE" && rows.length<PAGE, generation:g.id, visited:rows.length, phase:g.phase };
}
async function advance(db,g,rows,cursor,next,pageSize=PAGE) {
  await db.$executeRawUnsafe('UPDATE "CreatorEarningsGeneration" SET phase=$2,cursor=$3 WHERE id=$1',g.id,rows.length===pageSize?g.phase:next,rows.length===pageSize?cursor:"");
}
function verifiedWindowFrom(run) {
  const proof = run.proof.windows[0], window = run.windows[0];
  if (window.kind === "FULL" && window.from === null && proof.exhausted === true && run.proof.complete === true)
    return new Date(require("./financial-receipt-authority").FLOOR);
  return new Date(proof.comparisonFrom || window.comparisonFrom || window.from || proof.oldestAt);
}
async function publish(db,job,run,{ generationId = run.id, repair = false } = {}) {
  if (!supported(run)) return false;
  await lock(db,job.creatorId);
  generationId=await publicationGenerationId(db,run,generationId);
  const [g] = await db.$queryRawUnsafe('SELECT * FROM "CreatorEarningsGeneration" WHERE id=$1 AND "creatorId"=$2 AND "agencyId"=$3',generationId,job.creatorId,job.agencyId);
  if (!g) return false;
  if (g.publishedAt) return true;
  if (g.state !== "READY") return false;
  if (g.proofPolicyVersion !== FINANCIAL_PROOF_POLICY_VERSION) throw fail("EARNINGS_GENERATION_REBUILD_REQUIRED");
  if (Number(g.invalidCount) || Number(g.observedCount)!==run.proof.windows[0].count) throw fail("EARNINGS_GENERATION_PROOF_MISMATCH");
  const [previous] = await db.$queryRawUnsafe('SELECT * FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1',job.creatorId);
  if (!g.fullScan && !previous) throw fail("EARNINGS_BASELINE_REQUIRED");
  const resolution = run.windows[0].kind === "RESOLUTION";
  if ((g.mode === "DELTA" || repair) && previous?.activeGeneration !== g.baseGeneration) throw fail("EARNINGS_DELTA_BASE_SUPERSEDED");
  // A frontier reaches an existing baseline; it never proves its nominal
  // unbounded lower request. A point resolution proves no global range at all.
  let from = previous?.fromAt || g.fromAt, through = previous?.throughAt || g.throughAt;
  if (!resolution) {
    if (g.fullScan) {
      const verifiedFrom = verifiedWindowFrom(run);
      if (!Number.isFinite(+verifiedFrom)) throw fail("EARNINGS_PUBLICATION_TIME_INVALID");
      if (previous && (+verifiedFrom > +previous.throughAt || +g.throughAt < +previous.fromAt))
        throw fail("EARNINGS_DISJOINT_COVERAGE");
      from = new Date(Math.min(+from,+verifiedFrom));
    }
    through = new Date(Math.max(+through,+g.throughAt));
  }
  if (g.mode === "SNAPSHOT") {
    await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET state='RETIRED',"retiredAt"=clock_timestamp()
      WHERE "creatorId"=$1 AND state='ACTIVE'`,job.creatorId);
    await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET state='ACTIVE',"publishedAt"=clock_timestamp() WHERE id=$1`,g.id);
  } else {
    await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET state='RETIRED',"publishedAt"=clock_timestamp(),"retiredAt"=clock_timestamp() WHERE id=$1`,g.id);
  }
  await db.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerProof"("creatorId","agencyId","fromAt","throughAt",generation,"activeGeneration","confirmedThroughAt","proofPolicyVersion")
    VALUES($1,$2,$3,$4,$5,$6,$4,$7) ON CONFLICT("creatorId") DO UPDATE SET
      "fromAt"=EXCLUDED."fromAt","throughAt"=EXCLUDED."throughAt",
      "confirmedThroughAt"=GREATEST(CASE WHEN "CreatorEarningsLedgerProof"."proofPolicyVersion">=1
        THEN "CreatorEarningsLedgerProof"."confirmedThroughAt" END,EXCLUDED."throughAt"),
      "proofPolicyVersion"=CASE WHEN $8 THEN "CreatorEarningsLedgerProof"."proofPolicyVersion" ELSE $7 END,
      generation=EXCLUDED.generation,"activeGeneration"=EXCLUDED."activeGeneration"`,job.creatorId,job.agencyId,from,through,
      resolution||repair?previous.generation:run.generation,g.mode === "DELTA" ? g.baseGeneration : g.id,
      g.fullScan?FINANCIAL_PROOF_POLICY_VERSION:previous?.proofPolicyVersion||0,resolution);
  return true;
}
module.exports = {PAGE,APPLY_PAGE,lock,tryLock,upsert,activeEntry,snapshotAbsence,writeLive,unpublishedGenerationOwnedSql,retireUnpublished,repairUnpublishedPage,preparePage,publish};
