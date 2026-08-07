"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../prisma" && parent?.filename?.endsWith("creator-analytics-ledger-service.js")) return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { normalizeEarningsRow, normalizeCampaign, normalizeMessageDay } = require("./creator-analytics-ledger-service");
Module._load = originalLoad;

const root = path.join(__dirname, "..", "..");

test("earnings daily keeps unknown categories null instead of inventing zero", () => {
  const row = normalizeEarningsRow({ date: "2026-08-06", totalCents: 1250, currency: "USD", sourceTimezone: "UTC" });
  assert.equal(row.totalCents, 1250);
  assert.equal(row.messagesCents, null);
  assert.equal(row.tipsCents, null);
  assert.equal(normalizeEarningsRow({ date: "2026-02-31", totalCents: 100 }), null);
  assert.equal(normalizeEarningsRow({ date: "2026-08-06", totalCents: -1 }), null);
  assert.equal(normalizeEarningsRow({ date: "2026-08-06", sourceTimezone: "Europe/Kiev", totalCents: 100 }), null);
});

test("campaign normalization preserves unknown counters as null and rejects bad dates", () => {
  const row = normalizeCampaign({ id: "campaign-1", name: "Summer" });
  assert.equal(row.claimersCount, null);
  assert.equal(row.clicksCount, null);
  assert.equal(normalizeCampaign({ id: "campaign-2", name: "Bad", createdAt: "2026-02-31T10:00:00.000Z" }), null);
  assert.equal(normalizeCampaign({ id: "campaign-3", name: "Overflow", clicksCount: 2_147_483_648 }), null);
  assert.equal(normalizeCampaign({ id: "campaign-4", name: "Fraction", claimersCount: 1.5 }), null);
});

test("message day contract proves total equals incoming plus outgoing", () => {
  assert.ok(normalizeMessageDay({ date: "2026-08-06", sourceTimezone: "UTC", incomingMessages: 3, outgoingMessages: 4, totalMessages: 7, uniqueDialogs: 2, uniqueIncomingFans: 2, uniqueOutgoingFans: 2 }));
  assert.equal(normalizeMessageDay({ date: "2026-08-06", sourceTimezone: "UTC", incomingMessages: 3, outgoingMessages: 4, totalMessages: 8, uniqueDialogs: 2, uniqueIncomingFans: 2, uniqueOutgoingFans: 2 }), null);
  assert.equal(normalizeMessageDay({ date: "2026-08-06", sourceTimezone: "Europe/Kiev", incomingMessages: 3, outgoingMessages: 4, totalMessages: 7, uniqueDialogs: 2, uniqueIncomingFans: 2, uniqueOutgoingFans: 2 }), null);
});

test("relational migration is typed, split after enum migration, and keeps message text out", () => {
  const enumSql = fs.readFileSync(path.join(root, "prisma/migrations/20260806170000_creator_analytics_data_types/migration.sql"), "utf8");
  const tableSql = fs.readFileSync(path.join(root, "prisma/migrations/20260806180000_creator_analytics_relational_v1/migration.sql"), "utf8");
  for (const value of ["NOTIFICATION_LIKES", "NOTIFICATION_COMMENTS", "CAMPAIGNS", "MESSAGES_DAILY"]) assert.match(enumSql, new RegExp(value));
  assert.doesNotMatch(tableSql, /ADD VALUE/);
  for (const table of ["CreatorPostLike", "CreatorPostComment", "CreatorEarningsDaily", "CreatorCampaign", "CreatorCampaignFan", "CreatorMessagesDaily"]) assert.match(tableSql, new RegExp(`CREATE TABLE "${table}"`));
  assert.doesNotMatch(tableSql, /messageText|bodyText|contentJson|payloadJson/i);
  assert.match(tableSql, /"messagesCents" INTEGER,/);
  assert.doesNotMatch(tableSql, /"messagesCents" INTEGER NOT NULL/);
  assert.match(tableSql, /"onlyFansLikeId" TEXT/);
  assert.match(tableSql, /CreatorPostLike_creatorId_onlyFansLikeId_key/);
  assert.match(tableSql, /"totalCents" INTEGER NOT NULL,/);
  assert.doesNotMatch(tableSql, /"totalCents" INTEGER NOT NULL DEFAULT/);
});

test("campaign transport is page-oriented and notification engagement is accepted", () => {
  const resultService = fs.readFileSync(path.join(root, "src/services/job-result-service.js"), "utf8");
  assert.match(resultService, /campaigns_page/);
  assert.match(resultService, /campaign_claimers_page/);
  assert.match(resultService, /"likes", "comments"/);
  assert.match(resultService, /legacyUniqueFansKnown/);
  assert.match(resultService, /canWriteLegacySnapshot[\s\S]*legacySalesCountKnown[\s\S]*legacyUniqueFansKnown/);
  assert.match(resultService, /uniqueFans: legacyUniqueFansKnown \? summary\.uniqueFans : null/);
  const ledger = fs.readFileSync(path.join(root, "src/services/creator-analytics-ledger-service.js"), "utf8");
  assert.match(ledger, /Analytics idempotency conflict/);
  assert.match(ledger, /campaigns-v4/);
  assert.match(ledger, /MESSAGES_DAILY/);
  assert.match(ledger, /LOCAL_MESSAGE_HISTORY_INCOMPLETE/);
  const routes = fs.readFileSync(path.join(root, 'src/routes/stats.js'), 'utf8');
  assert.match(routes, /localCoverage/);
  assert.match(routes, /lastSeenAt: \{ gte: freshAfter \}/);
  assert.match(routes, /code: "INVALID_RANGE"/);
  assert.match(routes, /code: "INVALID_CAMPAIGN_ID"/);
  assert.match(routes, /ledger-coverage/);
  assert.match(routes, /buildNotificationScanParams/);
  assert.match(routes, /jobKey: "catchup_notifications_scan"/);
  assert.doesNotMatch(routes, /notificationWindows/);
  assert.doesNotMatch(routes, /backfillWindow/);
  const notificationSync = fs.readFileSync(path.join(root, "src/services/notification-sync-state-service.js"), "utf8");
  assert.match(notificationSync, /notificationMode: "full"/);
  assert.match(notificationSync, /notificationMode: "catchup"/);
  assert.match(notificationSync, /stopAtNotificationId/);
  assert.match(notificationSync, /pageLimit: 10/);
  const liveStart = routes.indexOf('router.post("/creators/:creatorId/notifications/live"');
  const liveEnd = routes.indexOf('router.post("/creators/:creatorId/messages-daily"', liveStart);
  const liveRoute = routes.slice(liveStart, liveEnd);
  assert.ok(liveStart >= 0 && liveEnd > liveStart);
  assert.doesNotMatch(liveRoute, /requireRefreshPermission/);
  assert.match(liveRoute, /workerDevice\.findFirst/);
  assert.match(liveRoute, /deviceCreatorBinding\.findFirst/);
  assert.match(liveRoute, /recordNotificationSocketEvent/);
  assert.match(ledger, /creatorCampaign\.findMany[\s\S]*take: 2000/);
});
