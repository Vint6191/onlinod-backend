"use strict";

// The payout remains a durable canonical operation. A time/amount correlation
// is separate evidence and can lose uniqueness when another observation arrives.
function exactEvidence(fact) {
  if (!fact?.externalTransactionId || !fact.externalNotificationId) return null;
  return { version: 1, kind: "EXACT", state: "EXACT", transactionId: fact.externalTransactionId,
    notificationId: fact.externalNotificationId };
}
function neighborhoodEvidence(previous, incoming, kind, now) {
  if (previous?.externalTransactionId) {
    const evidence = previous.financialCorrelation;
    if (evidence?.kind === "NEIGHBORHOOD" && evidence.state === "UNIQUE"
      && (incoming.fanRecordId !== evidence.fanId || incoming.amountCents !== evidence.amountCents
        || incoming.currency !== evidence.currency || Math.abs(+new Date(incoming.occurredAt) - Date.parse(evidence.occurredAt)) > 5000)) {
      return { ...evidence, state: "AMBIGUOUS", ambiguousAt: new Date(now).toISOString(), reason: "SOURCE_NEIGHBORHOOD_CHANGED" };
    }
    return evidence || null;
  }
  if (!previous) return null;
  return { version: 1, kind: "NEIGHBORHOOD", state: "UNIQUE",
    transactionId: incoming.externalTransactionId, notificationId: previous.externalNotificationId || null,
    fanId: previous.fanRecordId || previous.fanId, amountCents: previous.amountCents,
    currency: previous.currency, occurredAt: new Date(previous[kind === "SALE" ? "purchasedAt" : "tippedAt"]).toISOString() };
}
function requiresReview(fact, root) {
  const evidence = fact?.financialCorrelation;
  if (evidence?.kind === "EXACT" && evidence.state === "EXACT") return false;
  if (evidence?.state !== "AMBIGUOUS" && root?.attributionBasis !== "FINANCIAL_IDENTITY_AMBIGUOUS") return false;
  // A manager may adjudicate this exact conflict after it became visible. Keep
  // that explicit ownership decision; an older manual owner remains evidence.
  const manual = String(root?.resolvedSource || "").startsWith("manual_");
  if (manual && ["rejected", "released", "unresolved", "creator_revenue"].includes(root?.status)) return false;
  if (manual && root?.resolvedAt && evidence?.ambiguousAt && +new Date(root.resolvedAt) >= Date.parse(evidence.ambiguousAt)) return false;
  return true;
}
function restoredManualDecision(fact, root) {
  if (fact?.financialCorrelation?.state !== "EXACT" || root?.status !== "conflict"
    || root.attributionBasis !== "FINANCIAL_IDENTITY_AMBIGUOUS") return {};
  const statuses = { manual_claim_resolution: "attributed", manual_manager_resolution: "resolved",
    manual_manager_migration_review: "resolved", manual_chatter_claim: "claimed" };
  const status = statuses[root.resolvedSource];
  return status && root.attributedMemberId ? { status, attributionBasis: "MANUAL_OVERRIDE_PRESERVED" } : {};
}
async function invalidateNeighborhoods({ db, job, rows, kind, now }) {
  if (!rows.length) return [];
  if (rows.length > 500) throw Error("FINANCIAL_CORRELATION_PAGE_TOO_LARGE");
  const table = kind === "SALE" ? "CreatorSale" : "CreatorTip", time = kind === "SALE" ? "purchasedAt" : "tippedAt";
  const anchors = rows.filter(row => row.fanRecordId && row.amountCents > 0).map(row => ({
    fanId: row.fanRecordId, amountCents: row.amountCents, currency: row.currency, occurredAt: row.occurredAt || row[time],
  }));
  if (!anchors.length) return [];
  const runId = job.financialReceiptRunId || (job.id && job.params?.financialReceiptVersion === 1
    ? require("./financial-receipt-authority").runId(job) : null);
  // First bound by the indexed creator/fan/time neighborhood, then compare the
  // original notification coordinates. Payout replacement cannot drift them.
  const changed = await db.$queryRawUnsafe(`WITH candidates AS MATERIALIZED (
    SELECT DISTINCT f.id FROM jsonb_to_recordset($3::jsonb) a("fanId" text,"amountCents" integer,currency text,"occurredAt" timestamp)
    JOIN "${table}" f ON f."creatorId"=$2 AND f."fanId"=a."fanId"
      AND f."${time}" BETWEEN a."occurredAt"-interval '10 seconds' AND a."occurredAt"+interval '10 seconds'
      AND f."amountCents"=a."amountCents" AND f.currency=a.currency
    WHERE f."agencyId"=$1 AND f."externalTransactionId" IS NOT NULL AND f."externalNotificationId" IS NOT NULL
      AND COALESCE(f."financialCorrelation"->>'kind','')<>'EXACT'
      AND COALESCE(f."financialCorrelation"->>'state','')<>'AMBIGUOUS'
  ), ambiguous AS MATERIALIZED (
    SELECT f.id FROM candidates c JOIN "${table}" f ON f.id=c.id
    CROSS JOIN LATERAL (SELECT COALESCE((f."financialCorrelation"->>'occurredAt')::timestamp,f."${time}") AS at) origin
    WHERE EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" p WHERE p."creatorId"=$2 AND p."fanId"=f."fanId"
      AND p."externalTransactionId"<>f."externalTransactionId" AND p."factType"::text=$5
      AND p."amountCents"=f."amountCents" AND p.currency=f.currency
      AND p."occurredAt" BETWEEN origin.at-interval '5 seconds' AND origin.at+interval '5 seconds')
    OR EXISTS(SELECT 1 FROM "FinancialObservedFact" p WHERE p."runId"=$4 AND p."windowIndex"=0
      AND p."externalId"<>f."externalTransactionId" AND p.value->>'factType'=$5
      AND p.value->>'fanOnlyFansUserId'=f."fanOnlyFansUserIdAtEvent"
      AND p.value->>'amountCents'=f."amountCents"::text AND p.value->>'currency'=f.currency
      AND p."occurredAt" BETWEEN origin.at-interval '5 seconds' AND origin.at+interval '5 seconds')
    OR EXISTS(SELECT 1 FROM "${table}" n WHERE n."creatorId"=$2 AND n."fanId"=f."fanId" AND n.id<>f.id
      AND n."externalNotificationId" IS NOT NULL AND n."amountCents"=f."amountCents" AND n.currency=f.currency
      AND n."${time}" BETWEEN f."${time}"-interval '5 seconds' AND f."${time}"+interval '5 seconds'
      ${kind === "SALE" ? 'AND n."saleType"=f."saleType"' : ""})
  ) UPDATE "${table}" f SET "financialCorrelation"=COALESCE(f."financialCorrelation",
    jsonb_build_object('version',1,'kind','LEGACY_NEIGHBORHOOD','transactionId',f."externalTransactionId",'notificationId',f."externalNotificationId",
      'fanId',f."fanId",'amountCents',f."amountCents",'currency',f.currency,'occurredAt',f."${time}"))
      || jsonb_build_object('state','AMBIGUOUS','ambiguousAt',to_char($6::timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reason','MULTIPLE_FINANCIAL_IDENTITIES'),"updatedAt"=$6
    FROM ambiguous a WHERE f.id=a.id RETURNING f.id`, job.agencyId, job.creatorId, JSON.stringify(anchors), runId, kind, now);
  const held = await db.$queryRawUnsafe(`WITH candidates AS MATERIALIZED (
    SELECT DISTINCT f.id FROM jsonb_to_recordset($3::jsonb) a("fanId" text,"amountCents" integer,currency text,"occurredAt" timestamp)
    JOIN "${table}" f ON f."creatorId"=$2 AND f."fanId"=a."fanId"
      AND f."${time}" BETWEEN a."occurredAt"-interval '10 seconds' AND a."occurredAt"+interval '10 seconds'
      AND f."amountCents"=a."amountCents" AND f.currency=a.currency
    WHERE f."agencyId"=$1 AND f."externalTransactionId" IS NULL AND f."externalNotificationId" IS NOT NULL
      AND COALESCE(f."transactionStatus",'') NOT IN ('unverified','undo','refunded','refund','chargeback','reversed','reversal','superseded')
  ) UPDATE "${table}" f SET "transactionStatus"='unverified',"updatedAt"=$4 FROM candidates c
    WHERE f.id=c.id AND EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" p
      WHERE p."creatorId"=$2 AND p."fanId"=f."fanId" AND p."factType"::text=$5
        AND p."amountCents"=f."amountCents" AND p.currency=f.currency
        AND p."occurredAt" BETWEEN f."${time}"-interval '5 seconds' AND f."${time}"+interval '5 seconds'
        AND (EXISTS(SELECT 1 FROM "${table}" n WHERE n."creatorId"=$2 AND n."fanId"=f."fanId" AND n.id<>f.id
          AND n."externalNotificationId" IS NOT NULL AND n."amountCents"=f."amountCents" AND n.currency=f.currency
          AND n."${time}" BETWEEN p."occurredAt"-interval '5 seconds' AND p."occurredAt"+interval '5 seconds'
          ${kind === "SALE" ? 'AND n."saleType"=f."saleType"' : ""})
        OR EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" other WHERE other."creatorId"=$2 AND other."fanId"=f."fanId"
          AND other.id<>p.id AND other."factType"::text=$5 AND other."amountCents"=f."amountCents" AND other.currency=f.currency
          AND other."occurredAt" BETWEEN f."${time}"-interval '5 seconds' AND f."${time}"+interval '5 seconds')))
    RETURNING f.id`, job.agencyId, job.creatorId, JSON.stringify(anchors), now, kind);
  return [...new Set([...changed, ...held].map(row => row.id))];
}
module.exports = { exactEvidence, neighborhoodEvidence, requiresReview, restoredManualDecision, invalidateNeighborhoods };
