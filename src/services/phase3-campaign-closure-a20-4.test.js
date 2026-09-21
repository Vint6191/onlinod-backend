"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");

test("A20.4 PostgreSQL proof covers the fresh-audit missing real-DB cases", () => {
  const integration = fs.readFileSync(path.join(__dirname, "phase3-campaign-closure-a20-4.integration.test.js"), "utf8");
  const audit = fs.readFileSync(path.join(ROOT, "scripts/audit/phase3-a20-postgres-proof.js"), "utf8");
  assert.match(integration, /current canonical generation heals AVAILABLE\/UNAVAILABLE while superseded work stays historical-only/);
  assert.match(integration, /current-generation counter mismatch rolls back demand\/work healing/);
  assert.match(integration, /one real raw SQL round trip for 1\/20\/500 rows and records timing/);
  assert.match(integration, /CAMPAIGN_FAN_REFRESH_RECOVERY_COVERAGE_TRANSITION_LOST/);
  assert.match(integration, /workTransitioned, 4/);
  assert.match(integration, /counter\.businessQueryRaw, 1/);
  assert.match(audit, /phase3-campaign-closure-a20-4\.integration\.test\.js/);
  assert.match(integration, /syncExecuteRaw/);
});
