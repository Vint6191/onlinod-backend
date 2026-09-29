"use strict";
const { scopeSql, scopeParams } = require('./home-scope-repository');
const { CURRENT_DAY_FRESHNESS_MS, RECENT_CLOSED_FRESHNESS_MS, HISTORICAL_FRESHNESS_MS } = require('./analytics-freshness-policy');
const MAX_PAGE_SIZE = 100;
function pageInput({ after = null, limit = 50 } = {}) {
  if (after != null && (typeof after !== 'string' || after.length > 180 || /[\x00-\x1f]/.test(after))) {
    throw Object.assign(new Error('HOME_CURSOR_INVALID'), { code: 'HOME_CURSOR_INVALID', status: 400 });
  }
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw Object.assign(new Error('HOME_PAGE_SIZE_INVALID'), { code: 'HOME_PAGE_SIZE_INVALID', status: 400 });
  }
  return { after: after || '', limit: size };
}
// Each period is at most 90 days. SQL reduces all visible canonical rows to one
// aggregate and at most 90 chart points; no creator-sized arrays cross the wire.
function revenueSql(source = 'visible') {
  return `, periods AS (SELECT 0 AS period,$6::date AS start_day,$7::date AS end_day
    UNION ALL SELECT 1,$8::date,$9::date),
  covered AS (
    SELECT c."id",r.period,r.end_day-r.start_day+1 AS expected,
      COUNT(v."id") FILTER (WHERE p."status"='COMMITTED' AND
        (v."status"='COMPLETE' OR (v."coverageDate"=$10::date AND v."status"='PARTIAL'))) AS usable,
      COUNT(v."id") FILTER (WHERE p."status"='COMMITTED' AND
        (v."status"='COMPLETE' OR (v."coverageDate"=$10::date AND v."status"='PARTIAL'))
        AND v."lastVerifiedAt"<=$11::timestamp+interval '5 minutes'
        AND v."lastVerifiedAt">=$11::timestamp-(CASE WHEN v."coverageDate"=$10::date THEN ${CURRENT_DAY_FRESHNESS_MS}
          WHEN v."coverageDate">=$10::date-30 THEN ${RECENT_CLOSED_FRESHNESS_MS} ELSE ${HISTORICAL_FRESHNESS_MS} END)*interval '1 millisecond') AS fresh
    FROM ${source} c CROSS JOIN periods r LEFT JOIN "AnalyticsCoverage" v ON v."agencyId"=$1 AND v."creatorId"=c."id"
      AND v."dataType"='EARNINGS' AND v."sourceTimezone"='UTC' AND v."coverageDate" BETWEEN r.start_day AND r.end_day
    LEFT JOIN "AnalyticsScanProof" p ON p."id"=v."scanProofId" AND p."agencyId"=$1 AND p."creatorId"=c."id"
    GROUP BY c."id",r.period,r.start_day,r.end_day
  ), daily AS MATERIALIZED (
    SELECT d."creatorId",r.period,d."date",d."totalCents",d."collectedAt"
    FROM ${source} c JOIN "CreatorEarningsDaily" d ON d."creatorId"=c."id" AND d."agencyId"=$1 AND d."sourceTimezone"='UTC'
      JOIN periods r ON d."date" BETWEEN r.start_day AND r.end_day
      JOIN "AnalyticsScanProof" p ON p."id"=d."scanProofId" AND p."status"='COMMITTED' AND p."agencyId"=$1 AND p."creatorId"=c."id"
  ), earnings AS (
    SELECT "creatorId",period,COUNT(*) AS days,SUM("totalCents") AS cents,MAX("collectedAt") AS captured
    FROM daily GROUP BY "creatorId",period
  ), facts AS MATERIALIZED (
    SELECT v."id",v.period,(v.usable=v.expected AND COALESCE(e.days,0)=v.expected) AS usable,
      (v.fresh=v.expected AND COALESCE(e.days,0)=v.expected) AS fresh,COALESCE(e.cents,0) AS cents,e.captured
    FROM covered v LEFT JOIN earnings e ON e."creatorId"=v."id" AND e.period=v.period
  )`;
}
// A demand is pending only for its still-current member scope. Null creatorIds
// means that member's scope, never all agency creators. No 50-demand horizon.
function pendingSql(source = 'visible') {
  return `, live_demands AS MATERIALIZED (
    SELECT d.*, "phase3_member_has_broad_creator_access"(m."role"::text,m."roleKey",m."assignedCreators") AS broad
    FROM "AnalyticsCollectionDemand" d JOIN "AgencyMember" m ON m."id"=d."requestedByMemberId"
      AND m."agencyId"=d."agencyId" AND m."accessEpoch"=d."requestedAccessEpoch"
      AND m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL
      JOIN "User" u ON u."id"=m."userId" AND u."disabledAt" IS NULL
    WHERE d."agencyId"=$1 AND d."completedAt" IS NULL AND d."quarantinedAt" IS NULL
      AND d."coverageFrom"<=$6::date AND d."coverageTo">=$7::date
  ), pending AS (
    SELECT c."id" FROM ${source} c WHERE EXISTS (SELECT 1 FROM "JobInstance" j WHERE j."agencyId"=$1
      AND j."creatorId"=c."id" AND j."jobKey"='fetch_earnings' AND j."status" IN ('SCHEDULED','CLAIMED'))
    OR EXISTS (SELECT 1 FROM live_demands d WHERE (d."creatorIds" IS NULL OR d."creatorIds"='null'::jsonb OR d."creatorIds" ? c."id")
      AND (d.broad OR EXISTS (SELECT 1 FROM "AgencyMemberCreatorAccessCurrent" x
        WHERE x."memberId"=d."requestedByMemberId" AND x."agencyId"=$1
          AND x."accessEpoch"=d."requestedAccessEpoch" AND x."creatorId"=c."id")))
  )`;
}
function revenueParams(input) {
  const { range, previous, now } = input;
  return [...scopeParams(input), range.startDay, range.endDay, previous.startDay, previous.endDay,
    new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())), now];
}
function number(value) {
  const n = Number(value || 0);
  if (!Number.isSafeInteger(n)) throw Object.assign(new Error('HOME_AGGREGATE_OUT_OF_RANGE'), { code:'HOME_AGGREGATE_OUT_OF_RANGE' });
  return n;
}
async function readHomeTotals(input) {
  const { db, money, manage } = input;
  if (!money) {
    const [row] = await db.$queryRawUnsafe(`${scopeSql()} SELECT COUNT(*) AS total FROM visible`, ...scopeParams(input));
    return { totalCreators: number(row.total), reportingCreators:0, staleCreators:0, pendingCount:0, totalCents:null, deltaPct:null, points:[] };
  }
  const [row] = await db.$queryRawUnsafe(`${scopeSql()}${revenueSql()}${pendingSql()}
    , totals AS (SELECT period,COUNT(*) AS total,COUNT(*) FILTER (WHERE usable) AS reporting,
      COUNT(*) FILTER (WHERE usable AND NOT fresh) AS stale,SUM(cents) FILTER (WHERE usable) AS cents
      FROM facts GROUP BY period), points AS (SELECT d."date",SUM(d."totalCents") AS cents FROM daily d
      JOIN facts f ON f."id"=d."creatorId" AND f.period=d.period AND f.usable WHERE d.period=0 GROUP BY d."date")
    SELECT COALESCE(c.total,0) AS total,COALESCE(c.reporting,0) AS reporting,COALESCE(c.stale,0) AS stale,
      c.cents,COALESCE(p.total,0) AS previous_total,COALESCE(p.reporting,0) AS previous_reporting,
      COALESCE(p.stale,0) AS previous_stale,p.cents AS previous_cents,(SELECT COUNT(*) FROM pending) AS pending,
      CASE WHEN c.total=c.reporting THEN (SELECT jsonb_agg(jsonb_build_object('label',to_char("date",'YYYY-MM-DD'),'valueCents',cents) ORDER BY "date") FROM points)
      ELSE '[]'::jsonb END AS points FROM (SELECT 1) one LEFT JOIN totals c ON c.period=0 LEFT JOIN totals p ON p.period=1`, ...revenueParams(input));
  const total = number(row.total), reporting = number(row.reporting), stale = number(row.stale);
  const complete = total === reporting, previousComplete = total === number(row.previous_total) && total === number(row.previous_reporting);
  const cents = complete ? number(row.cents) : null, prev = previousComplete ? number(row.previous_cents) : null;
  const deltaPct = complete && previousComplete && !stale && !number(row.previous_stale) && prev
    ? Math.round(((cents-prev)/prev)*1000)/10 : null;
  return { totalCreators:total, reportingCreators:reporting, staleCreators:stale, pendingCount:number(row.pending),
    totalCents:cents, deltaPct, points: (row.points || []).map(p=>({label:p.label,valueCents:number(p.valueCents)})) };
}
async function readHomeCreatorPage(input) {
  const { db, money } = input, page = pageInput(input);
  const prefix = `${scopeSql({ cursor:true, cursorParameter:12, broad:typeof input.member.broad === "boolean" ? input.member.broad : null })}, page_candidates AS MATERIALIZED (SELECT "id","displayName","username","avatarUrl","status","remoteId" FROM visible
    WHERE "id">$12::text ORDER BY "id" LIMIT $13), page AS MATERIALIZED (SELECT * FROM page_candidates ORDER BY "id" LIMIT $14)`;
  const sql = money ? `${prefix}${revenueSql('page')}${pendingSql('page')}
    SELECT c.*,f.usable,f.fresh,f.cents,f.captured,(p."id" IS NOT NULL) AS pending,
      (SELECT COUNT(*)>$14 FROM page_candidates) AS more FROM page c
    JOIN facts f ON f."id"=c."id" AND f.period=0 LEFT JOIN pending p ON p."id"=c."id" ORDER BY c."id"`
    : `${prefix} SELECT c.*,false AS usable,false AS fresh,false AS pending,(SELECT COUNT(*)>$14 FROM page_candidates) AS more FROM page c ORDER BY c."id"`;
  // Parameters are typed even on the no-money branch (PostgreSQL extended protocol).
  const query = money ? sql : sql.replace('SELECT c.*,false', 'SELECT $6::date AS unused6,$7::date AS unused7,$8::date AS unused8,$9::date AS unused9,$10::date AS unused10,$11::timestamp AS unused11,c.*,false');
  const rows = await db.$queryRawUnsafe(query,...revenueParams(input),page.after,page.limit+1,page.limit);
  const creators = rows.map(c=>({id:c.id,name:c.displayName,displayName:c.displayName,username:c.username,avatarUrl:c.avatarUrl,status:c.status,remoteId:c.remoteId,
    revenueCents:c.usable?number(c.cents):null,salesCount:null,uniqueFans:null,capturedAt:c.usable?c.captured:null,
    hasRevenue:c.usable===true,pending:c.pending===true,stale:c.usable===true&&!c.fresh,
    staleSeconds:c.usable&&!c.fresh&&c.captured?Math.max(0,Math.floor((input.now-new Date(c.captured))/1000)):null}));
  return { creators, nextCursor:rows[0]?.more?rows.at(-1).id:null, limit:page.limit, order:'id_asc' };
}
async function readHomeJobCounts(input) {
  const rows = await input.db.$queryRawUnsafe(`${scopeSql()} SELECT j."status",COUNT(*) AS count FROM "JobInstance" j
    JOIN visible c ON c."id"=j."creatorId" WHERE j."agencyId"=$1 AND j."status" IN ('SCHEDULED','CLAIMED') GROUP BY j."status"`,...scopeParams(input));
  return Object.fromEntries(rows.map(r=>[r.status,number(r.count)]));
}
module.exports = { MAX_PAGE_SIZE, pageInput, readHomeTotals, readHomeCreatorPage, readHomeJobCounts, __test:{revenueSql,pendingSql,revenueParams} };
