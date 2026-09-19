"use strict";

function deriveCampaignPresentationStatus({
  collectorStatus = "IDLE",
  fanRefreshDelegated = false,
  membershipCoverageStatus = "MISSING",
  campaignFrontierFreshnessStatus = "MISSING",
  fanValuesComplete = false,
  fanValuesOutstanding = 0,
  fanValueFreshnessStatus = "MISSING",
  retryableFailedDemands = 0,
} = {}) {
  const normalizedCollector = String(collectorStatus || "IDLE").toUpperCase();
  const normalizedMembership = String(membershipCoverageStatus || "MISSING").toUpperCase();
  const normalizedFrontier = String(campaignFrontierFreshnessStatus || "MISSING").toUpperCase();
  const normalizedFan = String(fanValueFreshnessStatus || "MISSING").toUpperCase();
  const coverageComplete = normalizedMembership === "COMPLETE"
    && normalizedFrontier === "COMPLETE"
    && fanValuesComplete === true;
  const refreshPending = normalizedCollector === "COMPLETE" && fanRefreshDelegated === true && !coverageComplete
    && (Math.max(0, Number(fanValuesOutstanding || 0)) > 0 || normalizedFan === "QUEUED" || Math.max(0, Number(retryableFailedDemands || 0)) > 0);
  const coverageStatus = coverageComplete ? "COMPLETE"
    : refreshPending ? "PENDING"
      : (normalizedMembership === "MISSING" && normalizedFan === "MISSING" ? "MISSING" : "PARTIAL");
  let status = normalizedCollector;
  if (normalizedCollector === "COMPLETE") {
    if (fanRefreshDelegated === true) {
      status = coverageComplete ? "COMPLETE" : refreshPending ? "REFRESH_PENDING" : "PARTIAL";
    } else if (fanValuesComplete !== true) {
      // Rolling/legacy collectors own FanData inline. Preserve the historical
      // DONE -> PARTIAL contract when their terminal result did not prove value
      // completion; only delegated v13+ collectors derive freshness live.
      status = "PARTIAL";
    }
  }
  return { status, collectorStatus: normalizedCollector, coverageStatus, refreshPending, coverageComplete };
}

function deriveManualCampaignStartDebtAction({ failedDebt = 0, queuedDebt = 0 } = {}) {
  const failed = Math.max(0, Number(failedDebt || 0));
  const queued = Math.max(0, Number(queuedDebt || 0));
  if (failed > 0) return "repair";
  if (queued > 0) return "refresh_pending";
  return "full";
}

module.exports = { deriveCampaignPresentationStatus, deriveManualCampaignStartDebtAction };
