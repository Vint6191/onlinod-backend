"use strict";

// Phase 3 INT5.9A-14
// Pure capacity arithmetic + honest Campaign-directory due/overdue projection.
// This service does not schedule work and therefore cannot become a second
// provider limiter. Physical admission remains owned by the provider gate and
// job scheduler; these helpers only expose what the configured gate can prove.

const DEFAULT_PROVIDER_INTERVAL_MS = 700;
const DEFAULT_CAMPAIGN_DIRECTORY_PAGE_SIZE = 50;
const DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS = 72 * 60 * 60 * 1000;

// Must remain semantically aligned with provider-request-credit-authority-service.
// Keeping the weights local makes this module pure and avoids importing the DB
// authority just to perform arithmetic in read/status paths.
const PROVIDER_PRIORITY_CYCLE = Object.freeze([
  "critical_write", "critical_write", "critical_write",
  "interactive", "interactive",
  "realtime",
  "normal",
  "background",
]);
const PROVIDER_BACKGROUND_CATEGORY_CYCLE = Object.freeze([
  "campaign_frontier",
  "fan_data",
  "campaign_frontier",
  "fan_data",
  "background_other",
  "campaign_directory",
]);

function finiteInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function countShare(cycle, key) {
  const total = cycle.length;
  const hits = cycle.filter((value) => value === key).length;
  return total > 0 ? hits / total : 0;
}
function providerPhysicalStartsPerHour(intervalMs = DEFAULT_PROVIDER_INTERVAL_MS) {
  const spacing = Math.max(1, finiteInt(intervalMs, DEFAULT_PROVIDER_INTERVAL_MS, 1, 60_000));
  return 3_600_000 / spacing;
}
function providerPriorityShare(priority) {
  return countShare(PROVIDER_PRIORITY_CYCLE, String(priority || ""));
}
function providerBackgroundCategoryShare(category) {
  return countShare(PROVIDER_BACKGROUND_CATEGORY_CYCLE, String(category || ""));
}
function providerCategoryGuaranteedStartsPerHour(category, intervalMs = DEFAULT_PROVIDER_INTERVAL_MS) {
  return providerPhysicalStartsPerHour(intervalMs)
    * providerPriorityShare("background")
    * providerBackgroundCategoryShare(category);
}
function providerCategoryBackgroundOnlyStartsPerHour(category, intervalMs = DEFAULT_PROVIDER_INTERVAL_MS) {
  return providerPhysicalStartsPerHour(intervalMs) * providerBackgroundCategoryShare(category);
}
function estimatedCampaignDirectoryCalls(campaignCount, pageSize = DEFAULT_CAMPAIGN_DIRECTORY_PAGE_SIZE) {
  const count = Math.max(0, finiteInt(campaignCount, 0, 0));
  const size = Math.max(1, finiteInt(pageSize, DEFAULT_CAMPAIGN_DIRECTORY_PAGE_SIZE, 1, 1000));
  // A source-exhaustive offset traversal must also observe the terminal boundary.
  return Math.max(1, Math.ceil(count / size) + 1);
}
function campaignDirectoryFleetFeasibility({
  creatorCount,
  campaignCount,
  targetMs = DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS,
  intervalMs = DEFAULT_PROVIDER_INTERVAL_MS,
  mode = "full_saturation_guaranteed",
} = {}) {
  const creators = Math.max(0, finiteInt(creatorCount, 0, 0));
  const callsPerCreator = estimatedCampaignDirectoryCalls(campaignCount);
  const requiredCalls = creators * callsPerCreator;
  const startsPerHour = mode === "background_only"
    ? providerCategoryBackgroundOnlyStartsPerHour("campaign_directory", intervalMs)
    : providerCategoryGuaranteedStartsPerHour("campaign_directory", intervalMs);
  const requiredHours = startsPerHour > 0 ? requiredCalls / startsPerHour : Number.POSITIVE_INFINITY;
  const targetHours = Math.max(0, Number(targetMs) || 0) / 3_600_000;
  return {
    creators,
    campaignCount: Math.max(0, finiteInt(campaignCount, 0, 0)),
    callsPerCreator,
    requiredCalls,
    startsPerHour,
    requiredHours,
    targetHours,
    feasibleWithinTarget: Number.isFinite(requiredHours) && requiredHours <= targetHours,
    mode,
  };
}

function campaignDirectoryDiscoveryCapacityState(state, now = new Date(), targetMs = DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS) {
  const authorityNow = asDate(now) || new Date();
  const requestedRevision = Math.max(0, finiteInt(state?.campaignDirectoryDiscoveryRequestedRevision, 0, 0));
  const completedRevision = Math.max(0, finiteInt(state?.campaignDirectoryDiscoveryCompletedRevision, 0, 0));
  const pendingDemand = requestedRevision > completedRevision;
  const verifiedAt = asDate(state?.campaignDirectoryVerifiedAt);
  let dueAt = asDate(state?.campaignDirectoryDiscoveryDueAt);
  if (!dueAt && verifiedAt) dueAt = new Date(verifiedAt.getTime() + Math.max(1, Number(targetMs) || DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS));
  const campaignCount = Math.max(0, finiteInt(state?.campaignDirectoryCampaignCount, 0, 0));
  const overdueByMs = dueAt && authorityNow.getTime() > dueAt.getTime()
    ? authorityNow.getTime() - dueAt.getTime()
    : 0;
  let status = "FRESH";
  if (pendingDemand) status = "REQUESTED";
  else if (!verifiedAt || !dueAt) status = "DUE";
  else if (overdueByMs > 0) status = "OVERDUE";
  else if (dueAt.getTime() <= authorityNow.getTime()) status = "DUE";
  return {
    status,
    dueAt,
    verifiedAt,
    overdueByMs,
    pendingDemand,
    requestedRevision,
    completedRevision,
    campaignCount,
    estimatedProviderCalls: estimatedCampaignDirectoryCalls(campaignCount),
    targetMs: Math.max(1, Number(targetMs) || DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS),
  };
}

module.exports = {
  DEFAULT_PROVIDER_INTERVAL_MS,
  DEFAULT_CAMPAIGN_DIRECTORY_PAGE_SIZE,
  DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS,
  PROVIDER_PRIORITY_CYCLE,
  PROVIDER_BACKGROUND_CATEGORY_CYCLE,
  providerPhysicalStartsPerHour,
  providerPriorityShare,
  providerBackgroundCategoryShare,
  providerCategoryGuaranteedStartsPerHour,
  providerCategoryBackgroundOnlyStartsPerHour,
  estimatedCampaignDirectoryCalls,
  campaignDirectoryFleetFeasibility,
  campaignDirectoryDiscoveryCapacityState,
};
