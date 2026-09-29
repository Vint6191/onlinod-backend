BEGIN;
SET LOCAL lock_timeout='5s';
-- Phase 6 B1: additive, resumable current projection. No canonical scan in DDL.
-- All canonical writers (including older replicas) enqueue in their own transaction.
CREATE TABLE "ProviderCapacityProjectionState" (
  "id" TEXT PRIMARY KEY,
  "generation" TEXT NOT NULL,
  "jobKeys" TEXT[] NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 0,
  "directoryCursor" TEXT, "directoryComplete" BOOLEAN NOT NULL DEFAULT false,
  "fanCursor" TEXT, "fanComplete" BOOLEAN NOT NULL DEFAULT false,
  "jobCursor" TEXT, "jobComplete" BOOLEAN NOT NULL DEFAULT false,
  "sampledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "ProviderCapacityProjectionState" ("id","generation","jobKeys")
VALUES ('of-global-capacity-v1','phase6_capacity_incremental_v1',ARRAY['fetch_earnings','fetch_campaigns','traffic_sources_scan','fan_data_point_refresh','catchup_notifications_scan','financial_transactions_scan','dialog_intelligence_scan','vault_unsorted_scan','subscriber_directory_scan','likes_content_discovery','sfs_target_discovery','sfs_target_scan']);
CREATE TABLE "ProviderCapacityDirty" (
  "kind" TEXT NOT NULL CHECK ("kind" IN ('directory','fan','job')),
  "sourceId" TEXT NOT NULL,
  "touchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("kind","sourceId")
);
CREATE INDEX "ProviderCapacityDirty_turn_idx" ON "ProviderCapacityDirty" ("touchedAt","kind","sourceId");
CREATE TABLE "ProviderCapacityContribution" (
  "kind" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "bucket" TEXT NOT NULL,
  "itemCount" BIGINT NOT NULL DEFAULT 0 CHECK ("itemCount" >= 0),
  "overdueCount" BIGINT NOT NULL DEFAULT 0 CHECK ("overdueCount" >= 0),
  "requiredCalls" BIGINT NOT NULL DEFAULT 0 CHECK ("requiredCalls" >= 0),
  "oldestAt" TIMESTAMP(3), "nextDueAt" TIMESTAMP(3),
  PRIMARY KEY ("kind","sourceId")
);
CREATE INDEX "ProviderCapacityContribution_oldest_idx" ON "ProviderCapacityContribution" ("bucket","oldestAt") WHERE "oldestAt" IS NOT NULL;
CREATE INDEX "ProviderCapacityContribution_due_idx" ON "ProviderCapacityContribution" ("nextDueAt","kind","sourceId") WHERE "nextDueAt" IS NOT NULL;
CREATE TABLE "ProviderCapacityBucket" (
  "bucket" TEXT PRIMARY KEY,
  "itemCount" BIGINT NOT NULL DEFAULT 0 CHECK ("itemCount" >= 0),
  "overdueCount" BIGINT NOT NULL DEFAULT 0 CHECK ("overdueCount" >= 0),
  "requiredCalls" BIGINT NOT NULL DEFAULT 0 CHECK ("requiredCalls" >= 0)
);

CREATE FUNCTION onlinod_capacity_mark_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Preserve first enqueue time: a hot source must not move to the end forever.
  INSERT INTO "ProviderCapacityDirty" ("kind","sourceId","touchedAt")
  VALUES (TG_ARGV[0], CASE WHEN TG_OP='DELETE' THEN OLD."id" ELSE NEW."id" END, clock_timestamp())
  ON CONFLICT ("kind","sourceId") DO UPDATE SET "sourceId"=EXCLUDED."sourceId";
  -- An id rewrite is rare but must retract the former contribution too.
  IF TG_OP='UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
    INSERT INTO "ProviderCapacityDirty" ("kind","sourceId","touchedAt")
    VALUES (TG_ARGV[0], OLD."id", clock_timestamp()) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER onlinod_capacity_directory_dirty
AFTER INSERT OR DELETE OR UPDATE OF "id","baselineVerifiedAt","campaignDirectoryDiscoveryRequestedRevision","campaignDirectoryDiscoveryCompletedRevision","campaignDirectoryDiscoveryDueAt","campaignDirectoryCampaignCount"
ON "CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION onlinod_capacity_mark_dirty('directory');
CREATE TRIGGER onlinod_capacity_fan_dirty
AFTER INSERT OR DELETE OR UPDATE OF "id","requestedRevision","satisfiedRevision","lastRequestedAt"
ON "CreatorFanRefreshDemand" FOR EACH ROW EXECUTE FUNCTION onlinod_capacity_mark_dirty('fan');
CREATE TRIGGER onlinod_capacity_job_dirty
AFTER INSERT OR DELETE OR UPDATE OF "id","jobKey","status","scheduledAt"
ON "JobInstance" FOR EACH ROW EXECUTE FUNCTION onlinod_capacity_mark_dirty('job');

ALTER TABLE "ProviderCapacityDebtState"
  ADD COLUMN "projectionRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "projectionCoverageStatus" TEXT NOT NULL DEFAULT 'PARTIAL';
-- Fail conservative immediately, including while old binaries are being drained.
UPDATE "ProviderCapacityDebtState" SET "status"='UNKNOWN',
  "overloadReason"='CAPACITY_PROJECTION_REBUILD_OR_LAG',
  "futureDebtCoverageStatus"='PARTIAL', "futureDebtCoverageReason"='CAPACITY_PROJECTION_REBUILD_OR_LAG',
  "controlMode"='CONSERVATIVE', "controlReason"='CAPACITY_STATUS_UNKNOWN',
  "campaignDirectoryAdmissionBudgetCalls"="campaignDirectoryGuaranteedCallsPerSweep";
CREATE FUNCTION onlinod_capacity_publication_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Legacy binaries can finish work but cannot publish over the new authority.
  IF NEW."sourceVersion" <> 'phase6_provider_capacity_debt_v1' THEN RETURN NULL; END IF;
  IF current_setting('onlinod.capacity_projection_revision',true) IS DISTINCT FROM NEW."projectionRevision"::text
    OR NOT EXISTS (SELECT 1 FROM "ProviderCapacityProjectionState" WHERE "id"=NEW."id"
      AND "generation"='phase6_capacity_incremental_v1' AND "revision"=NEW."projectionRevision") THEN
    RAISE EXCEPTION 'CAPACITY_PUBLICATION_OWNER_REQUIRED';
  END IF;
  IF TG_OP='UPDATE' AND (NEW."projectionRevision" <= OLD."projectionRevision" OR NEW."sampledAt" < OLD."sampledAt") THEN
    RAISE EXCEPTION 'CAPACITY_PUBLICATION_STALE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER onlinod_capacity_publication_fence
BEFORE INSERT OR UPDATE ON "ProviderCapacityDebtState"
FOR EACH ROW EXECUTE FUNCTION onlinod_capacity_publication_fence();

COMMIT;
