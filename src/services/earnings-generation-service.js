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
const fail = (code) => Object.assign(new Error(code), { code });
async function lock(db, creatorId) {
  await db.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true), pg_advisory_xact_lock(hashtextextended($1,0))", `live-earnings:${creatorId}`);
}
async function tryLock(db, creatorId) {
  const [row] = await db.$queryRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true), pg_try_advisory_xact_lock(hashtextextended($1,0)) AS owned", `live-earnings:${creatorId}`);
  return row?.owned === true;
}
async function upsert(db, generation, rows) {
  if (!rows.length) return [];
  return db.$queryRawUnsafe(`INSERT INTO "CreatorEarningsGenerationEntry"
    (generation,"transactionId","occurredAt",category,"netCents","grossCents",status,"observedAt","fanOnlyFansUserId")
    SELECT $1,x."transactionId",x."occurredAt",x.category,x."netCents",x."grossCents",x.status,x."observedAt",x."fanOnlyFansUserId"
    FROM jsonb_to_recordset($2::jsonb) x("transactionId" text,"occurredAt" timestamp,category text,"netCents" bigint,"grossCents" bigint,status text,"observedAt" timestamp,"fanOnlyFansUserId" text)
    ORDER BY x."transactionId"
    ON CONFLICT(generation,"transactionId") DO UPDATE SET "occurredAt"=EXCLUDED."occurredAt",category=EXCLUDED.category,
      "netCents"=EXCLUDED."netCents","grossCents"=EXCLUDED."grossCents",status=EXCLUDED.status,"observedAt"=EXCLUDED."observedAt",
      "fanOnlyFansUserId"=COALESCE(EXCLUDED."fanOnlyFansUserId","CreatorEarningsGenerationEntry"."fanOnlyFansUserId")
    WHERE "CreatorEarningsGenerationEntry"."observedAt"<=EXCLUDED."observedAt" RETURNING "transactionId"`, generation,
    JSON.stringify(rows, (_, v) => typeof v === "bigint" ? v.toString() : v));
}
async function activeEntry(db, creatorId, transactionId) {
  const [row] = await db.$queryRawUnsafe(`SELECT e."transactionId",e."occurredAt",e.category,e."netCents",e."grossCents",e.status,e."observedAt",e."fanOnlyFansUserId",e.generation FROM "CreatorEarningsLedgerProof" p
    JOIN "CreatorEarningsGenerationEntry" e ON e.generation=p."activeGeneration"
    WHERE p."creatorId"=$1 AND e."transactionId"=$2
    UNION ALL SELECT e.* FROM (SELECT "transactionId","occurredAt",category,"netCents","grossCents",status,"observedAt","fanOnlyFansUserId",NULL::text AS generation
      FROM "CreatorEarningsLedgerEntry" WHERE "creatorId"=$1 AND "transactionId"=$2) e
    WHERE NOT EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1 AND "activeGeneration" IS NOT NULL)`, creatorId, transactionId);
  return row || null;
}
async function writeLive(db, scope, row) {
  // Caller owns lock(). The at-most-two targets are read after that lock.
  const targets = await db.$queryRawUnsafe(`SELECT id,state FROM "CreatorEarningsGeneration"
    WHERE "creatorId"=$1 AND mode='SNAPSHOT' AND state IN ('ACTIVE','BUILDING','READY') ORDER BY id`, scope.creatorId);
  if (!targets.some(x => x.state === "ACTIVE")) {
    await db.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerEntry"
      ("agencyId","creatorId","transactionId","occurredAt",category,"netCents",status,"observedAt","grossCents","fanOnlyFansUserId")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT("creatorId","transactionId") DO UPDATE SET
      "occurredAt"=EXCLUDED."occurredAt",category=EXCLUDED.category,"netCents"=EXCLUDED."netCents",
      "grossCents"=EXCLUDED."grossCents",status=EXCLUDED.status,"observedAt"=EXCLUDED."observedAt",
      "fanOnlyFansUserId"=COALESCE(EXCLUDED."fanOnlyFansUserId","CreatorEarningsLedgerEntry"."fanOnlyFansUserId")`, scope.agencyId,scope.creatorId,row.transactionId,
      row.occurredAt,row.category,row.netCents,row.status,row.observedAt,row.grossCents ?? null,row.fanOnlyFansUserId ?? null);
  }
  for (const target of targets) await upsert(db,target.id,[row]);
}
function supported(run) {
  return run?.proof?.complete && (run.windows?.length === 1 && ["FULL","RESOLUTION"].includes(run.windows[0].kind) || ["FRONTIER_PLUS_ONE", "FRONTIER_PLUS_TWO_AND_CHART"].includes(run.proof.kind));
}
async function preparePage(db, job, run) {
  if (!supported(run)) return { ready: false, unsupported: true };
  const from = new Date(run.proof.windows[0].oldestAt || run.windows[0].comparisonFrom || run.windows[0].from), through = new Date(run.windows[0].to), snapshot = require("./analytics-observation-time").observationStartForJob(job);
  if (![from,through,snapshot].every(x=>Number.isFinite(+x))) throw fail("EARNINGS_PUBLICATION_TIME_INVALID");
  await lock(db,job.creatorId);
  let [g] = await db.$queryRawUnsafe('SELECT * FROM "CreatorEarningsGeneration" WHERE id=$1', run.id);
  if (!g) {
    // A superseded build is unreachable from Home; retirement is bounded later.
    await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET state='RETIRED',"retiredAt"=clock_timestamp()
      WHERE "creatorId"=$1 AND state IN ('BUILDING','READY')`, job.creatorId);
    [g] = await db.$queryRawUnsafe(`INSERT INTO "CreatorEarningsGeneration"
      (id,"agencyId","creatorId","runId","baseGeneration","fromAt","throughAt","snapshotAt","fullScan","legacyPending",mode,phase)
      VALUES($1,$2,$3,$1,(SELECT "activeGeneration" FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$3),$4,$5,$6,$7,NOT EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$3 AND "activeGeneration" IS NOT NULL),
      CASE WHEN NOT $7 AND EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$3 AND "activeGeneration" IS NOT NULL) THEN 'DELTA' ELSE 'SNAPSHOT' END,
      CASE WHEN NOT $7 AND EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$3 AND "activeGeneration" IS NOT NULL) THEN 'APPLY' ELSE 'COPY' END) RETURNING *`,
      run.id,job.agencyId,job.creatorId,from,through,snapshot,run.windows[0].kind === "FULL");
  }
  if (g.agencyId !== job.agencyId || g.creatorId !== job.creatorId || +g.snapshotAt !== +snapshot) throw fail("EARNINGS_GENERATION_SCOPE_MISMATCH");
  if (g.publishedAt) return { ready:true, generation:g.id };
  if (g.state === "RETIRED") throw fail("EARNINGS_GENERATION_RETIRED");
  if (g.mode === "DELTA") {
    const [base] = await db.$queryRawUnsafe('SELECT "activeGeneration" FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1',job.creatorId);
    if (base?.activeGeneration !== g.baseGeneration) throw fail("EARNINGS_DELTA_BASE_SUPERSEDED");
  }
  if (g.state === "READY" || g.state === "ACTIVE") return { ready:true, generation:g.id };
  let rows;
  if (g.phase === "COPY") {
    rows = g.baseGeneration
      ? await db.$queryRawUnsafe(`SELECT * FROM "CreatorEarningsGenerationEntry" WHERE generation=$1 AND "transactionId">$2 ORDER BY "transactionId" LIMIT $3`,g.baseGeneration,g.cursor,PAGE)
      : await db.$queryRawUnsafe(`SELECT * FROM "CreatorEarningsLedgerEntry" WHERE "creatorId"=$1 AND "transactionId">$2 ORDER BY "transactionId" LIMIT $3`,job.creatorId,g.cursor,PAGE);
    // End-of-source proves what this provider returned, not that identities
    // absent from this later response ceased to exist. Corrections replace an
    // identity explicitly; omission never deletes confirmed historical money.
    await upsert(db,g.id,rows);
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
    await require("./financial-transactions-service").publishVerifiedFinancialFactsPage({ db, job, facts: rows.filter(row=>accepted.has(row.externalId)), now: new Date() });
    await db.$executeRawUnsafe(`UPDATE "CreatorEarningsGeneration" SET "observedCount"="observedCount"+$2,
      "invalidCount"="invalidCount"+$3,"oldestAt"=$4 WHERE id=$1`,g.id,rows.length,invalid,oldest);
    if (rows.length<APPLY_PAGE && (Number(g.observedCount)+rows.length !== run.proof.windows[0].count || Number(g.invalidCount)+invalid))
      throw fail("EARNINGS_GENERATION_PROOF_MISMATCH");
    await advance(db,g,rows,rows.at(-1)?.externalId,"RESOLVE",APPLY_PAGE);
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
      AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" old WHERE old.id="CreatorMoneyObservation"."coveredGeneration" AND old."publishedAt" IS NOT NULL) AND ("occurredAt" BETWEEN $3 AND $4 OR ($7 AND EXISTS(SELECT 1 FROM "FinancialObservedFact" f WHERE f."runId"=$8 AND f."windowIndex"=0 AND f."externalId"="CreatorMoneyObservation"."transactionId")))
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
async function publish(db,job,run) {
  if (!supported(run)) return false;
  await lock(db,job.creatorId);
  const [g] = await db.$queryRawUnsafe('SELECT * FROM "CreatorEarningsGeneration" WHERE id=$1 AND "creatorId"=$2 AND "agencyId"=$3',run.id,job.creatorId,job.agencyId);
  if (!g) return false;
  if (g.publishedAt) return true;
  if (g.state !== "READY") return false;
  if (Number(g.invalidCount) || Number(g.observedCount)!==run.proof.windows[0].count) throw fail("EARNINGS_GENERATION_PROOF_MISMATCH");
  const [previous] = await db.$queryRawUnsafe('SELECT * FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1',job.creatorId);
  if (!g.fullScan && !previous) throw fail("EARNINGS_BASELINE_REQUIRED");
  const resolution = run.windows[0].kind === "RESOLUTION";
  if (g.mode === "DELTA" && previous?.activeGeneration !== g.baseGeneration) throw fail("EARNINGS_DELTA_BASE_SUPERSEDED");
  // A frontier reaches an existing baseline; it never proves its nominal
  // unbounded lower request. A point resolution proves no global range at all.
  let from = previous?.fromAt || g.fromAt, through = previous?.throughAt || g.throughAt;
  if (!resolution) {
    if (g.fullScan) {
      if (previous && (+g.fromAt > +previous.throughAt || +g.throughAt < +previous.fromAt))
        throw fail("EARNINGS_DISJOINT_COVERAGE");
      from = new Date(Math.min(+from,+g.fromAt));
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
  await db.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerProof"("creatorId","agencyId","fromAt","throughAt",generation,"activeGeneration","confirmedThroughAt")
    VALUES($1,$2,$3,$4,$5,$6,$4) ON CONFLICT("creatorId") DO UPDATE SET
      "fromAt"=EXCLUDED."fromAt","throughAt"=EXCLUDED."throughAt",
      "confirmedThroughAt"=GREATEST("CreatorEarningsLedgerProof"."confirmedThroughAt",EXCLUDED."throughAt"),
      generation=EXCLUDED.generation,"activeGeneration"=EXCLUDED."activeGeneration"`,job.creatorId,job.agencyId,from,through,
      resolution?previous.generation:run.generation,g.mode === "DELTA" ? g.baseGeneration : g.id);
  return true;
}
module.exports = {PAGE,APPLY_PAGE,lock,tryLock,upsert,activeEntry,writeLive,preparePage,publish};
