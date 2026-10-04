BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN "membershipBaselineVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "membershipBaselineObservedAt" TIMESTAMP(3),
  ADD COLUMN "membershipBaselineGeneration" TEXT,
  ADD COLUMN "membershipCatchupVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "membershipCatchupObservedAt" TIMESTAMP(3),
  ADD COLUMN "membershipCatchupGeneration" TEXT;

-- No historical rewrite. The planner can adopt one current committed proof
-- under the creator lock, including full traversals waiting on FanData.
CREATE FUNCTION "onlinod_campaign_membership_proof_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b boolean; c boolean;
BEGIN
  IF TG_OP='UPDATE' AND (NEW."agencyId",NEW."creatorId") IS DISTINCT FROM (OLD."agencyId",OLD."creatorId")
    AND (OLD."membershipBaselineVerifiedAt" IS NOT NULL OR OLD."membershipCatchupVerifiedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'CAMPAIGN_MEMBERSHIP_SCOPE_IMMUTABLE';
  END IF;
  b := (NEW."membershipBaselineVerifiedAt",NEW."membershipBaselineObservedAt",NEW."membershipBaselineGeneration")
    IS DISTINCT FROM (OLD."membershipBaselineVerifiedAt",OLD."membershipBaselineObservedAt",OLD."membershipBaselineGeneration");
  c := (NEW."membershipCatchupVerifiedAt",NEW."membershipCatchupObservedAt",NEW."membershipCatchupGeneration")
    IS DISTINCT FROM (OLD."membershipCatchupVerifiedAt",OLD."membershipCatchupObservedAt",OLD."membershipCatchupGeneration");
  IF NOT b AND NOT c THEN RETURN NEW; END IF;
  IF NEW."membershipCoverageStatus" <> 'COMPLETE' OR NEW."membershipCoverageCompletedAt" IS NULL
    OR NEW."activeGeneration" IS NULL OR NEW."sourceJobId" IS NULL
    OR (b AND (NEW."mode" <> 'full'
      OR NEW."membershipBaselineVerifiedAt" IS DISTINCT FROM NEW."membershipCoverageCompletedAt"
      OR NEW."membershipBaselineObservedAt" IS DISTINCT FROM NEW."membershipObservedAt"
      OR NEW."membershipBaselineGeneration" IS DISTINCT FROM NEW."activeGeneration"))
    OR (c AND (NEW."mode" <> 'catchup'
      OR NEW."membershipCatchupVerifiedAt" IS DISTINCT FROM NEW."membershipCoverageCompletedAt"
      OR NEW."membershipCatchupObservedAt" IS DISTINCT FROM NEW."membershipObservedAt"
      OR NEW."membershipCatchupGeneration" IS DISTINCT FROM NEW."activeGeneration"))
    OR NOT EXISTS (
      SELECT 1 FROM "AnalyticsPublication" p JOIN "JobInstance" j ON j."id"=p."jobId"
      WHERE p."jobId"=NEW."sourceJobId" AND p."agencyId"=NEW."agencyId" AND p."creatorId"=NEW."creatorId"
        AND j."agencyId"=NEW."agencyId" AND j."creatorId"=NEW."creatorId" AND j."jobKey"='fetch_campaigns'
        AND p."payload"->>'scanRunId'=NEW."activeGeneration"
        AND ((p."state"='PENDING' AND p."stage"='FINALIZE' AND j."status"='PUBLISHING')
          OR (p."state"='COMMITTED' AND j."status"='DONE'))
    ) THEN RAISE EXCEPTION 'CAMPAIGN_MEMBERSHIP_PUBLICATION_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_membership_proof_guard_v1"
  BEFORE INSERT OR UPDATE ON "CreatorCampaignCollectionState"
  FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_membership_proof_guard_v1"();
COMMIT;
