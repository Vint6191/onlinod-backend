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
    "services/creator-analytics-permissions.js",
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

test("earnings, campaigns, overview and agency summary are permission guarded", () => {
  for (const route of [
    "/creators/:creatorId/earnings",
    "/creators/:creatorId/campaigns",
    "/creators/:creatorId/overview",
    "/agencies/:agencyId/earnings/summary",
  ]) {
    assert.match(routeBody(stats, "get", route), /requireEarningsPermission\(res, ctx\.member\)/, route);
  }
  assert.match(stats, /raw:\s*sanitizeAnalyticsRaw\(s\.raw\)/);
  assert.match(stats, /raw:\s*sanitizeAnalyticsRaw\(input\.raw\)/);
  assert.match(stats, /const cleanCampaigns = sanitizeCampaigns\(input\.campaigns\)/);
  assert.match(stats, /campaigns:\s*sanitizeCampaigns\(snapshot\.campaigns\)/);
  assert.match(stats, /campaigns:\s*sanitizeCampaigns\(campaigns\.campaigns\)/);
});

test("creator and agency refresh routes are guarded and agency scheduling is bounded", () => {
  assert.match(routeBody(stats, "post", "/creators/:creatorId/refresh"), /requireRefreshPermission\(res, ctx\.member\)/);
  const agency = routeBody(stats, "post", "/agencies/:agencyId/refresh");
  assert.match(agency, /requireRefreshPermission\(res, ctx\.member\)/);
  assert.match(agency, /const batchSize = 20/);
  assert.match(agency, /Promise\.allSettled/);
  assert.doesNotMatch(agency, /for \(const creator of creators\)[\s\S]*await scheduleJobNow/);
});

test("traffic reads and writes stay creator-bound and permission guarded", () => {
  assert.match(trafficService, /if \(!canViewTraffic\(member\)\)/);
  assert.match(trafficService, /if \(!canManageTrafficCosts\(member\)\)/);
  assert.match(trafficService, /if \(!canRefreshTraffic\(member\)\)/);
  assert.match(trafficService, /where:\s*\{ id, agencyId: creator\.agencyId, creatorId: creator\.id \}/);
  assert.match(trafficService, /agencyId: creator\.agencyId,[\s\S]*creatorId: creator\.id,[\s\S]*sourceId: source\.id/);
  assert.match(trafficRoute, /TRAFFIC_VIEW_FORBIDDEN/);
  assert.match(trafficRoute, /TRAFFIC_REFRESH_FORBIDDEN/);
  assert.match(trafficRoute, /INSUFFICIENT_TEAM_ROLE/);
});

test("senior role semantics are shared without loading Prisma", () => {
  assert.match(roleHelper, /HIGH_PRIVILEGE_KEYS/);
  assert.match(roleHelper, /roleKey/);
  assert.match(teamPermissions, /require\("\.\/agency-member-role"\)/);
  assert.doesNotMatch(roleHelper, /prisma|@prisma\/client/);
});
