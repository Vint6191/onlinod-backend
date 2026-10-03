BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL TIME ZONE 'UTC';

-- Lazy source evidence: no rewrite or scan of historical membership rows.
ALTER TABLE "CreatorCampaign"
  ADD COLUMN "claimersTraversalRunId" VARCHAR(120),
  ADD COLUMN "claimersTraversalStartedAt" TIMESTAMP(3),
  ADD COLUMN "claimersTraversalRevision" INTEGER,
  ADD COLUMN "claimersTraversalRejectedRows" INTEGER NOT NULL DEFAULT 0;

CREATE FUNCTION "campaign_traversal_origin_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."claimersTraversalRejectedRows" IS DISTINCT FROM OLD."claimersTraversalRejectedRows" THEN
    IF current_setting('onlinod.campaign_traversal_authority_version',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_ORIGIN_WRITER_REQUIRED';
    END IF;
    IF NEW."claimersTraversalRejectedRows" < 0 OR
      (NEW."claimersTraversalRunId" IS NOT DISTINCT FROM OLD."claimersTraversalRunId"
        AND NEW."claimersTraversalRejectedRows" < OLD."claimersTraversalRejectedRows") THEN
      RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_REJECTIONS_CANNOT_REWIND';
    END IF;
  END IF;
  IF (NEW."claimersTraversalRunId",NEW."claimersTraversalStartedAt",NEW."claimersTraversalRevision")
    IS DISTINCT FROM (OLD."claimersTraversalRunId",OLD."claimersTraversalStartedAt",OLD."claimersTraversalRevision") THEN
    IF current_setting('onlinod.campaign_traversal_authority_version',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_ORIGIN_WRITER_REQUIRED';
    END IF;
    IF OLD."claimersTraversalRunId" IS NOT NULL AND NEW."claimersTraversalRunId" = OLD."claimersTraversalRunId"
      AND OLD."claimersTraversalStartedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_ORIGIN_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_traversal_origin_guard_v1_trg"
BEFORE UPDATE OF "claimersTraversalRunId","claimersTraversalStartedAt","claimersTraversalRevision","claimersTraversalRejectedRows"
ON "CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION "campaign_traversal_origin_guard_v1"();

CREATE FUNCTION "campaign_traversal_job_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."jobKey" <> 'fetch_campaigns' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD."params"->>'campaignTraversalAuthorityVersion' = '1'
    AND NEW."params"->>'campaignTraversalAuthorityVersion' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_PROTOCOL_DOWNGRADE';
  END IF;
  IF NEW."params"->>'campaignTraversalAuthorityVersion' = '1'
    AND NEW."status" IN ('CLAIMED','PUBLISHING','DONE')
    AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."leaseRevision" IS DISTINCT FROM NEW."leaseRevision"
      OR OLD."claimedByDeviceId" IS DISTINCT FROM NEW."claimedByDeviceId"
      OR OLD."params" IS DISTINCT FROM NEW."params"
      OR OLD."continuation" IS DISTINCT FROM NEW."continuation")
    AND current_setting('onlinod.campaign_traversal_authority_version',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_AUTHORITY_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_traversal_job_guard_v1_trg"
BEFORE INSERT OR UPDATE OF "status","leaseRevision","claimedByDeviceId","params","continuation"
ON "JobInstance" FOR EACH ROW EXECUTE FUNCTION "campaign_traversal_job_guard_v1"();

-- A progress request with unchanged JSON can still ingest a page. Fence the
-- receipt too, so old binaries cannot bypass the job guard through that path.
CREATE FUNCTION "campaign_traversal_ingest_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."dataType" = 'CAMPAIGNS' AND NEW."sourceJobId" IS NOT NULL
    AND current_setting('onlinod.campaign_traversal_authority_version',true) IS DISTINCT FROM '1'
    AND EXISTS (SELECT 1 FROM "JobInstance" j WHERE j."id"=NEW."sourceJobId"
      AND j."params"->>'campaignTraversalAuthorityVersion'='1') THEN
    RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_INGEST_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_traversal_ingest_guard_v1_trg"
BEFORE INSERT OR UPDATE ON "AnalyticsIngestBatch"
FOR EACH ROW EXECUTE FUNCTION "campaign_traversal_ingest_guard_v1"();
COMMIT;
