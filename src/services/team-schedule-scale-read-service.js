"use strict";

const MAX_OPEN_COVERAGE_MS = 12 * 60 * 60 * 1000;
const SHIFT_DETAIL_LIMIT = 1000;
const SESSION_DETAIL_PER_CREATOR = 5;
const HANDOFF_DETAIL_LIMIT = 100;

function clean(value, max = 180) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function nullableNum(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function normalizedScope(value) {
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(value.map(String).map((v) => v.trim()).filter(Boolean)));
}
function supportsScheduleScaleRead(db) {
  return typeof db?.$queryRawUnsafe === "function";
}
function effectiveEndSql(alias = "c") {
  return `CASE WHEN ${alias}."endedAt" IS NOT NULL THEN ${alias}."endedAt" ELSE LEAST($4::timestamp, ${alias}."startedAt" + INTERVAL '12 hours') END`;
}
function coverageBaseSql() {
  const endExpr = effectiveEndSql("c");
  return `
    SELECT c."id",c."creatorId",c."memberId",c."coverageId",c."deviceId",c."startedAt",c."endedAt",c."startReason",c."endReason",c."source",
           GREATEST(c."startedAt", COALESCE($2::timestamp,c."startedAt")) AS seg_start,
           LEAST(${endExpr}, $3::timestamp) AS seg_end,
           (c."endedAt" IS NULL AND $4::timestamp >= c."startedAt" AND $4::timestamp <= c."startedAt" + INTERVAL '12 hours') AS active_now,
           (c."endedAt" IS NULL AND $4::timestamp > c."startedAt" + INTERVAL '12 hours') AS stale_open
      FROM "TeamCoverageSession" c
     WHERE c."agencyId"=$1
       AND ($5::text[] IS NULL OR c."creatorId" = ANY($5::text[]))
       AND c."startedAt" <= $3::timestamp
       AND ${endExpr} >= COALESCE($2::timestamp,c."startedAt")`;
}
async function query(db, sql, params) {
  return db.$queryRawUnsafe(sql, ...params);
}
function params({ agencyId, range, authorityNow, allowedCreatorIds }) {
  return [String(agencyId), range?.startAt ? new Date(range.startAt) : null, new Date(range.endAt), new Date(authorityNow), normalizedScope(allowedCreatorIds)];
}

async function loadCreatorCoverage({ db, agencyId, range, authorityNow, allowedCreatorIds }) {
  const sql = `WITH base AS (${coverageBaseSql()}), valid AS (
      SELECT * FROM base WHERE seg_end > seg_start
    ), ordered AS (
      SELECT v.*, MAX(seg_end) OVER (PARTITION BY "creatorId" ORDER BY seg_start,seg_end,"id" ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max_end
        FROM valid v
    ), marked AS (
      SELECT o.*, CASE WHEN prev_max_end IS NULL OR seg_start > prev_max_end THEN 1 ELSE 0 END AS new_group FROM ordered o
    ), grouped AS (
      SELECT m.*, SUM(new_group) OVER (PARTITION BY "creatorId" ORDER BY seg_start,seg_end,"id" ROWS UNBOUNDED PRECEDING) AS grp FROM marked m
    ), unions AS (
      SELECT "creatorId",grp,MIN(seg_start) AS s,MAX(seg_end) AS e FROM grouped GROUP BY "creatorId",grp
    ), union_totals AS (
      SELECT "creatorId",SUM(EXTRACT(EPOCH FROM (e-s)))::bigint AS covered_seconds FROM unions GROUP BY "creatorId"
    ), raw_totals AS (
      SELECT "creatorId",COUNT(*)::bigint AS sessions_count,
             SUM(EXTRACT(EPOCH FROM (seg_end-seg_start)))::bigint AS session_seconds,
             COUNT(DISTINCT "memberId")::bigint AS members_count,
             BOOL_OR(active_now) AS active_now,
             COUNT(*) FILTER (WHERE active_now)::bigint AS open_sessions,
             COUNT(*) FILTER (WHERE stale_open)::bigint AS stale_open_sessions
        FROM valid GROUP BY "creatorId"
    ), seq AS (
      SELECT v.*,LAG("memberId") OVER(PARTITION BY "creatorId" ORDER BY seg_start,seg_end,"id") AS prev_member,
             LAG(seg_end) OVER(PARTITION BY "creatorId" ORDER BY seg_start,seg_end,"id") AS prev_end
        FROM valid v
    ), transitions AS (
      SELECT "creatorId",
             COUNT(*) FILTER (WHERE prev_member IS NOT NULL AND prev_member<>"memberId" AND seg_start>=prev_end AND seg_start-prev_end<=INTERVAL '30 minutes')::bigint AS handoffs,
             COUNT(*) FILTER (WHERE prev_member IS NOT NULL AND prev_member<>"memberId" AND seg_start<prev_end)::bigint AS overlaps
        FROM seq GROUP BY "creatorId"
    )
    SELECT r."creatorId",u.covered_seconds,r.session_seconds,r.sessions_count,r.members_count,r.active_now,r.stale_open_sessions,
           COALESCE(t.handoffs,0)::bigint AS handoffs,COALESCE(t.overlaps,0)::bigint AS overlaps
      FROM raw_totals r JOIN union_totals u USING("creatorId") LEFT JOIN transitions t USING("creatorId")`;
  return query(db, sql, params({ agencyId, range, authorityNow, allowedCreatorIds }));
}

async function loadMemberCoverage({ db, agencyId, range, authorityNow, allowedCreatorIds }) {
  const sql = `WITH base AS (${coverageBaseSql()}), valid AS (SELECT * FROM base WHERE seg_end>seg_start)
    SELECT "memberId",SUM(EXTRACT(EPOCH FROM(seg_end-seg_start)))::bigint AS coverage_seconds,
           COUNT(*)::bigint AS sessions_count,COUNT(DISTINCT "creatorId")::bigint AS creators_count,
           BOOL_OR(active_now) AS active_now,COUNT(*) FILTER(WHERE stale_open)::bigint AS stale_open_sessions
      FROM valid GROUP BY "memberId"`;
  return query(db, sql, params({ agencyId, range, authorityNow, allowedCreatorIds }));
}

async function loadRecentSessions({ db, agencyId, range, authorityNow, allowedCreatorIds }) {
  const sql = `WITH base AS (${coverageBaseSql()}), valid AS (SELECT * FROM base WHERE seg_end>seg_start), ranked AS (
      SELECT v.*,ROW_NUMBER() OVER(PARTITION BY "creatorId" ORDER BY seg_start DESC,"id" DESC) AS rn FROM valid v
    ) SELECT * FROM ranked WHERE rn<=${SESSION_DETAIL_PER_CREATOR} ORDER BY "creatorId",seg_start DESC,"id" DESC`;
  return query(db, sql, params({ agencyId, range, authorityNow, allowedCreatorIds }));
}

async function loadHandoffDetails({ db, agencyId, range, authorityNow, allowedCreatorIds }) {
  const sql = `WITH base AS (${coverageBaseSql()}), valid AS (SELECT * FROM base WHERE seg_end>seg_start), seq AS (
      SELECT v.*,LAG("memberId") OVER(PARTITION BY "creatorId" ORDER BY seg_start,seg_end,"id") AS prev_member,
             LAG(seg_end) OVER(PARTITION BY "creatorId" ORDER BY seg_start,seg_end,"id") AS prev_end
        FROM valid v
    ), q AS (
      SELECT *,EXTRACT(EPOCH FROM(seg_start-prev_end))::bigint AS gap_seconds,
             CASE WHEN seg_start<prev_end THEN 'OVERLAP' ELSE 'HANDOFF' END AS kind
        FROM seq WHERE prev_member IS NOT NULL AND prev_member<>"memberId"
          AND (seg_start<prev_end OR seg_start-prev_end<=INTERVAL '30 minutes')
    ) SELECT * FROM q ORDER BY seg_start DESC,"id" DESC LIMIT ${HANDOFF_DETAIL_LIMIT}`;
  return query(db, sql, params({ agencyId, range, authorityNow, allowedCreatorIds }));
}

async function loadShiftMetrics({ db, agencyId, shiftIds, authorityNow, currentResponseGeneration = false }) {
  if (!shiftIds.length) return [];
  const sql = `WITH selected AS (
      SELECT s."id",s."memberId",s."startsAt",s."endsAt" FROM "TeamShift" s WHERE s."agencyId"=$1 AND s."id"=ANY($2::text[])
    ), cbase AS (
      SELECT s."id" AS shift_id,c."id" AS session_id,
             GREATEST(c."startedAt",s."startsAt") AS seg_start,
             LEAST(CASE WHEN c."endedAt" IS NOT NULL THEN c."endedAt" ELSE LEAST($3::timestamp,c."startedAt"+INTERVAL '12 hours') END,s."endsAt") AS seg_end
        FROM selected s JOIN "TeamShiftCreator" sc ON sc."shiftId"=s."id"
        JOIN "TeamCoverageSession" c ON c."agencyId"=$1 AND c."creatorId"=sc."creatorId" AND c."memberId"=s."memberId"
       WHERE c."startedAt"<s."endsAt" AND CASE WHEN c."endedAt" IS NOT NULL THEN c."endedAt" ELSE LEAST($3::timestamp,c."startedAt"+INTERVAL '12 hours') END>s."startsAt"
    ), valid AS (SELECT * FROM cbase WHERE seg_end>seg_start), ordered AS (
      SELECT v.*,MAX(seg_end) OVER(PARTITION BY shift_id ORDER BY seg_start,seg_end,session_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max_end FROM valid v
    ), marked AS (SELECT o.*,CASE WHEN prev_max_end IS NULL OR seg_start>prev_max_end THEN 1 ELSE 0 END AS new_group FROM ordered o),
    grouped AS (SELECT m.*,SUM(new_group) OVER(PARTITION BY shift_id ORDER BY seg_start,seg_end,session_id ROWS UNBOUNDED PRECEDING) AS grp FROM marked m),
    unions AS (SELECT shift_id,grp,MIN(seg_start) AS s,MAX(seg_end) AS e FROM grouped GROUP BY shift_id,grp),
    cov_union AS (SELECT shift_id,SUM(EXTRACT(EPOCH FROM(e-s)))::bigint AS actual_seconds FROM unions GROUP BY shift_id),
    cov_raw AS (SELECT shift_id,COUNT(DISTINCT session_id)::bigint AS sessions_count,MIN(seg_start) AS first_actual,MAX(seg_end) AS last_actual FROM valid GROUP BY shift_id),
    resp AS (
      SELECT s."id" AS shift_id,
             COUNT(*) FILTER(WHERE r."slaEligible"=TRUE AND COALESCE(r."projectionState",'FULL')='FULL')::bigint AS response_samples,
             percentile_cont(0.5) WITHIN GROUP(ORDER BY r."wallClockSeconds") FILTER(WHERE r."slaEligible"=TRUE AND COALESCE(r."projectionState",'FULL')='FULL') AS median_response,
             COUNT(*) FILTER(WHERE r."slaEligible"=TRUE AND r."sla15Pass"=TRUE AND COALESCE(r."projectionState",'FULL')='FULL')::bigint AS sla15_passes,
             COUNT(*) FILTER(WHERE COALESCE(r."projectionState",'FULL')<>'FULL')::bigint AS incomplete_responses
        FROM selected s JOIN "TeamShiftCreator" sc ON sc."shiftId"=s."id"
        JOIN "TeamResponseCaseCurrent" r ON r."agencyId"=$1 AND r."creatorId"=sc."creatorId" AND r."memberId"=s."memberId" AND r."replyAt">=s."startsAt" AND r."replyAt"<=s."endsAt"
         AND ($4::boolean=FALSE OR (r."derivationVersion"='team_response_v2' AND r."projectionState" IN ('FULL','INCOMPLETE_HISTORY')))
       GROUP BY s."id"
    )
    SELECT s."id" AS shift_id,COALESCE(u.actual_seconds,0)::bigint AS actual_seconds,COALESCE(c.sessions_count,0)::bigint AS sessions_count,
           c.first_actual,c.last_actual,COALESCE(r.response_samples,0)::bigint AS response_samples,r.median_response,
           COALESCE(r.sla15_passes,0)::bigint AS sla15_passes,COALESCE(r.incomplete_responses,0)::bigint AS incomplete_responses
      FROM selected s LEFT JOIN cov_union u ON u.shift_id=s."id" LEFT JOIN cov_raw c ON c.shift_id=s."id" LEFT JOIN resp r ON r.shift_id=s."id"`;
  return query(db, sql, [String(agencyId), shiftIds.map(String), new Date(authorityNow), currentResponseGeneration === true]);
}

async function loadPlanSummary({ db, agencyId, range, authorityNow, allowedCreatorIds }) {
  const scope = normalizedScope(allowedCreatorIds);
  const sql = `WITH selected AS (
      SELECT s."id",s."status",s."startsAt",s."endsAt" FROM "TeamShift" s
       WHERE s."agencyId"=$1 AND s."startsAt"<=$3::timestamp AND ($2::timestamp IS NULL OR s."endsAt">=$2::timestamp)
         AND ($5::text[] IS NULL OR EXISTS(SELECT 1 FROM "TeamShiftCreator" sc0 WHERE sc0."shiftId"=s."id" AND sc0."creatorId"=ANY($5::text[])))
    ), cbase AS (
      SELECT s."id" AS shift_id,GREATEST(c."startedAt",s."startsAt") AS seg_start,
             LEAST(CASE WHEN c."endedAt" IS NOT NULL THEN c."endedAt" ELSE LEAST($4::timestamp,c."startedAt"+INTERVAL '12 hours') END,s."endsAt") AS seg_end
        FROM selected s JOIN "TeamShiftCreator" sc ON sc."shiftId"=s."id"
        JOIN "TeamCoverageSession" c ON c."agencyId"=$1 AND c."creatorId"=sc."creatorId"
        JOIN "TeamShift" sx ON sx."id"=s."id" AND c."memberId"=sx."memberId"
       WHERE c."startedAt"<s."endsAt" AND CASE WHEN c."endedAt" IS NOT NULL THEN c."endedAt" ELSE LEAST($4::timestamp,c."startedAt"+INTERVAL '12 hours') END>s."startsAt"
    ), valid AS(SELECT * FROM cbase WHERE seg_end>seg_start), ordered AS(
      SELECT v.*,MAX(seg_end) OVER(PARTITION BY shift_id ORDER BY seg_start,seg_end ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max_end FROM valid v
    ), marked AS(SELECT o.*,CASE WHEN prev_max_end IS NULL OR seg_start>prev_max_end THEN 1 ELSE 0 END AS new_group FROM ordered o),
    grouped AS(SELECT m.*,SUM(new_group) OVER(PARTITION BY shift_id ORDER BY seg_start,seg_end ROWS UNBOUNDED PRECEDING) AS grp FROM marked m),
    unions AS(SELECT shift_id,grp,MIN(seg_start) AS s,MAX(seg_end) AS e FROM grouped GROUP BY shift_id,grp),
    cov AS(SELECT shift_id,SUM(EXTRACT(EPOCH FROM(e-s))) AS actual_seconds FROM unions GROUP BY shift_id),
    per_shift AS(
      SELECT s.*,EXTRACT(EPOCH FROM(s."endsAt"-s."startsAt")) AS planned_seconds,COALESCE(c.actual_seconds,0) AS actual_seconds FROM selected s LEFT JOIN cov c ON c.shift_id=s."id"
    ) SELECT
      COUNT(*) FILTER(WHERE "status"<>'CANCELLED')::bigint AS planned_shifts,
      COUNT(*) FILTER(WHERE "status"<>'CANCELLED' AND $4::timestamp>="startsAt" AND $4::timestamp<"endsAt")::bigint AS live_planned_shifts,
      COUNT(*) FILTER(WHERE "status"<>'CANCELLED' AND "endsAt"<=$4::timestamp)::bigint AS completed_shifts,
      COUNT(*) FILTER(WHERE "status"<>'CANCELLED' AND "endsAt"<=$4::timestamp AND actual_seconds<=0)::bigint AS missed_shifts,
      COALESCE(SUM(planned_seconds) FILTER(WHERE "status"<>'CANCELLED'),0)::bigint AS planned_seconds,
      COALESCE(SUM(LEAST(planned_seconds,actual_seconds)) FILTER(WHERE "status"<>'CANCELLED'),0)::bigint AS actual_against_plan_seconds
      FROM per_shift`;
  const rows = await query(db, sql, [String(agencyId), range?.startAt ? new Date(range.startAt) : null, new Date(range.endAt), new Date(authorityNow), scope]);
  return rows?.[0] || {};
}

async function loadVisibleShifts({ db, agencyId, queryRange, allowedCreatorIds, includeCreatorWhere }) {
  const where = queryRange.startAt
    ? { startsAt: { lte: queryRange.endAt }, endsAt: { gte: queryRange.startAt } }
    : { startsAt: { lte: queryRange.endAt } };
  if (Array.isArray(allowedCreatorIds)) {
    const ids = normalizedScope(allowedCreatorIds) || [];
    where.creators = { some: { creatorId: { in: ids.length ? ids : ["__none__"] } } };
  }
  const rows = await db.teamShift.findMany({
    where: { agencyId, ...where },
    include: {
      member: { select: { id: true, displayName: true, roleKey: true, user: { select: { name: true, email: true } } } },
      creators: includeCreatorWhere,
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: SHIFT_DETAIL_LIMIT + 1,
  });
  return { rows: rows.slice(0, SHIFT_DETAIL_LIMIT), complete: rows.length <= SHIFT_DETAIL_LIMIT, limit: SHIFT_DETAIL_LIMIT };
}

function memberNameFromContext(context, memberId) {
  return context?.members?.find((row) => String(row.id) === String(memberId))?.name || String(memberId);
}
function creatorFromContext(context, creatorId) {
  return context?.creators?.find((row) => String(row.id) === String(creatorId)) || { id: String(creatorId), name: String(creatorId), username: null, avatarUrl: null };
}
function fulfillment({ status, startsAt, endsAt, actualSeconds, nowMs }) {
  if (String(status || "PLANNED").toUpperCase() === "CANCELLED") return "CANCELLED";
  const s = new Date(startsAt).getTime(); const e = new Date(endsAt).getTime();
  if (nowMs < s) return "UPCOMING";
  if (nowMs >= s && nowMs < e) return actualSeconds > 0 ? "LIVE" : "NOT_STARTED";
  if (actualSeconds <= 0) return "MISSED";
  const planned = Math.max(0, Math.round((e-s)/1000));
  return planned > 0 && actualSeconds/planned >= .8 ? "COVERED" : "PARTIAL";
}

async function buildScheduleScaleRead({ db, agencyId, queryRange, authorityNow, allowedCreatorIds, context, includeCreatorWhere, currentResponseGeneration = false }) {
  const visible = await loadVisibleShifts({ db, agencyId, queryRange, allowedCreatorIds, includeCreatorWhere });
  const shiftIds = visible.rows.map((r) => String(r.id));
  const [shiftMetricRows, creatorRows, memberRows, recentRows, handoffRows, plan] = await Promise.all([
    loadShiftMetrics({ db, agencyId, shiftIds, authorityNow, currentResponseGeneration }),
    loadCreatorCoverage({ db, agencyId, range: queryRange, authorityNow, allowedCreatorIds }),
    loadMemberCoverage({ db, agencyId, range: queryRange, authorityNow, allowedCreatorIds }),
    loadRecentSessions({ db, agencyId, range: queryRange, authorityNow, allowedCreatorIds }),
    loadHandoffDetails({ db, agencyId, range: queryRange, authorityNow, allowedCreatorIds }),
    loadPlanSummary({ db, agencyId, range: queryRange, authorityNow, allowedCreatorIds }),
  ]);
  const metrics = new Map((shiftMetricRows || []).map((row) => [String(row.shift_id), row]));
  const nowMs = new Date(authorityNow).getTime();
  const shifts = visible.rows.map((row) => {
    const m = metrics.get(String(row.id)) || {};
    const creatorLinks = (row.creators || []).map((link) => creatorFromContext(context, link.creatorId || link.creator?.id)).filter((x) => x.id);
    const plannedSeconds = Math.max(0, Math.round((new Date(row.endsAt)-new Date(row.startsAt))/1000));
    const actualPresenceSeconds = Math.max(0, Math.round(num(m.actual_seconds)));
    const firstActualAt = iso(m.first_actual); const lastActualAt = iso(m.last_actual);
    const firstMs = firstActualAt ? new Date(firstActualAt).getTime() : null; const lastMs = lastActualAt ? new Date(lastActualAt).getTime() : null;
    const startMs = new Date(row.startsAt).getTime(); const endMs = new Date(row.endsAt).getTime();
    const samples = num(m.response_samples); const incomplete = num(m.incomplete_responses);
    return {
      id:String(row.id),revision:Number(row.revision||1),memberId:String(row.memberId),memberName:row.member?.displayName||row.member?.user?.name||row.member?.user?.email||String(row.memberId),roleKey:row.member?.roleKey||null,
      creatorIds:creatorLinks.map((c)=>c.id),creators:creatorLinks,startsAt:iso(row.startsAt),endsAt:iso(row.endsAt),timezone:row.timezone||"UTC",status:String(row.status||"PLANNED").toUpperCase(),note:row.note||null,createdAt:iso(row.createdAt),updatedAt:iso(row.updatedAt),cancelledAt:iso(row.cancelledAt),
      plannedSeconds,actualPresenceSeconds,gapSeconds:Math.max(0,plannedSeconds-actualPresenceSeconds),firstActualAt,lastActualAt,
      lateStartSeconds:firstMs==null?null:Math.max(0,Math.round((firstMs-startMs)/1000)),earlyEndSeconds:lastMs==null||nowMs<endMs?null:Math.max(0,Math.round((endMs-lastMs)/1000)),sessionsCount:num(m.sessions_count),
      fulfillment:fulfillment({status:row.status,startsAt:row.startsAt,endsAt:row.endsAt,actualSeconds:actualPresenceSeconds,nowMs}),responseSamples:samples,
      medianResponseSeconds:incomplete?null:nullableNum(m.median_response),sla15Pct:incomplete?null:(samples?num(m.sla15_passes)/samples*100:null),responseCoverage:incomplete?"PARTIAL":"FULL",
    };
  });
  const sessionByCreator = new Map();
  for (const r of recentRows || []) {
    const id=String(r.creatorId||r.creatorid||r.creator_id||""); if(!id) continue;
    if(!sessionByCreator.has(id)) sessionByCreator.set(id,[]);
    sessionByCreator.get(id).push({id:String(r.id),creatorId:id,memberId:String(r.memberId||r.memberid||r.member_id),memberName:memberNameFromContext(context,r.memberId||r.memberid||r.member_id),roleKey:null,coverageId:r.coverageId||r.coverageid||null,deviceId:r.deviceId||r.deviceid||null,startedAt:iso(r.startedAt||r.startedat),endedAt:iso(r.endedAt||r.endedat),durationSeconds:Math.max(0,Math.round((new Date(r.seg_end)-new Date(r.seg_start))/1000)),startReason:r.startReason||r.startreason||null,endReason:r.endReason||r.endreason||null,activeNow:Boolean(r.active_now),staleOpen:Boolean(r.stale_open),source:r.source||null});
  }
  const creators=(creatorRows||[]).map((r)=>{const id=String(r.creatorId||r.creatorid||r.creator_id);const c=creatorFromContext(context,id);return{creatorId:id,creatorName:c.name,creatorUsername:c.username||null,creatorAvatarUrl:c.avatarUrl||null,coveredSeconds:num(r.covered_seconds),sessionSeconds:num(r.session_seconds),sessionsCount:num(r.sessions_count),membersCount:num(r.members_count),handoffs:num(r.handoffs),overlaps:num(r.overlaps),activeNow:Boolean(r.active_now),openSessions:num(r.open_sessions),staleOpenSessions:num(r.stale_open_sessions),sessions:sessionByCreator.get(id)||[]};}).sort((a,b)=>Number(b.activeNow)-Number(a.activeNow)||b.coveredSeconds-a.coveredSeconds||a.creatorName.localeCompare(b.creatorName));
  const members=(memberRows||[]).map((r)=>({memberId:String(r.memberId||r.memberid||r.member_id),memberName:memberNameFromContext(context,r.memberId||r.memberid||r.member_id),coverageSeconds:num(r.coverage_seconds),sessionsCount:num(r.sessions_count),creatorsCount:num(r.creators_count),activeNow:Boolean(r.active_now),staleOpenSessions:num(r.stale_open_sessions)})).sort((a,b)=>Number(b.activeNow)-Number(a.activeNow)||b.coverageSeconds-a.coverageSeconds);
  const handoffs=[]; const overlaps=[];
  for(const r of handoffRows||[]){const cid=String(r.creatorId||r.creatorid||r.creator_id);const at=iso(r.seg_start);const gap=num(r.gap_seconds);const base={creatorId:cid,creatorName:creatorFromContext(context,cid).name,fromMemberId:String(r.prev_member),fromMemberName:memberNameFromContext(context,r.prev_member),toMemberId:String(r.memberId||r.memberid||r.member_id),toMemberName:memberNameFromContext(context,r.memberId||r.memberid||r.member_id),at,gapSeconds:gap};if(String(r.kind)==="OVERLAP")overlaps.push({...base,overlapSeconds:Math.abs(gap)});else handoffs.push(base);}
  const coveredSeconds=creators.reduce((s,r)=>s+r.coveredSeconds,0);const psec=num(plan.planned_seconds);const asec=num(plan.actual_against_plan_seconds);
  return { shifts, creators, members, handoffs, overlaps,
    summary:{plannedShifts:num(plan.planned_shifts),livePlannedShifts:num(plan.live_planned_shifts),completedShifts:num(plan.completed_shifts),missedShifts:num(plan.missed_shifts),creatorsCovered:creators.length,membersWithCoverage:members.length,sessions:creators.reduce((s,r)=>s+r.sessionsCount,0),openSessions:creators.reduce((s,r)=>s+r.openSessions,0),staleOpenSessions:creators.reduce((s,r)=>s+r.staleOpenSessions,0),handoffs:creators.reduce((s,r)=>s+r.handoffs,0),overlaps:creators.reduce((s,r)=>s+r.overlaps,0),coveredSeconds,plannedSeconds:psec,actualAgainstPlanSeconds:asec,planCoveragePct:psec>0?asec/psec*100:null},
    detailCoverage:{complete:visible.complete,shiftLimit:visible.limit,returnedShifts:shifts.length,sessionDetailPerCreator:SESSION_DETAIL_PER_CREATOR,handoffDetailLimit:HANDOFF_DETAIL_LIMIT},
  };
}

module.exports={SHIFT_DETAIL_LIMIT,SESSION_DETAIL_PER_CREATOR,HANDOFF_DETAIL_LIMIT,supportsScheduleScaleRead,buildScheduleScaleRead};
