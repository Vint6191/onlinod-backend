"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(name) {
  return fs.readFileSync(path.join(__dirname, name), "utf8");
}

test("current Analytics read and billing entrypoints resolve PostgreSQL clock authority", () => {
  const home = source("home-summary-service.js");
  const overview = source("creator-overview-service.js");
  const ledger = source("creator-analytics-ledger-service.js");
  const billing = source("billing-wallet-service.js");
  const settings = source("settings-service.js");

  assert.match(home, /const now = await dbAuthorityNow\(\{ db: prisma, fallbackNow: new Date\(\) \}\);/);
  assert.match(overview, /async function readCreatorOverview[\s\S]*?now = await dbAuthorityNow\(\{ db, fallbackNow: now \}\);/);
  assert.match(overview, /async function readCreatorTaskActivityDays[\s\S]*?if \(!authorityResolved\) now = await dbAuthorityNow/);
  assert.match(overview, /async function readCreatorTaskActivity[\s\S]*?if \(!authorityResolved\) now = await dbAuthorityNow/);
  assert.match(ledger, /async function readCreatorCoverage[\s\S]*?if \(!authorityResolved\) now = await dbAuthorityNow/);
  assert.match(ledger, /async function readCreatorLedgerOverview[\s\S]*?if \(!authorityResolved\) now = await dbAuthorityNow/);
  assert.match(ledger, /async function readCampaignFans[\s\S]*?if \(!authorityResolved\) now = await dbAuthorityNow/);
  assert.match(billing, /async function readRolling30dRevenue[\s\S]*?if \(!authorityResolved\) now = await dbAuthorityNow/);
  assert.match(billing, /async function readRolling30dRevenueBatch[\s\S]*?now = await dbAuthorityNow/);
  assert.match(billing, /async function chargeMonthlyPeriod[\s\S]*?now = await dbAuthorityNow\(\{ db: tx, fallbackNow: now \}\);/);
  assert.match(billing, /async function renewDueCreatorSubscriptions[\s\S]*?now = await dbAuthorityNow\(\{ db: client, fallbackNow: now \}\);/);
  assert.match(settings, /async function getBillingSettings[\s\S]*?const now = await dbAuthorityNow\(\{ db: client, fallbackNow: new Date\(\) \}\);/);
});

test("Financial, Campaign and Notification receipt metadata uses PostgreSQL receipt time", () => {
  const financial = source("financial-transactions-service.js");
  const ledger = source("creator-analytics-ledger-service.js");
  const notifications = source("notification-facts-service.js");

  assert.match(financial, /acceptFinancialGeneration[\s\S]*?const now = await dbAuthorityNow\(\{ db: tx, fallbackNow: processReceivedAt \}\);/);
  assert.match(financial, /ingestFinancialChartChunk[\s\S]*?const now = await dbAuthorityNow\(\{ db, fallbackNow: processReceivedAt \}\);/);
  assert.match(ledger, /campaign page receipt uses PostgreSQL time|const serverReceivedAt = await dbAuthorityNow/);
  assert.match(notifications, /const now = await dbAuthorityNow\(\{ db, fallbackNow: new Date\(\) \}\);/);
  assert.doesNotMatch(notifications, /status: "FAILED", completedAt: new Date\(\)/);
});
