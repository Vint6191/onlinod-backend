"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

test("INT5.1A Subscriber Directory canonical chronology uses server scan generation, not Desktop wall clock", () => {
  const source = fs.readFileSync(path.join(__dirname, "subscriber-directory-service.js"), "utf8");
  assert.match(source, /const producerObservedAt = dateOrNull\(chunk\.observedAt\)/);
  assert.match(source, /const observedAt = dateOrNull\(run\.createdAt\) \|\| dateOrNull\(job\.createdAt\)/);
  assert.match(source, /SUBSCRIBER_SCAN_CAUSAL_GENERATION_REQUIRED/);
  assert.match(source, /fanDataObservationTimeBasis:\s*"SERVER_SCAN_GENERATION"/);
  assert.match(source, /producerObservedAt:\s*producerObservedAt\?\.toISOString/);
  assert.doesNotMatch(source, /const observedAt = dateOrNull\(chunk\.observedAt\) \|\| new Date\(\)/);
});

test("INT5.1A direct USER_PROFILE ingress is bound to one delivery lease and target fan", () => {
  const route = read("routes/fan-data.js");
  const actions = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(route, /deliveryId = clean\(req\.body\?\.deliveryId\)/);
  assert.match(route, /leaseToken = clean\(req\.body\?\.leaseToken/);
  assert.match(route, /leaseRevision = Number\(req\.body\?\.leaseRevision\)/);
  assert.match(route, /authorizeActionProfileObservation\(\{/);
  assert.match(route, /sourceDeliveryId:\s*scope\.delivery\.id/);
  assert.match(route, /observedAtPolicy:\s*"SERVER_GENERATION"/);
  assert.match(actions, /FAN_DATA_OBSERVATION_TARGET_SCOPE_MISMATCH/);
  assert.match(actions, /PROFILE_OBSERVATION_ACTION_TYPES/);
  assert.match(actions, /FAN_DATA_OBSERVATION_ACTION_SCOPE_FORBIDDEN/);
  assert.match(actions, /onlyFansUserIds = \[\]/);
  assert.match(actions, /fanIds\.length !== 1 \|\| fanIds\[0\] !== targetId/);
  assert.match(actions, /attemptStartedAt = validDate\(object\(delivery\.result\)\.attemptStartedAt/);
});

test("INT5.1A relationship write completion uses post-effect causal barrier refresh instead of scalar AUTOMATION_WRITE_RESULT time", () => {
  const actions = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  const authority = fs.readFileSync(path.join(__dirname, "fan-data-authority-service.js"), "utf8");
  assert.match(actions, /fanDataReconcileRequired/);
  assert.match(actions, /automation_relationship_effect_reconcile/);
  assert.match(actions, /causalBarrierKey:\s*`automation-effect:\$\{target\.deliveryId\}`/);
  assert.match(authority, /const causalBarrierKey = text\(params\?\.causalBarrierKey/);
  assert.doesNotMatch(actions, /projectFanRelationship\([\s\S]{0,500}AUTOMATION_WRITE_RESULT/);
});
