BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL TIME ZONE 'UTC';

ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN "campaignFrontierSelection" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "campaignDirectoryFactsRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "campaignDirectoryCountRevision" BIGINT;

-- A count certifies a directory only while its fact identity is unchanged.
-- Claimer progress/metadata/retirement do not change membership of a directory.
-- No historical rewrite: old directories are verified on first reuse/seal.
CREATE FUNCTION "campaign_directory_facts_clock_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_creator TEXT; next_creator TEXT; target_creator TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND
    (OLD."creatorId", OLD."externalCampaignId", OLD."sourceScanRunId", OLD."sourceScanStartedAt")
    IS NOT DISTINCT FROM
    (NEW."creatorId", NEW."externalCampaignId", NEW."sourceScanRunId", NEW."sourceScanStartedAt") THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN previous_creator := OLD."creatorId"; END IF;
  IF TG_OP <> 'DELETE' THEN next_creator := NEW."creatorId"; END IF;
  FOR target_creator IN SELECT DISTINCT c FROM unnest(ARRAY[previous_creator,next_creator]) c
    WHERE c IS NOT NULL ORDER BY c LOOP
    UPDATE "CreatorCampaignCollectionState"
      SET "campaignDirectoryFactsRevision" = "campaignDirectoryFactsRevision" + 1
      WHERE "creatorId" = target_creator;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_directory_facts_clock_v1_trg"
AFTER INSERT OR DELETE OR UPDATE OF "creatorId", "externalCampaignId", "sourceScanRunId", "sourceScanStartedAt"
ON "CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION "campaign_directory_facts_clock_v1"();

CREATE FUNCTION "campaign_directory_count_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('onlinod.campaign_directory_count_version', true) IS DISTINCT FROM '1'
    AND (TG_OP = 'INSERT' OR
      (OLD."campaignDirectoryGeneration", OLD."campaignDirectoryRequestedAt", OLD."campaignDirectoryRevision", OLD."campaignDirectoryCampaignCount")
      IS DISTINCT FROM
      (NEW."campaignDirectoryGeneration", NEW."campaignDirectoryRequestedAt", NEW."campaignDirectoryRevision", NEW."campaignDirectoryCampaignCount")) THEN
    NEW."campaignDirectoryCountRevision" := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_directory_count_guard_v1_trg"
BEFORE INSERT OR UPDATE OF "campaignDirectoryGeneration", "campaignDirectoryRequestedAt", "campaignDirectoryRevision", "campaignDirectoryCampaignCount", "campaignDirectoryCountRevision"
ON "CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION "campaign_directory_count_guard_v1"();

-- An old Backend cannot re-lease a bounded traversal to a v1 Desktop. Existing
-- leases and legacy jobs keep their established protocol during rolling deploy.
CREATE FUNCTION "campaign_bounded_claim_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."jobKey" = 'fetch_campaigns' AND NEW."status" = 'CLAIMED'
    AND NEW."params"->>'campaignBoundedTraversalVersion' = '1'
    AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."leaseRevision" IS DISTINCT FROM NEW."leaseRevision"
      OR OLD."claimedByDeviceId" IS DISTINCT FROM NEW."claimedByDeviceId"
      OR OLD."continuation" IS DISTINCT FROM NEW."continuation")
    AND current_setting('onlinod.campaign_bounded_traversal_version', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'CAMPAIGN_BOUNDED_TRAVERSAL_CLAIM_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_bounded_claim_guard_v1_trg"
BEFORE INSERT OR UPDATE OF "status", "leaseRevision", "claimedByDeviceId", "params", "continuation"
ON "JobInstance" FOR EACH ROW EXECUTE FUNCTION "campaign_bounded_claim_guard_v1"();

-- Supporting range indexes are built concurrently by analytics-traffic-indexes.
COMMIT;
