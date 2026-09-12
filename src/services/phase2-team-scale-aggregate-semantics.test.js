"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function member() {
  return {
    id: "member-a",
    agencyId: "agency-1",
    userId: "user-a",
    role: "OPERATOR",
    roleKey: "chatter",
    displayName: "Marina",
    assignedCreators: ["creator-1"],
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    deactivatedAt: null,
    deletedAt: null,
    user: { id: "user-a", email: "marina@example.test", name: "Marina" },
    teamFunctions: [{ functionKey: "CHATTER" }],
  };
}

function makePrisma({ queryLog }) {
  const aggregate = async () => ({});
  return {
    agencyMember: {
      async findMany() { return [member()]; },
    },
    teamMemberActivityDaily: { aggregate },
    teamMoneyAttributionFact: { aggregate },
    teamResponseCase: { aggregate },
    teamDialogSession: { aggregate },
    teamProjectionCoverage: {
      async findUnique() {
        return {
          agencyId: "agency-1",
          responseCoverageFrom: new Date("2026-01-01T00:00:00.000Z"),
          dialogCoverageFrom: new Date("2026-01-01T00:00:00.000Z"),
        };
      },
    },
    teamHistoricalAnalyticsCoverage: {
      async findUnique() {
        return {
          agencyId: "agency-1",
          activityCoverageFrom: new Date("2026-01-01T00:00:00.000Z"),
          moneyCoverageFrom: new Date("2026-01-01T00:00:00.000Z"),
          activityProjectionVersion: "team_activity_daily_v1",
          moneyProjectionVersion: "team_money_fact_v1",
          source: "phase2_historical_authority",
        };
      },
    },
    systemSetting: { async findUnique() { return null; } },
    async $queryRawUnsafe(sql) {
      queryLog.push(sql);
      if (/clock_timestamp\(\)/.test(sql)) return [{ authorityNow: new Date("2026-09-09T20:00:00.000Z") }];
      if (/WITH fan_keys AS/.test(sql)) {
        return [{ memberId: "member-a", uniqueFans: 20n, creatorCoverage: 3n }];
      }
      if (/FROM "TeamMemberActivityDaily" d/.test(sql) && /SUM\(d\."messagesSent"\)/.test(sql)) {
        return [{
          memberId: "member-a",
          messagesSent: 11n,
          ppvSentMessages: 2n,
          broadcastDispatches: 1n,
          postsCreated: 2n,
          storiesCreated: 1n,
          contentActions: 3n,
          contentMediaItemsPublished: 7n,
          contentCreatorCoverage: 2n,
          contentActiveDays: 4n,
          lastContentActivityAt: new Date("2026-09-08T12:00:00.000Z"),
        }];
      }
      if (/FROM "TeamActivityEvent" e/.test(sql) && /incomingMessagesLegacy/.test(sql)) {
        return [{ memberId: "member-a", chatOpened: 2n, incomingMessagesLegacy: 1n, engagementReplies: 1n, massMessages: 4n, backlogClearedLegacy: 0n, backlogMaxAgeSecondsLegacy: 0 }];
      }
      if (/FROM "TeamResponseCaseCurrent" r/.test(sql) && /GROUPING SETS/.test(sql)) {
        const row = {
          cases: 8n,
          incomingHandled: 8n,
          freshReplies: 6n,
          backlogReplies: 1n,
          handoffReplies: 1n,
          unknownReplies: 0n,
          responseSamples: 8n,
          avgResponseSeconds: 12,
          medianResponseSeconds: 10,
          p90ResponseSeconds: 30,
          sla5Passes: 6n,
          sla15Passes: 8n,
          coverageResponseAvgSeconds: 9,
          coverageResponseMedianSeconds: 8,
          seenResponseAvgSeconds: 7,
          seenResponseMedianSeconds: 6,
          backlogMaxAgeSeconds: 60n,
        };
        return [{ ...row, isTotal: 0, memberId: "member-a" }, { ...row, isTotal: 1, memberId: null }];
      }
      if (/WITH grouped AS/.test(sql) && /TeamDialogSession/.test(sql)) return [];
      if (/FROM "TeamOperationalPendingCurrent" p/.test(sql) || /FROM "TeamPendingDialogStateCurrent" p/.test(sql)) {
        return [{ isTotal: 1, memberId: null, pendingDialogs: 0n, pendingIncomingMessages: 0n, unassignedDialogs: 0n, seenDialogs: 0n, olderThan15m: 0n, olderThan60m: 0n, oldestPendingAt: null }];
      }
      if (/FROM "TeamMoneyAttributionFact" m/.test(sql) && /GROUPING SETS/.test(sql)) {
        return [
          { memberId: "member-a", sourceType: "PPV", currency: "USD", sourceGrouped: 0, currencyGrouped: 0, factCount: 2n, amountCents: 5000n },
          { memberId: "member-a", sourceType: null, currency: null, sourceGrouped: 1, currencyGrouped: 1, factCount: 2n, amountCents: 5000n },
        ];
      }
      throw new Error(`UNEXPECTED_SQL:${sql.slice(0, 120)}`);
    },
  };
}

function loadAnalytics(prisma) {
  const prismaPath = require.resolve("../prisma");
  const servicePath = require.resolve("./team-analytics-service");
  const retentionPath = require.resolve("./retention-service");
  delete require.cache[servicePath];
  delete require.cache[retentionPath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  return require(servicePath);
}

test("production scale metrics preserve SQL aggregates through metric finalization", async () => {
  const queryLog = [];
  const analytics = loadAnalytics(makePrisma({ queryLog }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "30d", includeMoney: true });
  const metric = payload.members[0].metrics;

  assert.equal(metric.uniqueFans, 20, "audience union count must survive cleanMetric");
  assert.equal(metric.creatorCoverage, 3, "creator union count must survive cleanMetric");
  assert.equal(metric.contentCreatorCoverage, 2);
  assert.equal(metric.contentActiveDays, 4);
  assert.equal(metric.responseSamples, 8);
  assert.equal(metric.avgResponseSeconds, 12);
  assert.equal(metric.medianResponseSeconds, 10);
  assert.equal(metric.p90ResponseSeconds, 30);
  assert.equal(metric.slaReply5mPct, 75);
  assert.equal(metric.slaReply15mPct, 100);
  assert.equal(metric.coverageResponseAvgSeconds, 9);
  assert.equal(metric.coverageResponseMedianSeconds, 8);
  assert.equal(metric.seenResponseAvgSeconds, 7);
  assert.equal(metric.seenResponseMedianSeconds, 6);
});

test("audience coverage uses SQL UNION semantics and money-off never references money facts", async () => {
  const queryLog = [];
  const analytics = loadAnalytics(makePrisma({ queryLog }));
  await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "30d", includeMoney: false });

  const audienceSql = queryLog.find((sql) => /WITH fan_keys AS/.test(sql));
  assert.ok(audienceSql, "audience coverage aggregate must execute");
  assert.match(audienceSql, /\bUNION\b/);
  assert.match(audienceSql, /TeamActivityEvent/);
  assert.match(audienceSql, /TeamMemberActivityDaily/);
  assert.match(audienceSql, /team_v13_provenance/);
  assert.match(audienceSql, /electron_team_v13/);
  assert.doesNotMatch(audienceSql, /TeamMoneyAttributionFact/);
  assert.equal(queryLog.some((sql) => /TeamMoneyAttributionFact/.test(sql)), false, "money OFF must not query money facts anywhere in snapshot");
});


test("all raw Team aggregate lanes preserve the current-telemetry predicate", () => {
  const source = fs.readFileSync(path.join(__dirname, "team-analytics-service.js"), "utf8");
  const activityStart = source.indexOf("async function loadActivitySummarySql");
  const legacyStart = source.indexOf("async function loadLegacyBoundedSummarySql");
  const responseStart = source.indexOf("function responseSelectSql", legacyStart);
  const audienceStart = source.indexOf("async function loadAudienceCoverageSummarySql");
  const applyStart = source.indexOf("function applyResponseAggregate", audienceStart);
  assert.match(source.slice(activityStart, legacyStart), /currentTelemetrySql\("e"\)/);
  assert.match(source.slice(legacyStart, responseStart), /currentTelemetrySql\("e"\)/);
  assert.match(source.slice(audienceStart, applyStart), /currentTelemetrySql\("e"\)/);
});
