"use strict";

// Financial proof has its own version, independent of syncPolicyVersion.
// Version 0 preserves the provider scan, not its old global heartbeat extension.
const FINANCIAL_PROOF_POLICY_VERSION = 2;

// SQL references are source-owned expressions. Canonical fact projections are
// applied in bounded units before the ledger pointer swap. All secondary money
// readers share this fence while a replacement is incomplete or still uses
// the former membership policy; saved amounts remain independently available.
function financialPublicationPendingSql(creatorId) {
  return `(EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" fp
      WHERE fp."creatorId"=${creatorId} AND fp."proofPolicyVersion"<>${FINANCIAL_PROOF_POLICY_VERSION})
    OR EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" fg
      WHERE fg."creatorId"=${creatorId} AND (fg.state='REPAIRING' OR (fg."fullScan" AND fg.state IN ('BUILDING','READY')))))`;
}

// An outstanding sequence is tied to its receiver. Another receiver can close
// that debt only with independently delivered intervals covering the entire
// uncertain tail after the provider snapshot, never with a later empty frame.
function uncoveredReceiverDebtSql(proof = 'p', receiver = 's') {
  const hi = `GREATEST(CASE WHEN ${receiver}."capturedSeq">${receiver}."ackedSeq"
      THEN COALESCE(${receiver}."unackedThroughAt",${receiver}."capturedAt") END,
    CASE WHEN ${receiver}.loss THEN COALESCE(${receiver}."lossAt",${receiver}."capturedAt") END)`;
  return `(${hi}>${proof}."throughAt" AND NOT COALESCE((
    SELECT range_agg(tsrange(dr."captureFromAt",dr."capturedAt",'[]'))
      @> tsrange(${proof}."throughAt",GREATEST(${proof}."throughAt",${hi}),'[]')
    FROM "CreatorRealtimeSession" dr WHERE dr."creatorId"=${receiver}."creatorId" AND dr.id<>${receiver}.id
      AND dr."ackedSeq">=dr."capturedSeq" AND dr."captureFromAt" IS NOT NULL
      AND dr."capturedAt">=dr."captureFromAt" AND (NOT dr.loss OR dr."lossAt"<=${proof}."throughAt")
  ),false))`;
}

async function advanceDelivered(db, creatorIds) {
  if (!creatorIds.length) return 0;
  await db.$executeRawUnsafe("SELECT set_config('onlinod.earnings_writer_generation','v8',true)");
  // Walk delivered receiver intervals from the proven boundary. An empty
  // receiver cannot acknowledge another receiver's undelivered sequence,
  // including a retired incarnation. A later provider proof can independently
  // cover that old tail; no journal entries need be discarded.
  return db.$executeRawUnsafe(`WITH RECURSIVE eligible AS MATERIALIZED (
    SELECT p."creatorId",p."throughAt",
      GREATEST(p."throughAt",p."confirmedThroughAt") AS frontier
    FROM "CreatorEarningsLedgerProof" p
    WHERE p."creatorId"=ANY($1::text[]) AND p."proofPolicyVersion"=$2
      AND NOT EXISTS(SELECT 1 FROM "CreatorRecoveryIntent" i
        WHERE i."creatorId"=p."creatorId" AND i.stream='financial' AND i.status<>'COMPLETE')
      AND NOT EXISTS(SELECT 1 FROM "CreatorRealtimeSession" s
        WHERE s."creatorId"=p."creatorId" AND ${uncoveredReceiverDebtSql()})
      AND NOT EXISTS(SELECT 1 FROM "CreatorMoneyObservation" m WHERE m."creatorId"=p."creatorId" AND m.status='PENDING'
        AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" g WHERE g.id=m."coveredGeneration" AND g."publishedAt" IS NOT NULL))
    ), delivered AS MATERIALIZED (
      SELECT s."creatorId",s."captureFromAt" AS lo,s."capturedAt" AS hi
      FROM "CreatorRealtimeSession" s JOIN eligible p ON p."creatorId"=s."creatorId"
      WHERE s."ackedSeq">=s."capturedSeq" AND s."captureFromAt" IS NOT NULL
        AND s."captureFromAt"<=s."capturedAt" AND s."capturedAt">p.frontier
        AND (NOT s.loss OR s."lossAt"<=p."throughAt")
    ), walk AS (
      SELECT "creatorId",frontier::timestamp FROM eligible
      UNION ALL
      SELECT w."creatorId",n.hi FROM walk w
      CROSS JOIN LATERAL (SELECT max(d.hi) AS hi FROM delivered d
        WHERE d."creatorId"=w."creatorId" AND d.lo<=w.frontier AND d.hi>w.frontier) n
      WHERE n.hi IS NOT NULL
    ), complete AS (SELECT "creatorId",max(frontier) AS frontier FROM walk GROUP BY "creatorId")
    UPDATE "CreatorEarningsLedgerProof" p SET "confirmedThroughAt"=c.frontier
    FROM complete c WHERE p."creatorId"=c."creatorId"
      AND c.frontier>GREATEST(p."throughAt",p."confirmedThroughAt")`, creatorIds, FINANCIAL_PROOF_POLICY_VERSION);
}

module.exports = { advanceDelivered, FINANCIAL_PROOF_POLICY_VERSION, uncoveredReceiverDebtSql, financialPublicationPendingSql };
