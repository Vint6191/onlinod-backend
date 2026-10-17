"use strict";

const { COLLECTION_FUTURE_SKEW_TOLERANCE_MS } = require("./analytics-freshness-policy");
const { earningsObservationSql } = require("./analytics-observation-time");
const CREATOR_BATCH = 250;
const DAY = 86400000;

// These aliases are fixed by source code, never accepted from an API. Published
// facts and durable proof describe the SAME day and scan. Mutable collection
// coverage must not invalidate the previous published snapshot. Operational
// jobs and ingest batches are deliberately absent: retention may remove them.
function publishedEarningsJoins() {
  return `JOIN "AnalyticsScanProof" p ON p."id"=d."scanProofId" AND p."creatorId"=d."creatorId" AND p."agencyId"=d."agencyId"
      AND p."dataType"='EARNINGS' AND p."sourceTimezone"='UTC' AND p."status"='COMMITTED'
      AND p."proofVersion"=2 AND p."committedAt" IS NOT NULL
      AND p."scanRunId"=d."sourceScanRunId" AND d."date" BETWEEN p."scanFrom" AND p."scanTo"
    CROSS JOIN LATERAL (SELECT d."coverageStatus" AS status,d."lastVerifiedAt" AS "lastVerifiedAt") v`;
}
function windowDays(from, to) {
  const count = (new Date(to)-new Date(from))/DAY + 1;
  if (!Number.isInteger(count) || count < 1 || count > 366) {
    throw Object.assign(new Error("EARNINGS_READ_WINDOW_INVALID"), { code: "EARNINGS_READ_WINDOW_INVALID", status: 400 });
  }
  return count;
}
function integer(value) {
  const n = Number(value || 0);
  if (!Number.isSafeInteger(n)) throw Object.assign(new Error("EARNINGS_AGGREGATE_OUT_OF_RANGE"), { code: "EARNINGS_AGGREGATE_OUT_OF_RANGE" });
  return n;
}

async function readPublishedEarningsDays({ db, creatorId, from, to, now }) {
  windowDays(from, to);
  const today = new Date(now.toISOString().slice(0, 10));
  const rows = await db.$queryRawUnsafe(`/* published_earnings_days_v1 */
    WITH live_scope AS (SELECT id,"agencyId" FROM "CreatorAccount" WHERE id=$1),
    periods AS (SELECT 0 AS period,($2::timestamptz AT TIME ZONE 'UTC')::date AS start_day,($3::timestamptz AT TIME ZONE 'UTC')::date AS end_day),
    ${require("./earnings-live-read-sql").liveLedgerDailySql("live_scope","$5")},
    published AS MATERIALIZED (
      SELECT d.*,${earningsObservationSql()} AS "publishedObservedAt" FROM "CreatorEarningsPublishedDay" d ${publishedEarningsJoins()}
      WHERE d."creatorId"=$1 AND d."sourceTimezone"='UTC' AND d."date" BETWEEN ($2::timestamptz AT TIME ZONE 'UTC')::date AND ($3::timestamptz AT TIME ZONE 'UTC')::date
        AND (v."status"='COMPLETE' OR (d."date"=($4::timestamptz AT TIME ZONE 'UTC')::date AND v."status"='PARTIAL'))
    )
    SELECT d.*,to_jsonb(l) AS live,days.date AS "stateDate",COALESCE(d."coverageStatus",c."status"::text,'MISSING') AS "coverageStatus",d."publishedObservedAt" AS "coverageVerifiedAt",
      c."retryAfterAt" AS "coverageRetryAfterAt",c."lastErrorCode" AS "coverageErrorCode"
    FROM generate_series(($2::timestamptz AT TIME ZONE 'UTC'),($3::timestamptz AT TIME ZONE 'UTC'),interval '1 day') days(date)
    LEFT JOIN "AnalyticsCoverage" c ON c."creatorId"=$1 AND c."dataType"='EARNINGS' AND c."sourceTimezone"='UTC' AND c."coverageDate"=days.date
    LEFT JOIN published d ON d."date"=days.date LEFT JOIN ledger_daily l ON l.date=days.date ORDER BY days.date`, creatorId, from, to, today, now);
  // Retry/partial hints survive even when amounts are unavailable. They can
  // never certify money: only the joined published row supplies proof status.
  return rows.map(({ live,stateDate,coverageStatus,coverageVerifiedAt,coverageRetryAfterAt,coverageErrorCode,publishedObservedAt,...daily }) => {
    if(live) {
      const categories={};for(const key of ["subscriptions","messages","tips","posts","streams","referrals"])
        categories[key+"Cents"]=live.categoryTotals?.other ? null : integer(live.categoryTotals?.[key] || 0);
      return {daily:{id:`ledger:${creatorId}:${new Date(stateDate).toISOString().slice(0,10)}`,creatorId,date:stateDate,
        sourceTimezone:"UTC",currency:"USD",...categories,totalCents:integer(live.totalCents),hourlyPoints:live.hourlyPoints,
        collectedAt:new Date(live.collectedAt)},
        coverage:{coverageDate:stateDate,status:+new Date(stateDate)===+today?"PARTIAL":"COMPLETE",lastVerifiedAt:new Date(live.observed),
          retryAfterAt:coverageRetryAfterAt,lastErrorCode:live.fresh?null:"LIVE_DELIVERY_OR_RECONCILIATION_PENDING",
          proofKind:"FINANCIAL_LEDGER_V1",liveFresh:live.fresh}};
    }
    return {daily:daily.id?daily:null,coverage:{coverageDate:stateDate,status:coverageStatus,lastVerifiedAt:coverageVerifiedAt,
      retryAfterAt:coverageRetryAfterAt,lastErrorCode:coverageErrorCode,scanProofId:daily.scanProofId,
      scanProof:daily.id?{status:"COMMITTED",proofVersion:2}:null}};
  });
}

async function readPublishedEarningsAggregates({ db, creatorIds, from, to, now, freshnessMs }) {
  windowDays(from, to);
  const ids = [...new Set(creatorIds.map(String))], rows = [];
  const freshAfter = new Date(now.getTime()-freshnessMs);
  const freshBefore = new Date(now.getTime()+COLLECTION_FUTURE_SKEW_TOLERANCE_MS);
  for (let offset = 0; offset < ids.length; offset += CREATOR_BATCH) {
    // One PostgreSQL statement is one snapshot, including inside a caller's
    // READ COMMITTED billing transaction. Never combine independent counts and
    // sums across commits. SQL returns <=250 aggregates, not every daily row.
    // Ledger ownership has the same precedence as the day/Home readers. A
    // partial boundary day is unavailable, never permission to substitute an
    // older competing published amount. Freshness keeps the caller's age policy
    // while preserving recovery, unresolved-money and capture-gap fences.
    const batch = await db.$queryRawUnsafe(`/* published_earnings_aggregate_v1 */
      WITH live_scope AS (SELECT id,"agencyId" FROM "CreatorAccount" WHERE id=ANY($1::text[]) AND "deletedAt" IS NULL),
      periods AS (SELECT 0 AS period,($2::timestamptz AT TIME ZONE 'UTC')::date AS start_day,($3::timestamptz AT TIME ZONE 'UTC')::date AS end_day),
      ${require("./earnings-live-read-sql").liveLedgerDailySql("live_scope","$6")},
      authoritative_days AS MATERIALIZED (
        SELECT l."creatorId",l.date,l."totalCents",l."collectedAt",
          (NOT a.recovering AND NOT a.unresolved AND a."shortGapFrom" IS NULL
            AND l.observed BETWEEN ($4::timestamptz AT TIME ZONE 'UTC') AND ($5::timestamptz AT TIME ZONE 'UTC')) AS fresh
        FROM ledger_daily l JOIN ledger_authority a ON a.id=l."creatorId"
        WHERE l.date::timestamp>=a."fromAt"
          AND l.date::timestamp+interval '1 day'<=${require("./earnings-live-read-sql").coverageThroughSql()}
      ), usable_days AS (
        SELECT * FROM authoritative_days
        UNION ALL
        SELECT d."creatorId",d.date,d."totalCents",d."collectedAt",
          (${earningsObservationSql()} BETWEEN ($4::timestamptz AT TIME ZONE 'UTC') AND ($5::timestamptz AT TIME ZONE 'UTC')
            AND NOT EXISTS(SELECT 1 FROM ledger_authority a WHERE a.id=d."creatorId"
              AND (a.recovering OR a.unresolved OR a."shortGapFrom" IS NOT NULL))) AS fresh
        FROM "CreatorEarningsPublishedDay" d ${publishedEarningsJoins()}
        WHERE d."creatorId"=ANY($1::text[]) AND d."sourceTimezone"='UTC' AND d."date" BETWEEN ($2::timestamptz AT TIME ZONE 'UTC')::date AND ($3::timestamptz AT TIME ZONE 'UTC')::date
          AND v."status"='COMPLETE'
          AND NOT EXISTS(SELECT 1 FROM ledger_daily l WHERE l."creatorId"=d."creatorId" AND l.date=d.date)
      )
      SELECT "creatorId",COUNT(*)::bigint AS days,SUM("totalCents")::bigint AS cents,
        MAX("collectedAt") AS captured,COUNT(*) FILTER (WHERE fresh)::bigint AS fresh
      FROM usable_days GROUP BY "creatorId"`, ids.slice(offset, offset+CREATOR_BATCH), from, to, freshAfter, freshBefore, now);
    rows.push(...batch.map(row => ({ ...row, days: integer(row.days), cents: integer(row.cents), fresh: integer(row.fresh) })));
  }
  return new Map(rows.map(row => [row.creatorId, row]));
}

module.exports = { CREATOR_BATCH, publishedEarningsJoins, readPublishedEarningsDays, readPublishedEarningsAggregates };
