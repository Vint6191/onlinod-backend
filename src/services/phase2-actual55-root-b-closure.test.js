"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

function read(name) { return fs.readFileSync(path.join(__dirname, name), "utf8"); }

test("F55-03 recovery seen boundaries include canonical event-id order", () => {
  const pending = read("team-pending-projection-service.js");
  const response = read("team-response-projection-service.js");
  assert.match(pending, /afterEventId/);
  assert.match(pending, /e\."ts"=\$4[\s\S]*e\."id">\$5/);
  assert.match(response, /incomingEventId/);
  assert.match(response, /id: \{ gt: lowerId \}/);
  assert.match(response, /id: \{ lt: upperId \}/);
});

test("F55-03 modern reply chronology uses telemetryEventId and never ledger id at the same instant", () => {
  const response = read("team-response-projection-service.js");
  assert.match(response, /telemetryEventId: \{ lt: eventId \}/);
  assert.match(response, /telemetryEventId: \{ gt: eventId \}/);
  assert.doesNotMatch(response, /sameInstantClause = stableLedgerId/);
  assert.doesNotMatch(response, /const sameInstant = stableId \? \{ sentAt, id:/);
});

test("INT5 F55-03 mixed same-time reply clusters fail closed even for a strictly earlier incoming episode", () => {
  const response = fs.readFileSync(path.join(__dirname, "team-response-projection-service.js"), "utf8");
  assert.match(response, /findSameTimeReplyPeers/);
  assert.match(response, /findIncomingAffectedByUnorderedSameTimeReplies/);
  assert.match(response, /for \(const peer of sameTimeReplyPeers\)/);
});

test("F55-04 only Team pending repair opts into preserving progress across newer revisions", () => {
  const scheduler = read("job-scheduler.js");
  const domain = read("domain-work-authority-service.js");
  assert.match(domain, /preserveProgressOnNewerRevision = false/);
  assert.match(domain, /preserveProgressOnNewerRevision === true/);
  const matches = scheduler.match(/preserveProgressOnNewerRevision/g) || [];
  assert.equal(matches.length, 1);
  assert.match(scheduler, /Boolean\(nextProgressCursor\?\.pendingRepair\)/);
});

test("Root B migration adds physical modern reply temporal-order index", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911150000_phase2_actual55_root_b_temporal_repair", "migration.sql"), "utf8");
  assert.match(migration, /TeamSentMessageLedger_temporal_order_v3_idx/);
  assert.match(migration, /"sentAt","telemetryEventId","id"/);
});


test("F55-04 DB publisher preserves only pendingRepair cursor for TEAM_DIALOG_PROJECTION", () => {
  const domain = read("domain-work-authority-service.js");
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911150000_phase2_actual55_root_b_temporal_repair", "migration.sql"), "utf8");
  for (const source of [domain, migration]) {
    assert.match(source, /TEAM_DIALOG_PROJECTION/);
    assert.match(source, /pendingRepair/);
    assert.match(source, /progressCursor/);
  }
});
