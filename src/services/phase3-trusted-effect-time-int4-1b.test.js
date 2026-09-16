"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildAutomationEffectTimeEvidence,
  sanitizeAutomationSettlementResult,
} = require("./automation-effect-time-service");

const commitAt = new Date("2026-09-16T10:00:00.000Z");
const receiptAt = new Date("2026-09-16T10:01:00.000Z");

test("INT4.1B canonical automation result chronology is server commit time, not delayed settlement", () => {
  const evidence = buildAutomationEffectTimeEvidence(
    { writeCommitAt: commitAt },
    { effectObservedAt: "2026-09-16T10:00:01.000Z" },
    receiptAt,
  );
  assert.equal(evidence.authorityObservedAt.toISOString(), commitAt.toISOString());
  assert.equal(evidence.settlementReceivedAt.toISOString(), receiptAt.toISOString());
  assert.equal(evidence.producerEffectObservedAt.toISOString(), "2026-09-16T10:00:01.000Z");
  assert.equal(evidence.producerTimeAccepted, true);
  assert.equal(evidence.effectTimeBasis, "SERVER_WRITE_COMMIT_LOWER_BOUND");
});

test("INT4.1B future or pre-permit producer clock cannot own canonical chronology", () => {
  for (const effectObservedAt of ["2099-01-01T00:00:00.000Z", "2026-09-16T09:59:59.000Z"]) {
    const evidence = buildAutomationEffectTimeEvidence({ writeCommitAt: commitAt }, { effectObservedAt }, receiptAt);
    assert.equal(evidence.authorityObservedAt.toISOString(), commitAt.toISOString());
    assert.equal(evidence.producerEffectObservedAt, null);
    assert.equal(evidence.producerTimeAccepted, false);
  }
});

test("INT4.1B settlement result strips raw producer time and stores explicit temporal provenance", () => {
  const evidence = buildAutomationEffectTimeEvidence(
    { writeCommitAt: commitAt },
    { code: "followed", effectObservedAt: "2026-09-16T10:00:01.000Z" },
    receiptAt,
  );
  const stored = sanitizeAutomationSettlementResult({ code: "followed", effectObservedAt: "2026-09-16T10:00:01.000Z" }, evidence);
  assert.equal(stored.effectObservedAt, undefined);
  assert.equal(stored.effectAuthorityObservedAt, commitAt.toISOString());
  assert.equal(stored.producerEffectObservedAt, "2026-09-16T10:00:01.000Z");
  assert.equal(stored.settlementReceivedAt, receiptAt.toISOString());
  assert.equal(stored.effectTimeBasis, "SERVER_WRITE_COMMIT_LOWER_BOUND");
});

test("INT4.1B idempotent preflight without write permit does not manufacture AUTOMATION_WRITE_RESULT time", () => {
  const evidence = buildAutomationEffectTimeEvidence(
    { writeCommitAt: null },
    { code: "already_followed", effectObservedAt: "2026-09-16T10:00:01.000Z" },
    receiptAt,
  );
  assert.equal(evidence, null);
});

test("INT4.1B relationship projector consumes trusted effect authority time rather than settlement now", () => {
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /buildAutomationEffectTimeEvidence\(delivery, clientResult, now\)/);
  assert.match(source, /sanitizeAutomationSettlementResult\(clientResult, effectTime\)/);
  assert.match(source, /projectKnownRelationshipOutcome\(\{ db: tx, delivery: current, effectTime, outcomeCode \}\)/);
  assert.match(source, /observedAt:\s*effectTime\.authorityObservedAt/);
  assert.doesNotMatch(source, /projectFanRelationship\([\s\S]{0,400}observedAt:\s*now[\s\S]{0,160}AUTOMATION_WRITE_RESULT/);
});
