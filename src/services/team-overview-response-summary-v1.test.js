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

const members = [
  { id: "member-a", agencyId: "agency-1", userId: "user-a", role: "OPERATOR", roleKey: "chatter", displayName: "A", assignedCreators: "all", createdAt: new Date("2026-08-01T00:00:00Z"), user: { id: "user-a", name: "A", email: "a@test" }, teamFunctions: [{ functionKey: "CHATTER" }] },
  { id: "member-b", agencyId: "agency-1", userId: "user-b", role: "OPERATOR", roleKey: "chatter", displayName: "B", assignedCreators: "all", createdAt: new Date("2026-08-01T00:01:00Z"), user: { id: "user-b", name: "B", email: "b@test" }, teamFunctions: [{ functionKey: "CHATTER" }] },
];
const responses = [
  { id: "r1", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", dialogId: "d1", replyMessageId: "m1", incomingCount: 1, classification: "FRESH", wallClockSeconds: 60, coverageResponseSeconds: 50, seenResponseSeconds: 40, slaEligible: true, sla5Pass: true, sla15Pass: true, replyAt: new Date("2026-08-12T09:00:00Z") },
  { id: "r2", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", dialogId: "d2", replyMessageId: "m2", incomingCount: 1, classification: "FRESH", wallClockSeconds: 120, coverageResponseSeconds: 110, seenResponseSeconds: 90, slaEligible: true, sla5Pass: true, sla15Pass: true, replyAt: new Date("2026-08-12T09:01:00Z") },
  { id: "r3", agencyId: "agency-1", memberId: "member-b", creatorId: "creator-1", dialogId: "d3", replyMessageId: "m3", incomingCount: 1, classification: "FRESH", wallClockSeconds: 900, coverageResponseSeconds: 800, seenResponseSeconds: 700, slaEligible: true, sla5Pass: false, sla15Pass: true, replyAt: new Date("2026-08-12T09:02:00Z") },
  { id: "r4", agencyId: "agency-1", memberId: "member-b", creatorId: "creator-1", dialogId: "d4", replyMessageId: "m4", incomingCount: 2, classification: "BACKLOG", wallClockSeconds: 21600, coverageResponseSeconds: 120, seenResponseSeconds: 60, slaEligible: false, sla5Pass: null, sla15Pass: null, replyAt: new Date("2026-08-12T09:03:00Z") },
];

const prismaMock = {
  agencyMember: listModel(members),
  teamActivityEvent: listModel([]),
  teamPpvPurchaseLedger: listModel([]),
  teamResponseCase: listModel(responses),
  teamDialogSession: listModel([]),
  teamProjectionCoverage: {
    async findUnique() {
      return {
        agencyId: "agency-1",
        responseCoverageFrom: new Date("2026-08-01T00:00:00Z"),
        dialogCoverageFrom: new Date("2026-08-01T00:00:00Z"),
      };
    },
  },
};
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prismaMock };
const analytics = require("./team-analytics-service");

test("Team overview computes exact median/P90 from response cases instead of aggregating member medians", async () => {
  const payload = await analytics.buildTeamOverview({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false });
  const o = payload.overview;
  assert.equal(o.responseSamples, 3);
  assert.equal(o.freshReplies, 3);
  assert.equal(o.backlogReplies, 1);
  assert.equal(o.incomingMessages, 5);
  assert.equal(o.avgResponseSeconds, 360);
  assert.equal(o.medianResponseSeconds, 120);
  assert.equal(o.p90ResponseSeconds, 900);
  assert.equal(Math.round(o.slaReply5mPct), 67);
  assert.equal(o.slaReply15mPct, 100);
  assert.equal(o.coverageResponseMedianSeconds, 115);
  assert.equal(o.seenResponseMedianSeconds, 75);
  assert.equal(o.unansweredIncomingCount, null);
  assert.equal(payload.projection.unansweredSource, "not_projected");
  assert.equal(payload.responseSummary.source, "team_response_case_v1");
});
