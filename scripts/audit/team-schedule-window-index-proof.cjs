"use strict";
// Current production schedule queries over retained and expired history. Tests
// both custom and generic prepared plans without disabling sequential scans.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const alive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("TEAM_SCHEDULE_WINDOW_PROOF_DEADLINE"); process.exit(2); }, 120000);
function nodes(plan) { return [plan, ...(plan.Plans || []).flatMap(nodes)]; }
async function main() {
  const f = await fixture(), { db, root } = f;
  const result = { ok: false, runtime: "isolated PGlite + Prisma", oldShifts: 10000, plans: [] };
  try {
    const s = await scope(db), now = new Date(), memberId = "member-" + s.agencyId;
    const from = new Date(+now - 7 * 86400000), through = new Date(+now + 7 * 86400000);
    await db.$executeRawUnsafe(`INSERT INTO "TeamShift" (id,"agencyId","memberId","startsAt","endsAt","updatedAt")
      SELECT 'expired-'||n,$1,$2,$3::timestamp-INTERVAL '4 years'+n*INTERVAL '1 hour',
        $3::timestamp-INTERVAL '4 years'+(n+1)*INTERVAL '1 hour',CURRENT_TIMESTAMP FROM generate_series(1,10000) n`, s.agencyId, memberId, now);
    await db.teamShift.createMany({ data: [
      ...Array.from({ length: 12 }, (_, i) => ({ id: "recent-" + i, agencyId: s.agencyId, memberId,
        startsAt: new Date(+now - 3 * 86400000 + i * 3600000), endsAt: new Date(+now - 3 * 86400000 + (i + 1) * 3600000) })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: "future-" + i, agencyId: s.agencyId, memberId,
        startsAt: new Date(+now + (i + 1) * 3600000), endsAt: new Date(+now + (i + 2) * 3600000) })),
      // Old databases do not enforce today's maximum duration. A lower bound
      // inferred from startsAt would incorrectly hide this still-live row.
      { id: "retained-long-shift", agencyId: s.agencyId, memberId, startsAt: new Date(+now - 4 * 365 * 86400000), endsAt: new Date(+now + 86400000) },
    ] });
    await db.$executeRawUnsafe(`INSERT INTO "TeamShiftCreator"("shiftId","creatorId","creatorRefId") SELECT id,$2,$2 FROM "TeamShift" WHERE "agencyId"=$1`, s.agencyId, s.creatorId);
    for (const table of ["TeamShift", "TeamShiftCreator", "AgencyMember", "CreatorAccount", "User"]) await db.$executeRawUnsafe(`ANALYZE "${table}"`);
    const queries = new Map();
    const watched = new Proxy(db, { get(target, key) {
      if (key === "$queryRawUnsafe") return async (sql, ...args) => {
        if (sql.includes("visible_shift_id")) queries.set("detail", { sql, args });
        if (sql.includes("FROM per_shift")) queries.set("summary", { sql, args });
        return target.$queryRawUnsafe(sql, ...args);
      };
      const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
    const schedule = await require(path.join(root, "src/services/team-schedule-scale-read-service")).buildScheduleScaleRead({
      db: watched, agencyId: s.agencyId, authorityNow: now, queryRange: { startAt: from, endAt: now },
      planningRange: { startAt: from, endAt: through }, allowedCreatorIds: [s.creatorId], currentResponseGeneration: true,
      context: { members: [{ id: memberId, name: "Owner" }], creators: [{ id: s.creatorId, name: "Creator" }] },
      includeCreatorWhere: { where: { creatorRefId: s.creatorId }, include: { creator: true } },
    });
    assert.equal(schedule.shifts.length, 19); assert.equal(schedule.summary.plannedShifts, 19);
    assert(schedule.shifts.some(row => row.id === "retained-long-shift"));
    assert(schedule.shifts.some(row => row.id === "future-5"));
    assert.equal(queries.size, 2);
    const literal = value => value == null ? "NULL" : Array.isArray(value)
      ? `ARRAY[${value.map(literal).join(",")}]::text[]`
      : `'${(value instanceof Date ? value.toISOString() : String(value)).replaceAll("'", "''")}'`;
    for (const [name, { sql }] of queries) {
      const types = name === "detail" ? "text,timestamp,timestamp,text[],timestamp" : "text,timestamp,timestamp,timestamp,text[]";
      await db.$executeRawUnsafe(`PREPARE schedule_${name}(${types}) AS ${sql}`);
    }
    async function explain(mode, phase) {
      await db.$executeRawUnsafe(`SET plan_cache_mode = ${mode}`);
      const reports = [];
      for (const [name, { args }] of queries) {
        const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE schedule_${name}(${args.map(literal).join(",")})`);
        const plan = rows[0]["QUERY PLAN"][0], all = nodes(plan.Plan);
        const scans = all.filter(row => row["Relation Name"] === "TeamShift");
        const examined = scans.reduce((sum, row) => sum + ((row["Actual Rows"] || 0) + (row["Rows Removed by Filter"] || 0)) * row["Actual Loops"], 0);
        const report = { phase, mode, query: name, examinedShifts: examined,
          indexes: [...new Set(all.map(row => row["Index Name"]).filter(Boolean))], plan };
        reports.push(report); result.plans.push(report);
      }
      return reports;
    }
    await db.$executeRawUnsafe('DROP INDEX "TeamShift_agencyId_endsAt_idx"');
    const without = await explain("force_generic_plan", "before_index");
    assert(without.every(row => row.examinedShifts >= result.oldShifts), "fixture must reproduce lifetime-history scans without the end-window index");
    const migration = fs.readFileSync(path.join(root, "prisma/migrations/20261018010000_team_schedule_end_window/migration.sql"), "utf8");
    await db.$executeRawUnsafe(migration);
    await db.$executeRawUnsafe('ANALYZE "TeamShift"');
    const custom = await explain("force_custom_plan", "after_index");
    for (const row of custom) {
      assert(row.indexes.includes("TeamShift_agencyId_endsAt_idx"), JSON.stringify(row));
      assert(row.examinedShifts <= 40, JSON.stringify(row));
    }
    const generic = await explain("force_generic_plan", "after_index");
    // Record, rather than hide, the optimizer's choice with forced unknown
    // parameter estimates. The application uses PostgreSQL's automatic policy.
    result.forcedGenericIsBounded = generic.every(row => row.examinedShifts <= 40);
    for (const [name, { sql }] of queries) {
      await db.$executeRawUnsafe(`DEALLOCATE schedule_${name}`);
      const types = name === "detail" ? "text,timestamp,timestamp,text[],timestamp" : "text,timestamp,timestamp,timestamp,text[]";
      await db.$executeRawUnsafe(`PREPARE schedule_${name}(${types}) AS ${sql}`);
    }
    await db.$executeRawUnsafe("SET plan_cache_mode = auto");
    for (let execution = 0; execution < 7; execution++) {
      for (const [name, { args }] of queries) await db.$queryRawUnsafe(`EXECUTE schedule_${name}(${args.map(literal).join(",")})`);
    }
    const automatic = await explain("auto", "after_index_eighth_execution");
    for (const row of automatic) {
      assert(row.indexes.includes("TeamShift_agencyId_endsAt_idx"), JSON.stringify(row));
      assert(row.examinedShifts <= 40, JSON.stringify(row));
    }
    result.preparedPlans = await db.$queryRawUnsafe("SELECT name, generic_plans::int, custom_plans::int FROM pg_prepared_statements WHERE name IN ('schedule_detail','schedule_summary') ORDER BY name");
    const readiness = await require(path.join(root, "src/services/database-contract-service")).readDatabaseContract(db);
    assert.equal(readiness.ready, true, JSON.stringify(readiness));
    result.contractVersion = readiness.version; result.returnedShifts = schedule.shifts.length; result.ok = true;
  } finally {
    await f.close();
    const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || ".", "evidence/team-schedule-window-index.json");
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ ...result, plans: result.plans.map(({ plan, ...rest }) => rest) }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(() => { clearInterval(alive); clearTimeout(deadline); });
