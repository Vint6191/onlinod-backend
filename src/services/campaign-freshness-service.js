"use strict";

const { directoryObservationAt, directoryDiscoveryDeadline, parseObservationTime } = require("./analytics-observation-time");
const { CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS } = require("./analytics-freshness-policy");
const { evaluateDurableCollectorState } = require("./analytics-state-evaluator");
const { directoryCountInvalidated } = require("./campaign-directory-count-authority");

const FRONTIER_OBSERVATION_VERSION = 1;
const CAMPAIGN_COVERAGE_SELECT = Object.freeze(Object.fromEntries([
  "status", "baselineVerifiedAt", "lastCatchupCompletedAt", "baselineObservedAt", "lastCatchupObservedAt", "retryAfterAt",
  "activeGeneration", "membershipCoverageStatus", "membershipObservedAt",
  "campaignDirectoryGeneration", "campaignDirectoryRequestedAt", "campaignDirectoryVerifiedAt", "campaignDirectoryRevision",
  "campaignDirectoryCampaignCount", "campaignDirectoryDiscoveryDueAt", "campaignDirectoryDiscoveryRequestedRevision", "campaignDirectoryDiscoveryCompletedRevision",
  "campaignDirectoryFactsRevision", "campaignDirectoryCountRevision",
  "campaignFrontierPlanRunId", "campaignFrontierObservationVersion", "campaignFrontierFreshnessStatus", "campaignFrontierNextDueAt",
  "campaignFrontierTargetCount", "campaignFrontierCompletedCount", "campaignFrontierDeferredCount",
  "fanValueCoverageScanRunId", "fanValueExpected", "fanValueFreshnessStatus", "fanValueOutstanding", "fanValueFailed",
].map(key => [key, true])));

function directoryPending(state) {
  return Number(state?.campaignDirectoryDiscoveryRequestedRevision || 0) > Number(state?.campaignDirectoryDiscoveryCompletedRevision || 0);
}
function directoryDue(state, now = new Date()) {
  const deadline = directoryDiscoveryDeadline(state, CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS, now);
  return !state?.campaignDirectoryGeneration || !(Number(state.campaignDirectoryRevision) > 0)
    || directoryPending(state) || directoryCountInvalidated(state) || !deadline || +deadline <= +now;
}
function frontierDue(state, now = new Date()) {
  // A completed old plan did not include unknown source ages in its due set.
  // Its cached future deadline cannot certify the new observation contract.
  if (state?.campaignFrontierObservationVersion !== FRONTIER_OBSERVATION_VERSION
      || !state.activeGeneration || state.campaignFrontierPlanRunId !== state.activeGeneration
      || state.campaignFrontierFreshnessStatus !== "COMPLETE"
      || state.membershipCoverageStatus !== "COMPLETE"
      || Number(state.campaignFrontierDeferredCount || 0) > 0
      || Number(state.campaignFrontierCompletedCount || 0) < Number(state.campaignFrontierTargetCount || 0)) return true;
  const next = parseObservationTime(state.campaignFrontierNextDueAt);
  // No deadline is valid only for an exactly empty, verified directory.
  return next ? +next <= +now : state.campaignDirectoryCampaignCount !== 0;
}
function fanRefreshPending(state) {
  return Boolean(state?.activeGeneration && state.fanValueCoverageScanRunId === state.activeGeneration
    && Number(state.fanValueExpected || 0) > 0 && state.fanValueFreshnessStatus !== "COMPLETE");
}
function frontierDueWhere(exactGeneration, now) {
  return { ...exactGeneration, OR: [
    { claimersNextDueAt: null }, { claimersNextDueAt: { lte: now } },
    { claimersObservationVersion: { lt: FRONTIER_OBSERVATION_VERSION } },
  ] };
}
function evaluateCampaignCollectionState(state, now = new Date()) {
  const base = evaluateDurableCollectorState({ status: state?.status, baselineVerifiedAt: state?.baselineVerifiedAt,
    lastVerifiedAt: state?.lastCatchupCompletedAt, baselineObservedAt: state?.baselineObservedAt,
    lastObservedAt: state?.lastCatchupObservedAt, retryAfterAt: state?.retryAfterAt, now });
  const discoveryDue = directoryDue(state, now), membershipDue = frontierDue(state, now);
  const delegatedPending = fanRefreshPending(state);
  const fresh = base.proven && !discoveryDue && !membershipDue && !delegatedPending;
  const deferred = !fresh && Boolean(base.retryAfterAt && +base.retryAfterAt > +now);
  return Object.freeze({ ...base, fresh, stale: base.usable && !fresh, deferred,
    due: !fresh && !deferred && !base.failed && !delegatedPending,
    freshnessAuthority: "DIRECTORY_AND_FRONTIERS",
    directoryDue: discoveryDue, frontierDue: membershipDue, fanRefreshPending: delegatedPending,
    directoryObservedAt: directoryObservationAt(state, now),
    directoryNextDueAt: directoryDiscoveryDeadline(state, CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS, now),
    frontierNextDueAt: parseObservationTime(state?.campaignFrontierNextDueAt),
  });
}

module.exports = { FRONTIER_OBSERVATION_VERSION, CAMPAIGN_COVERAGE_SELECT, directoryPending, directoryDue, frontierDue,
  fanRefreshPending, frontierDueWhere, evaluateCampaignCollectionState };
