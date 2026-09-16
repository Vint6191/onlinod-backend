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

test("INT5.1A automation result keeps a causal interval instead of inventing scalar effect time", () => {
  const evidence = buildAutomationEffectTimeEvidence(
    { writeCommitAt: commitAt },
    { effectObservedAt: "2026-09-16T10:00:01.000Z" },
    receiptAt,
  );
  assert.equal(evidence.causalLowerAt.toISOString(), commitAt.toISOString());
  assert.equal(evidence.causalUpperAt.toISOString(), receiptAt.toISOString());
  assert.equal(evidence.producerEffectObservedAt.toISOString(), "2026-09-16T10:00:01.000Z");
  assert.equal(evidence.producerTimeAccepted, true);
  assert.equal(evidence.effectTimeBasis, "SERVER_CAUSAL_INTERVAL_RECONCILE");
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, "authorityObservedAt"), false);
});

test("INT5.1A future or pre-permit producer clock remains forensic-only", () => {
  for (const effectObservedAt of ["2099-01-01T00:00:00.000Z", "2026-09-16T09:59:59.000Z"]) {
    const evidence = buildAutomationEffectTimeEvidence({ writeCommitAt: commitAt }, { effectObservedAt }, receiptAt);
    assert.equal(evidence.causalLowerAt.toISOString(), commitAt.toISOString());
    assert.equal(evidence.causalUpperAt.toISOString(), receiptAt.toISOString());
    assert.equal(evidence.producerEffectObservedAt, null);
    assert.equal(evidence.producerTimeAccepted, false);
  }
});

test("INT5.1A settlement result stores interval provenance and requires canonical reconcile", () => {
  const evidence = buildAutomationEffectTimeEvidence(
    { writeCommitAt: commitAt },
    { code: "followed", effectObservedAt: "2026-09-16T10:00:01.000Z" },
    receiptAt,
  );
  const stored = sanitizeAutomationSettlementResult({ code: "followed", effectObservedAt: "2026-09-16T10:00:01.000Z" }, evidence);
  assert.equal(stored.effectObservedAt, undefined);
  assert.equal(stored.effectAuthorityObservedAt, undefined);
  assert.equal(stored.effectCausalLowerAt, commitAt.toISOString());
  assert.equal(stored.effectCausalUpperAt, receiptAt.toISOString());
  assert.equal(stored.producerEffectObservedAt, "2026-09-16T10:00:01.000Z");
  assert.equal(stored.effectTimeBasis, "SERVER_CAUSAL_INTERVAL_RECONCILE");
  assert.equal(stored.fanDataReconcileRequired, true);
});

test("INT5.1A idempotent preflight without write permit does not manufacture effect interval", () => {
  const evidence = buildAutomationEffectTimeEvidence(
    { writeCommitAt: null },
    { code: "already_followed", effectObservedAt: "2026-09-16T10:00:01.000Z" },
    receiptAt,
  );
  assert.equal(evidence, null);
});

test("INT5.1A known relationship write heals FanData through a post-effect causal-barrier refresh", () => {
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /buildAutomationEffectTimeEvidence\(delivery, clientResult, now\)/);
  assert.match(source, /sanitizeAutomationSettlementResult\(clientResult, effectTime\)/);
  assert.match(source, /ensureRelationshipEffectFanRefresh\(finalDelivery\)/);
  assert.match(source, /causalBarrierKey:\s*`automation-effect:\$\{target\.deliveryId\}`/);
  assert.doesNotMatch(source, /projectKnownRelationshipOutcome/);
  assert.doesNotMatch(source, /source:\s*"AUTOMATION_WRITE_RESULT"/);
});
