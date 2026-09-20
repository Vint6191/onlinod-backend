"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("A23 physical proof models operational release activation and serializes shared-schema test files", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  const operationalize = source("scripts/audit/phase3-a20-operationalize-runtime.js");
  const fixture = source("scripts/audit/phase3-postgres-proof-fixture-authority.js");
  const seeded = source("scripts/audit/phase3-a20-seeded-rolling-coverage.js");

  assert.match(runner, /--test-concurrency=1/);
  assert.match(runner, /clean-current-operationalize/);
  assert.match(runner, /rolling-a13-operationalize/);
  assert.match(runner, /seeded-pre-a20-2-operationalize/);
  assert.match(runner, /phase3-a20-operational-runtime\.integration\.test\.js/);
  assert.match(runner, /PHASE3_A20_NODE_PROOF_PASS/);
  assert.match(runner, /PHASE3_A20_POSTGRES_STEP_FAILURE_DIGEST/);
  assert.doesNotMatch(runner, /process\.stdout\.write\(out\.stdout/);

  assert.match(operationalize, /activateTeamControlPlaneAfterDrain/);
  assert.match(operationalize, /A20_RUNTIME_OPERATIONALIZATION_PASS/);
  assert.match(operationalize, /activationState/);
  assert.match(operationalize, /ACTIVE/);

  assert.match(fixture, /assertTeamControlPlaneWriteAdmission/);
  assert.match(fixture, /authorizeCreatorAccountWrite/);
  assert.match(fixture, /db\.\$transaction/);
  assert.match(seeded, /withPhase3PostgresFixtureAuthority/);
});

test("A23 physical proof test-count contract is real, not an external-step offset", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  const proofFiles = [...runner.matchAll(/path\.join\(ROOT, "([^"]+\.integration\.test\.js)"\)/g)].map((match) => match[1]);
  let registered = 0;
  for (const file of proofFiles) {
    const text = source(file);
    registered += text.split(/\r?\n/).filter((line) => /^\s*test\(/.test(line)).length;
  }
  const expected = Number(runner.match(/EXPECTED_PROOF_TEST_COUNT\s*=\s*(\d+)/)?.[1] || 0);
  assert.equal(expected, 40);
  assert.equal(registered, expected);
});

test("A23 physical pack owns its fixtures and has no accidental cross-file bootstrap dependency", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  const proofFiles = [...runner.matchAll(/path\.join\(ROOT, "([^"]+\.integration\.test\.js)"\)/g)].map((match) => match[1]);
  for (const file of proofFiles) {
    const text = source(file);
    if (file.endsWith("phase3-a20-operational-runtime.integration.test.js")) continue;
    assert.doesNotMatch(text, /await\s+db\.agency\.(?:create|update|delete|deleteMany)\(/, `${file} bypasses audit fixture Team generation authority`);
    assert.doesNotMatch(text, /await\s+db\.creatorAccount\.(?:create|update|delete|deleteMany)\(/, `${file} bypasses audit fixture Creator generation authority`);
  }
  const futureDebt = source("src/services/phase3-provider-future-debt-postgres-int5-9a-18.integration.test.js");
  assert.doesNotMatch(futureDebt, /creatorAccount\.findFirst/);
  assert.doesNotMatch(futureDebt, /if\s*\(!creator\)\s*return/);
  assert.match(futureDebt, /withPhase3PostgresFixtureAuthority/);

  const seeded = source("scripts/audit/phase3-a20-seeded-rolling-coverage.js");
  assert.match(seeded, /withPhase3PostgresFixtureAuthority/);
  assert.doesNotMatch(seeded, /await\s+db\.\$executeRawUnsafe\(`INSERT INTO "Agency"/);
  assert.doesNotMatch(seeded, /await\s+db\.\$executeRawUnsafe\(`INSERT INTO "CreatorAccount"/);
});


test("A24 physical proof pins PostgreSQL search_path and attests schema-local triggers/FKs before fixtures", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  const isolation = source("scripts/audit/phase3-a20-schema-isolation.js");
  const fixture = source("scripts/audit/phase3-postgres-proof-fixture-authority.js");

  assert.match(runner, /search_path=\$\{safeSchema\},pg_catalog,public/);
  assert.match(runner, /clean-current-schema-isolation/);
  assert.match(runner, /rolling-current-schema-isolation/);
  assert.match(runner, /seeded-current-schema-isolation/);
  assert.match(isolation, /A20_SCHEMA_ISOLATION_PASS/);
  assert.match(isolation, /Phase2WorkCoverage_agencyId_fkey/);
  assert.match(isolation, /cross-schema foreign keys/);
  assert.match(isolation, /trigger points at a function outside the audit schema/);
  assert.match(isolation, /runtimeFixtureLifecycle/);
  assert.match(runner, /clean-current-fixture-lifecycle/);
  assert.match(isolation, /Agency_phase2_initial_coverage/);
  assert.match(isolation, /current_schema\(\)/);
  assert.match(fixture, /pinPhase3AuditSchema/);
  assert.match(fixture, /set_config\('search_path'/);
  assert.match(fixture, /cleanupPhase3PostgresAgencyFixture/);
});

test("A24 physical integration files use canonical Agency fixture teardown instead of ad-hoc deleteMany", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  const proofFiles = [...runner.matchAll(/path\.join\(ROOT, "([^"]+\.integration\.test\.js)"\)/g)].map((match) => match[1]);
  for (const file of proofFiles) {
    const text = source(file);
    if (!/agency(?:Id|\.create)/.test(text)) continue;
    assert.doesNotMatch(text, /withPhase3PostgresFixtureAuthority\([^)]*=>\s*tx\.agency\.deleteMany/, `${file} has ad-hoc Agency fixture teardown`);
  }
});
