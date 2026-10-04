BEGIN;
-- New generation only: preserve v3 and its progress for rolling deployment.
-- Large retention indexes are built CONCURRENTLY by the deploy postflight.
WITH catalog("laneName","ordinal") AS (VALUES
    ('providerCapacityProjection',0),
    ('messageLibraryTrash',1),
    ('adminBillingPricing',2),
    ('notificationHistoryRepair',3),
    ('notificationConsequences',4),
    ('agencyDestructiveCleanup',5),
    ('creatorDestructiveCleanup',6),
    ('providerOperationalBackfill',7),
    ('subscriberDirectoryMaintenance',8),
    ('creatorRecurringPlanning',9),
    ('campaignFanRefreshPromotion',10),
    ('dependencyFanout',11),
    ('customReminderWork',12),
    ('providerOperationalDirty',13),
    ('telegramConfirmedProjection',14),
    ('telegramInboundProjection',15),
    ('customExternalProofConvergence',16),
    ('teamMoneyReconciliation',17),
    ('teamReadSummary',18),
    ('teamPendingBackfill',19),
    ('teamResponseRangeRepair',20),
    ('teamLegacyPendingRepair',21),
    ('analyticsPublication',22),
    ('trafficProjection',23),
    ('campaignReadProjection',24),
    ('financialReceiptRetention',25),
    ('analyticsFactPublication',26),
    ('fanObservationTokenRetention',27),
    ('providerWaiterRetention',28)
), baseline AS (
  SELECT COALESCE(min("turnCount"),0) AS turns FROM "MaintenanceAdmissionClassState"
  WHERE "generation"='phase6_maintenance_campaign_read_v3'
)
INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName","ordinal","turnCount","lastAdmittedAt")
SELECT 'phase6_maintenance_registry_v4',c."laneName",c."ordinal",
  COALESCE(prior."turnCount",baseline.turns),prior."lastAdmittedAt"
FROM catalog c CROSS JOIN baseline LEFT JOIN "MaintenanceAdmissionClassState" prior
  ON prior."generation"='phase6_maintenance_campaign_read_v3' AND prior."laneName"=c."laneName"
ON CONFLICT ("generation","laneName") DO NOTHING;
COMMIT;
