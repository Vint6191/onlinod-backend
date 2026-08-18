"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("creator Telegram contact is a nullable backend field with an additive migration", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260818223000_creator_telegram_contact/migration.sql");
  const creator = schema.slice(schema.indexOf("model CreatorAccount {"), schema.indexOf("model CreatorConnectSession"));
  assert.match(creator, /telegramContact\s+String\?/);
  assert.match(migration, /ALTER TABLE "CreatorAccount" ADD COLUMN "telegramContact" TEXT/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i);
});

test("Telegram contact write is agency-scoped, management-gated and does not expose future MTProto behavior", () => {
  const source = read("src/routes/creators.js");
  const start = source.indexOf('router.patch("/:id/telegram-contact"');
  const end = source.indexOf('router.patch("/:id"', start + 1);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /creatorManagementRequired, creatorAccessRequired/);
  assert.match(route, /agencyId: req\.auth\.agencyId/);
  assert.match(route, /deletedAt: null/);
  assert.match(route, /telegramContactSchema\.parse\(req\.body\)/);
  assert.match(route, /data: \{ telegramContact: input\.telegramContact \}/);
  assert.match(route, /creator\.telegram_contact\.updated/);
  assert.match(route, /hadContact/);
  assert.match(route, /hasContact/);
  assert.doesNotMatch(route, /api_hash|apiId|MTProto|BotFather|sendMessage|telegramUserId/i);
});

test("Telegram contact validation is deliberately contact-only", () => {
  const source = read("src/routes/creators.js");
  assert.match(source, /telegramContact: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(160\)/);
  assert.match(source, /Invalid Telegram contact/);
  execFileSync(process.execPath, ["--check", path.join(root, "src/routes/creators.js")], { stdio: "pipe" });
});
