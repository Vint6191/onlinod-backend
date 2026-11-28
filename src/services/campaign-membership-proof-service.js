"use strict";

const { trustedCollectionTimestamp } = require("./analytics-freshness-policy");
const { VERSION } = require("./campaign-source-validation-authority-service");

// Historical facts and proofs remain available during rollout. Only a proof
// produced by the current source validator can authorize current completeness.
function membershipProofState(state) {
  const baseline = Boolean(state?.membershipBaselineVerifiedAt && state?.membershipBaselineGeneration
    && state.membershipBaselineSourceValidationVersion === VERSION);
  const catchup = Boolean(state?.membershipCatchupVerifiedAt && state?.membershipCatchupGeneration
    && state.membershipCatchupSourceValidationVersion === VERSION);
  return { ...state,
    baselineVerifiedAt: baseline ? state.membershipBaselineVerifiedAt : null,
    baselineObservedAt: baseline ? state.membershipBaselineObservedAt : null,
    baselineGeneration: baseline ? state.membershipBaselineGeneration : null,
    lastCatchupCompletedAt: catchup ? state.membershipCatchupVerifiedAt : null,
    lastCatchupObservedAt: catchup ? state.membershipCatchupObservedAt : null,
    lastCatchupGeneration: catchup ? state.membershipCatchupGeneration : null,
    legacyBaselineVerifiedAt: baseline ? null : state?.membershipBaselineVerifiedAt || state?.baselineVerifiedAt || null,
    legacyCatchupVerifiedAt: catchup ? null : state?.membershipCatchupVerifiedAt || state?.lastCatchupCompletedAt || null,
  };
}

function membershipProofData(mode, generation, verifiedAt, observedAt, sourceValidationVersion = 0) {
  return mode === "full"
    ? { membershipBaselineVerifiedAt: verifiedAt, membershipBaselineObservedAt: observedAt, membershipBaselineGeneration: generation,
      membershipBaselineSourceValidationVersion: sourceValidationVersion === VERSION ? VERSION : 0 }
    : { membershipCatchupVerifiedAt: verifiedAt, membershipCatchupObservedAt: observedAt, membershipCatchupGeneration: generation,
      membershipCatchupSourceValidationVersion: sourceValidationVersion === VERSION ? VERSION : 0 };
}

// Persist only while holding the creator collector lock. Read-only readiness
// may derive the same immutable evidence without acquiring a write lock. Adopt one already
// published generation lazily; never scan historical Work or replay provider
// history just because the old combined baseline waited for a failed fan.
async function recoverPublishedMembershipProof({ db, state, now, persist = true }) {
  if (!state || !state.activeGeneration || !state.sourceJobId || !["full", "catchup"].includes(state.mode)
      || state.membershipCoverageStatus !== "COMPLETE"
      || !trustedCollectionTimestamp(state.membershipCoverageCompletedAt, now)) return state;
  const existing = state.mode === "full" ? state.membershipBaselineVerifiedAt : state.membershipCatchupVerifiedAt;
  if (existing || typeof db.analyticsPublication?.findFirst !== "function") return state;
  const published = await db.analyticsPublication.findFirst({
    where: { jobId: state.sourceJobId, agencyId: state.agencyId, creatorId: state.creatorId,
      state: "COMMITTED", payload: { path: ["scanRunId"], equals: state.activeGeneration },
      job: { status: "DONE", jobKey: "fetch_campaigns", agencyId: state.agencyId, creatorId: state.creatorId } },
    orderBy: { leaseRevision: "desc" }, select: { id: true, payload: true },
  });
  if (!published) return state;
  const data = membershipProofData(state.mode, state.activeGeneration, state.membershipCoverageCompletedAt,
    state.membershipObservedAt || null, published.payload?.sourceValidationVersion);
  if (!persist) return { ...state, ...data };
  return db.creatorCampaignCollectionState.update({ where: { creatorId: state.creatorId }, data });
}

module.exports = { membershipProofState, membershipProofData, recoverPublishedMembershipProof };
