"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const authority = require("./campaign-source-validation-authority-service");
const membership = require("./campaign-membership-proof-service");
const freshness = require("./campaign-freshness-service");
const now = new Date("2026-11-28T08:00:00.000Z");
const job = extra => ({ jobKey: "fetch_campaigns", status: "SCHEDULED", startedAt: null, continuation: null,
  params: { collectionGeneration: "legacy", collectionRequestedAt: now.toISOString() }, ...extra });

test("only an untouched scheduled legacy generation can acquire the validator without rotation", () => {
  assert.equal(authority.needsRotation(job()), false);
  for (const extra of [{ status: "CLAIMED" }, { startedAt: now }, { continuation: { driverPhase: "execute", jobContinuation: {} } },
    { continuation: { driverPhase: "complete", result: { scanRunId: "legacy" } } }, { result: { scanRunId: "legacy" } }]) {
    assert.equal(authority.needsRotation(job(extra)), true);
  }
  assert.equal(authority.needsRotation({ ...job({ status: "CLAIMED" }), jobKey: "financial_transactions_scan" }), false);
});

test("current params never relabel a partially accepted old checkpoint", () => {
  const current = job({ status: "CLAIMED", params: { ...job().params, sourceValidationVersion: 1 } });
  assert.equal(authority.needsRotation(current), false);
  for (const cursor of [{ collectorVersion: "campaigns-v13" }, { sourceValidationVersion: 2 },
    { driverPhase: "complete", result: { scanRunId: "legacy" } }]) {
    const mixed = { ...current, continuation: { driverPhase: "execute", jobContinuation: cursor } };
    assert.equal(authority.needsRotation(mixed), true);
    assert.throws(() => authority.assertCurrent(mixed, { sourceValidationVersion: 1 }), /SOURCE_VALIDATION_REQUIRED/);
  }
  current.continuation = { driverPhase: "execute", jobContinuation: { sourceValidationVersion: 1 } };
  assert.equal(authority.needsRotation(current), false);
  assert.throws(() => authority.assertCurrent(current, { sourceValidationVersion: "1" }), /SOURCE_VALIDATION_REQUIRED/);
  assert.throws(() => authority.assertCurrent(current, {}), /SOURCE_VALIDATION_REQUIRED/);
  authority.assertCurrent(current, { sourceValidationVersion: 1 });
});

test("directory reuse retains only a command bound to the strict durable directory revision", () => {
  const old = { collectionGeneration: "next", campaignDirectoryReuseVersion: 1,
    campaignDirectoryReuseGeneration: "old", campaignDirectoryReuseRevision: 4, campaignDirectoryReuseCampaignCount: 3 };
  assert.deepEqual(authority.claimParams(old), { collectionGeneration: "next", sourceValidationVersion: 1 });
  assert.equal(old.campaignDirectoryReuseGeneration, "old");
  assert.equal(authority.claimParams({ ...old, campaignDirectoryReuseSourceValidationVersion: 1 }).campaignDirectoryReuseRevision, 4);
});

test("legacy membership remains available while baseline and catchup revisions advance independently", () => {
  const state = { membershipBaselineVerifiedAt: now, membershipBaselineGeneration: "old-full",
    membershipBaselineObservedAt: now, membershipBaselineSourceValidationVersion: 0,
    membershipCatchupVerifiedAt: now, membershipCatchupGeneration: "new-bounded",
    membershipCatchupObservedAt: now, membershipCatchupSourceValidationVersion: 1,
    baselineVerifiedAt: now, baselineGeneration: "old-full" };
  const proof = membership.membershipProofState(state);
  assert.equal(proof.baselineGeneration, null);
  assert.equal(proof.legacyBaselineVerifiedAt, now);
  assert.equal(proof.lastCatchupGeneration, "new-bounded");
  assert.equal(state.baselineGeneration, "old-full");
  const current = membership.membershipProofState({ ...state, ...membership.membershipProofData("full", "new-full", now, now, 1) });
  assert.equal(current.baselineGeneration, "new-full");
  assert.equal(current.lastCatchupGeneration, "new-bounded");
  assert.equal(membership.membershipProofData("full", "adopted-legacy", now, now).membershipBaselineSourceValidationVersion, 0);
});

test("a recent legacy directory is due for validation without rewriting retained source time", () => {
  const state = { campaignDirectoryGeneration: "old", campaignDirectoryRequestedAt: now,
    campaignDirectoryVerifiedAt: now, campaignDirectoryRevision: 2, campaignDirectoryFactsRevision: 2n,
    campaignDirectoryCountRevision: 2n, campaignDirectoryDiscoveryDueAt: new Date(+now + 3600000) };
  assert.equal(freshness.directoryDue(state, now), true);
  assert.equal(freshness.directoryDue({ ...state, campaignDirectorySourceValidationVersion: 1 }, now), false);
  assert.equal(+state.campaignDirectoryVerifiedAt, +now);
});
