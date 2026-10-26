"use strict";

const { scopeSql } = require("./home-scope-repository");
const { ledgerAuthoritySql, coverageThroughSql, freshSql } = require("./earnings-live-read-sql");
const { subscriberHeadColumns, subscriberHeadJoins } = require("./published-subscriber-summary");

function literalSearch(value) {
  return value ? `%${value.replace(/[\\%_]/g, "\\$&")}%` : "";
}
function searchSql() {
  return `($15::text='' OR COALESCE("displayName",'') ILIKE $15::text ESCAPE E'\\\\'
    OR COALESCE("username",'') ILIKE $15::text ESCAPE E'\\\\')`;
}
function directionSql() {
  return `f.usable AND f.fresh AND f.previous_usable AND f.previous_fresh
    AND (($16::text='increasing' AND f.cents>f.previous_cents) OR ($16::text='declining' AND f.cents<f.previous_cents))`;
}
function jsonRows(rows) {
  // Prisma decodes timestamp columns as UTC Dates, but JSONB contains their SQL
  // strings without an offset. Preserve that same UTC authority after packing
  // the bounded page, independent of the server or desktop local timezone.
  return (rows || []).map(row => {
    const result = { ...row };
    for (const key of ["captured", "observed", "subscribers_updated_at"]) {
      const value = row[key];
      if (value == null) continue;
      const explicitUtc = typeof value === "string" && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
        ? value.replace(" ", "T") + "Z" : value;
      result[key] = new Date(explicitUtc).toISOString();
    }
    return result;
  });
}

// A global trend filter cannot be applied after LIMIT. Aggregate the visible
// scope's bounded daily rollups once in SQL, then seek/page the matching ids.
// The normal financial-generation path does not materialize zero days for every
// creator; even a large all-zero agency has only two authority facts per model.
async function readHomeTrendRows(input, page, { revenueSql, pendingSql, revenueParams }) {
  const { db } = input;
  const prefix = `${scopeSql({ cursor: true, cursorParameter: 12, broad: typeof input.member.broad === "boolean" ? input.member.broad : null })},
    searched AS MATERIALIZED (SELECT * FROM visible WHERE ${searchSql()})`;
  const params = [...revenueParams(input), page.after, page.limit + 1, page.limit,
    literalSearch(page.search), page.trend, page.includeRevenuePoints];
  const selectPage = (pointSql) => `, paired_facts AS MATERIALIZED (
    SELECT id,bool_and(usable) FILTER(WHERE period=0) AS usable,bool_and(fresh) FILTER(WHERE period=0) AS fresh,
      MAX(cents) FILTER(WHERE period=0) AS cents,MAX(captured) FILTER(WHERE period=0) AS captured,MIN(observed) FILTER(WHERE period=0) AS observed,
      bool_and(usable) FILTER(WHERE period=1) AS previous_usable,bool_and(fresh) FILTER(WHERE period=1) AS previous_fresh,
      MAX(cents) FILTER(WHERE period=1) AS previous_cents FROM facts GROUP BY id
  ), candidates AS MATERIALIZED (
    SELECT f.* FROM paired_facts f WHERE ${directionSql()} ORDER BY f.id LIMIT $13
  ), page_facts AS MATERIALIZED (SELECT * FROM candidates ORDER BY id LIMIT $14), page AS MATERIALIZED (
    SELECT c.*,f.usable,f.fresh,f.cents,f.captured,f.observed,f.previous_usable,f.previous_fresh,f.previous_cents
    FROM page_facts f JOIN LATERAL (
      SELECT c.id,c."agencyId",c."displayName",c."username",c."avatarUrl",c.status,c."remoteId"
      FROM "CreatorAccount" c WHERE c.id=f.id AND c."agencyId"=$1 AND c."deletedAt" IS NULL OFFSET 0
    ) c ON true ORDER BY c.id
  )
  ${pendingSql("page")}, result AS (
    SELECT c.*,(p.id IS NOT NULL) AS pending,${subscriberHeadColumns()},(SELECT COUNT(*)>$14 FROM candidates) AS more,
      CASE WHEN $17::boolean THEN (${pointSql}) ELSE '[]'::jsonb END AS points
    FROM page c LEFT JOIN pending p ON p.id=c.id ${subscriberHeadJoins()} ORDER BY c.id
  ) SELECT (SELECT ready FROM eligibility) AS "fastReady",COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM result r),'[]'::jsonb) AS rows,
    $10::timestamptz AS today`;
  const fast = `${prefix}, periods AS (
    SELECT 0 AS period,($6::timestamptz AT TIME ZONE 'UTC')::date AS start_day,($7::timestamptz AT TIME ZONE 'UTC')::date AS end_day
    UNION ALL SELECT 1,($8::timestamptz AT TIME ZONE 'UTC')::date,($9::timestamptz AT TIME ZONE 'UTC')::date
  ), ${ledgerAuthoritySql("searched")}, eligibility AS MATERIALIZED (
    SELECT (SELECT count(*) FROM ledger_authority)=(SELECT count(*) FROM searched) AS ready
  ), authority_facts AS MATERIALIZED (
    SELECT a.id,r.period,r.start_day,r.end_day,a."activeGeneration",a."throughAt" AS captured,
      GREATEST(a."throughAt",a."lastDeliveredAt") AS observed,
      a."fromAt"::date<=r.start_day AND ${coverageThroughSql()}::date>=r.end_day AS usable,
      ${freshSql("$11")} AS fresh FROM ledger_authority a CROSS JOIN periods r
  ), day_values AS MATERIALIZED (
    SELECT f.id,f.period,e.date,e."netCents" AS cents FROM authority_facts f JOIN "CreatorEarningsGenerationDay" e
      ON e.generation=f."activeGeneration" AND e.date BETWEEN f.start_day AND f.end_day
      WHERE (SELECT ready FROM eligibility)
    UNION ALL SELECT f.id,f.period,e.hour::date,e."netCents" FROM authority_facts f JOIN "CreatorEarningsLedgerHour" e
      ON e."creatorId"=f.id AND e.hour>=f.start_day AND e.hour<f.end_day+1
      WHERE f."activeGeneration" IS NULL AND (SELECT ready FROM eligibility)
  ), sums AS (SELECT id,period,SUM(cents) AS cents FROM day_values GROUP BY id,period), facts AS (
    SELECT a.*,COALESCE(v.cents,0) AS cents FROM authority_facts a LEFT JOIN sums v ON v.id=a.id AND v.period=a.period
  )${selectPage(`SELECT jsonb_agg(jsonb_build_object('label',to_char(d.at,'YYYY-MM-DD'),'valueCents',COALESCE(v.cents,0)) ORDER BY d.at)
      FROM generate_series(($6::timestamptz AT TIME ZONE 'UTC'),($7::timestamptz AT TIME ZONE 'UTC'),interval '1 day') d(at)
      LEFT JOIN (SELECT date,SUM(cents) AS cents FROM day_values WHERE id=c.id AND period=0 GROUP BY date) v ON v.date=d.at::date`)}`;
  const [row] = await db.$queryRawUnsafe(fast, ...params);
  if (row?.fastReady === true) return jsonRows(row.rows);

  // Installations with a still-current pre-ledger publication use the same
  // proof-joined fallback as the existing Home reader, with identical filters.
  const fallback = `${prefix}${revenueSql("searched")}, eligibility AS (SELECT true AS ready)
    ${selectPage(`SELECT jsonb_agg(jsonb_build_object('label',to_char(d.date,'YYYY-MM-DD'),'valueCents',d."totalCents") ORDER BY d.date)
      FROM daily d WHERE d."creatorId"=c.id AND d.period=0`)}`;
  const [legacy] = await db.$queryRawUnsafe(fallback, ...params);
  return jsonRows(legacy?.rows);
}

module.exports = { readHomeTrendRows, literalSearch, searchSql };
