BEGIN;
SET LOCAL lock_timeout='5s';
-- Constant-size admission metadata only. No domain history scan or business lease.
CREATE TABLE "MaintenanceAdmissionClassState" (
  "generation" VARCHAR(80) NOT NULL,
  "laneName" VARCHAR(120) NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0 AND "ordinal" < 64),
  "turnCount" BIGINT NOT NULL DEFAULT 0 CHECK ("turnCount" >= 0),
  "lastAdmittedAt" TIMESTAMP(3),
  PRIMARY KEY ("generation","laneName"),
  CONSTRAINT "MaintenanceAdmissionClassState_generation_ordinal_key" UNIQUE ("generation","ordinal")
);
CREATE INDEX "MaintenanceAdmissionClassState_turn_idx"
ON "MaintenanceAdmissionClassState" ("generation","turnCount","ordinal");
INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal") VALUES
  ('phase6_maintenance_progress_v1','providerCapacityProjection',0),
  ('phase6_maintenance_progress_v1','messageLibraryTrash',1),
  ('phase6_maintenance_progress_v1','adminBillingPricing',2),
  ('phase6_maintenance_progress_v1','notificationHistoryRepair',3),
  ('phase6_maintenance_progress_v1','notificationConsequences',4),
  ('phase6_maintenance_progress_v1','agencyDestructiveCleanup',5),
  ('phase6_maintenance_progress_v1','creatorDestructiveCleanup',6),
  ('phase6_maintenance_progress_v1','providerOperationalBackfill',7),
  ('phase6_maintenance_progress_v1','subscriberDirectoryMaintenance',8),
  ('phase6_maintenance_progress_v1','creatorRecurringPlanning',9),
  ('phase6_maintenance_progress_v1','campaignFanRefreshPromotion',10),
  ('phase6_maintenance_progress_v1','dependencyFanout',11),
  ('phase6_maintenance_progress_v1','customReminderWork',12),
  ('phase6_maintenance_progress_v1','providerOperationalDirty',13),
  ('phase6_maintenance_progress_v1','telegramConfirmedProjection',14),
  ('phase6_maintenance_progress_v1','telegramInboundProjection',15),
  ('phase6_maintenance_progress_v1','customExternalProofConvergence',16),
  ('phase6_maintenance_progress_v1','teamMoneyReconciliation',17),
  ('phase6_maintenance_progress_v1','teamReadSummary',18),
  ('phase6_maintenance_progress_v1','teamPendingBackfill',19),
  ('phase6_maintenance_progress_v1','teamResponseRangeRepair',20),
  ('phase6_maintenance_progress_v1','teamLegacyPendingRepair',21);
-- A future catalog change uses an explicit new generation (all peers start
-- balanced); do not add a zero-turn class to a long-running generation.
COMMIT;
