"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FAILURE_CATEGORIES, classifyAutomationFailure, categoryAllowsBlindRetry, automationActionWriteSemantics } = require("./automation-failure-taxonomy");

test("Audit17 backend taxonomy owns unknown-outcome policy from facts, not Desktop category strings", () => {
  assert.equal(classifyAutomationFailure({ failureCode: "comment_result_unknown", deliveryStatus: "COMMITTING" }), FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE);
  assert.equal(classifyAutomationFailure({ failureCode: "send_result_unknown", deliveryStatus: "COMMITTING" }), FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE);
  assert.equal(classifyAutomationFailure({
    failureCode: "future_transport_code",
    deliveryStatus: "COMMITTING",
    endpointSemantics: "NON_IDEMPOTENT_WRITE",
    writeReachedWire: true,
  }), FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE);
});

test("Audit17 idempotent ambiguity and delete verification remain retryable without trusting Desktop retryable", () => {
  for (const failureCode of ["write_outcome_ambiguous", "delete_not_confirmed"]) {
    const category = classifyAutomationFailure({
      failureCode,
      deliveryStatus: "COMMITTING",
      endpointSemantics: "IDEMPOTENT_WRITE",
      writeReachedWire: true,
    });
    assert.equal(category, FAILURE_CATEGORIES.IDEMPOTENT_RETRYABLE, failureCode);
    assert.equal(categoryAllowsBlindRetry(category), true, failureCode);
  }
});

test("Audit17 proven-no-effect is the authoritative safe retry proof", () => {
  const category = classifyAutomationFailure({
    failureCode: "future_unknown_failure",
    deliveryStatus: "RUNNING",
    endpointSemantics: "NON_IDEMPOTENT_WRITE",
    provenNoEffect: true,
  });
  assert.equal(category, FAILURE_CATEGORIES.DEFINITE_NO_WRITE_RETRYABLE);
  assert.equal(categoryAllowsBlindRetry(category), true);
});

test("Audit17 action delivery policy derives semantics from actionType while client hints stay telemetry-only", () => {
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /endpointSemantics = automationActionWriteSemantics\(delivery\.actionType\)/);
  assert.match(source, /reportedEndpointSemantics:\s*inputResult\.endpointSemantics/);
  assert.match(source, /reportedIdempotent:\s*inputResult\.idempotent === true/);
  assert.match(source, /reportedProvenNoEffect:\s*inputResult\.provenNoEffect === true/);
  assert.match(source, /reportedFailureCategory = normalizeFailureCategory\(input\.failureCategory\)/);
  assert.doesNotMatch(source, /failureCategory\s*=\s*reportedFailureCategory/);
});


test("Audit17 backend owns Automation action write semantics", () => {
  assert.equal(automationActionWriteSemantics("SEND_MESSAGE"), "NON_IDEMPOTENT_WRITE");
  assert.equal(automationActionWriteSemantics("SFS_COMMENT_POST"), "NON_IDEMPOTENT_WRITE");
  assert.equal(automationActionWriteSemantics("DELETE_MESSAGE"), "IDEMPOTENT_WRITE");
  assert.equal(automationActionWriteSemantics("FOLLOW_FAN"), "IDEMPOTENT_WRITE");
  assert.equal(automationActionWriteSemantics("future_unknown_action"), "NON_IDEMPOTENT_WRITE");
});
