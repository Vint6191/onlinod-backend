"use strict";

const { trustedCollectionTimestamp } = require("./analytics-freshness-policy");

// Membership proof and FanData receipts have independent lifetimes. Retain the
// old combined fields for compatibility; a combined proof also proves membership.
function membershipProofState(state) {
  const baseline = Boolean(state?.membershipBaselineVerifiedAt && state?.membershipBaselineGeneration);
  const catchup = Boolean(state?.membershipCatchupVerifiedAt && state?.membershipCatchupGeneration);
  return { ...state,
    baselineVerifiedAt: baseline ? state.membershipBaselineVerifiedAt : state?.baselineVerifiedAt,
    baselineObservedAt: baseline ? state.membershipBaselineObservedAt : state?.baselineObservedAt,
    baselineGeneration: baseline ? state.membershipBaselineGeneration : state?.baselineGeneration,
    lastCatchupCompletedAt: catchup ? state.membershipCatchupVerifiedAt : state?.lastCatchupCompletedAt,
    lastCatchupObservedAt: catchup ? state.membershipCatchupObservedAt : state?.lastCatchupObservedAt,
    lastCatchupGeneration: catchup ? state.membershipCatchupGeneration : state?.lastCatchupGeneration,
  };
}

function membershipProofData(mode, generation, verifiedAt, observedAt) {
  return mode === "full"
    ? { membershipBaselineVerifiedAt: verifiedAt, membershipBaselineObservedAt: observedAt, membershipBaselineGeneration: generation }
    : { membershipCatchupVerifiedAt: verifiedAt, membershipCatchupObservedAt: observedAt, membershipCatchupGeneration: generation };
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
    orderBy: { leaseRevision: "desc" }, select: { id: true },
  });
  if (!published) return state;
  const data = membershipProofData(state.mode, state.activeGeneration, state.membershipCoverageCompletedAt, state.membershipObservedAt || null);
  if (!persist) return { ...state, ...data };
  return db.creatorCampaignCollectionState.update({ where: { creatorId: state.creatorId }, data });
}

module.exports = { membershipProofState, membershipProofData, recoverPublishedMembershipProof };
