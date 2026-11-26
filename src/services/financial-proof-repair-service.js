"use strict";

const { hashCanonicalJson } = require("./realtime-receipt-hash");
const { FINANCIAL_PROOF_POLICY_VERSION } = require("./earnings-coverage-service");
const { runRootCommit } = require("./db-commit-kernel");
const PAGE = 20;
const asDate = value => {
  if (value == null) return null;
  const text = typeof value === "string" && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? value.replace(" ", "T") + "Z" : value;
  const date = new Date(text); return Number.isFinite(+date) ? date : null;
};
const fault = code => Object.assign(new Error(code), { code, status: 409 });

// The caller holds the creator's live-state lock. No provider request or money
// deletion takes place here. Old throughAt is the accepted provider boundary;
// only the former global-heartbeat extension is demoted during adoption.
async function ensureFinancialDebt({ db, agencyId, creatorIds, now = new Date(), targetAt = now, requiredThroughAt = null }) {
  const ids = [...new Set(creatorIds)].sort();
  if (!ids.length) return { adopted: 0, queued: 0, repairedStarts: 0 };
  const rows = await db.$queryRawUnsafe(`SELECT p.*,l."shortGapFrom",l."shortGapTo",
    (SELECT max(COALESCE(s."unackedThroughAt",s."capturedAt")) FROM "CreatorRealtimeSession" s
      WHERE s."creatorId"=p."creatorId" AND s."capturedSeq">s."ackedSeq"
        AND COALESCE(s."unackedSinceAt",s."updatedAt")<$3::timestamp-interval '3 minutes') AS "strandedThrough",
    (SELECT max(COALESCE(s."lossAt",s."capturedAt")) FROM "CreatorRealtimeSession" s
      WHERE s."creatorId"=p."creatorId" AND s.loss) AS "lostThrough"
    FROM "CreatorEarningsLedgerProof" p LEFT JOIN "CreatorLiveSync" l ON l."creatorId"=p."creatorId"
    WHERE p."agencyId"=$1 AND p."creatorId"=ANY($2::text[]) ORDER BY p."creatorId" FOR UPDATE OF p`, agencyId, ids, now.toISOString());
  const report = { adopted: 0, queued: 0, repairedStarts: 0 }, wake = [];
  for (const row of rows) {
    const legacy = row.proofPolicyVersion !== FINANCIAL_PROOF_POLICY_VERSION;
    let fromAt = row.fromAt, reason = "FINANCIAL_DELIVERY_GAP";
    let gapFrom = legacy ? row.throughAt : new Date(Math.max(+row.throughAt, +(row.confirmedThroughAt || row.throughAt)));
    let end = legacy ? asDate(targetAt) : asDate(requiredThroughAt);
    if (legacy) {
      // A retained, matched FULL comparison is evidence for the empty start of
      // a day. No rounding of the first payment timestamp can replace it.
      const [receipt] = await db.$queryRawUnsafe(`SELECT r.windows,r.proof FROM "FinancialReceiptRun" r
        LEFT JOIN "CreatorFinancialCollectionState" s ON s."creatorId"=r."creatorId"
        WHERE r."creatorId"=$1 AND r."agencyId"=$2
          AND (r.generation=$3 OR r.generation=s."baselineGeneration")
          AND r.proof->>'complete'='true' AND r.windows->0->>'kind'='FULL'
          AND r.proof->'windows'->0->>'matched'='true' ORDER BY r."updatedAt" DESC LIMIT 1`, row.creatorId, agencyId, row.generation);
      const verifiedStart = asDate(receipt?.proof?.windows?.[0]?.comparisonFrom || receipt?.windows?.[0]?.comparisonFrom || receipt?.windows?.[0]?.from);
      const verifiedEnd = asDate(receipt?.windows?.[0]?.to);
      if (verifiedStart && verifiedEnd && verifiedStart <= row.fromAt && verifiedEnd >= row.fromAt) {
        fromAt = verifiedStart;
        if (+fromAt < +row.fromAt) report.repairedStarts++;
        reason = "FINANCIAL_PROOF_ADOPTION";
      } else {
        reason = "FINANCIAL_PROOF_ADOPTION_FULL";
        // This is a requested verification boundary, not a manufactured proof.
        // It also keeps a narrower catch-up from consuming the full-scan debt.
        gapFrom = new Date(row.fromAt); gapFrom.setUTCHours(0, 0, 0, 0);
      }
      await db.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v7',true)");
      await db.$executeRawUnsafe(`UPDATE "CreatorEarningsLedgerProof" SET "fromAt"=$2::timestamp,"confirmedThroughAt"="throughAt",
        "proofPolicyVersion"=$3 WHERE "creatorId"=$1 AND "proofPolicyVersion"=$4`, row.creatorId, fromAt.toISOString(),
      FINANCIAL_PROOF_POLICY_VERSION, row.proofPolicyVersion);
      report.adopted++;
    }
    for (const candidate of [row.shortGapTo, row.strandedThrough, row.lostThrough]) {
      const through = asDate(candidate);
      const bounded = through && legacy && through > targetAt ? asDate(targetAt) : through;
      if (bounded && bounded > row.throughAt && (!end || bounded > end)) end = bounded;
    }
    const shortStart = asDate(row.shortGapFrom);
    if (shortStart && row.shortGapTo > row.throughAt && shortStart < gapFrom) gapFrom = shortStart;
    if (!end || end <= gapFrom) continue;
    // One unfinished financial obligation owns its immutable target, including
    // STOPPED work. A later heartbeat cannot allocate a new generation behind
    // that owner or reset its retry budget. Remaining tail is evaluated after
    // successful completion advances the provider boundary.
    const id = hashCanonicalJson(["financial-proof", FINANCIAL_PROOF_POLICY_VERSION, row.creatorId, gapFrom.toISOString(), end.toISOString(), reason]);
    const created = await db.$executeRawUnsafe(`INSERT INTO "CreatorRecoveryIntent"
      (id,"agencyId","creatorId",stream,reason,"gapFrom","targetAt","policyVersion")
      SELECT $1,$2,$3,'financial',$4,$5::timestamp,$6::timestamp,2
      WHERE NOT EXISTS(SELECT 1 FROM "CreatorRecoveryIntent" WHERE "creatorId"=$3 AND stream='financial' AND status<>'COMPLETE'
        AND (NOT $7::boolean OR ("gapFrom"<=$5::timestamp AND "targetAt">=$6::timestamp AND (reason=$4 OR $4<>'FINANCIAL_PROOF_ADOPTION_FULL'))))
      ON CONFLICT(id) DO NOTHING`, id, agencyId, row.creatorId, reason, gapFrom.toISOString(), end.toISOString(), legacy);
    if (created) { report.queued++; wake.push(row.creatorId); }
  }
  if (wake.length) await require("./domain-work-authority-service").publishDomainWorkBatch({ db, items: wake.map(creatorId => ({
    agencyId, creatorId, workClass: "CREATOR_RECURRING_PLANNING", objectType: "CreatorAccount", objectId: creatorId, partitionKey: creatorId,
  })) });
  return report;
}

async function inventory({ db, agencyId = null, cursor = "", upperCreatorId = null, limit = PAGE }) {
  const size = Math.min(100, Math.max(1, Number(limit) || PAGE));
  return db.$queryRawUnsafe(`SELECT p."creatorId",p."agencyId",p."proofPolicyVersion",p."fromAt",p."throughAt",p."confirmedThroughAt",
      l."shortGapFrom",l."shortGapTo",
      (p."proofPolicyVersion"<>$4 OR l."shortGapTo">p."throughAt") AS candidate,
      (SELECT count(*)::int FROM "CreatorRecoveryIntent" i WHERE i."creatorId"=p."creatorId" AND i.stream='financial' AND i.status<>'COMPLETE') AS "openRecoveryCount"
    FROM "CreatorEarningsLedgerProof" p JOIN "CreatorAccount" c ON c.id=p."creatorId" AND c."deletedAt" IS NULL
    LEFT JOIN "CreatorLiveSync" l ON l."creatorId"=p."creatorId"
    WHERE ($1::text IS NULL OR p."agencyId"=$1) AND p."creatorId">$2 AND ($3::text IS NULL OR p."creatorId"<=$3)
    ORDER BY p."creatorId" LIMIT $5`, agencyId, cursor, upperCreatorId, FINANCIAL_PROOF_POLICY_VERSION, size);
}

async function runRepairPage({ db = require("../prisma"), runId = "financial-proof-v1", agencyId = null,
  mode = "dry-run", cursor = "", targetAt = new Date(), expectedRevision = null, limit = PAGE } = {}) {
  if (!["dry-run", "apply"].includes(mode) || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(runId)) throw fault("FINANCIAL_REPAIR_INPUT_INVALID");
  const target = asDate(targetAt); if (!target) throw fault("FINANCIAL_REPAIR_TARGET_INVALID");
  if (mode === "dry-run") {
    const rows = await inventory({ db, agencyId, cursor, limit });
    return { runId, policyVersion: FINANCIAL_PROOF_POLICY_VERSION, mode, scope: { agencyId }, cursor,
      targetAt: target.toISOString(), revision: 0, status: rows.length ? "PREVIEW" : "COMPLETE", counts: { visited: rows.length, candidates: rows.filter(row => row.candidate === true).length },
      candidates: rows.filter(row => row.candidate === true), nextCursor: rows.at(-1)?.creatorId || null };
  }
  return runRootCommit(db, async ({ tx }) => {
    const key = `repair:financial-proof:${runId}`;
    await tx.$executeRawUnsafe(`INSERT INTO "SystemSetting"(id,key,value,"updatedAt") VALUES($1,$1,'{}'::jsonb,clock_timestamp()) ON CONFLICT(key) DO NOTHING`, key);
    const [stored] = await tx.$queryRawUnsafe('SELECT * FROM "SystemSetting" WHERE key=$1 FOR UPDATE', key);
    if (expectedRevision != null && stored.revision !== expectedRevision) throw fault("FINANCIAL_REPAIR_REVISION_CONFLICT");
    let state = stored.value;
    if (!state.runId) {
      const [upper] = await tx.$queryRawUnsafe('SELECT max("creatorId") AS id FROM "CreatorEarningsLedgerProof" WHERE ($1::text IS NULL OR "agencyId"=$1)', agencyId);
      state = { runId, policyVersion: FINANCIAL_PROOF_POLICY_VERSION, mode, scope: { agencyId }, cursor: "", upperCreatorId: upper.id || "",
        targetAt: target.toISOString(), revision: stored.revision, status: "RUNNING", counts: { visited: 0, adopted: 0, queued: 0, repairedStarts: 0 } };
    } else if (state.policyVersion !== FINANCIAL_PROOF_POLICY_VERSION || state.scope.agencyId !== agencyId) throw fault("FINANCIAL_REPAIR_SCOPE_MISMATCH");
    if (state.status === "COMPLETE") return { ...state, revision: stored.revision, pageVisited: 0 };
    const rows = await inventory({ db: tx, agencyId, cursor: state.cursor, upperCreatorId: state.upperCreatorId, limit });
    for (const row of rows) {
      // Page over indexed proof identities before checking eligibility. A page
      // with no remaining candidates must not scan an unbounded upgraded tail.
      state.counts.visited++;
      state.cursor = row.creatorId;
      if (row.candidate !== true) continue;
      await tx.$executeRawUnsafe('INSERT INTO "CreatorLiveSync"("creatorId","agencyId") VALUES($1,$2) ON CONFLICT("creatorId") DO NOTHING', row.creatorId, row.agencyId);
      await tx.$queryRawUnsafe('SELECT "creatorId" FROM "CreatorLiveSync" WHERE "creatorId"=$1 FOR UPDATE', row.creatorId);
      const result = await ensureFinancialDebt({ db: tx, agencyId: row.agencyId, creatorIds: [row.creatorId], now: target, targetAt: new Date(state.targetAt) });
      for (const name of ["adopted", "queued", "repairedStarts"]) state.counts[name] += result[name];
    }
    state.status = rows.length < Math.min(100, Math.max(1, Number(limit) || PAGE)) ? "COMPLETE" : "RUNNING";
    state.completionMeaning = "ADOPTION_ONLY_PROVIDER_RECOVERY_MUST_COMPLETE";
    const [verification] = await tx.$queryRawUnsafe(`SELECT
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM "CreatorRecoveryIntent" i WHERE i."creatorId"=p."creatorId" AND i.stream='financial' AND i.status<>'COMPLETE'))::int AS pending,
      count(*) FILTER(WHERE p."proofPolicyVersion"=$2 AND p."throughAt">=$3::timestamp)::int AS verified
      FROM "CreatorEarningsLedgerProof" p WHERE ($1::text IS NULL OR p."agencyId"=$1) AND p."creatorId"=ANY($4::text[])`,
    agencyId, FINANCIAL_PROOF_POLICY_VERSION, state.targetAt, rows.map(row => row.creatorId));
    state.counts.recoveryPending = (state.counts.recoveryPending || 0) + verification.pending;
    state.counts.verified = (state.counts.verified || 0) + verification.verified;
    state.countsRecordedAtAdoption = true;
    state.revision = stored.revision + 1;
    const changed = await tx.systemSetting.updateMany({ where: { id: stored.id, revision: stored.revision },
      data: { value: state, revision: { increment: 1 } } });
    if (changed.count !== 1) throw fault("FINANCIAL_REPAIR_REVISION_CONFLICT");
    return { ...state, pageVisited: rows.length };
  }, { profile: "COMMAND", timeout: 15000, statementTimeoutMs: 10000, authority: { kind: "FINANCIAL_PROOF_REPAIR", ...(agencyId ? { agencyId } : {}) } });
}

async function runSweep({ db = require("../prisma"), now = new Date(), limit = PAGE } = {}) {
  const result = await runRepairPage({ db, mode: "apply", targetAt: now, limit });
  return { ok: true, processed: result.pageVisited, status: result.status,
    completionMeaning: "ADOPTION_ONLY_PROVIDER_RECOVERY_MUST_COMPLETE", counts: result.counts };
}

module.exports = { ensureFinancialDebt, inventory, runRepairPage, runSweep, PAGE };
