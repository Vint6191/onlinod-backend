"use strict";
const {scopeSql}=require("./home-scope-repository");
const {ledgerAuthoritySql,coverageThroughSql,freshSql}=require("./earnings-live-read-sql");
// Coverage is an interval predicate per creator, never C creators × D zero
// rows. Only actual daily buckets participate in aggregation; fill chart zeros
// once for the agency after SUM. The fallback still serves pre-ledger installs.
async function read(db,params,pendingSql) {
 const [row]=await db.$queryRawUnsafe(`${scopeSql()}, periods AS (
   SELECT 0 AS period,($6::timestamptz AT TIME ZONE 'UTC')::date AS start_day,($7::timestamptz AT TIME ZONE 'UTC')::date AS end_day
   UNION ALL SELECT 1,($8::timestamptz AT TIME ZONE 'UTC')::date,($9::timestamptz AT TIME ZONE 'UTC')::date),
   ${ledgerAuthoritySql("visible")}, eligibility AS MATERIALIZED (
     SELECT (SELECT count(*) FROM ledger_authority)=(SELECT count(*) FROM visible) AS ready
   ), facts AS MATERIALIZED (
     SELECT c.id,r.period,r.start_day,r.end_day,a."activeGeneration",
       a."fromAt"::date<=r.start_day AND ${coverageThroughSql()}::date>=r.end_day AS usable,
       ${freshSql("$11")} AS fresh FROM visible c CROSS JOIN periods r LEFT JOIN ledger_authority a ON a.id=c.id
   ), values_by_day AS MATERIALIZED (
     SELECT f.id,f.period,e.date,e."netCents" AS cents FROM facts f JOIN "CreatorEarningsGenerationDay" e
       ON e.generation=f."activeGeneration" AND e.date BETWEEN f.start_day AND f.end_day
       WHERE f.usable AND (SELECT ready FROM eligibility)
     UNION ALL SELECT f.id,f.period,e.hour::date,e."netCents" FROM facts f JOIN "CreatorEarningsLedgerHour" e
       ON e."creatorId"=f.id AND e.hour>=f.start_day AND e.hour<f.end_day+1
       WHERE f."activeGeneration" IS NULL AND f.usable AND (SELECT ready FROM eligibility)
   ), creator_values AS (SELECT id,period,SUM(cents) AS cents FROM values_by_day GROUP BY id,period),
   median AS (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(v.cents,0)))::numeric)::bigint AS cents
     FROM facts f LEFT JOIN creator_values v ON v.id=f.id AND v.period=f.period WHERE f.period=0 AND f.usable
   ), stats AS (SELECT period,count(*) AS total,count(*) FILTER(WHERE usable) AS reporting,
       count(*) FILTER(WHERE usable AND NOT fresh) AS stale FROM facts GROUP BY period),
   sums AS (SELECT period,SUM(cents) AS cents FROM values_by_day GROUP BY period),
   chart_days AS (SELECT date,SUM(cents) AS cents FROM values_by_day WHERE period=0 GROUP BY date),
   hour_values AS (
     SELECT e.hour,e."netCents" AS cents FROM facts f JOIN "CreatorEarningsGenerationHour" e ON e.generation=f."activeGeneration"
       AND e.hour>=f.start_day AND e.hour<f.end_day+1 WHERE f.period=0 AND f.start_day=f.end_day AND f.usable
     UNION ALL SELECT e.hour,e."netCents" FROM facts f JOIN "CreatorEarningsLedgerHour" e ON e."creatorId"=f.id
       AND e.hour>=f.start_day AND e.hour<f.end_day+1 WHERE f."activeGeneration" IS NULL AND f.period=0 AND f.start_day=f.end_day AND f.usable
   ), chart_hours AS (SELECT hour,SUM(cents) AS cents FROM hour_values GROUP BY hour)
   ${pendingSql()}
   SELECT (SELECT ready FROM eligibility) AS "fastReady",COALESCE(c.total,0) AS total,COALESCE(c.reporting,0) AS reporting,
     COALESCE(c.stale,0) AS stale,COALESCE(s.cents,0) AS cents,(SELECT cents FROM median) AS median_cents,
     COALESCE(p.total,0) AS previous_total,COALESCE(p.reporting,0) AS previous_reporting,COALESCE(p.stale,0) AS previous_stale,
     COALESCE(ps.cents,0) AS previous_cents,(SELECT count(*) FROM pending) AS pending,
     CASE WHEN COALESCE(c.total,0)=0 OR c.total<>c.reporting THEN '[]'::jsonb WHEN $6::timestamptz=$7::timestamptz THEN (
       SELECT jsonb_agg(jsonb_build_object('label',to_char(h.at,'HH24:00'),'valueCents',COALESCE(x.cents,0)) ORDER BY h.at)
       FROM periods r CROSS JOIN LATERAL generate_series(r.start_day::timestamp,r.start_day+interval '23 hours',interval '1 hour') h(at)
       LEFT JOIN chart_hours x ON x.hour=h.at WHERE r.period=0
     ) ELSE (SELECT jsonb_agg(jsonb_build_object('label',to_char(d.at,'YYYY-MM-DD'),'valueCents',COALESCE(x.cents,0)) ORDER BY d.at)
       FROM periods r CROSS JOIN LATERAL generate_series(r.start_day::timestamp,r.end_day::timestamp,interval '1 day') d(at)
       LEFT JOIN chart_days x ON x.date=d.at::date WHERE r.period=0) END AS points,
     $10::timestamptz AS "today"
     FROM (SELECT 1) seed LEFT JOIN stats c ON c.period=0 LEFT JOIN stats p ON p.period=1
       LEFT JOIN sums s ON s.period=0 LEFT JOIN sums ps ON ps.period=1`,...params);
 return row?.fastReady===true?row:null;
}
module.exports={read};
