"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function listModel(rows = []) {
  return {
    async findMany(args = {}) {
      const cursorId = args.cursor?.id || null;
      let start = 0;
      if (cursorId) {
        const idx = rows.findIndex((row) => String(row.id) === String(cursorId));
        start = idx >= 0 ? idx + Number(args.skip || 0) : rows.length;
      }
      const take = Number(args.take || rows.length || 1000);
      return rows.slice(start, start + take);
    },
  };
}

function memberRow() {
  return {
    id: "member-a",
    agencyId: "agency-1",
    userId: "user-a",
    role: "OPERATOR",
    roleKey: "chatter",
    displayName: "Marina",
    assignedCreators: ["creator-1"],
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    deletedAt: null,
    user: { id: "user-a", email: "marina@example.test", name: "Marina" },
    teamFunctions: [{ functionKey: "CHATTER" }],
  };
}

function dayStart(input) {
  const d = new Date(input);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function makePrisma({ coverageDaysAgo = 20, rawEvents = [], dailyRows = [], moneyFacts = [] } = {}) {
  const now = new Date();
  const coverage = new Date(now.getTime() - coverageDaysAgo * 86400000);
  const factModel = {
    ...listModel(moneyFacts),
    async groupBy(args = {}) {
      const sourceType = args.where?.sourceType;
      const active = moneyFacts.filter((row) => row.sourceType === sourceType && row.attributionActive === true && row.memberId);
      const byKey = new Map();
      for (const row of active) {
        const key = `${row.memberId}|${row.currency || "USD"}`;
        const prev = byKey.get(key) || { memberId: row.memberId, currency: row.currency || "USD", _sum: { amountCents: 0 } };
        prev._sum.amountCents += Number(row.amountCents || 0);
        byKey.set(key, prev);
      }
      return Array.from(byKey.values());
    },
    async findMany(args = {}) {
      const sourceType = args.where?.sourceType;
      const rows = moneyFacts.filter((row) => !sourceType || row.sourceType === sourceType);
      const cursorId = args.cursor?.id || null;
      if (!cursorId) return rows;
      const idx = rows.findIndex((row) => String(row.id) === String(cursorId));
      return idx >= 0 ? rows.slice(idx + Number(args.skip || 0)) : [];
    },
  };
  return {
    agencyMember: listModel([memberRow()]),
    teamActivityEvent: listModel(rawEvents),
    teamMemberActivityDaily: listModel(dailyRows),
    teamMoneyAttributionFact: factModel,
    teamResponseCase: listModel([]),
    teamDialogSession: listModel([]),
    teamPendingDialogState: listModel([]),
    teamProjectionCoverage: {
      async findUnique() {
        return { agencyId: "agency-1", responseCoverageFrom: coverage, dialogCoverageFrom: coverage };
      },
    },
    teamHistoricalAnalyticsCoverage: {
      async findUnique() {
        return {
          agencyId: "agency-1",
          activityCoverageFrom: coverage,
          moneyCoverageFrom: coverage,
          activityProjectionVersion: "team_activity_daily_v1",
          moneyProjectionVersion: "team_money_fact_v1",
          source: "phase2_historical_authority",
        };
      },
    },
    systemSetting: { async findUnique() { return null; } },
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

test("daily projection owns post-coverage activity exactly once while raw legacy remains causal only", async () => {
  const now = new Date();
  const postCoverage = new Date(now.getTime() - 86400000);
  const daily = [{
    id: "daily-a",
    agencyId: "agency-1",
    memberId: "member-a",
    creatorKey: "creator-1",
    creatorId: "creator-1",
    day: dayStart(postCoverage),
    messagesSent: 1,
    ppvSentMessages: 1,
    broadcastDispatches: 0,
    postsCreated: 0,
    storiesCreated: 0,
    contentActions: 0,
    contentMediaItemsPublished: 0,
  }];
  const raw = [
    {
      id: "canonical-echo",
      agencyId: "agency-1",
      memberId: "member-a",
      creatorId: "creator-1",
      accountId: "creator-1",
      fanId: "fan-1",
      dialogId: "fan-1",
      messageId: "msg-1",
      eventKind: "MESSAGE_SEND_CONFIRMED",
      actionSource: "MANUAL",
      lifecycle: "CONFIRMED",
      isPpv: true,
      source: "electron_team_v13",
      ts: postCoverage,
      extra: { telemetryVersion: "team_v13_provenance" },
    },
    {
      id: "legacy-echo",
      agencyId: "agency-1",
      memberId: "member-a",
      creatorId: "creator-1",
      accountId: "creator-1",
      fanId: "fan-1",
      dialogId: "fan-1",
      type: "chat_message_sent_local",
      source: "electron_team_v12",
      ts: postCoverage,
      extra: { telemetryVersion: "team_v12_actual_backend_ppv_safe", isPpv: true, replySeconds: 30 },
    },
    {
      id: "legacy-ppv-echo",
      agencyId: "agency-1",
      memberId: "member-a",
      creatorId: "creator-1",
      type: "ppv_message_sent_recorded",
      source: "electron_team_v12",
      ts: postCoverage,
      extra: { telemetryVersion: "team_v12_actual_backend_ppv_safe", isPpv: true },
    },
  ];
  const analytics = loadAnalytics(makePrisma({ coverageDaysAgo: 5, rawEvents: raw, dailyRows: daily }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false });
  assert.equal(payload.members[0].metrics.messagesSent, 1);
  assert.equal(payload.members[0].metrics.ppvSentMessages, 1);
  assert.equal(payload.projection.historical.families.manualActivity.status, "PARTIAL");
});

test("hybrid range keeps pre-coverage detail and post-coverage compact facts without treating missing history as zero", async () => {
  const now = new Date();
  const preCoverage = new Date(now.getTime() - 5 * 86400000);
  const postCoverage = new Date(now.getTime() - 86400000);
  const raw = [{
    id: "pre-cutover",
    agencyId: "agency-1",
    memberId: "member-a",
    creatorId: "creator-1",
    accountId: "creator-1",
    eventKind: "MESSAGE_SEND_CONFIRMED",
    actionSource: "MANUAL",
    lifecycle: "CONFIRMED",
    source: "electron_team_v12",
    ts: preCoverage,
    extra: { telemetryVersion: "team_v12_actual_backend_ppv_safe" },
  }];
  const daily = [{
    id: "post-daily",
    agencyId: "agency-1",
    memberId: "member-a",
    creatorKey: "creator-1",
    creatorId: "creator-1",
    day: dayStart(postCoverage),
    messagesSent: 2,
    ppvSentMessages: 0,
    broadcastDispatches: 0,
    postsCreated: 0,
    storiesCreated: 0,
    contentActions: 0,
    contentMediaItemsPublished: 0,
  }];
  const analytics = loadAnalytics(makePrisma({ coverageDaysAgo: 3, rawEvents: raw, dailyRows: daily }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false });
  assert.equal(payload.members[0].metrics.messagesSent, 3);
  assert.equal(payload.projection.historical.families.manualActivity.status, "PARTIAL");
  assert.match(payload.source, /team_historical_authority_v1/);
});

test("long-range member money is read from durable TeamMoneyAttributionFact", async () => {
  const now = new Date();
  const fact = {
    id: "money-1",
    agencyId: "agency-1",
    sourceType: "PPV",
    sourceRowId: "raw-deleted-1",
    externalId: "purchase-1",
    creatorId: "creator-1",
    memberId: "member-a",
    userId: "user-a",
    fanId: "fan-1",
    dialogId: "fan-1",
    amountCents: 5000,
    currency: "USD",
    occurredAt: new Date(now.getTime() - 2 * 86400000),
    businessStatus: "attributed",
    financialStatus: "active",
    attributionActive: true,
  };
  const analytics = loadAnalytics(makePrisma({ coverageDaysAgo: 30, moneyFacts: [fact] }));
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "30d", includeMoney: true });
  const m = payload.members[0].metrics;
  assert.equal(m.ppvSoldMessages, 1);
  assert.equal(m.ppvRevenueCents, 5000);
  assert.equal(m.revenueAttributedCents, 5000);
  assert.equal(m.moneySource, "team_money_fact_v1");
  assert.equal(payload.projection.historical.families.money.status, "FULL");
});
