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
  assert.match(creator, /telegramUserId\s+String\?/);
  assert.match(creator, /@@index\(\[agencyId, telegramUserId\]\)/);
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
  assert.match(route, /updateCreatorTelegramContact\(\{/);
  assert.match(route, /telegramContact: input\.telegramContact/);
  assert.match(route, /telegramAccountId: input\.telegramAccountId/);
  assert.match(route, /db: prisma/);
  const authority = read("src/services/creator-telegram-contact-authority-service.js");
  assert.match(authority, /lockActiveTelegramAccountReference/);
  assert.match(authority, /CREATOR_TELEGRAM_ACCOUNT_RETIRING/);
  assert.match(authority, /isolationLevel: "Serializable"/);
  assert.match(authority, /contactChanged = existing\.telegramContact !== telegramContact/);
  assert.match(authority, /creator\.telegram_contact\.updated/);
  assert.match(authority, /hadContact/);
  assert.match(authority, /hasContact/);
  assert.doesNotMatch(route, /agencyTelegramMtprotoAccount\.(findFirst|updateMany)/, "route must not pre-read or mutate Telegram account lifecycle outside the authority transaction");
  assert.doesNotMatch(route, /api_hash|apiHash|BotFather|sendMessage|local-material|encryptedPayload|session/i);
});

test("Telegram contact validation stays contact-scoped while allowing an agency Telegram account assignment", () => {
  const source = read("src/routes/creators.js");
  assert.match(source, /telegramContact: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(160\)/);
  assert.match(source, /Invalid Telegram contact/);
  execFileSync(process.execPath, ["--check", path.join(root, "src/routes/creators.js")], { stdio: "pipe" });
});
