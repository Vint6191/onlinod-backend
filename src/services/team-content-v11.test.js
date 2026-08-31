"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function listModel(rows) {
  return { async findMany(args = {}) {
    let filtered = rows.slice();
    if (args.where?.creatorId?.in) filtered = filtered.filter((row) => args.where.creatorId.in.includes(String(row.creatorId || "")));
    return filtered.slice(0, Number(args.take || filtered.length));
  } };
}

const member = { id: "member-content", agencyId: "agency-1", userId: "user-1", role: "OPERATOR", roleKey: "chatter", displayName: "Producer", assignedCreators: ["creator-1"], createdAt: new Date("2026-08-01T00:00:00Z"), user: { id: "user-1", name: "Producer", email: "p@example.test" }, teamFunctions: [{ functionKey: "CONTENT" }] };
const events = [
  { id: "p1", agencyId: "agency-1", memberId: "member-content", creatorId: "creator-1", accountId: "creator-1", contentId: "post-1", eventKind: "CONTENT_POST_PUBLISHED_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", mediaCount: 2, source: "electron_team_v13", ts: new Date("2026-08-12T09:00:00Z"), extra: { telemetryVersion: "team_v13_provenance" } },
  { id: "s1", agencyId: "agency-1", memberId: "member-content", creatorId: "creator-1", accountId: "creator-1", contentId: "story-1", eventKind: "CONTENT_STORY_PUBLISHED_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", mediaCount: 1, source: "electron_team_v13", ts: new Date("2026-08-12T10:00:00Z"), extra: { telemetryVersion: "team_v13_provenance" } },
  { id: "ignored-source", agencyId: "agency-1", memberId: "member-content", creatorId: "creator-1", accountId: "creator-1", contentId: "post-auto", eventKind: "CONTENT_POST_PUBLISHED_CONFIRMED", actionSource: "AUTOMATION", lifecycle: "CONFIRMED", mediaCount: 5, source: "electron_team_v13", ts: new Date("2026-08-12T11:00:00Z"), extra: { telemetryVersion: "team_v13_provenance" } },
  { id: "ignored-lifecycle", agencyId: "agency-1", memberId: "member-content", creatorId: "creator-1", accountId: "creator-1", contentId: "post-attempt", eventKind: "CONTENT_POST_PUBLISHED_CONFIRMED", actionSource: "MANUAL", lifecycle: "ATTEMPTED", mediaCount: 9, source: "electron_team_v13", ts: new Date("2026-08-12T12:00:00Z"), extra: { telemetryVersion: "team_v13_provenance" } },
];
const prismaMock = {
  agencyMember: listModel([member]),
  teamActivityEvent: listModel(events),
  teamProjectionCoverage: { async findUnique() { return { agencyId: "agency-1", responseCoverageFrom: new Date("2026-08-01T00:00:00Z"), dialogCoverageFrom: new Date("2026-08-01T00:00:00Z") }; } },
  teamPpvPurchaseLedger: listModel([]),
  teamResponseCase: listModel([]),
  teamDialogSession: listModel([]),
};
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prismaMock };
const analytics = require("./team-analytics-service");

test("Content Team counts only confirmed MANUAL publish provenance", async () => {
  const result = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false, allowedCreatorIds: ["creator-1"] });
  const metric = result.members[0].metrics;
  assert.equal(metric.postsCreated, 1);
  assert.equal(metric.storiesCreated, 1);
  assert.equal(metric.contentActions, 2);
  assert.equal(metric.contentMediaItemsPublished, 3);
  assert.equal(metric.contentCreatorCoverage, 1);
  assert.equal(metric.contentActiveDays, 1);
  assert.equal(metric.lastContentActivityAt, "2026-08-12T10:00:00.000Z");
});
