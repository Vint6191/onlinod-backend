"use strict";

// Phase 3 INT5.9A-15
// Durable typed projection of lower-bound provider capacity debt.
// Canonical work remains in CreatorCampaignCollectionState,
// CreatorFanRefreshDemand and JobInstance. This projection exists so the
// scheduler/operator can reason from durable fleet facts instead of from
// ad-hoc arithmetic in logs.

const {
  DEFAULT_PROVIDER_INTERVAL_MS,
  DEFAULT_CAMPAIGN_DIRECTORY_PAGE_SIZE,
  DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS,
  providerPhysicalStartsPerHour,
  providerPriorityShare,
  providerBackgroundCategoryShare,
  providerCategoryGuaranteedStartsPerHour,
  estimatedCampaignDirectoryCalls,
} = require("./provider-capacity-sla-service");
const { CAMPAIGN_FAN_VALUE_FRESHNESS_MS, CAMPAIGN_DIRECTORY_DISCOVERY_TARGET_MS,
  COLLECTION_FUTURE_SKEW_TOLERANCE_MS } = require("./analytics-freshness-policy");
const { CLAIMABLE_DESKTOP_JOB_KEYS } = require("./job-catalog");
const {
  providerCapacityTopologyContract,
  deriveProviderOverloadControl,
} = require("./provider-capacity-topology-control-service");

const PROVIDER_CAPACITY_STATE_ID = "of-global-capacity-v1";
const PROVIDER_CAPACITY_SOURCE_VERSION = "phase6_provider_capacity_debt_v1";
const BACKGROUND_OTHER_PROVIDER_JOB_KEYS = Object.freeze(
  CLAIMABLE_DESKTOP_JOB_KEYS.filter((key) => !["fetch_campaigns", "fan_data_point_refresh"].includes(String(key || "")))
);

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function nonNegativeInt(value) {
  return Math.max(0, Math.floor(finiteNumber(value, 0)));
}
function nonNegativeBigInt(value) {
  try {
    const n = typeof value === "bigint" ? value : BigInt(value ?? 0);
    return n < 0n ? 0n : n;
  } catch (_) {
    return 0n;
  }
}
function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function hours(ms) {
  return Math.max(0, finiteNumber(ms, 0)) / 3_600_000;
}
function safeClearHours(calls, startsPerHour) {
  const n = Number(nonNegativeBigInt(calls));
  const rate = Math.max(0, finiteNumber(startsPerHour, 0));
  return rate > 0 ? n / rate : (n > 0 ? Number.POSITIVE_INFINITY : 0);
}
function capacityCallsWithinTarget(startsPerHour, targetHours) {
  return BigInt(Math.max(0, Math.floor(Math.max(0, finiteNumber(startsPerHour, 0)) * Math.max(0, finiteNumber(targetHours, 0)))));
}
function debtCalls(requiredCalls, startsPerHour, targetHours) {
  const required = nonNegativeBigInt(requiredCalls);
  const capacity = capacityCallsWithinTarget(startsPerHour, targetHours);
  return required > capacity ? required - capacity : 0n;
}

function deriveProviderCapacityDebtSnapshot({
  now = new Date(),
  campaignDirectory = {},
  fanData = {},
  backgroundOther = {},
  actualUsage = {},
  projection = { complete: true, revision: 0n },
  intervalMs = DEFAULT_PROVIDER_INTERVAL_MS,
  directoryTargetMs = DEFAULT_CAMPAIGN_DIRECTORY_TARGET_MS,
  fanDataTargetMs = CAMPAIGN_FAN_VALUE_FRESHNESS_MS,
} = {}) {
  const sampledAt = asDate(now) || new Date();
  const physicalStartsPerHour = providerPhysicalStartsPerHour(intervalMs);
  const backgroundGuaranteedStartsPerHour = physicalStartsPerHour * providerPriorityShare("background");
  const campaignDirectoryGuaranteedStartsPerHour = providerCategoryGuaranteedStartsPerHour("campaign_directory", intervalMs);
  const fanDataGuaranteedStartsPerHour = providerCategoryGuaranteedStartsPerHour("fan_data", intervalMs);

  const campaignDirectoryDueCreators = nonNegativeInt(campaignDirectory.dueCreators);
  const campaignDirectoryOverdueCreators = nonNegativeInt(campaignDirectory.overdueCreators);
  const campaignDirectoryRequiredCalls = nonNegativeBigInt(campaignDirectory.requiredCalls);
  const fanDataUnsatisfiedDemands = nonNegativeBigInt(fanData.unsatisfiedDemands);
  const fanDataPendingJobs = nonNegativeInt(fanData.pendingJobs);
  const backgroundOtherPendingJobs = nonNegativeInt(backgroundOther.pendingJobs);
  const backgroundOtherPendingJobClasses = nonNegativeInt(backgroundOther.pendingJobClasses);
  const backgroundOtherOldestScheduledAt = asDate(backgroundOther.oldestScheduledAt);
  // A generic JobInstance proves durable future work exists, but not how many
  // OF calls a domain-specific continuation will consume. Never invent
  // `1 job == 1 call` as an SLA forecast.
  const backgroundOtherCallCardinalityKnown = backgroundOtherPendingJobs === 0;
  const projectionComplete = projection.complete === true;
  const futureDebtCoverageStatus = backgroundOtherCallCardinalityKnown && projectionComplete ? "COMPLETE_AT_SAMPLE" : "PARTIAL";
  const futureDebtCoverageReason = !projectionComplete ? "CAPACITY_PROJECTION_REBUILD_OR_LAG" : (backgroundOtherCallCardinalityKnown ? null : "BACKGROUND_OTHER_CALL_CARDINALITY_UNKNOWN");

  const actualUsageWindowStartedAt = asDate(actualUsage.windowStartedAt);
  const actualUsageTotalStarts = nonNegativeBigInt(actualUsage.totalStarts);
  const actualUsageCriticalWriteStarts = nonNegativeBigInt(actualUsage.criticalWriteStarts);
  const actualUsageInteractiveStarts = nonNegativeBigInt(actualUsage.interactiveStarts);
  const actualUsageRealtimeStarts = nonNegativeBigInt(actualUsage.realtimeStarts);
  const actualUsageNormalStarts = nonNegativeBigInt(actualUsage.normalStarts);
  const actualUsageCampaignDirectoryStarts = nonNegativeBigInt(actualUsage.campaignDirectoryStarts);
  const actualUsageCampaignFrontierStarts = nonNegativeBigInt(actualUsage.campaignFrontierStarts);
  const actualUsageFanDataStarts = nonNegativeBigInt(actualUsage.fanDataStarts);
  const actualUsageBackgroundOtherStarts = nonNegativeBigInt(actualUsage.backgroundOtherStarts);
  const actualUsageUnclassifiedStarts = nonNegativeBigInt(actualUsage.unclassifiedStarts);
  const actualUsageClassifiedStarts = actualUsageCriticalWriteStarts + actualUsageInteractiveStarts + actualUsageRealtimeStarts +
    actualUsageNormalStarts + actualUsageCampaignDirectoryStarts + actualUsageCampaignFrontierStarts +
    actualUsageFanDataStarts + actualUsageBackgroundOtherStarts;
  const actualUsageAccountingComplete = actualUsageUnclassifiedStarts === 0n && actualUsageClassifiedStarts === actualUsageTotalStarts;

  const campaignDirectoryTargetHours = hours(directoryTargetMs);
  const fanDataTargetHours = hours(fanDataTargetMs);
  const campaignDirectoryCapacityDebtCalls = debtCalls(
    campaignDirectoryRequiredCalls,
    campaignDirectoryGuaranteedStartsPerHour,
    campaignDirectoryTargetHours,
  );
  const fanDataCapacityDebtCalls = debtCalls(
    fanDataUnsatisfiedDemands,
    fanDataGuaranteedStartsPerHour,
    fanDataTargetHours,
  );
  const providerLowerBoundRequiredCalls = campaignDirectoryRequiredCalls + fanDataUnsatisfiedDemands;
  const campaignDirectoryGuaranteedClearHours = safeClearHours(campaignDirectoryRequiredCalls, campaignDirectoryGuaranteedStartsPerHour);
  const fanDataGuaranteedClearHours = safeClearHours(fanDataUnsatisfiedDemands, fanDataGuaranteedStartsPerHour);
  const providerExclusiveClearHours = safeClearHours(providerLowerBoundRequiredCalls, physicalStartsPerHour);

  const overloadedReasons = [];
  if (campaignDirectoryCapacityDebtCalls > 0n) overloadedReasons.push("CAMPAIGN_DIRECTORY_CAPACITY_DEBT");
  if (fanDataCapacityDebtCalls > 0n) overloadedReasons.push("FAN_DATA_CAPACITY_DEBT");
  const hasWork = providerLowerBoundRequiredCalls > 0n || fanDataPendingJobs > 0 || campaignDirectoryDueCreators > 0;
  if (!actualUsageAccountingComplete) overloadedReasons.push("ACTUAL_USAGE_ACCOUNTING_INCOMPLETE");
  if (!backgroundOtherCallCardinalityKnown) overloadedReasons.push("FUTURE_DEBT_COVERAGE_PARTIAL");
  if (!projectionComplete) overloadedReasons.push("CAPACITY_PROJECTION_REBUILD_OR_LAG");
  const status = (!projectionComplete || !actualUsageAccountingComplete || !backgroundOtherCallCardinalityKnown)
    ? "UNKNOWN"
    : (overloadedReasons.length ? "OVERLOADED" : (hasWork ? "PRESSURED" : "HEALTHY"));
  const topology = providerCapacityTopologyContract();
  const control = deriveProviderOverloadControl({
    snapshot: { status, overloadReason: overloadedReasons.length ? overloadedReasons.join(",") : null, sampledAt },
    now: sampledAt,
    intervalMs,
  });

  return {
    id: PROVIDER_CAPACITY_STATE_ID,
    sourceVersion: PROVIDER_CAPACITY_SOURCE_VERSION,
    projectionRevision: nonNegativeBigInt(projection.revision),
    projectionCoverageStatus: projectionComplete ? "COMPLETE_AT_SAMPLE" : "PARTIAL",
    sampledAt,
    status,
    overloadReason: overloadedReasons.length ? overloadedReasons.join(",") : null,
    physicalStartsPerHour,
    backgroundGuaranteedStartsPerHour,
    campaignDirectoryGuaranteedStartsPerHour,
    fanDataGuaranteedStartsPerHour,
    campaignDirectoryDueCreators,
    campaignDirectoryOverdueCreators,
    campaignDirectoryRequiredCalls,
    campaignDirectoryCapacityDebtCalls,
    campaignDirectoryOldestDueAt: asDate(campaignDirectory.oldestDueAt),
    campaignDirectoryGuaranteedClearHours,
    campaignDirectoryTargetHours,
    fanDataUnsatisfiedDemands,
    fanDataPendingJobs,
    fanDataCapacityDebtCalls,
    fanDataOldestRequestedAt: asDate(fanData.oldestRequestedAt),
    fanDataGuaranteedClearHours,
    fanDataTargetHours,
    providerLowerBoundRequiredCalls,
    providerExclusiveClearHours,
    actualUsageWindowStartedAt,
    actualUsageTotalStarts,
    actualUsageCriticalWriteStarts,
    actualUsageInteractiveStarts,
    actualUsageRealtimeStarts,
    actualUsageNormalStarts,
    actualUsageCampaignDirectoryStarts,
    actualUsageCampaignFrontierStarts,
    actualUsageFanDataStarts,
    actualUsageBackgroundOtherStarts,
    actualUsageUnclassifiedStarts,
    actualUsageAccountingComplete,
    backgroundOtherPendingJobs,
    backgroundOtherOldestScheduledAt,
    backgroundOtherPendingJobClasses,
    backgroundOtherCallCardinalityKnown,
    futureDebtCoverageStatus,
    futureDebtCoverageReason,
    topologyVersion: topology.version,
    topologyId: topology.topologyId,
    topologyScope: topology.scope,
    topologyShardCount: topology.shardCount,
    topologyShardingAllowed: topology.shardingAllowed,
    controlMode: control.controlMode,
    controlReason: control.controlReason,
    operatorActionRequired: control.operatorActionRequired,
    campaignDirectoryAdmissionBudgetCalls: control.campaignDirectoryAdmissionBudgetCalls,
    campaignDirectoryGuaranteedCallsPerSweep: control.campaignDirectoryGuaranteedCallsPerSweep,
  };
}

async function readCanonicalCapacityInputs({ db, now = new Date() } = {}) {
  if (typeof db?.$queryRawUnsafe !== "function") {
    return { supported: false, reason: "raw_sql_unavailable" };
  }
  const authorityNow = asDate(now) || new Date();
  const rows = await db.$queryRawUnsafe(`
    WITH source_directory AS (
      SELECT *,CASE WHEN "campaignDirectoryVerifiedAt" IS NOT NULL AND "campaignDirectoryRequestedAt" IS NOT NULL
        AND LEAST("campaignDirectoryVerifiedAt","campaignDirectoryRequestedAt") <= $1::timestamp + ${COLLECTION_FUTURE_SKEW_TOLERANCE_MS} * interval '1 millisecond'
        THEN LEAST("campaignDirectoryDiscoveryDueAt", LEAST("campaignDirectoryVerifiedAt","campaignDirectoryRequestedAt")
          + $4::bigint * interval '1 millisecond') ELSE NULL END AS "observationDueAt"
      FROM "CreatorCampaignCollectionState"
    ), directory AS (
      SELECT
        COUNT(*) FILTER (
          WHERE "baselineVerifiedAt" IS NOT NULL
            AND (
              "campaignDirectoryDiscoveryRequestedRevision" > "campaignDirectoryDiscoveryCompletedRevision"
              OR "observationDueAt" IS NULL
              OR "observationDueAt" <= $1
            )
        )::bigint AS "dueCreators",
        COUNT(*) FILTER (
          WHERE "baselineVerifiedAt" IS NOT NULL
            AND "observationDueAt" IS NOT NULL
            AND "observationDueAt" < $1
        )::bigint AS "overdueCreators",
        COALESCE(SUM(
          CASE WHEN "baselineVerifiedAt" IS NOT NULL
            AND (
              "campaignDirectoryDiscoveryRequestedRevision" > "campaignDirectoryDiscoveryCompletedRevision"
              OR "observationDueAt" IS NULL
              OR "observationDueAt" <= $1
            )
          THEN GREATEST(1, CEIL(GREATEST(0, "campaignDirectoryCampaignCount")::numeric / $2::numeric)::bigint + 1)
          ELSE 0 END
        ), 0)::bigint AS "requiredCalls",
        MIN("observationDueAt") FILTER (
          WHERE "baselineVerifiedAt" IS NOT NULL
            AND (
              "campaignDirectoryDiscoveryRequestedRevision" > "campaignDirectoryDiscoveryCompletedRevision"
              OR "observationDueAt" IS NULL
              OR "observationDueAt" <= $1
            )
        ) AS "oldestDueAt"
      FROM source_directory
    ), fan AS (
      SELECT
        COUNT(*) FILTER (WHERE "requestedRevision" > "satisfiedRevision")::bigint AS "unsatisfiedDemands",
        MIN("lastRequestedAt") FILTER (WHERE "requestedRevision" > "satisfiedRevision") AS "oldestRequestedAt"
      FROM "CreatorFanRefreshDemand"
    ), jobs AS (
      SELECT COUNT(*)::bigint AS "pendingJobs"
      FROM "JobInstance"
      WHERE "jobKey"='fan_data_point_refresh' AND "status" IN ('SCHEDULED','CLAIMED')
    ), background_other AS (
      SELECT
        COUNT(*)::bigint AS "backgroundOtherPendingJobs",
        COUNT(DISTINCT "jobKey")::bigint AS "backgroundOtherPendingJobClasses",
        MIN("scheduledAt") AS "backgroundOtherOldestScheduledAt"
      FROM "JobInstance"
      WHERE "jobKey" = ANY($3::text[])
        AND "status" IN ('SCHEDULED','CLAIMED','PAUSED')
    ), usage AS (
      SELECT
        "usageWindowStartedAt", "usageTotalStarts", "usageCriticalWriteStarts",
        "usageInteractiveStarts", "usageRealtimeStarts", "usageNormalStarts",
        "usageCampaignDirectoryStarts", "usageCampaignFrontierStarts", "usageFanDataStarts",
        "usageBackgroundOtherStarts", "usageUnclassifiedStarts"
      FROM "OfProviderRequestGateState" WHERE "id"='of-global' LIMIT 1
    )
    SELECT directory.*, fan.*, jobs."pendingJobs", background_other.*, usage.*
    FROM directory CROSS JOIN fan CROSS JOIN jobs CROSS JOIN background_other LEFT JOIN usage ON TRUE
  `, authorityNow, DEFAULT_CAMPAIGN_DIRECTORY_PAGE_SIZE, BACKGROUND_OTHER_PROVIDER_JOB_KEYS, CAMPAIGN_DIRECTORY_DISCOVERY_TARGET_MS);
  const row = Array.isArray(rows) ? rows[0] : rows;
  return capacityInputsFromRow(row);
}

function capacityInputsFromRow(row) {
  return {
    supported: true,
    campaignDirectory: {
      dueCreators: row?.dueCreators ?? row?.duecreators ?? 0,
      overdueCreators: row?.overdueCreators ?? row?.overduecreators ?? 0,
      requiredCalls: row?.requiredCalls ?? row?.requiredcalls ?? 0,
      oldestDueAt: row?.oldestDueAt ?? row?.oldestdueat ?? null,
    },
    fanData: {
      unsatisfiedDemands: row?.unsatisfiedDemands ?? row?.unsatisfieddemands ?? 0,
      pendingJobs: row?.pendingJobs ?? row?.pendingjobs ?? 0,
      oldestRequestedAt: row?.oldestRequestedAt ?? row?.oldestrequestedat ?? null,
    },
    backgroundOther: {
      pendingJobs: row?.backgroundOtherPendingJobs ?? row?.backgroundotherpendingjobs ?? 0,
      pendingJobClasses: row?.backgroundOtherPendingJobClasses ?? row?.backgroundotherpendingjobclasses ?? 0,
      oldestScheduledAt: row?.backgroundOtherOldestScheduledAt ?? row?.backgroundotheroldestscheduledat ?? null,
    },
    actualUsage: {
      windowStartedAt: row?.usageWindowStartedAt ?? row?.usagewindowstartedat ?? null,
      totalStarts: row?.usageTotalStarts ?? row?.usagetotalstarts ?? 0,
      criticalWriteStarts: row?.usageCriticalWriteStarts ?? row?.usagecriticalwritestarts ?? 0,
      interactiveStarts: row?.usageInteractiveStarts ?? row?.usageinteractivestarts ?? 0,
      realtimeStarts: row?.usageRealtimeStarts ?? row?.usagerealtimestarts ?? 0,
      normalStarts: row?.usageNormalStarts ?? row?.usagenormalstarts ?? 0,
      campaignDirectoryStarts: row?.usageCampaignDirectoryStarts ?? row?.usagecampaigndirectorystarts ?? 0,
      campaignFrontierStarts: row?.usageCampaignFrontierStarts ?? row?.usagecampaignfrontierstarts ?? 0,
      fanDataStarts: row?.usageFanDataStarts ?? row?.usagefandatastarts ?? 0,
      backgroundOtherStarts: row?.usageBackgroundOtherStarts ?? row?.usagebackgroundotherstarts ?? 0,
      unclassifiedStarts: row?.usageUnclassifiedStarts ?? row?.usageunclassifiedstarts ?? 0,
    },
  };
}

async function persistProviderCapacityDebtSnapshot({ db, snapshot } = {}) {
  const context = require("./db-commit-kernel").currentCommitContext();
  if (!context || context.tx !== db) throw Object.assign(new Error("CAPACITY_PUBLICATION_OWNER_REQUIRED"), { code: "CAPACITY_PUBLICATION_OWNER_REQUIRED" });
  if (typeof db?.$queryRawUnsafe !== "function") return { persisted: false, reason: "raw_sql_unavailable", snapshot };
  const rows = await db.$queryRawUnsafe(`
    INSERT INTO "ProviderCapacityDebtState" (
      "id","sourceVersion","sampledAt","revision","status","overloadReason",
      "physicalStartsPerHour","backgroundGuaranteedStartsPerHour",
      "campaignDirectoryGuaranteedStartsPerHour","fanDataGuaranteedStartsPerHour",
      "campaignDirectoryDueCreators","campaignDirectoryOverdueCreators",
      "campaignDirectoryRequiredCalls","campaignDirectoryCapacityDebtCalls","campaignDirectoryOldestDueAt",
      "campaignDirectoryGuaranteedClearHours","campaignDirectoryTargetHours",
      "fanDataUnsatisfiedDemands","fanDataPendingJobs","fanDataCapacityDebtCalls","fanDataOldestRequestedAt",
      "fanDataGuaranteedClearHours","fanDataTargetHours","providerLowerBoundRequiredCalls","providerExclusiveClearHours",
      "actualUsageWindowStartedAt","actualUsageTotalStarts","actualUsageCriticalWriteStarts","actualUsageInteractiveStarts",
      "actualUsageRealtimeStarts","actualUsageNormalStarts","actualUsageCampaignDirectoryStarts","actualUsageCampaignFrontierStarts",
      "actualUsageFanDataStarts","actualUsageBackgroundOtherStarts","actualUsageUnclassifiedStarts","actualUsageAccountingComplete",
      "backgroundOtherPendingJobs","backgroundOtherOldestScheduledAt","backgroundOtherPendingJobClasses","backgroundOtherCallCardinalityKnown",
      "futureDebtCoverageStatus","futureDebtCoverageReason",
      "topologyVersion","topologyId","topologyScope","topologyShardCount","topologyShardingAllowed",
      "controlMode","controlReason","operatorActionRequired","campaignDirectoryAdmissionBudgetCalls","campaignDirectoryGuaranteedCallsPerSweep",
      "projectionRevision","projectionCoverageStatus","createdAt","updatedAt"
    ) VALUES (
      $1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    )
    ON CONFLICT ("id") DO UPDATE SET
      "sourceVersion"=EXCLUDED."sourceVersion",
      "projectionRevision"=EXCLUDED."projectionRevision",
      "projectionCoverageStatus"=EXCLUDED."projectionCoverageStatus",
      "sampledAt"=EXCLUDED."sampledAt",
      "revision"="ProviderCapacityDebtState"."revision" + 1,
      "status"=EXCLUDED."status",
      "overloadReason"=EXCLUDED."overloadReason",
      "physicalStartsPerHour"=EXCLUDED."physicalStartsPerHour",
      "backgroundGuaranteedStartsPerHour"=EXCLUDED."backgroundGuaranteedStartsPerHour",
      "campaignDirectoryGuaranteedStartsPerHour"=EXCLUDED."campaignDirectoryGuaranteedStartsPerHour",
      "fanDataGuaranteedStartsPerHour"=EXCLUDED."fanDataGuaranteedStartsPerHour",
      "campaignDirectoryDueCreators"=EXCLUDED."campaignDirectoryDueCreators",
      "campaignDirectoryOverdueCreators"=EXCLUDED."campaignDirectoryOverdueCreators",
      "campaignDirectoryRequiredCalls"=EXCLUDED."campaignDirectoryRequiredCalls",
      "campaignDirectoryCapacityDebtCalls"=EXCLUDED."campaignDirectoryCapacityDebtCalls",
      "campaignDirectoryOldestDueAt"=EXCLUDED."campaignDirectoryOldestDueAt",
      "campaignDirectoryGuaranteedClearHours"=EXCLUDED."campaignDirectoryGuaranteedClearHours",
      "campaignDirectoryTargetHours"=EXCLUDED."campaignDirectoryTargetHours",
      "fanDataUnsatisfiedDemands"=EXCLUDED."fanDataUnsatisfiedDemands",
      "fanDataPendingJobs"=EXCLUDED."fanDataPendingJobs",
      "fanDataCapacityDebtCalls"=EXCLUDED."fanDataCapacityDebtCalls",
      "fanDataOldestRequestedAt"=EXCLUDED."fanDataOldestRequestedAt",
      "fanDataGuaranteedClearHours"=EXCLUDED."fanDataGuaranteedClearHours",
      "fanDataTargetHours"=EXCLUDED."fanDataTargetHours",
      "providerLowerBoundRequiredCalls"=EXCLUDED."providerLowerBoundRequiredCalls",
      "providerExclusiveClearHours"=EXCLUDED."providerExclusiveClearHours",
      "actualUsageWindowStartedAt"=EXCLUDED."actualUsageWindowStartedAt",
      "actualUsageTotalStarts"=EXCLUDED."actualUsageTotalStarts",
      "actualUsageCriticalWriteStarts"=EXCLUDED."actualUsageCriticalWriteStarts",
      "actualUsageInteractiveStarts"=EXCLUDED."actualUsageInteractiveStarts",
      "actualUsageRealtimeStarts"=EXCLUDED."actualUsageRealtimeStarts",
      "actualUsageNormalStarts"=EXCLUDED."actualUsageNormalStarts",
      "actualUsageCampaignDirectoryStarts"=EXCLUDED."actualUsageCampaignDirectoryStarts",
      "actualUsageCampaignFrontierStarts"=EXCLUDED."actualUsageCampaignFrontierStarts",
      "actualUsageFanDataStarts"=EXCLUDED."actualUsageFanDataStarts",
      "actualUsageBackgroundOtherStarts"=EXCLUDED."actualUsageBackgroundOtherStarts",
      "actualUsageUnclassifiedStarts"=EXCLUDED."actualUsageUnclassifiedStarts",
      "actualUsageAccountingComplete"=EXCLUDED."actualUsageAccountingComplete",
      "backgroundOtherPendingJobs"=EXCLUDED."backgroundOtherPendingJobs",
      "backgroundOtherOldestScheduledAt"=EXCLUDED."backgroundOtherOldestScheduledAt",
      "backgroundOtherPendingJobClasses"=EXCLUDED."backgroundOtherPendingJobClasses",
      "backgroundOtherCallCardinalityKnown"=EXCLUDED."backgroundOtherCallCardinalityKnown",
      "futureDebtCoverageStatus"=EXCLUDED."futureDebtCoverageStatus",
      "futureDebtCoverageReason"=EXCLUDED."futureDebtCoverageReason",
      "topologyVersion"=EXCLUDED."topologyVersion",
      "topologyId"=EXCLUDED."topologyId",
      "topologyScope"=EXCLUDED."topologyScope",
      "topologyShardCount"=EXCLUDED."topologyShardCount",
      "topologyShardingAllowed"=EXCLUDED."topologyShardingAllowed",
      "controlMode"=EXCLUDED."controlMode",
      "controlReason"=EXCLUDED."controlReason",
      "operatorActionRequired"=EXCLUDED."operatorActionRequired",
      "campaignDirectoryAdmissionBudgetCalls"=EXCLUDED."campaignDirectoryAdmissionBudgetCalls",
      "campaignDirectoryGuaranteedCallsPerSweep"=EXCLUDED."campaignDirectoryGuaranteedCallsPerSweep",
      "updatedAt"=CURRENT_TIMESTAMP
    RETURNING *
  `,
  snapshot.id, snapshot.sourceVersion, snapshot.sampledAt, snapshot.status, snapshot.overloadReason,
  snapshot.physicalStartsPerHour, snapshot.backgroundGuaranteedStartsPerHour,
  snapshot.campaignDirectoryGuaranteedStartsPerHour, snapshot.fanDataGuaranteedStartsPerHour,
  snapshot.campaignDirectoryDueCreators, snapshot.campaignDirectoryOverdueCreators,
  snapshot.campaignDirectoryRequiredCalls, snapshot.campaignDirectoryCapacityDebtCalls, snapshot.campaignDirectoryOldestDueAt,
  snapshot.campaignDirectoryGuaranteedClearHours, snapshot.campaignDirectoryTargetHours,
  snapshot.fanDataUnsatisfiedDemands, snapshot.fanDataPendingJobs, snapshot.fanDataCapacityDebtCalls, snapshot.fanDataOldestRequestedAt,
  snapshot.fanDataGuaranteedClearHours, snapshot.fanDataTargetHours, snapshot.providerLowerBoundRequiredCalls, snapshot.providerExclusiveClearHours,
  snapshot.actualUsageWindowStartedAt, snapshot.actualUsageTotalStarts, snapshot.actualUsageCriticalWriteStarts, snapshot.actualUsageInteractiveStarts,
  snapshot.actualUsageRealtimeStarts, snapshot.actualUsageNormalStarts, snapshot.actualUsageCampaignDirectoryStarts, snapshot.actualUsageCampaignFrontierStarts,
  snapshot.actualUsageFanDataStarts, snapshot.actualUsageBackgroundOtherStarts, snapshot.actualUsageUnclassifiedStarts, snapshot.actualUsageAccountingComplete,
  snapshot.backgroundOtherPendingJobs, snapshot.backgroundOtherOldestScheduledAt, snapshot.backgroundOtherPendingJobClasses, snapshot.backgroundOtherCallCardinalityKnown,
  snapshot.futureDebtCoverageStatus, snapshot.futureDebtCoverageReason,
  snapshot.topologyVersion, snapshot.topologyId, snapshot.topologyScope, snapshot.topologyShardCount, snapshot.topologyShardingAllowed,
  snapshot.controlMode, snapshot.controlReason, snapshot.operatorActionRequired, snapshot.campaignDirectoryAdmissionBudgetCalls, snapshot.campaignDirectoryGuaranteedCallsPerSweep, snapshot.projectionRevision, snapshot.projectionCoverageStatus);
  const saved = (Array.isArray(rows) ? rows[0] : rows) || null;
  return { persisted: Boolean(saved), snapshot: saved };
}

async function refreshProviderCapacityDebtSnapshot({ db, batchSize } = {}) {
  const { runProviderCapacityProjectionBatch } = require("./provider-capacity-projection-service");
  return runProviderCapacityProjectionBatch({ db, batchSize, publish: async ({ db: tx, row, now }) => {
    const inputs = capacityInputsFromRow(row);
    const snapshot = deriveProviderCapacityDebtSnapshot({ now, ...inputs, projection: { complete: row.projectionComplete === true, revision: row.revision } });
    const persisted = await persistProviderCapacityDebtSnapshot({ db: tx, snapshot });
    return { ok: persisted.persisted === true, ...persisted, computed: snapshot };
  }});
}

async function readProviderCapacityDebtSnapshot({ db } = {}) {
  if (typeof db?.$queryRawUnsafe !== "function") return null;
  const rows = await db.$queryRawUnsafe(`SELECT * FROM "ProviderCapacityDebtState" WHERE "id"=$1 LIMIT 1`, PROVIDER_CAPACITY_STATE_ID);
  return (Array.isArray(rows) ? rows[0] : rows) || null;
}

module.exports = {
  PROVIDER_CAPACITY_STATE_ID,
  PROVIDER_CAPACITY_SOURCE_VERSION,
  BACKGROUND_OTHER_PROVIDER_JOB_KEYS,
  deriveProviderCapacityDebtSnapshot,
  readCanonicalCapacityInputs,
  persistProviderCapacityDebtSnapshot,
  refreshProviderCapacityDebtSnapshot,
  readProviderCapacityDebtSnapshot,
};
