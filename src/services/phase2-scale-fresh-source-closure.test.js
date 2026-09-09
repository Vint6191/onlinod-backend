"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(name) { return fs.readFileSync(path.join(__dirname, name), "utf8"); }

test("production Team analytics cannot fall back to historical materialization", async () => {
  const prismaPath = require.resolve("../prisma");
  const analyticsPath = require.resolve("./team-analytics-service");
  delete require.cache[analyticsPath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: {
      // Production-like signal: raw SQL exists. Aggregate delegates are
      // deliberately incomplete, so the read authority must fail closed.
      async $queryRawUnsafe() { return []; },
      teamMemberActivityDaily: { async aggregate() { return {}; } },
      teamMoneyAttributionFact: {},
      teamResponseCase: { async aggregate() { return {}; } },
      teamDialogSession: { async aggregate() { return {}; } },
    },
  };
  const analytics = require("./team-analytics-service");
  await assert.rejects(
    analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false }),
    (err) => err?.code === "TEAM_ANALYTICS_DATA_UNAVAILABLE" && err?.section === "scale_read_authority"
  );
});

test("all Team summary adapters converge on one snapshot authority", () => {
  const analytics = source("team-analytics-service.js");
  const overviewStart = analytics.indexOf("async function buildTeamOverview");
  const alertsStart = analytics.indexOf("async function buildTeamAlerts");
  const flagsStart = analytics.indexOf("async function buildTeamFlags");
  const exportsStart = analytics.indexOf("module.exports", flagsStart);
  assert.match(analytics.slice(overviewStart, alertsStart), /buildTeamAnalyticsSnapshot/);
  assert.match(analytics.slice(alertsStart, flagsStart), /buildTeamAnalyticsSnapshot/);
  assert.doesNotMatch(analytics.slice(alertsStart, flagsStart), /buildTeamMembers\(/);
  assert.match(analytics.slice(flagsStart, exportsStart), /buildTeamAlerts/);
});

test("production scale read fallback is restricted to reduced doubles", () => {
  const analytics = source("team-analytics-service.js");
  assert.match(analytics, /function isReducedTeamAnalyticsTestDouble\(\)/);
  assert.match(analytics, /typeof prisma\?\.\$queryRawUnsafe !== "function"/);
  assert.match(analytics, /TEAM_ANALYTICS_SCALE_READ_AUTHORITY_REQUIRED/);
});
