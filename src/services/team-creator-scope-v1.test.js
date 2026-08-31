"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function listModel(rows) {
  return {
    async findMany(args = {}) {
      let filtered = rows.slice();
      const creatorFilter = args.where?.creatorId?.in;
      if (Array.isArray(creatorFilter)) filtered = filtered.filter((row) => creatorFilter.includes(String(row.creatorId || "")));
      const cursorId = args.cursor?.id || null;
      let start = 0;
      if (cursorId) {
        const idx = filtered.findIndex((row) => row.id === cursorId);
        start = idx >= 0 ? idx + Number(args.skip || 0) : 0;
      }
      return filtered.slice(start, start + Number(args.take || filtered.length));
    },
  };
}

const member = {
  id: "member-a", agencyId: "agency-1", userId: "user-a", role: "OPERATOR", roleKey: "supervisor",
  displayName: "Scoped supervisor", assignedCreators: ["creator-1"], createdAt: new Date("2026-08-01T00:00:00Z"),
  user: { id: "user-a", email: "scope@example.test", name: "Scoped" }, teamFunctions: [{ functionKey: "SUPERVISOR" }],
};
const events = [
  { id: "e1", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", accountId: "creator-1", fanId: "fan-1", dialogId: "fan-1", messageId: "m1", eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", source: "electron_team_v13", ts: new Date("2026-08-12T09:00:00Z"), extra: { telemetryVersion: "team_v13_provenance" } },
  { id: "e2", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-2", accountId: "creator-2", fanId: "fan-2", dialogId: "fan-2", messageId: "m2", eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", source: "electron_team_v13", ts: new Date("2026-08-12T09:01:00Z"), extra: { telemetryVersion: "team_v13_provenance" } },
];
const responses = [
  { id: "r1", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", dialogId: "fan-1", replyMessageId: "m1", incomingCount: 1, classification: "FRESH", wallClockSeconds: 60, coverageResponseSeconds: 60, seenResponseSeconds: 30, slaEligible: true, sla5Pass: true, sla15Pass: true, replyAt: new Date("2026-08-12T09:00:00Z") },
  { id: "r2", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-2", dialogId: "fan-2", replyMessageId: "m2", incomingCount: 1, classification: "FRESH", wallClockSeconds: 900, coverageResponseSeconds: 900, seenResponseSeconds: 800, slaEligible: true, sla5Pass: false, sla15Pass: true, replyAt: new Date("2026-08-12T09:01:00Z") },
];
const prismaMock = {
  agencyMember: listModel([member]),
  teamActivityEvent: listModel(events),
  teamPpvPurchaseLedger: listModel([]),
  teamResponseCase: listModel(responses),
  teamDialogSession: listModel([]),
  teamProjectionCoverage: {
    async findUnique() {
      return { agencyId: "agency-1", responseCoverageFrom: new Date("2026-08-01T00:00:00Z"), dialogCoverageFrom: new Date("2026-08-01T00:00:00Z") };
    },
  },
};
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prismaMock };
const analytics = require("./team-analytics-service");

test("scoped Team viewer read model excludes events and response cases from unassigned creators", async () => {
  const scoped = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false, allowedCreatorIds: ["creator-1"] });
  const metric = scoped.members[0].metrics;
  assert.equal(metric.messagesSent, 1);
  assert.equal(metric.responseSamples, 1);
  assert.equal(metric.avgResponseSeconds, 60);
  assert.deepEqual(scoped.projection.creatorScope, ["creator-1"]);
});

test("empty creator scope fails closed instead of becoming all creators", async () => {
  const scoped = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false, allowedCreatorIds: [] });
  const metric = scoped.members[0].metrics;
  assert.equal(metric.messagesSent, 0);
  assert.equal(metric.responseSamples, 0);
  assert.deepEqual(scoped.projection.creatorScope, []);
});
