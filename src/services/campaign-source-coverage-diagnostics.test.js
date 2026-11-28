"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { campaignDirectoryDiscoveryCapacityState } = require("./provider-capacity-sla-service");
const { evaluateCampaignCollectionState } = require("./campaign-freshness-service");

test("Campaign directory diagnostics require validated source coverage while retaining historical dates", () => {
  const now = new Date("2026-11-28T12:00:00.000Z");
  const state = {
    status: "COMPLETE", baselineVerifiedAt: now, baselineGeneration: "legacy",
    membershipBaselineVerifiedAt: now, membershipBaselineGeneration: "legacy", membershipBaselineSourceValidationVersion: 0,
    campaignDirectoryGeneration: "legacy", campaignDirectoryRevision: 1,
    campaignDirectorySourceValidationVersion: 0, campaignDirectoryRequestedAt: now, campaignDirectoryVerifiedAt: now,
    campaignDirectoryCampaignCount: 2, campaignDirectoryDiscoveryDueAt: new Date(+now + 3600000),
    campaignDirectoryDiscoveryRequestedRevision: 1, campaignDirectoryDiscoveryCompletedRevision: 1,
    campaignDirectoryFactsRevision: 1n, campaignDirectoryCountRevision: 1n,
  };
  const before = structuredClone(state);
  const current = evaluateCampaignCollectionState(state, now);
  assert.equal(current.proven, false); assert.equal(current.directoryDue, true);
  for (const version of [undefined, 0, "1", 2]) {
    const diagnostic = campaignDirectoryDiscoveryCapacityState({ ...state, campaignDirectorySourceValidationVersion: version }, now);
    assert.equal(diagnostic.status, "DUE", `Validator marker ${String(version)} cannot be FRESH`);
    assert.equal(+diagnostic.verifiedAt, +now); assert.equal(+diagnostic.dueAt, +state.campaignDirectoryDiscoveryDueAt);
    assert.equal(diagnostic.estimatedProviderCalls, 2);
  }
  assert.equal(campaignDirectoryDiscoveryCapacityState({ ...state, campaignDirectorySourceValidationVersion: 1 }, now).status, "FRESH");
  assert.equal(campaignDirectoryDiscoveryCapacityState({ ...state, campaignDirectoryDiscoveryRequestedRevision: 2 }, now).status, "REQUESTED");
  assert.equal(campaignDirectoryDiscoveryCapacityState({ ...state, campaignDirectoryDiscoveryDueAt: new Date(+now - 1) }, now).status, "OVERDUE");
  assert.deepEqual(state, before, "Read diagnostics must not rewrite historical evidence");
});
