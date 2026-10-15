"use strict";

// Capacity belongs to independent creator timelines. Per-creator reservation
// protects periodic discovery; aggregate fleet debt never throttles other models.
const {
  DEFAULT_PROVIDER_INTERVAL_MS,
  providerCategoryGuaranteedStartsPerHour,
} = require("./provider-capacity-sla-service");

const PROVIDER_CAPACITY_TOPOLOGY_VERSION = "creator_provider_capacity_v2";
const PROVIDER_CAPACITY_TOPOLOGY_ID = "of-creator";
const PROVIDER_CAPACITY_TOPOLOGY_SCOPE = "CREATOR_PARALLEL";
const PROVIDER_CAPACITY_TOPOLOGY_SHARD_COUNT = 0;
const PROVIDER_CAPACITY_SHARDING_ALLOWED = true;
const DEFAULT_NORMAL_DIRECTORY_ADMISSION_CALLS = Math.max(
  1,
  Math.min(20_000, Number.parseInt(process.env.CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP || "2400", 10) || 2400),
);
const DEFAULT_CAPACITY_SNAPSHOT_MAX_AGE_MS = Math.max(
  60_000,
  Math.min(6 * 60 * 60 * 1000, Number.parseInt(process.env.PROVIDER_CAPACITY_SNAPSHOT_MAX_AGE_MS || String(2 * 60 * 60 * 1000), 10) || (2 * 60 * 60 * 1000)),
);

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function finiteInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function guaranteedDirectoryCallsPerSweep(intervalMs = DEFAULT_PROVIDER_INTERVAL_MS) {
  // Recurring scheduler sweep is hourly. A guaranteed weighted hourly credit is
  // therefore also the conservative admission budget for one hourly sweep.
  return Math.max(1, Math.floor(providerCategoryGuaranteedStartsPerHour("campaign_directory", intervalMs)));
}
function providerCapacityTopologyContract(creatorCount = 0) {
  return Object.freeze({
    version: PROVIDER_CAPACITY_TOPOLOGY_VERSION,
    topologyId: PROVIDER_CAPACITY_TOPOLOGY_ID,
    scope: PROVIDER_CAPACITY_TOPOLOGY_SCOPE,
    shardCount: finiteInt(creatorCount, 0),
    shardingAllowed: PROVIDER_CAPACITY_SHARDING_ALLOWED,
  });
}
function deriveProviderOverloadControl({
  snapshot = null,
  now = new Date(),
  intervalMs = DEFAULT_PROVIDER_INTERVAL_MS,
  normalDirectoryAdmissionCalls = DEFAULT_NORMAL_DIRECTORY_ADMISSION_CALLS,
  snapshotMaxAgeMs = DEFAULT_CAPACITY_SNAPSHOT_MAX_AGE_MS,
} = {}) {
  const authorityNow = asDate(now) || new Date();
  const sampledAt = asDate(snapshot?.sampledAt);
  const ageMs = sampledAt ? Math.max(0, authorityNow.getTime() - sampledAt.getTime()) : Number.POSITIVE_INFINITY;
  const snapshotFresh = Boolean(sampledAt && ageMs <= Math.max(1, finiteInt(snapshotMaxAgeMs, DEFAULT_CAPACITY_SNAPSHOT_MAX_AGE_MS, 1)));
  const rawStatus = String(snapshot?.status || "UNKNOWN").trim().toUpperCase();
  const overloaded = snapshotFresh && rawStatus === "OVERLOADED";
  const conservative = !snapshotFresh || rawStatus === "UNKNOWN";
  const guaranteedCalls = guaranteedDirectoryCallsPerSweep(intervalMs);
  const normalCalls = Math.max(1, finiteInt(normalDirectoryAdmissionCalls, DEFAULT_NORMAL_DIRECTORY_ADMISSION_CALLS, 1, 20_000));
  const protectedMode = overloaded || conservative;
  const controlMode = overloaded ? "OVERLOAD_PROTECTED" : (conservative ? "CONSERVATIVE" : "NORMAL");
  const reason = overloaded
    ? String(snapshot?.overloadReason || "PROVIDER_CAPACITY_OVERLOADED")
    : (conservative ? (snapshotFresh ? "CAPACITY_STATUS_UNKNOWN" : "CAPACITY_SNAPSHOT_STALE_OR_MISSING") : null);
  return {
    topology: providerCapacityTopologyContract(),
    controlMode,
    controlReason: reason,
    snapshotFresh,
    snapshotAgeMs: Number.isFinite(ageMs) ? ageMs : null,
    operatorActionRequired: overloaded,
    campaignDirectoryAdmissionBudgetCalls: protectedMode ? guaranteedCalls : normalCalls,
    campaignDirectoryGuaranteedCallsPerSweep: guaranteedCalls,
    canonicalDebtPreserved: true,
    shedsCanonicalWork: false,
  };
}

module.exports = {
  PROVIDER_CAPACITY_TOPOLOGY_VERSION,
  PROVIDER_CAPACITY_TOPOLOGY_ID,
  PROVIDER_CAPACITY_TOPOLOGY_SCOPE,
  PROVIDER_CAPACITY_TOPOLOGY_SHARD_COUNT,
  PROVIDER_CAPACITY_SHARDING_ALLOWED,
  DEFAULT_NORMAL_DIRECTORY_ADMISSION_CALLS,
  DEFAULT_CAPACITY_SNAPSHOT_MAX_AGE_MS,
  guaranteedDirectoryCallsPerSweep,
  providerCapacityTopologyContract,
  deriveProviderOverloadControl,
};
