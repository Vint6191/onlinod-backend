BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE "CreatorCampaign"
  ADD COLUMN "claimersCursorRunId" VARCHAR(120),
  ADD COLUMN "claimersCursorPage" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimersCursorOffset" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimersCursorPending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "claimersEligibleAt" TIMESTAMP(3),
  ADD CONSTRAINT "campaign_fair_cursor_nonnegative" CHECK ("claimersCursorPage">=0 AND "claimersCursorOffset">=0);
ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN "campaignFrontierNextEligibleAt" TIMESTAMP(3),
  ADD COLUMN "campaignFrontierScheduleVersion" INTEGER NOT NULL DEFAULT 0;

-- One cursor per campaign, overwritten only by an accepted new generation.
-- No retained per-page queue or unbounded migration/backfill of fact history.
CREATE FUNCTION "campaign_fair_cursor_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean;
BEGIN
  changed := (NEW."claimersCursorRunId",NEW."claimersCursorPage",NEW."claimersCursorOffset",NEW."claimersCursorPending")
    IS DISTINCT FROM (OLD."claimersCursorRunId",COALESCE(OLD."claimersCursorPage",0),COALESCE(OLD."claimersCursorOffset",0),COALESCE(OLD."claimersCursorPending",false));
  IF changed THEN
    IF current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1'
      OR current_setting('onlinod.campaign_refresh_creator',true) IS DISTINCT FROM NEW."creatorId"
      OR NOT EXISTS(SELECT 1 FROM "CreatorCampaignCollectionState" s JOIN "JobInstance" j ON j.id=s."sourceJobId"
        WHERE s."creatorId"=NEW."creatorId" AND s."agencyId"=NEW."agencyId" AND s."activeGeneration"=NEW."claimersCursorRunId"
          AND j."creatorId"=s."creatorId" AND j."agencyId"=s."agencyId" AND j."status"='CLAIMED'
          AND j."params"->>'campaignFairPagesVersion'='1' AND j."params"->>'collectionGeneration'=s."activeGeneration")
      THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_CURSOR_WRITER_REQUIRED'; END IF;
    IF NEW."claimersCursorRunId" IS DISTINCT FROM OLD."claimersCursorRunId" THEN
      IF NEW."claimersCursorRunId" IS NULL OR NEW."claimersCursorPage"<>0 OR NEW."claimersCursorOffset"<>0 OR NOT NEW."claimersCursorPending"
        THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_CURSOR_INITIAL_INVALID'; END IF;
    ELSIF NOT OLD."claimersCursorPending" OR NEW."claimersCursorPage"<>OLD."claimersCursorPage"+1
      OR NEW."claimersCursorOffset"<OLD."claimersCursorOffset" OR NEW."claimersCursorOffset">OLD."claimersCursorOffset"+50
      THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_CURSOR_TRANSITION_INVALID'; END IF;
  END IF;
  -- Metadata or old binaries cannot retain a now-unjustified retry deadline.
  IF current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1' AND
    (NEW."claimersNextDueAt",NEW."claimerRevision",NEW."claimersObservationVersion") IS DISTINCT FROM
    (OLD."claimersNextDueAt",OLD."claimerRevision",OLD."claimersObservationVersion") THEN NEW."claimersEligibleAt":=NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_fair_cursor_guard_v1_trg" BEFORE INSERT OR UPDATE ON "CreatorCampaign"
  FOR EACH ROW EXECUTE FUNCTION "campaign_fair_cursor_guard_v1"();

CREATE FUNCTION "campaign_fair_job_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."jobKey"<>'fetch_campaigns' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD."params"->>'campaignFairPagesVersion'='1' AND NEW."params"->>'campaignFairPagesVersion' IS DISTINCT FROM '1'
    THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_PROTOCOL_DOWNGRADE'; END IF;
  IF NEW."params"->>'campaignFairPagesVersion'='1'
    AND (NEW.status IN ('CLAIMED','PUBLISHING','DONE') OR NEW.params IS DISTINCT FROM OLD.params OR NEW.continuation IS DISTINCT FROM OLD.continuation) AND
    (TG_OP='INSERT' OR (NEW.status,NEW."leaseRevision",NEW."claimedByDeviceId",NEW.params,NEW.continuation)
      IS DISTINCT FROM (OLD.status,OLD."leaseRevision",OLD."claimedByDeviceId",OLD.params,OLD.continuation))
    AND current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1'
    THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_EXECUTOR_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_fair_job_guard_v1_trg" BEFORE INSERT OR UPDATE ON "JobInstance"
  FOR EACH ROW EXECUTE FUNCTION "campaign_fair_job_guard_v1"();
CREATE FUNCTION "campaign_fair_ingest_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."dataType"='CAMPAIGNS' AND current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1'
    AND EXISTS(SELECT 1 FROM "JobInstance" j WHERE j.id=NEW."sourceJobId" AND j.params->>'campaignFairPagesVersion'='1')
    THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_INGEST_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_fair_ingest_guard_v1_trg" BEFORE INSERT OR UPDATE ON "AnalyticsIngestBatch"
  FOR EACH ROW EXECUTE FUNCTION "campaign_fair_ingest_guard_v1"();
CREATE FUNCTION "campaign_fair_schedule_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1' THEN
    NEW."campaignFrontierScheduleVersion":=0; NEW."campaignFrontierNextEligibleAt":=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_fair_schedule_guard_v1_trg" BEFORE INSERT OR UPDATE OF "campaignFrontierPlanRunId","campaignFrontierNextDueAt","campaignFrontierNextEligibleAt","campaignFrontierScheduleVersion"
  ON "CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION "campaign_fair_schedule_guard_v1"();
COMMIT;
