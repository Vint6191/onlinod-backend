"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const stats = read("routes/stats.js");
const trafficRoute = read("routes/traffic.js");
const trafficService = read("services/traffic-service.js");
const roleHelper = read("middleware/agency-member-role.js");
const teamPermissions = read("middleware/team-permissions.js");

function routeBody(source, method, route) {
  const marker = `router.${method}("${route}"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${method.toUpperCase()} ${route}`);
  const next = source.indexOf("\nrouter.", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("all changed Creator Analytics backend files pass syntax checks", () => {
  for (const relative of [
    "middleware/agency-member-role.js",
    "middleware/team-permissions.js",
    "services/creator-analytics-sanitize.js",
    "routes/stats.js",
    "services/traffic-service.js",
    "routes/traffic.js",
  ]) {
    const file = path.join(root, relative);
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${relative}: ${result.stderr || result.stdout}`);
  }
});

test("snapshot-era Stats surfaces are explicit 410 tombstones and current overview stays guarded", () => {
  for (const [method, route] of [
    ["post", "/earnings/upsert"],
    ["post", "/campaigns/upsert"],
    ["get", "/creators/:creatorId/earnings"],
    ["get", "/creators/:creatorId/campaigns"],
    ["get", "/creators/:creatorId/overview"],
    ["get", "/agencies/:agencyId/earnings/summary"],
    ["post", "/agencies/:agencyId/refresh"],
    ["post", "/creators/:creatorId/messages-daily"],
  ]) {
    assert.match(routeBody(stats, method, route), /legacyStatsGone/, `${method.toUpperCase()} ${route}`);
  }
  assert.match(stats, /function legacyStatsGone/);
  assert.match(stats, /status\(410\)/);
  assert.match(stats, /ANALYTICS_LEGACY_STATS_RETIRED/);

  const overview = routeBody(stats, "get", "/creators/:creatorId/overview-v2");
  assert.match(overview, /requireEarningsPermission\(res, ctx\.member\)/);
  assert.match(overview, /readCreatorOverview\(/);
  assert.doesNotMatch(overview, /CreatorEarningsSnapshot|creatorEarningsSnapshot|sanitizeAnalyticsRaw/);
});

test("current creator refresh is the sole Stats refresh control plane", () => {
  const creator = routeBody(stats, "post", "/creators/:creatorId/refresh");
  assert.match(creator, /requireRefreshPermission\(res, ctx\.member\)/);
  assert.match(creator, /ensureAnalyticsFreshness\(/);
  assert.match(creator, /reason: "INTERACTIVE_REFRESH"/);
  assert.match(creator, /ensureRecurringCreatorAnalyticsCatchups\(/);
  assert.match(creator, /scheduleSubscriberScan\(/);
  assert.doesNotMatch(creator, /jobKey: "fetch_earnings"/);
  assert.doesNotMatch(creator, /TRACKED_RANGES/);
  assert.match(routeBody(stats, "post", "/agencies/:agencyId/refresh"), /legacyStatsGone/);
});

test("every live creator-scoped Stats route resolves current creator access before business work", () => {
  const liveRoutes = [
    ["post", "/creators/:creatorId/refresh"],
    ["get", "/creators/:creatorId/overview-v2"],
    ["get", "/creators/:creatorId/current-task"],
    ["get", "/creators/:creatorId/task-activity"],
    ["get", "/creators/:creatorId/campaigns/:campaignId/fans"],
    ["get", "/creators/:creatorId/notification-scan"],
    ["post", "/creators/:creatorId/notification-scan/start"],
    ["post", "/creators/:creatorId/notification-scan/stop"],
    ["get", "/creators/:creatorId/financial-transaction-scan"],
    ["post", "/creators/:creatorId/financial-transaction-scan/start"],
    ["post", "/creators/:creatorId/financial-transaction-scan/stop"],
    ["get", "/creators/:creatorId/campaign-scan"],
    ["post", "/creators/:creatorId/campaign-scan/start"],
    ["post", "/creators/:creatorId/campaign-scan/stop"],
    ["post", "/creators/:creatorId/notifications/live"],
  ];
  for (const [method, route] of liveRoutes) {
    const body = routeBody(stats, method, route);
    assert.match(body, /loadCreatorWithAccess\(/, `${method.toUpperCase()} ${route}`);
  }
  assert.match(routeBody(stats, "post", "/creators/:creatorId/notifications/live"), /requireAuthDevice\(/);
  assert.match(routeBody(stats, "post", "/creators/:creatorId/messages-daily"), /legacyStatsGone/);
});

test("traffic reads and writes stay creator-bound and permission guarded", () => {
  assert.match(trafficService, /requireCreatorAccess\(\{ agencyId: creator\.agencyId, member, creatorId: creator\.id, db: prisma \}\)/);
  assert.match(trafficService, /resolveEffectivePermissions\(\{ member, db: prisma \}\)/);
  assert.match(trafficService, /key: "traffic\.view"/);
  assert.match(trafficService, /key: "traffic\.manage_costs"/);
  assert.match(trafficService, /key: "traffic\.refresh"/);
  assert.match(trafficService, /id:\s*cleanSourceId/);
  assert.match(trafficService, /agencyId:\s*creator\.agencyId,[\s\S]*creatorId:\s*creator\.id/);
  assert.match(trafficService, /agencyId: creator\.agencyId,[\s\S]*creatorId: creator\.id,[\s\S]*sourceId: source\.id/);
  assert.match(trafficRoute, /requireProductCreator/);
  assert.match(trafficRoute, /requireProductDevice/);
  assert.match(trafficRoute, /TRAFFIC_VIEW_FORBIDDEN/);
  assert.match(trafficRoute, /TRAFFIC_REFRESH_FORBIDDEN/);
  assert.doesNotMatch(trafficService, /creator-analytics-permissions/);
});

test("senior role semantics are shared without loading Prisma", () => {
  assert.match(roleHelper, /HIGH_PRIVILEGE_KEYS/);
  assert.match(roleHelper, /roleKey/);
  assert.match(teamPermissions, /require\("\.\/agency-member-role"\)/);
  assert.doesNotMatch(roleHelper, /prisma|@prisma\/client/);
});


test("Analytics product range subsets share the canonical range authority and reject silent fallback", () => {
  const ranges = require("./analytics-range-contract");
  assert.equal(ranges.normalizeCreatorOverviewRangeKey("30d"), "30d");
  assert.equal(ranges.normalizeHomeRangeKey("24h"), "today");
  assert.throws(() => ranges.normalizeCreatorOverviewRangeKey("today"), /CREATOR_OVERVIEW_RANGE_UNSUPPORTED/);
  assert.throws(() => ranges.normalizeHomeRangeKey("365d"), /HOME_RANGE_UNSUPPORTED/);
  assert.throws(() => ranges.normalizeCreatorOverviewRangeKey("garbage"), /ANALYTICS_RANGE_INVALID/);
  const refreshBody = routeBody(stats, "post", "/creators/:creatorId/refresh");
  assert.match(refreshBody, /normalizeCreatorOverviewRangeKey/);
  assert.match(refreshBody, /INVALID_OVERVIEW_RANGE/);
});
