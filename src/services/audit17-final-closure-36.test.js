"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("Audit17 final: programmatic kind registry owns non-idempotent BUSINESS_COMMIT semantics", () => {
  const source = read("services/programmatic-of-write-authority-service.js");
  for (const kind of ["MASS_QUEUE_CREATE", "VAULT_RELAY_SEND", "VAULT_CREATE_LIST", "CUSTOM_RELAY_SEND"]) {
    const start = source.indexOf(`${kind}: Object.freeze({`);
    assert.ok(start >= 0, kind);
    const block = source.slice(start, start + 700);
    assert.match(block, /writeSemantics:\s*"NON_IDEMPOTENT_WRITE"/);
    assert.match(block, /commitClass:\s*"BUSINESS_COMMIT"/);
  }
  assert.match(source, /reportedEndpointSemantics/);
  assert.match(source, /const reachedWire = delivery\.status === "COMMITTING" \|\| Boolean\(delivery\.writeCommitAt\)/);
});

test("Audit17 final: Automation policy derives semantics from actionType and preserves anchored send no-effect proof only", () => {
  const source = read("services/automation-action-delivery-service.js");
  assert.match(source, /endpointSemantics = automationActionWriteSemantics\(delivery\.actionType\)/);
  assert.match(source, /actionSpecificNoEffectProof[\s\S]*delivery\.actionType === "SEND_MESSAGE"[\s\S]*failureCode === "send_reconcile_no_effect"[\s\S]*readbackCovered === true/);
  assert.match(source, /reportedEndpointSemantics/);
  assert.match(source, /reportedIdempotent/);
  assert.match(source, /reportedProvenNoEffect/);
});

test("Audit17 final: both origins have bounded stranded reconciliation maintenance", () => {
  const programmatic = read("services/programmatic-of-write-authority-service.js");
  const automation = read("services/automation-action-delivery-service.js");
  assert.match(programmatic, /status:\s*"RECONCILE_REQUIRED", claimUntil:\s*null/);
  assert.match(programmatic, /MAINTENANCE_RECONCILIATION_WINDOW_EXPIRED/);
  assert.match(automation, /status:\s*"RECONCILE_REQUIRED", claimUntil:\s*null/);
  assert.match(automation, /MAINTENANCE_RECONCILIATION_WINDOW_EXPIRED/);
  assert.match(automation, /reconciliationStartedAt:\s*object\(delivery\.result\)\.reconciliationStartedAt \|\| delivery\.writeCommitAt/);
});

test("Audit17 final: interactive lease maintenance is scoped to current agency and creators", () => {
  const programmatic = read("services/programmatic-of-write-authority-service.js");
  const automation = read("services/automation-action-delivery-service.js");
  assert.match(programmatic, /sweepExpiredAutomationLeases\(\{ now, agencyId, creatorIds: \[creatorId\] \}\)/);
  assert.match(automation, /sweepExpiredActionLeases\(\{ now: new Date\(\), agencyId: device\.agencyId, creatorIds \}\)/);
  assert.match(automation, /sweepExpiredProgrammaticWriteLeases\(\{ now, agencyId: options\.agencyId, creatorIds: options\.creatorIds \}\)/);
});

test("Audit17 final: mounted Automation overview is origin-isolated", () => {
  const source = read("services/follow-back-service.js");
  const start = source.indexOf("async function getAutomationOverview");
  assert.ok(start >= 0);
  const block = source.slice(start, start + 1000);
  assert.match(block, /automationDelivery\.groupBy\([\s\S]*where:\s*\{ agencyId, creatorId, originKind:\s*"AUTOMATION" \}/);
});

test("Audit17 final: manual Custom unresolved resolution requires review permission at service boundary", () => {
  const source = read("services/custom-content-submissions-service.js");
  for (const fn of ["closeCustomContentSubmissionRelayWriteUnresolved", "resolveCustomContentSubmissionRelayWriteMatched"]) {
    const start = source.indexOf(`async function ${fn}`);
    assert.ok(start >= 0, fn);
    const block = source.slice(start, start + 2600);
    assert.match(block, /canUsePermission\(\{ member, key:\s*"content\.review_customs"/);
    assert.match(block, /CUSTOM_SUBMISSION_MANUAL_RESOLUTION_FORBIDDEN/);
  }
});


test("Audit17 final: Automation planners explicitly mint AUTOMATION rows and guard idempotency adoption", () => {
  const files = [
    "services/bump-service.js",
    "services/follow-back-service.js",
    "services/follow-automation-service.js",
    "services/likes-service.js",
    "services/sfs-service.js",
  ];
  for (const relative of files) {
    const source = read(relative);
    let cursor = 0;
    while ((cursor = source.indexOf("automationDelivery.create({", cursor)) >= 0) {
      const block = source.slice(cursor, cursor + 1100);
      assert.match(block, /originKind:\s*"AUTOMATION"/, relative);
      cursor += 1;
    }
    const idempotencyLookups = [...source.matchAll(/automationDelivery\.findUnique\(\{\s*where:\s*\{\s*idempotencyKey(?:\s*:\s*[^}]+)?\s*\}\s*\}\)/g)];
    for (const match of idempotencyLookups) {
      const before = source.slice(Math.max(0, match.index - 180), match.index);
      assert.match(before, /assertAutomationDeliveryAdoption\(/, `${relative}: idempotency adoption must be guarded`);
    }
  }
});
