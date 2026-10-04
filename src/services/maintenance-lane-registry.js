"use strict";

// Executable catalog: names, ordinals and callbacks come from the same source.
// Existing ordinals are append-only within this generation's migration contract.
const MAINTENANCE_ADMISSION_GENERATION = "phase6_maintenance_registry_v5";
const scheduler = "./job-scheduler";
const MAINTENANCE_LANES = Object.freeze([
  ["providerCapacityProjection", "./provider-capacity-debt-authority-service", "refreshProviderCapacityDebtSnapshot"],
  ["messageLibraryTrash", "./message-library-lifecycle-service", "runMessageLibraryTrashMaintenance"],
  ["adminBillingPricing", "./admin-bulk-pricing-command-service", "runAdminBulkPricingSweep"],
  ["notificationHistoryRepair", "./notification-history-repair-service", "runNotificationHistoryRepairSweep"],
  ["notificationConsequences", "./notification-consequence-service", "runNotificationConsequenceSweep"],
  ["agencyDestructiveCleanup", scheduler, "runAgencyDestructiveCleanupSweep"],
  ["creatorDestructiveCleanup", scheduler, "runCreatorDestructiveCleanupSweep"],
  ["providerOperationalBackfill", scheduler, "maybeBackfillProviderOperationalDebt"],
  ["subscriberDirectoryMaintenance", "./subscriber-directory-maintenance-service", "runSubscriberDirectoryMaintenance", { maxSignals: 16, concurrency: 4, maxRuntimeMs: 5000, recoveryStepsPerRun: 4, retentionBatch: 50 }],
  ["creatorRecurringPlanning", scheduler, "runRecurringCreatorWork"],
  ["campaignFanRefreshPromotion", "./campaign-fan-refresh-queue-service", "runCampaignFanRefreshPromotionMaintenance", { maxCreators: 200, maxJobsPerCreator: 4, concurrency: 4, maxRuntimeMs: 8000 }],
  ["dependencyFanout", scheduler, "maybeRunPhase2DependencyFanout"],
  ["customReminderWork", scheduler, "maybePlanDueCustomReminderWork"],
  ["providerOperationalDirty", scheduler, "maybeRepairProviderOperationalDirty"],
  ["telegramConfirmedProjection", scheduler, "runTelegramConfirmedProjectionMaintenanceSweep"],
  ["telegramInboundProjection", scheduler, "runTelegramInboundProjectionMaintenanceSweep"],
  ["customExternalProofConvergence", scheduler, "runCustomExternalProofConvergenceSweep"],
  ["teamMoneyReconciliation", scheduler, "runTeamMoneyReconciliationSweep"],
  ["teamReadSummary", scheduler, "runTeamReadSummarySweep"],
  ["teamPendingBackfill", scheduler, "maybeBackfillTeamPendingProjection"],
  ["teamResponseRangeRepair", scheduler, "runTeamResponseRangeRepairSweep"],
  ["teamLegacyPendingRepair", scheduler, "maybeRepairLegacyTeamPendingBootstrap"],
  ["analyticsPublication", "./analytics-publication-service", "runAnalyticsPublicationSweep"],
  ["trafficProjection", "./traffic-projection-service", "runTrafficProjectionSweep"],
  ["campaignReadProjection", "./campaign-read-projection-service", "seedCampaignProjection"],
  ["financialReceiptRetention", "./financial-receipt-retention-service", "runSweep"],
  ["analyticsFactPublication", "./analytics-fact-publication-service", "runSweep"],
  ["fanObservationTokenRetention", "./background-retention-service", "runFanObservationTokenRetention"],
  ["providerWaiterRetention", "./background-retention-service", "runProviderWaiterRetention"],
  ["massObservationRetention", "./mass-queue-observation-service", "runMassObservationRetention"],
].map(([name, module, method, options = {}], ordinal) => Object.freeze({ name, module, method, ordinal, options: Object.freeze(options) })));
const MAINTENANCE_LANE_NAMES = Object.freeze(MAINTENANCE_LANES.map(lane => lane.name));
if (new Set(MAINTENANCE_LANE_NAMES).size !== MAINTENANCE_LANES.length || MAINTENANCE_LANES.length > 64) {
  throw new Error("MAINTENANCE_REGISTRY_INVALID");
}

// Resolve lazily, after job-scheduler has finished loading; never capture partial
// CommonJS exports through an import cycle. Validate ALL handlers before admission.
function resolveMaintenanceLanes({ db, now = new Date() } = {}) {
  return new Map(MAINTENANCE_LANES.map(lane => {
    const run = require(lane.module)[lane.method];
    if (typeof run !== "function") throw Object.assign(new Error(`MAINTENANCE_HANDLER_MISSING:${lane.name}`), { code: "MAINTENANCE_HANDLER_MISSING" });
    return [lane.name, () => run({ db, now, ...lane.options })];
  }));
}
module.exports = { MAINTENANCE_ADMISSION_GENERATION, MAINTENANCE_LANES, MAINTENANCE_LANE_NAMES, resolveMaintenanceLanes };
