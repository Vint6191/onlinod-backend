BEGIN;
SET LOCAL lock_timeout='5s';

-- Retained receipt rows are not a queue. Cut over without rewriting history.
-- The BEFORE STATEMENT fence rejects old binaries before their unbounded scan.
CREATE FUNCTION onlinod_campaign_refresh_work_writer_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Referential actions may clear a Job/Demand FK during lifecycle cleanup.
  IF pg_trigger_depth()>1 THEN RETURN NULL; END IF;
  IF current_setting('onlinod.campaign_refresh_work_version',true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_EXECUTOR_REQUIRED';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER campaign_refresh_work_writer_v2
BEFORE INSERT OR UPDATE ON "CreatorCampaignFanRefreshWork"
FOR EACH STATEMENT EXECUTE FUNCTION onlinod_campaign_refresh_work_writer_v2();

CREATE FUNCTION onlinod_campaign_refresh_work_scope_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth()>1 THEN RETURN NEW; END IF;
  IF current_setting('onlinod.campaign_refresh_creator',true) IS DISTINCT FROM NEW."creatorId" THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_CREATOR_REQUIRED';
  END IF;
  IF TG_OP='UPDATE' AND
    ROW(NEW."id",NEW."agencyId",NEW."creatorId",NEW."scanRunId",NEW."scanStartedAt",NEW."onlyFansUserId",
      NEW."campaignJobId",NEW."demandId",NEW."requestedRevision",NEW."freshnessCutoffAt") IS DISTINCT FROM
    ROW(OLD."id",OLD."agencyId",OLD."creatorId",OLD."scanRunId",OLD."scanStartedAt",OLD."onlyFansUserId",
      OLD."campaignJobId",OLD."demandId",OLD."requestedRevision",OLD."freshnessCutoffAt") THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_IDENTITY_IMMUTABLE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "CreatorCampaignCollectionState" s
    WHERE s."agencyId"=NEW."agencyId" AND s."creatorId"=NEW."creatorId"
      AND s."fanValueCoverageScanRunId"=NEW."scanRunId") THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_GENERATION_SUPERSEDED';
  END IF;
  IF NEW."demandId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "CreatorFanRefreshDemand" d
    WHERE d."id"=NEW."demandId" AND d."agencyId"=NEW."agencyId"
      AND d."creatorId"=NEW."creatorId" AND d."onlyFansUserId"=NEW."onlyFansUserId") THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_DEMAND_SCOPE_INVALID';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "JobInstance" j WHERE j."id"=NEW."campaignJobId"
    AND j."agencyId"=NEW."agencyId" AND j."creatorId"=NEW."creatorId")
    OR (NEW."refreshJobId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "JobInstance" j
      WHERE j."id"=NEW."refreshJobId" AND j."agencyId"=NEW."agencyId" AND j."creatorId"=NEW."creatorId")) THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_JOB_SCOPE_INVALID';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaign_refresh_work_scope_v2
BEFORE INSERT OR UPDATE ON "CreatorCampaignFanRefreshWork"
FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_refresh_work_scope_v2();

-- Large-table indexes are built CONCURRENTLY by the existing deployment hook.
-- Existing immutable migrations, Work IDs, Demand IDs and receipts are retained.
COMMIT;
