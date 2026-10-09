"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("TeamActivityEvent v13 provenance columns stay relational and indexed", () => {
  const schema = read("prisma/schema.prisma");
  const model = schema.match(/model TeamActivityEvent \{[\s\S]*?\n\}/)?.[0] || "";
  for (const field of [
    "eventKind", "actionSource", "lifecycle", "dialogId", "messageId",
    "correlationId", "coverageId", "automationDeliveryId", "broadcastDispatchId",
    "priceCents", "currency", "isPpv", "mediaCount",
  ]) assert.match(model, new RegExp(`\\b${field}\\b`), `missing TeamActivityEvent.${field}`);

  for (const index of [
    "@@index([agencyId, eventKind, ts])",
    "@@index([agencyId, actionSource, ts])",
    "@@index([agencyId, messageId])",
    "@@index([agencyId, correlationId])",
    "@@index([agencyId, automationDeliveryId])",
    "@@index([agencyId, broadcastDispatchId])",
  ]) assert.ok(model.includes(index), `missing provenance index ${index}`);
});



test("canonical telemetry keeps human actor separate from automation/system facts", () => {
  const ingest = read("src/services/telemetry-ingest-service.js");
  assert.ok(ingest.includes('const TEAM_V13_VERSION = "team_v13_provenance"'));
  assert.ok(ingest.includes('const TEAM_V13_SOURCE = "electron_team_v13"'));
  assert.match(ingest, /\["AUTOMATION", "CAMPAIGN_QUEUE", "SYSTEM"\]\.includes\(actionSource\)/);
  assert.match(ingest, /const humanActor = requiresHuman && !forbidsHuman \? authenticatedMember : null/);
});

test("Team efficiency denominator is confirmed manual messages, not mass volume", () => {
  const analytics = read("src/services/team-analytics-service.js");
  assert.match(analytics, /metrics\.dollarsPerMessageCents = revenue\.cents !== null && metrics\.messagesSent > 0 \? Math\.round\(revenue\.cents \/ metrics\.messagesSent\)/);
  assert.match(analytics, /out\.dollarsPerMessageCents = out\.revenueAttributedCents !== null && out\.messagesSent > 0 \? Math\.round\(out\.revenueAttributedCents \/ out\.messagesSent\)/);
  assert.doesNotMatch(analytics, /dollarsPerMessageCents\s*=\s*[^;]*\/\s*(?:metric\.|out\.)?totalMessages/);
});





test("Team read models do not silently truncate activity or attribution ledgers", () => {
  const analytics = read("src/services/team-analytics-service.js");
  assert.match(analytics, /async function findAllById\(/);
  assert.match(analytics, /cursor: \{ id: cursorId \}, skip: 1/);
  assert.doesNotMatch(analytics, /take:\s*(?:10000|20000|50000)\b/);
  assert.match(analytics, /findAllById\(prisma\.teamActivityEvent/);
  assert.match(analytics, /findAllById\(prisma\.teamMoneyAttributionFact/);
  assert.match(analytics, /loadActivityDaily/);
  assert.doesNotMatch(analytics, /findAllById\(prisma\.teamPpvPurchaseLedger/);
});




test("response derivation explicitly separates fresh SLA from backlog and handoff", () => {
  const projection = read("src/services/team-response-projection-service.js");
  assert.match(projection, /classification = "FRESH"/);
  assert.match(projection, /classification = "HANDOFF"/);
  assert.match(projection, /classification = "BACKLOG"/);
  assert.match(projection, /const slaEligible = classification === "FRESH"/);
  assert.match(projection, /MAX_OPEN_COVERAGE_MS = 12 \* 60 \* 60 \* 1000/);
});

test("Team analytics reads are capability-gated and money visibility is independent", () => {
  const capabilities = read("src/services/team-capabilities.js");
  const route = read("src/routes/team-analytics.js");
  const analytics = read("src/services/team-analytics-service.js");
  assert.ok(capabilities.includes('VIEW_ANALYTICS: "team.analytics.view"'));
  assert.ok(route.includes('TEAM_CAPABILITIES.VIEW_ANALYTICS'));
  assert.ok(route.includes('TEAM_CAPABILITIES.VIEW_ATTRIBUTION'));
  assert.ok(route.includes('TEAM_ANALYTICS_VIEW_REQUIRED'));
  for (const builder of ["buildTeamAnalyticsSnapshot", "buildTeamOverview", "buildTeamAlerts", "buildTeamFlags"]) {
    assert.match(route, new RegExp(`${builder}\\(\\{[^}]*includeMoney`, "s"));
  }
  assert.match(route, /router\.get\("\/members"[\s\S]*buildTeamAnalyticsSnapshot\(\{[^}]*includeMoney/s);
  assert.match(analytics, /if \(!includeMoney\) \{[\s\S]*metrics\.revenueAttributedCents = null/);
  assert.match(analytics, /overview\.revenueAttributedCents = null/);
});

test("Team analytics creator scope fails closed for scoped members", () => {
  const route = read("src/routes/team-analytics.js");
  const analytics = read("src/services/team-analytics-service.js");
  assert.match(route, /function analyticsCreatorScope\(member\)/);
  assert.match(route, /if \(Array\.isArray\(raw\)\)/);
  assert.match(route, /return \[\];/);
  assert.match(analytics, /function creatorScopeWhere\(allowedCreatorIds\)/);
  assert.ok(analytics.includes('{ creatorId: { in: ids.length ? ids : ["__none__"] } }'));
  assert.match(analytics, /loadProjectedResponseCases\(\{ agencyId, range, allowedCreatorIds/);
  assert.match(analytics, /getPpvLedgerRevenueByMember\(\{ agencyId, range: computed\.range, allowedCreatorIds \}\)/);
});

test("response/session diagnostics are behind Team analytics capability and creator scope", () => {
  const route = read("src/routes/team-analytics.js");
  const service = read("src/services/team-response-read-service.js");
  for (const routeName of ["/responses", "/dialog-sessions", "/coverage-sessions"]) {
    assert.ok(route.includes(`router.get("${routeName}"`));
  }
  assert.match(route, /router\.get\("\/responses"[\s\S]*requireTeamAnalyticsViewer/);
  assert.match(service, /creatorId: \{ in: ids\.length \? ids : \["__none__"\] \}/);
  assert.doesNotMatch(service, /messageText|bodyText|textContent/);
});
