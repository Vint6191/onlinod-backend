"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const schedule = require("./team-schedule-service");

function rawDb() {
  let rawCalls = 0;
  let shiftTake = null;
  let shiftArgs = null;
  let visibleShiftSql = null;
  const db = {
    systemSetting: { async findUnique() { return null; } },
    workspaceSetting: { async findUnique() { return null; } },
    teamProjectionCoverage: { async findUnique() { return { agencyId:"a", responseCoverageFrom:new Date("2026-01-01T00:00:00Z"), dialogCoverageFrom:new Date("2026-01-01T00:00:00Z") }; } },
    creatorAccount: { async findMany() { return [{ id:"c", displayName:"Creator", username:"creator", avatarUrl:null }]; } },
    agencyMember: { async findMany() { return [{ id:"m", displayName:"Member", roleKey:"chatter", assignedCreators:"all", user:{name:"Member",email:"m@test"}, teamFunctions:[] }]; } },
    teamShift: { async findMany(args) { shiftTake = args.take; shiftArgs = args; return [{ id:"s", agencyId:"a", memberId:"m", startsAt:new Date("2026-09-09T09:00:00Z"), endsAt:new Date("2026-09-09T17:00:00Z"), timezone:"UTC", status:"PLANNED", revision:1, note:null, createdAt:new Date("2026-09-01T00:00:00Z"), updatedAt:new Date("2026-09-01T00:00:00Z"), cancelledAt:null, member:{id:"m",displayName:"Member",roleKey:"chatter",assignedCreators:"all",user:{name:"Member",email:"m@test"}}, creators:[{creatorId:"c",creatorRefId:"c",creator:{id:"c",displayName:"Creator",username:"creator",avatarUrl:null}}] }]; } },
    teamCoverageSession: { async findMany() { throw new Error("production scale path must not materialize coverage rows"); } },
    teamResponseCase: { async findMany() { throw new Error("production scale path must not materialize response rows"); } },
    async $queryRawUnsafe(sql) {
      if (sql.includes('clock_timestamp()')) return [{ authorityNow: new Date("2026-09-10T12:00:00Z") }];
      rawCalls += 1;
      if (sql.includes('AS visible_shift_id')) { visibleShiftSql = sql; return [{ visible_shift_id:"s" }]; }
      if (sql.includes('AS planned_shifts')) return [{ planned_shifts:1n, live_planned_shifts:0n, completed_shifts:1n, missed_shifts:0n, planned_seconds:28800n, actual_against_plan_seconds:21600n }];
      if (sql.includes('AS shift_id') && sql.includes('median_response')) return [{ shift_id:"s", actual_seconds:21600n, sessions_count:1n, first_actual:new Date("2026-09-09T09:00:00Z"), last_actual:new Date("2026-09-09T15:00:00Z"), response_samples:2n, median_response:660, sla15_passes:1n, incomplete_responses:0n }];
      if (sql.includes('AS covered_seconds') && sql.includes('AS handoffs')) return [{ creatorId:"c", covered_seconds:21600n, session_seconds:21600n, sessions_count:1n, members_count:1n, active_now:false, open_sessions:0n, stale_open_sessions:0n, handoffs:0n, overlaps:0n }];
      if (sql.includes('AS coverage_seconds')) return [{ memberId:"m", coverage_seconds:21600n, sessions_count:1n, creators_count:1n, active_now:false, stale_open_sessions:0n }];
      if (sql.includes(`rn<=5`)) return [{ id:"cov", creatorId:"c", memberId:"m", coverageId:"cov", deviceId:"d", startedAt:new Date("2026-09-09T09:00:00Z"), endedAt:new Date("2026-09-09T15:00:00Z"), seg_start:new Date("2026-09-09T09:00:00Z"), seg_end:new Date("2026-09-09T15:00:00Z"), active_now:false, stale_open:false, source:"team_v13" }];
      if (sql.includes('AS gap_seconds')) return [];
      throw new Error(`unexpected raw query: ${sql.slice(0,120)}`);
    },
  };
  return { db, stats:()=>({rawCalls,shiftTake,shiftArgs,visibleShiftSql}) };
}

test("A15 Schedule production read uses SQL aggregates and bounded details instead of retained-range materialization", async () => {
  const { db, stats } = rawDb();
  const out = await schedule.buildTeamSchedule({ agencyId:"a", rangeKey:"7d", now:new Date("2026-09-10T12:00:00Z"), db });
  assert.equal(out.source, "team_shift_scale_sql_v2");
  assert.equal(out.shifts.length, 1);
  assert.equal(out.shifts[0].actualPresenceSeconds, 21600);
  assert.equal(out.shifts[0].medianResponseSeconds, 660);
  assert.equal(Math.round(out.shifts[0].sla15Pct), 50);
  assert.equal(out.summary.planCoveragePct, 75);
  assert.deepEqual(out.detailCoverage, { complete:true, shiftLimit:1000, returnedShifts:1, sessionDetailPerCreator:5, handoffDetailLimit:100 });
  assert.equal(stats().shiftTake, undefined, "bounded visible ids are selected by SQL before Prisma detail hydration");
  assert.deepEqual(stats().shiftArgs.where.id.in, ["s"]);
  assert.equal(stats().shiftArgs.include.creators.where.creator.is.deletedAt, null, "nested creator links exclude soft-retired Creators");
  assert.match(stats().visibleShiftSql, /phase2_scope_allows_creator/);
  assert.match(stats().visibleShiftSql, /LIMIT 1001/);
  assert.equal(stats().rawCalls, 7, "one bounded visible-id query plus a fixed aggregate query family replaces retained-range materialization");
});
