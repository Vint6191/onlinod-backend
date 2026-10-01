BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL TIME ZONE 'UTC';

-- Drain the sole capacity publisher before taking source-table DDL locks.
SELECT pg_advisory_xact_lock(hashtext('phase6-capacity-projection-v1'));

-- Additive metadata only. Do not backfill or rewrite historical facts.
-- Missing observed timestamps preserve completed baselines as usable STALE;
-- bounded ordinary catch-ups populate fresh evidence without a full rebuild.
ALTER TABLE "CreatorNotificationSyncState"
  ADD COLUMN "fullBackfillObservedAt" TIMESTAMP(3),
  ADD COLUMN "lastCatchupObservedAt" TIMESTAMP(3);
ALTER TABLE "CreatorFinancialCollectionState"
  ADD COLUMN "baselineObservedAt" TIMESTAMP(3),
  ADD COLUMN "lastCatchupObservedAt" TIMESTAMP(3);
ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN "baselineObservedAt" TIMESTAMP(3),
  ADD COLUMN "lastCatchupObservedAt" TIMESTAMP(3),
  ADD COLUMN "membershipObservedAt" TIMESTAMP(3);
ALTER TABLE "AnalyticsScanProof"
  ADD COLUMN "observationStartedAt" TIMESTAMP(3);

-- A bounded reseed must revisit the new source-age semantics. Keep existing
-- contributions: dirty repair subtracts/replaces them without double counting.
-- Fan/job bootstrap progress and all canonical facts remain intact.
DROP TRIGGER onlinod_capacity_directory_dirty ON "CreatorCampaignCollectionState";
CREATE TRIGGER onlinod_capacity_directory_dirty
AFTER INSERT OR DELETE OR UPDATE OF "id","baselineVerifiedAt",
  "campaignDirectoryDiscoveryRequestedRevision","campaignDirectoryDiscoveryCompletedRevision",
  "campaignDirectoryDiscoveryDueAt","campaignDirectoryCampaignCount",
  "campaignDirectoryVerifiedAt","campaignDirectoryRequestedAt"
ON "CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION onlinod_capacity_mark_dirty('directory');

-- Move the persisted publication fence atomically with its generation.
CREATE OR REPLACE FUNCTION onlinod_capacity_publication_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Legacy binaries can finish work but cannot publish over the new authority.
  IF NEW."sourceVersion" <> 'phase6_provider_capacity_debt_v1' THEN RETURN NULL; END IF;
  IF current_setting('onlinod.capacity_projection_revision',true) IS DISTINCT FROM NEW."projectionRevision"::text
    OR NOT EXISTS (SELECT 1 FROM "ProviderCapacityProjectionState" WHERE "id"=NEW."id"
      AND "generation"='phase6_capacity_observation_v2' AND "revision"=NEW."projectionRevision") THEN
    RAISE EXCEPTION 'CAPACITY_PUBLICATION_OWNER_REQUIRED';
  END IF;
  IF TG_OP='UPDATE' AND (NEW."projectionRevision" <= OLD."projectionRevision" OR NEW."sampledAt" < OLD."sampledAt") THEN
    RAISE EXCEPTION 'CAPACITY_PUBLICATION_STALE';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE current_state "ProviderCapacityProjectionState"%ROWTYPE;
BEGIN
  SELECT * INTO current_state FROM "ProviderCapacityProjectionState"
    WHERE "id"='of-global-capacity-v1' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAPACITY_PROJECTION_STATE_MISSING'; END IF;
  IF current_state."generation" <> 'phase6_capacity_incremental_v1' THEN
    RAISE EXCEPTION 'CAPACITY_PROJECTION_GENERATION_MISMATCH';
  END IF;
  UPDATE "ProviderCapacityProjectionState" SET
    "generation"='phase6_capacity_observation_v2',
    "directoryCursor"=NULL,"directoryComplete"=false,
    "revision"="revision"+1,"sampledAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
    WHERE "id"=current_state."id" RETURNING * INTO current_state;
  PERFORM set_config('onlinod.capacity_projection_revision',current_state."revision"::text,true);
  UPDATE "ProviderCapacityDebtState" SET
    "sourceVersion"='phase6_provider_capacity_debt_v1',
    "revision"="revision"+1,"projectionRevision"=current_state."revision",
    "sampledAt"=current_state."sampledAt","updatedAt"=current_state."sampledAt",
    "status"='UNKNOWN',"overloadReason"='ANALYTICS_OBSERVATION_TRANSITION',
    "projectionCoverageStatus"='PARTIAL',"futureDebtCoverageStatus"='PARTIAL',
    "futureDebtCoverageReason"='ANALYTICS_OBSERVATION_TRANSITION',
    "controlMode"='CONSERVATIVE',"controlReason"='CAPACITY_STATUS_UNKNOWN',
    "operatorActionRequired"=false,
    "campaignDirectoryAdmissionBudgetCalls"="campaignDirectoryGuaranteedCallsPerSweep"
    WHERE "id"=current_state."id";
END $$;

COMMIT;
