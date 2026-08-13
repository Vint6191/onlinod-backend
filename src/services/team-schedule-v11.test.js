"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const schedule = require("./team-schedule-service");

function dbForRead() {
  const coverage = [
    {
      id: "cov-a", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "coverage-a", deviceId: "dev-1",
      startedAt: new Date("2026-08-12T09:00:00Z"), endedAt: new Date("2026-08-12T15:00:00Z"), startReason: "workspace", endReason: "switch", source: "team_v13",
      member: { id: "member-a", displayName: "Marina", roleKey: "chatter", user: { name: "Marina", email: "m@example.test" } },
      creator: { id: "creator-1", displayName: "Vilgelmina", username: "vilgelmina", avatarUrl: null },
    },
    {
      id: "cov-b", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-b", coverageId: "coverage-b", deviceId: "dev-2",
      startedAt: new Date("2026-08-12T15:05:00Z"), endedAt: new Date("2026-08-12T17:00:00Z"), startReason: "handoff", endReason: "close", source: "team_v13",
      member: { id: "member-b", displayName: "Nikita", roleKey: "chatter", user: { name: "Nikita", email: "n@example.test" } },
      creator: { id: "creator-1", displayName: "Vilgelmina", username: "vilgelmina", avatarUrl: null },
    },
    {
      id: "cov-stale", agencyId: "agency-1", creatorId: "creator-2", memberId: "member-a", coverageId: "coverage-stale", deviceId: "dev-1",
      startedAt: new Date("2026-08-12T10:00:00Z"), endedAt: null, startReason: "workspace", endReason: null, source: "team_v13",
      member: { id: "member-a", displayName: "Marina", roleKey: "chatter", user: { name: "Marina", email: "m@example.test" } },
      creator: { id: "creator-2", displayName: "Mira", username: "mira", avatarUrl: null },
    },
  ];
  return {
    teamCoverageSession: { async findMany() { return coverage; } },
    teamShift: { async findMany() { return [{
      id: "shift-1", agencyId: "agency-1", memberId: "member-a", startsAt: new Date("2026-08-12T09:00:00Z"), endsAt: new Date("2026-08-12T17:00:00Z"), timezone: "Europe/Kyiv", status: "PLANNED", note: "day shift", createdAt: new Date("2026-08-11T10:00:00Z"), updatedAt: new Date("2026-08-11T10:00:00Z"), cancelledAt: null,
      member: { id: "member-a", displayName: "Marina", roleKey: "chatter", user: { name: "Marina", email: "m@example.test" } },
      creators: [{ creatorId: "creator-1", creator: { id: "creator-1", displayName: "Vilgelmina", username: "vilgelmina", avatarUrl: null } }],
    }]; } },
    teamResponseCase: { async findMany() { return [
      { creatorId: "creator-1", memberId: "member-a", replyAt: new Date("2026-08-12T10:00:00Z"), slaEligible: true, sla15Pass: true, wallClockSeconds: 120 },
      { creatorId: "creator-1", memberId: "member-a", replyAt: new Date("2026-08-12T11:00:00Z"), slaEligible: true, sla15Pass: false, wallClockSeconds: 1200 },
    ]; } },
    workspaceSetting: { async findUnique() { return { value: "Europe/Kyiv" }; } },
    creatorAccount: { async findMany({ where = {} } = {}) {
      const rows = [
        { id: "creator-1", displayName: "Vilgelmina", username: "vilgelmina", avatarUrl: null },
        { id: "creator-2", displayName: "Mira", username: "mira", avatarUrl: null },
      ];
      const ids = where?.creatorId?.in;
      return Array.isArray(ids) ? rows.filter((row) => ids.includes(row.id)) : rows;
    } },
    agencyMember: { async findMany() { return [
      { id: "member-a", displayName: "Marina", roleKey: "chatter", assignedCreators: "all", user: { name: "Marina", email: "m@example.test" }, teamFunctions: [{ functionKey: "CHATTER" }] },
      { id: "member-b", displayName: "Nikita", roleKey: "chatter", assignedCreators: ["creator-1"], user: { name: "Nikita", email: "n@example.test" }, teamFunctions: [{ functionKey: "CHATTER" }] },
    ]; } },
  };
}

test("Schedule read model combines planned shifts with actual coverage without immortal open sessions", async () => {
  const payload = await schedule.buildTeamSchedule({ agencyId: "agency-1", rangeKey: "7d", now: new Date("2026-08-13T12:00:00Z"), db: dbForRead(), canManageSchedule: true });
  assert.equal(payload.context.workspaceTimezone, "Europe/Kyiv");
  assert.equal(payload.context.canManageSchedule, true);
  assert.equal(payload.shifts.length, 1);
  assert.equal(payload.shifts[0].plannedSeconds, 8 * 60 * 60);
  assert.equal(payload.shifts[0].actualPresenceSeconds, 6 * 60 * 60);
  assert.equal(payload.shifts[0].gapSeconds, 2 * 60 * 60);
  assert.equal(payload.shifts[0].fulfillment, "PARTIAL");
  assert.equal(Math.round(payload.shifts[0].sla15Pct), 50);
  assert.equal(payload.shifts[0].medianResponseSeconds, 660);
  assert.equal(payload.summary.handoffs, 1);
  assert.equal(payload.handoffs[0].gapSeconds, 5 * 60);
  assert.equal(payload.summary.openSessions, 0, "a 26h orphan must not stay LIVE forever");
  assert.equal(payload.summary.staleOpenSessions, 1);
  const staleCreator = payload.creators.find((row) => row.creatorId === "creator-2");
  assert.equal(staleCreator.activeNow, false);
  assert.equal(staleCreator.staleOpenSessions, 1);
  assert.equal(staleCreator.sessions[0].durationSeconds, 12 * 60 * 60, "stale open coverage is capped at the same 12h bound as response projection");
});



test("Schedule context never leaks target member creator ids outside the acting member scope", async () => {
  const payload = await schedule.buildTeamSchedule({
    agencyId: "agency-1",
    rangeKey: "7d",
    now: new Date("2026-08-13T12:00:00Z"),
    db: dbForRead(),
    allowedCreatorIds: ["creator-1"],
    canManageSchedule: true,
  });
  assert.deepEqual(payload.context.creators.map((row) => row.id), ["creator-1"]);
  const allMember = payload.context.members.find((row) => row.id === "member-a");
  assert.deepEqual(allMember.assignedCreators, ["creator-1"], "an unscoped target member must be projected through the acting manager scope");
  const scopedMember = payload.context.members.find((row) => row.id === "member-b");
  assert.deepEqual(scopedMember.assignedCreators, ["creator-1"]);
  assert.equal(JSON.stringify(payload.context).includes("creator-2"), false, "hidden creator ids must not leak through context metadata");
});

test("Schedule write target validation is fail-closed for actor and target-member creator scope", async () => {
  const db = {
    agencyMember: { async findFirst() { return { id: "member-a", assignedCreators: ["creator-1"], displayName: "Marina", user: { name: "Marina" } }; } },
    creatorAccount: { async findMany({ where }) { return (where.id.in || []).filter((id) => id === "creator-1" || id === "creator-2").map((id) => ({ id })); } },
    teamShift: { async create({ data }) { return { id: "shift-new", ...data, creators: data.creators.create }; } },
    auditLog: { async create() { return { id: "audit-1" }; } },
  };
  await schedule.createTeamShift({ agencyId: "agency-1", actorUserId: "user-manager", actorMemberId: "manager", actorAllowedCreatorIds: ["creator-1"], input: { memberId: "member-a", creatorIds: ["creator-1"], startsAt: "2026-08-14T09:00:00Z", endsAt: "2026-08-14T17:00:00Z", timezone: "Europe/Kyiv" }, db });
  await assert.rejects(() => schedule.createTeamShift({ agencyId: "agency-1", actorUserId: "user-manager", actorMemberId: "manager", actorAllowedCreatorIds: ["creator-1"], input: { memberId: "member-a", creatorIds: ["creator-2"], startsAt: "2026-08-14T09:00:00Z", endsAt: "2026-08-14T17:00:00Z", timezone: "Europe/Kyiv" }, db }), (err) => err.code === "TEAM_SCHEDULE_CREATOR_FORBIDDEN");
});

test("Schedule is relational, additive and exposes an explicit granular manage permission", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const access = fs.readFileSync(path.join(__dirname, "team-access-control.js"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "team-schedule-service.js"), "utf8");
  const route = fs.readFileSync(path.join(__dirname, "../routes/team-schedule.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260813003000_team_content_schedule_v1/migration.sql"), "utf8");
  assert.match(schema, /model TeamShift \{/);
  assert.match(schema, /model TeamShiftCreator \{/);
  assert.match(schema, /contentId\s+String\?/);
  assert.match(access, /workspace\.manage_schedule/);
  assert.match(route, /write && !canManageSchedule/);
  assert.match(route, /actorAllowedCreatorIds: actor\.allowedCreatorIds/);
  assert.match(server, /app\.use\("\/api\/team\/schedule", authRequired, teamScheduleRoutes\)/);
  assert.match(service, /findAllById\(db\.teamShift/);
  assert.match(service, /findAllById\(db\.teamResponseCase/);
  assert.doesNotMatch(service, /take:\s*(?:10000|50000)/, "Schedule reads must not silently truncate at legacy fixed caps");
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
  assert.match(migration, /TeamShiftCreator_creatorId_fkey[^;]+ON DELETE RESTRICT/i, "hard creator deletion must not silently erase historical planned-shift links");
  assert.doesNotMatch(schema.slice(schema.indexOf("model TeamShift {"), schema.indexOf("model AnalyticsSnapshot {")), /creatorIds\s+Json/i, "creator assignments must stay relational");
  assert.match(schema.slice(schema.indexOf("model TeamShiftCreator {"), schema.indexOf("model AnalyticsSnapshot {")), /creator CreatorAccount\s+@relation\([^\n]+onDelete: Restrict\)/);
});
