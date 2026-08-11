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

test("provenance migration is additive and contains all canonical core columns", () => {
  const sql = read("prisma/migrations/20260811234000_team_activity_provenance_v1/migration.sql");
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN)/i);
  for (const column of [
    "eventKind", "actionSource", "lifecycle", "dialogId", "messageId",
    "correlationId", "coverageId", "automationDeliveryId", "broadcastDispatchId",
    "priceCents", "currency", "isPpv", "mediaCount",
  ]) assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS \"${column}\"`), `migration missing ${column}`);
  assert.ok(sql.includes("TeamActivityEvent_agencyId_correlationId_idx"));
  assert.ok(sql.includes("TeamActivityEvent_agencyId_broadcastDispatchId_idx"));
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
  assert.match(analytics, /metric\.dollarsPerMessageCents = metric\.messagesSent > 0\s*\? Math\.round\(metric\.revenueAttributedCents \/ metric\.messagesSent\)/);
  assert.match(analytics, /out\.dollarsPerMessageCents = out\.messagesSent > 0\s*\? Math\.round\(out\.revenueAttributedCents \/ out\.messagesSent\)/);
  assert.doesNotMatch(analytics, /dollarsPerMessageCents\s*=\s*[^;]*\/\s*(?:metric\.|out\.)?totalMessages/);
});

test("Claims audit separates resolution actor from selected member", () => {
  const schema = read("prisma/schema.prisma");
  const model = schema.match(/model TeamPpvClaimAudit \{[\s\S]*?\n\}/)?.[0] || "";
  for (const field of ["actorMemberId", "selectedMemberId", "action", "reason", "evidence", "purchaseId"]) {
    assert.match(model, new RegExp(`\\b${field}\\b`), `missing TeamPpvClaimAudit.${field}`);
  }
  const sql = read("prisma/migrations/20260811235500_team_claim_audit_v1/migration.sql");
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN)/i);
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS "TeamPpvClaimAudit"'));
  assert.ok(sql.includes('"actorMemberId" TEXT NOT NULL'));
  assert.ok(sql.includes('"selectedMemberId" TEXT'));
});

test("Team performance functions are relational and independent from RBAC role", () => {
  const schema = read("prisma/schema.prisma");
  const model = schema.match(/model TeamMemberFunction \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(model, /functionKey\s+String/);
  assert.ok(model.includes("@@unique([agencyId, memberId, functionKey])"));
  const sql = read("prisma/migrations/20260811235800_team_member_functions_v1/migration.sql");
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN)/i);
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS "TeamMemberFunction"'));
  assert.ok(sql.includes('"functionKey" TEXT NOT NULL'));

  const teamRoute = read("src/routes/team.js");
  assert.ok(teamRoute.includes('router.patch("/members/:memberId/functions"'));
  assert.ok(teamRoute.includes('const TEAM_FUNCTION_KEYS = Object.freeze(["CHATTER", "CONTENT", "SUPERVISOR"])'));
});

test("Team read models do not silently truncate activity or attribution ledgers", () => {
  const analytics = read("src/services/team-analytics-service.js");
  assert.match(analytics, /async function findAllById\(/);
  assert.match(analytics, /cursor: \{ id: cursorId \}, skip: 1/);
  assert.doesNotMatch(analytics, /take:\s*(?:10000|20000|50000)\b/);
  assert.match(analytics, /findAllById\(prisma\.teamActivityEvent/);
  assert.match(analytics, /findAllById\(prisma\.teamPpvPurchaseLedger/);
  assert.match(analytics, /findAllById\(prisma\.teamTipLedger/);
});
