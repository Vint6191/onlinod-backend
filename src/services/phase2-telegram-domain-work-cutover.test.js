"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
const migration = fs.readFileSync(path.join(ROOT, "prisma", "migrations", "20260910054500_phase2_telegram_domain_work_cutover", "migration.sql"), "utf8");

function functionBlock(name, nextName) {
  const start = scheduler.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = nextName ? scheduler.indexOf(`async function ${nextName}`, start + 1) : -1;
  return scheduler.slice(start, end > start ? end : undefined);
}

test("Telegram live producers publish exact revisioned DomainWork for inbound facts and confirmed receipts", () => {
  assert.match(migration, /"phase2_publish_domain_work"\([\s\S]*'TELEGRAM_INBOUND_PROJECTION'[\s\S]*'TelegramInboundEvent'[\s\S]*NEW\."id"/);
  assert.match(migration, /'TELEGRAM_CONFIRMED_PROJECTION'[\s\S]*'TelegramDeliveryIntent'[\s\S]*NEW\."id"/);
  assert.match(migration, /'TELEGRAM_INBOUND_PROJECTION'[\s\S]*'TelegramDeliveryReceipt'[\s\S]*NEW\."id"/);
  assert.match(migration, /v_confirm_changed BOOLEAN/);
  assert.doesNotMatch(migration, /IF\s+NEW\."state"\s*=\s*'CONFIRMED'\s+OR\s+NEW\."projectionBlockedAt"\s+IS\s+NOT\s+NULL/i,
    "clearing/re-writing projection metadata must not republish current work forever");
});

test("Telegram historical activation is per-agency, bounded, cursor-resumable and separate from migration DDL", () => {
  const confirmed = functionBlock("runTelegramConfirmedCoverageEnumerationUnit", "runTelegramInboundCoverageEnumerationUnit");
  const inbound = functionBlock("runTelegramInboundCoverageEnumerationUnit", "maybeRunPhase2HistoricalEnumeration");
  for (const block of [confirmed, inbound]) {
    assert.match(block, /agencyId:\s*String\(item\.agencyId\)/);
    assert.match(block, /take:\s*100/);
    assert.match(block, /publishDomainWork/);
    assert.match(block, /yieldDomainWorkClaim/);
    assert.match(block, /markPhase2CoverageComplete/);
  }
  assert.match(confirmed, /lastIntentId/);
  assert.match(inbound, /lastInboundEventId/);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+"DomainWorkItem"[\s\S]{0,800}SELECT[\s\S]{0,800}"Telegram(?:DeliveryIntent|InboundEvent)"/i,
    "deployment migration must not globally enumerate Telegram history");
});

test("Phase2 migration chain has no duplicated plpgsql function terminator", () => {
  const migrationsDir = path.join(ROOT, "prisma", "migrations");
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => /^20260910/.test(name))
    .map((name) => path.join(migrationsDir, name, "migration.sql"))
    .filter((file) => fs.existsSync(file));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\$\$\s+LANGUAGE\s+plpgsql(?:\s+[A-Z]+)*;\s*\$\$\s+LANGUAGE\s+plpgsql/i, path.relative(ROOT, file));
    const functions = (source.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION/gi) || []).length;
    const terminators = (source.match(/\$\$\s+LANGUAGE\s+plpgsql(?:\s+[A-Z]+)*;/gi) || []).length;
    assert.equal(terminators, functions, `${path.relative(ROOT, file)} function bodies must each have one plpgsql terminator`);
  }
});
