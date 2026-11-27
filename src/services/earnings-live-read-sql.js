"use strict";
const { FINANCIAL_PROOF_POLICY_VERSION, uncoveredReceiverDebtSql, financialPublicationPendingSql } = require("./earnings-coverage-service");
// Arguments are source-owned SQL aliases/parameter positions, never user input.
function ledgerAuthoritySql(source) {
  return `  ledger_authority AS MATERIALIZED (
    SELECT c.id,p."fromAt",p."throughAt",p."proofPolicyVersion",p."activeGeneration",l."lastDeliveredAt",
      ${financialPublicationPendingSql('c.id')} AS publishing,
      CASE WHEN p."proofPolicyVersion">=1 THEN p."confirmedThroughAt" ELSE p."throughAt" END AS "confirmedThroughAt",
      EXISTS(SELECT 1 FROM "CreatorRecoveryIntent" i WHERE i."creatorId"=c.id AND i.stream='financial' AND i.status<>'COMPLETE') AS recovering,
      EXISTS(SELECT 1 FROM "CreatorRecoveryIntent" i WHERE i."creatorId"=c.id AND i.stream='financial' AND i.status='STOPPED') AS "recoveryStopped",
      CASE WHEN l."shortGapTo">GREATEST(p."throughAt",CASE WHEN p."proofPolicyVersion">=1 THEN p."confirmedThroughAt" END)
        THEN l."shortGapFrom" ELSE NULL END AS "shortGapFrom",
      EXISTS(SELECT 1 FROM "CreatorRealtimeSession" s WHERE s."creatorId"=c.id AND ${uncoveredReceiverDebtSql()}) AS undelivered,
      EXISTS(SELECT 1 FROM "CreatorMoneyObservation" m WHERE m."creatorId"=c.id AND m.status='PENDING'
        AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" g WHERE g.id=m."coveredGeneration" AND g."publishedAt" IS NOT NULL)) AS unresolved
    FROM ${source} c JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=c.id AND p."agencyId"=c."agencyId"
    LEFT JOIN "CreatorLiveSync" l ON l."creatorId"=c.id
  )`;
}
function coverageThroughSql() {
  return `GREATEST(a."throughAt",a."confirmedThroughAt")`;
}
function freshSql(now) {
  return `(a."proofPolicyVersion"=${FINANCIAL_PROOF_POLICY_VERSION} AND NOT a.publishing AND NOT a.recovering AND NOT a.unresolved
    AND NOT a.undelivered AND a."shortGapFrom" IS NULL
    AND ${coverageThroughSql()}>=(${now}::timestamptz AT TIME ZONE 'UTC')-interval '3 minutes')`;
}
function coverageFirstDaySql() {
  // A partial first day must not mask a separately verified whole daily bucket.
  return `(a."fromAt"+interval '1 day'-interval '1 millisecond')::date`;
}
function coverageLastDaySql(now) {
  // Today's amount is an as-of snapshot; a historical day needs its whole end.
  const through = coverageThroughSql();
  return `(CASE WHEN ${through}::date<(${now}::timestamptz AT TIME ZONE 'UTC')::date
    AND ${through}<${through}::date+interval '1 day'-interval '1 millisecond'
    THEN ${through}::date-1 ELSE ${through}::date END)`;
}
function liveLedgerDailySql(source = "visible", now = "$11") {
  return `${ledgerAuthoritySql(source)}, ledger_bounds AS (
    SELECT min(start_day) AS lo,max(end_day)+1 AS hi FROM periods
  ), ledger_categories AS MATERIALIZED (
    SELECT a.id AS "creatorId",e.date,e.category,e."netCents" AS cents,e."observedAt" AS observed
    FROM ledger_authority a JOIN "CreatorEarningsGenerationDay" e ON e.generation=a."activeGeneration"
      CROSS JOIN ledger_bounds b WHERE e.date>=b.lo AND e.date<b.hi
    UNION ALL
    SELECT a.id,e.hour::date,e.category,SUM(e."netCents")::bigint,MAX(e."observedAt")
    FROM ledger_authority a JOIN "CreatorEarningsLedgerHour" e ON e."creatorId"=a.id
      CROSS JOIN ledger_bounds b WHERE a."activeGeneration" IS NULL AND e.hour>=b.lo AND e.hour<b.hi
    GROUP BY a.id,e.hour::date,e.category
  ), ledger_day_values AS MATERIALIZED (
    SELECT "creatorId",date,SUM(cents)::bigint AS cents,MAX(observed) AS observed,
      jsonb_object_agg(category,cents) AS categories FROM ledger_categories GROUP BY "creatorId",date
  ), ledger_hours AS MATERIALIZED (
    SELECT a.id AS "creatorId",e.hour,e."netCents" AS cents FROM ledger_authority a
      JOIN "CreatorEarningsGenerationHour" e ON e.generation=a."activeGeneration"
      JOIN periods r ON r.period=0 AND r.start_day=r.end_day AND e.hour>=r.start_day AND e.hour<r.end_day+1
    UNION ALL
    SELECT a.id,e.hour,e."netCents" FROM ledger_authority a
      JOIN "CreatorEarningsLedgerHour" e ON e."creatorId"=a.id AND a."activeGeneration" IS NULL
      JOIN periods r ON r.period=0 AND r.start_day=r.end_day AND e.hour>=r.start_day AND e.hour<r.end_day+1
  ), ledger_hour_values AS (
    SELECT a.id,hrs.hour,COALESCE(SUM(e.cents),0)::bigint AS cents FROM ledger_authority a
    JOIN periods r ON r.period=0 AND r.start_day=r.end_day
    CROSS JOIN LATERAL generate_series(r.start_day::timestamp,r.start_day+interval '23 hours',interval '1 hour') hrs(hour)
    LEFT JOIN ledger_hours e ON e."creatorId"=a.id AND e.hour=hrs.hour GROUP BY a.id,hrs.hour
  ), ledger_hour_points AS (
    SELECT id,jsonb_agg(jsonb_build_object('label',to_char(hour,'HH24:00'),'valueCents',cents) ORDER BY hour) AS points
    FROM ledger_hour_values GROUP BY id
  ), ledger_daily AS MATERIALIZED (
    SELECT a.id AS "creatorId",r.period,day.date::date AS date,COALESCE(x.cents,0)::bigint AS "totalCents",
      CASE WHEN r.period=0 AND r.start_day=r.end_day THEN h.points ELSE NULL END AS "hourlyPoints",
      GREATEST(a."throughAt",x.observed) AS "collectedAt",${coverageThroughSql()} AS observed,
      ${freshSql(now)} AS fresh,x.categories AS "categoryTotals"
    FROM ledger_authority a CROSS JOIN periods r
    CROSS JOIN LATERAL generate_series(GREATEST(r.start_day,${coverageFirstDaySql()}),
      LEAST(r.end_day,${coverageLastDaySql(now)}),interval '1 day') day(date)
    LEFT JOIN ledger_day_values x ON x."creatorId"=a.id AND x.date=day.date::date
    LEFT JOIN ledger_hour_points h ON h.id=a.id
  )`;
}
async function readLiveEarningsCoverage(db, creatorId, now) {
  const [row] = await db.$queryRawUnsafe(
    `WITH source AS (SELECT id,"agencyId" FROM "CreatorAccount" WHERE id=$1 AND "deletedAt" IS NULL),
    ${ledgerAuthoritySql("source")} SELECT a."fromAt",${coverageThroughSql()} AS "throughAt",${freshSql("$2")} AS fresh,
      a."proofPolicyVersion",a."activeGeneration",a.publishing,a.recovering,a."recoveryStopped",a.unresolved,a.undelivered,a."shortGapFrom",
      ${coverageThroughSql()} AS "sourceObservedAt",pg_current_snapshot()::text AS "snapshotRevision"
    FROM ledger_authority a`,
    creatorId,
    now
  );
  return row?.fromAt && row?.throughAt ? row : null;
}
module.exports = { liveLedgerDailySql, readLiveEarningsCoverage, ledgerAuthoritySql, coverageThroughSql, freshSql, coverageFirstDaySql, coverageLastDaySql };
