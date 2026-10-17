"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const alive = setInterval(() => {}, 1000);
const report = { ok: false, runtime: "isolated PGlite + real Prisma", coveredShifts: 5000, additionalShiftStates: 3, plans: [] };
const before = `per_shift AS(
      SELECT s.*,EXTRACT(EPOCH FROM(s."endsAt"-s."startsAt")) AS planned_seconds,COALESCE(c.actual_seconds,0) AS actual_seconds FROM selected s LEFT JOIN cov c ON c.shift_id=s."id"
    )`;
const after = `per_shift AS(
      SELECT "id",MAX("status") AS "status",MAX("startsAt") AS "startsAt",MAX("endsAt") AS "endsAt",
             SUM(planned_seconds) AS planned_seconds,SUM(actual_seconds) AS actual_seconds
        FROM (
          SELECT s."id",s."status",s."startsAt",s."endsAt",EXTRACT(EPOCH FROM(s."endsAt"-s."startsAt")) AS planned_seconds,0::numeric AS actual_seconds FROM selected s
          UNION ALL
          SELECT c.shift_id,NULL::text,NULL::timestamp,NULL::timestamp,0::numeric,c.actual_seconds FROM cov c
        ) contributions
       GROUP BY "id"
    )`;
function nodes(plan) { return [plan, ...(plan.Plans || []).flatMap(nodes)]; }
async function main() {
  const f = await fixture(), { db, root } = f;
  try {
    const s = await scope(db), memberId = "member-" + s.agencyId, now = new Date(), ago = minutes => new Date(+now - minutes * 60000);
    await db.$executeRawUnsafe(`INSERT INTO "TeamShift"(id,"agencyId","memberId","startsAt","endsAt","status","updatedAt")
      SELECT 'summary-shift-'||n,$1,$2,$3::timestamp,$4::timestamp,CASE WHEN n%10=0 THEN 'CANCELLED' ELSE 'PLANNED' END,CURRENT_TIMESTAMP
        FROM generate_series(1,$5::int) n`, s.agencyId, memberId, ago(120), ago(60), report.coveredShifts);
    await db.teamShift.createMany({ data: [
      { id: "summary-missed", agencyId: s.agencyId, memberId, startsAt: ago(50), endsAt: ago(40) },
      { id: "summary-live", agencyId: s.agencyId, memberId, startsAt: ago(5), endsAt: ago(-5) },
      { id: "summary-future", agencyId: s.agencyId, memberId, startsAt: ago(-60), endsAt: ago(-120) },
    ] });
    await db.$executeRawUnsafe(`INSERT INTO "TeamShiftCreator"("shiftId","creatorId","creatorRefId")
      SELECT id,$2,$2 FROM "TeamShift" WHERE "agencyId"=$1`, s.agencyId, s.creatorId);
    await db.teamCoverageSession.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, memberId,
      coverageId: "summary-coverage", startedAt: ago(115), endedAt: ago(105) } });
    let captured;
    const capture = { $queryRawUnsafe: async (sql, ...args) => {
      if (sql.includes("FROM per_shift")) captured = { sql, args };
      return [];
    } };
    await require(path.join(root, "src/services/team-schedule-scale-read-service")).buildScheduleScaleRead({
      db: capture, agencyId: s.agencyId, authorityNow: now, queryRange: { startAt: ago(7 * 1440), endAt: now },
      planningRange: { startAt: ago(7 * 1440), endAt: ago(-7 * 1440) }, allowedCreatorIds: [s.creatorId], context: {}, includeCreatorWhere: {},
    });
    assert(captured, "Capture the actual production summary query");
    assert(captured.sql.includes(after), "Actual production summary must consume contributions without a coverage join");
    const currentUsesContributionFold = captured.sql.includes(after);
    const oldSql = currentUsesContributionFold ? captured.sql.replace(after, before) : captured.sql;
    const newSql = currentUsesContributionFold ? captured.sql : captured.sql.replace(before, after);
    async function explain(sql, label) {
      const rows = await db.$queryRawUnsafe("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql, ...captured.args);
      const plan = rows[0]["QUERY PLAN"][0], all = nodes(plan.Plan);
      const cov = all.filter(row => row["Node Type"] === "CTE Scan" && row["CTE Name"] === "cov");
      const covRowsRead = cov.reduce((sum, row) => sum + row["Actual Rows"] * row["Actual Loops"], 0);
      const joinComparisons = all.reduce((sum, row) => sum + (row["Rows Removed by Join Filter"] || 0) * row["Actual Loops"], 0);
      const result = { label, covRowsRead, joinComparisons, plan }; report.plans.push(result); return result;
    }
    const coldBefore = await explain(oldSql, "cold_before_join");
    const coldAfter = await explain(newSql, "cold_contribution_fold");
    assert(coldBefore.covRowsRead >= report.coveredShifts ** 2, "Cold fixture must expose the quadratic coverage join");
    assert.equal(coldAfter.covRowsRead, report.coveredShifts, "Each coverage result must be consumed exactly once");
    for (const table of ["TeamShift", "TeamShiftCreator", "TeamCoverageSession", "AgencyMember", "CreatorAccount", "User"])
      await db.$executeRawUnsafe(`ANALYZE "${table}"`);
    await explain(oldSql, "analyzed_before_join");
    const warmAfter = await explain(newSql, "analyzed_contribution_fold");
    assert.equal(warmAfter.covRowsRead, report.coveredShifts);
    const oldRows = await db.$queryRawUnsafe(oldSql, ...captured.args), newRows = await db.$queryRawUnsafe(newSql, ...captured.args);
    assert.deepEqual(newRows, oldRows);
    assert.equal(Number(newRows[0].planned_shifts), 4503);
    assert.equal(Number(newRows[0].live_planned_shifts), 1);
    assert.equal(Number(newRows[0].completed_shifts), 4501);
    assert.equal(Number(newRows[0].missed_shifts), 1);
    assert.equal(Number(newRows[0].planned_seconds), 4500 * 3600 + 1200);
    assert.equal(Number(newRows[0].actual_against_plan_seconds), 4500 * 600);
    const denied = await db.$queryRawUnsafe(newSql, ...captured.args.slice(0, 4), []);
    assert.equal(Number(denied[0].planned_shifts), 0); assert.equal(Number(denied[0].actual_against_plan_seconds), 0);
    await db.teamCoverageSession.deleteMany({ where: { agencyId: s.agencyId } });
    const missed = await db.$queryRawUnsafe(newSql, ...captured.args);
    assert.equal(Number(missed[0].missed_shifts), 4501); assert.equal(Number(missed[0].actual_against_plan_seconds), 0);
    await db.teamCoverageSession.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, memberId,
      coverageId: "summary-clipped-coverage", startedAt: ago(130), endedAt: ago(50) } });
    const clipped = await db.$queryRawUnsafe(newSql, ...captured.args);
    assert.equal(Number(clipped[0].actual_against_plan_seconds), 4500 * 3600);
    assert.equal(Number(clipped[0].missed_shifts), 1);
    assert.deepEqual(clipped, await db.$queryRawUnsafe(oldSql, ...captured.args));
    report.currentUsesContributionFold = currentUsesContributionFold;
    report.summary = newRows[0]; report.ok = true;
  } finally {
    await f.close();
    const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || ".", "evidence/team-schedule-summary-plan.json");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, (_key, value) => typeof value === "bigint" ? String(value) : value, 2));
  }
  console.log(JSON.stringify({ ...report, summary: undefined, plans: report.plans.map(({ plan, ...rest }) => ({ ...rest, executionMs: plan["Execution Time"] })) }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearInterval(alive));
