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

// A late notification must consult the same neighborhood as a late payout.
// Match only before a separate notification identity exists. Once both roots
// exist, their immutable identities and manual histories require review.
async function notificationCandidates({ db, job, facts, fanRecordIds, kind }) {
  if (typeof db.$queryRawUnsafe !== "function" || !facts.length) return new Map();
  const table = kind === "SALE" ? "CreatorSale" : "CreatorTip", time = kind === "SALE" ? "purchasedAt" : "tippedAt";
  const input = facts.filter(fact => !fact.externalTransactionId && fact.externalNotificationId && fact.amountCents > 0
    && fanRecordIds.get(fact.externalFanId)).map(fact => ({
    fingerprint: fact.fingerprint, notificationId: fact.externalNotificationId,
    fanId: fanRecordIds.get(fact.externalFanId), amountCents: fact.amountCents,
    currency: fact.currency, occurredAt: fact.occurredAt, saleType: fact.saleType || "OTHER",
  }));
  if (!input.length) return new Map();
  if (input.length > 500) throw Error("FINANCIAL_CORRELATION_PAGE_TOO_LARGE");
  const rows = await db.$queryRawUnsafe(`WITH incoming AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($3::jsonb)
      r(fingerprint text,"notificationId" text,"fanId" text,"amountCents" integer,currency text,"occurredAt" timestamp,"saleType" text)
  ) SELECT r.fingerprint AS "incomingFingerprint",r."notificationId" AS "incomingNotificationId",r."occurredAt" AS "notificationAt",f.*
    FROM incoming r CROSS JOIN LATERAL (SELECT f.* FROM "${table}" f
      WHERE f."agencyId"=$1 AND f."creatorId"=$2 AND f."fanId"=r."fanId"
        AND f."externalTransactionId" IS NOT NULL AND f."externalNotificationId" IS NULL
        AND f."amountCents"=r."amountCents" AND f.currency=r.currency
        AND f."${time}" BETWEEN r."occurredAt"-interval '5 seconds' AND r."occurredAt"+interval '5 seconds'
        AND COALESCE(f."financialCorrelation"->>'state','')<>'AMBIGUOUS'
        ${kind === "SALE" ? 'AND f."saleType"::text=r."saleType"' : ""}
      ORDER BY f.id LIMIT 2) f
    WHERE NOT EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" p
      WHERE p."creatorId"=$2 AND p."fanId"=r."fanId" AND p."externalTransactionId"<>f."externalTransactionId"
        AND p."factType"::text=$4 AND p."amountCents"=r."amountCents" AND p.currency=r.currency
        AND p."occurredAt" BETWEEN r."occurredAt"-interval '5 seconds' AND r."occurredAt"+interval '5 seconds')
      AND NOT EXISTS(SELECT 1 FROM "${table}" n WHERE n."creatorId"=$2 AND n."fanId"=r."fanId"
        AND n."externalNotificationId" IS NOT NULL AND n."amountCents"=r."amountCents" AND n.currency=r.currency
        AND n."${time}" BETWEEN f."${time}"-interval '5 seconds' AND f."${time}"+interval '5 seconds'
        ${kind === "SALE" ? 'AND n."saleType"::text=r."saleType"' : ""})
      AND NOT EXISTS(SELECT 1 FROM incoming n WHERE n."notificationId"<>r."notificationId" AND n."fanId"=r."fanId"
        AND n."amountCents"=r."amountCents" AND n.currency=r.currency
        AND n."occurredAt" BETWEEN f."${time}"-interval '5 seconds' AND f."${time}"+interval '5 seconds'
        ${kind === "SALE" ? 'AND n."saleType"=r."saleType"' : ""})`,
  job.agencyId, job.creatorId, JSON.stringify(input), kind);
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.incomingFingerprint) || [];
    group.push(row); groups.set(row.incomingFingerprint, group);
  }
  return new Map([...groups].filter(([, rows]) => rows.length === 1).map(([fingerprint, [row]]) => [fingerprint, {
    ...row, fanRecordId: row.fanId, financialCorrelation: { version: 1, kind: "NEIGHBORHOOD", state: "UNIQUE",
      transactionId: row.externalTransactionId, notificationId: row.incomingNotificationId,
      fanId: row.fanId, amountCents: row.amountCents, currency: row.currency, occurredAt: row.notificationAt.toISOString() },
  }]));
}

function reviewMessageId(fact) {
  return fact?.messageId || fact?.financialCorrelation?.reviewMessageId || null;
}
async function reviewCandidates(db, fact, kind) {
  const ids = fact?.financialCorrelation?.notificationFactIds;
  if (!Array.isArray(ids) || !ids.length) return [];
  const model = kind === "SALE" ? "teamPpvPurchaseLedger" : "teamTipLedger";
  if (!db[model]?.findMany) return [];
  const rows = await db[model].findMany({ where: { agencyId: fact.agencyId, creatorId: fact.creatorId,
    [kind === "SALE" ? "creatorSaleId" : "creatorTipId"]: { in: ids.slice(0, 100) }, attributedMemberId: { not: null } }, take: 100 });
  return rows.map(row => ({ memberId: row.attributedMemberId, userId: row.attributedUserId,
    shiftKey: row.attributedShiftKey, source: "separate_notification_owner_evidence" }));
}

// Older builds could persist payout and notification as different canonical
// facts. Preserve both identities, withdraw unverified notification money, and
// put the payout's real money in the existing manager review lane. A manual
// owner is retained as evidence, never copied to a different operation.
async function quarantineSeparateIdentities({ db, job, anchors, kind, now }) {
  if (!anchors.length) return [];
  const table = kind === "SALE" ? "CreatorSale" : "CreatorTip", time = kind === "SALE" ? "purchasedAt" : "tippedAt";
  const pairs = await db.$queryRawUnsafe(`WITH payouts AS MATERIALIZED (
    SELECT DISTINCT p.id FROM jsonb_to_recordset($3::jsonb) a("fanId" text,"amountCents" integer,currency text,"occurredAt" timestamp)
    JOIN "${table}" p ON p."creatorId"=$2 AND p."fanId"=a."fanId" AND p."amountCents"=a."amountCents" AND p.currency=a.currency
      AND p."${time}" BETWEEN a."occurredAt"-interval '10 seconds' AND a."occurredAt"+interval '10 seconds'
    WHERE p."agencyId"=$1 AND p."externalTransactionId" IS NOT NULL AND p."externalNotificationId" IS NULL
      AND COALESCE(p."financialCorrelation"->>'kind','')<>'EXACT'
  ) SELECT p.id AS "payoutId",p."externalTransactionId",n.id AS "notificationFactId",n."externalNotificationId",n."messageId"
    FROM payouts c JOIN "${table}" p ON p.id=c.id JOIN "${table}" n ON n."creatorId"=$2 AND n."fanId"=p."fanId"
      AND n."externalTransactionId" IS NULL AND n."externalNotificationId" IS NOT NULL
      AND n."amountCents"=p."amountCents" AND n.currency=p.currency
      AND n."${time}" BETWEEN p."${time}"-interval '5 seconds' AND p."${time}"+interval '5 seconds'
      ${kind === "SALE" ? 'AND n."saleType"=p."saleType"' : ""}
    ORDER BY p.id,n.id`, job.agencyId, job.creatorId, JSON.stringify(anchors));
  if (!pairs.length) return [];
  const groups = new Map();
  for (const row of pairs) {
    const group = groups.get(row.payoutId) || { id: row.payoutId, transactionId: row.externalTransactionId,
      notificationFactIds: [], reviewMessageId: null };
    if (group.notificationFactIds.length < 100) group.notificationFactIds.push(row.notificationFactId);
    group.reviewMessageId ||= row.messageId || null;
    groups.set(row.payoutId, group);
  }
  const changed = await db.$queryRawUnsafe(`UPDATE "${table}" f SET "financialCorrelation"=
    jsonb_build_object('version',1,'kind','LEGACY_NEIGHBORHOOD','state','AMBIGUOUS',
      'transactionId',r."transactionId",'notificationFactIds',r."notificationFactIds",'reviewMessageId',r."reviewMessageId",
      'reason','SEPARATE_CANONICAL_IDENTITIES','ambiguousAt',to_char($4::timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),"updatedAt"=$4
    FROM jsonb_to_recordset($3::jsonb) r(id text,"transactionId" text,"notificationFactIds" jsonb,"reviewMessageId" text)
    WHERE f.id=r.id AND f."agencyId"=$1 AND f."creatorId"=$2
      AND (f."financialCorrelation"->>'reason' IS DISTINCT FROM 'SEPARATE_CANONICAL_IDENTITIES'
        OR f."financialCorrelation"->'notificationFactIds' IS DISTINCT FROM r."notificationFactIds") RETURNING f.id`,
  job.agencyId, job.creatorId, JSON.stringify([...groups.values()]), now);
  const held = await db.$queryRawUnsafe(`UPDATE "${table}" SET "transactionStatus"='unverified',"updatedAt"=$4
    WHERE "agencyId"=$1 AND "creatorId"=$2 AND id=ANY($3::text[]) AND "externalTransactionId" IS NULL
      AND COALESCE("transactionStatus",'') NOT IN ('unverified','undo','refunded','refund','chargeback','reversed','reversal','superseded') RETURNING id`,
  job.agencyId, job.creatorId, [...new Set(pairs.map(row => row.notificationFactId))], now);
  return [...new Set([...changed, ...held].map(row => row.id))];
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
  const separate = await quarantineSeparateIdentities({ db, job, anchors, kind, now });
  return [...new Set([...changed, ...held].map(row => row.id).concat(separate))];
}
module.exports = { exactEvidence, neighborhoodEvidence, requiresReview, restoredManualDecision, invalidateNeighborhoods,
  notificationCandidates, reviewMessageId, reviewCandidates };
