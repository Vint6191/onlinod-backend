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
    WITH published AS MATERIALIZED (
      SELECT d.*,${earningsObservationSql()} AS "publishedObservedAt" FROM "CreatorEarningsPublishedDay" d ${publishedEarningsJoins()}
      WHERE d."creatorId"=$1 AND d."sourceTimezone"='UTC' AND d."date" BETWEEN ($2::timestamptz AT TIME ZONE 'UTC')::date AND ($3::timestamptz AT TIME ZONE 'UTC')::date
        AND (v."status"='COMPLETE' OR (d."date"=($4::timestamptz AT TIME ZONE 'UTC')::date AND v."status"='PARTIAL'))
    )
    SELECT d.*,days.date AS "stateDate",COALESCE(d."coverageStatus",c."status"::text,'MISSING') AS "coverageStatus",d."publishedObservedAt" AS "coverageVerifiedAt",
      c."retryAfterAt" AS "coverageRetryAfterAt",c."lastErrorCode" AS "coverageErrorCode"
    FROM generate_series(($2::timestamptz AT TIME ZONE 'UTC'),($3::timestamptz AT TIME ZONE 'UTC'),interval '1 day') days(date)
    LEFT JOIN "AnalyticsCoverage" c ON c."creatorId"=$1 AND c."dataType"='EARNINGS' AND c."sourceTimezone"='UTC' AND c."coverageDate"=days.date
    LEFT JOIN published d ON d."date"=days.date ORDER BY days.date`, creatorId, from, to, today);
  // Retry/partial hints survive even when amounts are unavailable. They can
  // never certify money: only the joined published row supplies proof status.
  return rows.map(({ stateDate, coverageStatus, coverageVerifiedAt, coverageRetryAfterAt, coverageErrorCode, publishedObservedAt, ...daily }) => ({
    daily: daily.id ? daily : null,
    coverage: { coverageDate: stateDate, status: coverageStatus, lastVerifiedAt: coverageVerifiedAt,
      retryAfterAt: coverageRetryAfterAt, lastErrorCode: coverageErrorCode, scanProofId: daily.scanProofId,
      scanProof: daily.id ? { status: "COMMITTED", proofVersion: 2 } : null },
  }));
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
    const batch = await db.$queryRawUnsafe(`/* published_earnings_aggregate_v1 */
      SELECT d."creatorId",COUNT(*)::bigint AS days,SUM(d."totalCents")::bigint AS cents,
        MAX(d."collectedAt") AS captured,
        COUNT(*) FILTER (WHERE ${earningsObservationSql()} BETWEEN ($4::timestamptz AT TIME ZONE 'UTC') AND ($5::timestamptz AT TIME ZONE 'UTC'))::bigint AS fresh
      FROM "CreatorEarningsPublishedDay" d ${publishedEarningsJoins()}
      WHERE d."creatorId"=ANY($1::text[]) AND d."sourceTimezone"='UTC' AND d."date" BETWEEN ($2::timestamptz AT TIME ZONE 'UTC')::date AND ($3::timestamptz AT TIME ZONE 'UTC')::date
        AND v."status"='COMPLETE'
      GROUP BY d."creatorId"`, ids.slice(offset, offset+CREATOR_BATCH), from, to, freshAfter, freshBefore);
    rows.push(...batch.map(row => ({ ...row, days: integer(row.days), cents: integer(row.cents), fresh: integer(row.fresh) })));
  }
  return new Map(rows.map(row => [row.creatorId, row]));
}

module.exports = { CREATOR_BATCH, publishedEarningsJoins, readPublishedEarningsDays, readPublishedEarningsAggregates };
