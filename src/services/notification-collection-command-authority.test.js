"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(name) {
  return fs.readFileSync(path.join(__dirname, name), "utf8");
}

const resultService = read("job-result-service.js");
const teamObservation = read("team-observation-service.js");
const orchestrator = read("creator-analytics-sync-orchestrator.js");
const manualControl = read("notification-scan-control-service.js");
const collectorControl = read("analytics-collector-control-service.js");
const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20261009000000_current_baseline", "migration.sql"), "utf8");
const desktop = fs.readFileSync(path.join(__dirname, "..", "..", "..", "desktop", "apps", "desktop", "electron", "main", "services", "backend-jobs", "handlers", "notifications-catchup-handler.ts"), "utf8");

test("Notifications use the same server-owned collection command envelope as the other current collectors", () => {
  assert.match(collectorControl, /NOTIFICATIONS:\s*"NOTIFICATIONS"/);
  assert.match(orchestrator, /buildCollectionCommand\(\{ collectorType: COLLECTOR_TYPES\.NOTIFICATIONS/);
  assert.match(manualControl, /buildCollectionCommand\(\{ collectorType: COLLECTOR_TYPES\.NOTIFICATIONS/);
  assert.match(desktop, /state\.scanRunId = collectionGeneration/);
  assert.doesNotMatch(desktop, /state\.scanRunId\s*=\s*existingScanRunId\s*\|\|\s*randomUUID\(\)/);
});

test("Notification page and completion generation fences execute before canonical fact ingest", () => {
  const allBranch = resultService.indexOf('chunkResult?.kind === "notification_facts_page_all"');
  const allFence = resultService.indexOf("assertNotificationCollectionResult", allBranch);
  const allWrite = resultService.indexOf("ingestNotificationFacts", allFence);
  assert.ok(allBranch >= 0 && allFence > allBranch && allWrite > allFence, "ALL page must fence generation before fact writes");

  const typedBranch = resultService.indexOf('chunkResult?.kind === "notification_facts_page"');
  const typedFence = resultService.indexOf("assertNotificationCollectionResult", typedBranch);
  const typedWrite = resultService.indexOf("ingestNotificationFacts", typedFence);
  assert.ok(typedBranch >= 0 && typedFence > typedBranch && typedWrite > typedFence, "typed page must fence generation before fact writes");

  const completion = teamObservation.indexOf("async function applyCatchupJobResult");
  const completionFence = teamObservation.indexOf("assertNotificationCollectionResult", completion);
  const completionWrite = teamObservation.indexOf("ingestNotificationFacts", completionFence);
  assert.ok(completion >= 0 && completionFence > completion && completionWrite > completionFence, "completion must fence generation before fact writes");
});


