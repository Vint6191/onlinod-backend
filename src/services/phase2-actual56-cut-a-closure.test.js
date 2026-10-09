"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const migration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const conservationMigration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const zeroTransitionMigration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const domainWork = read("src/services/domain-work-authority-service.js");
const settings = read("src/services/settings-service.js");
const scheduler = read("src/services/job-scheduler.js");
const retirementFanout = read("src/services/telegram-account-retirement-fanout-service.js");





test("F56-13 Telegram retirement publishes one durable key and detaches creator bindings in bounded worker batches", () => {
  assert.match(settings, /objectType: "TelegramAccountRetirement"/);
  assert.match(settings, /detachPending: true/);
  assert.doesNotMatch(settings, /creatorAccount\.updateMany\(\{ where: \{ agencyId, telegramAccountId: id \}/);
  assert.match(scheduler, /processTelegramAccountRetirementFanout/);
  assert.match(retirementFanout, /Math\.min\(100, Number\(batchSize\) \|\| 50\)/);
  assert.match(retirementFanout, /take,/);
  assert.match(retirementFanout, /telegramAccountId: accountId/);
  assert.match(retirementFanout, /data: \{ telegramAccountId: null \}/);
  assert.match(retirementFanout, /lifecycleState: "RETIRING"/);
});
