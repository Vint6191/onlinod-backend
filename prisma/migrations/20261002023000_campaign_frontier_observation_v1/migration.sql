BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL TIME ZONE 'UTC';

-- Old receipt-time deadlines stay readable but do not certify source age.
-- Constant defaults install metadata; ordinary bounded catch-ups reverify old
-- frontiers. There is no UPDATE over historical campaigns in this migration.
ALTER TABLE "CreatorCampaign"
  ADD COLUMN "claimersObservationVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN "campaignFrontierObservationVersion" INTEGER NOT NULL DEFAULT 0;

-- An old binary may overlap this additive rollout. Its writes must invalidate
-- the new proof marker even when the row previously carried version 1.
CREATE FUNCTION "campaign_frontier_observation_guard_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('onlinod.campaign_observation_version', true) IS DISTINCT FROM '1' THEN
    NEW."claimersObservationVersion" := 0;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "campaign_frontier_observation_guard_v1_trg"
BEFORE INSERT OR UPDATE OF "claimersVerifiedAt", "claimerVerifiedRevision", "claimersLastVerifiedRunId", "claimersObservationVersion"
ON "CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION "campaign_frontier_observation_guard_v1"();

CREATE FUNCTION "campaign_plan_observation_guard_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('onlinod.campaign_observation_version', true) IS DISTINCT FROM '1' THEN
    NEW."campaignFrontierObservationVersion" := 0;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "campaign_plan_observation_guard_v1_trg"
BEFORE INSERT OR UPDATE OF "campaignFrontierPlanRunId", "campaignFrontierFreshnessStatus", "campaignFrontierNextDueAt",
  "campaignFrontierCompletedCount", "campaignFrontierDeferredCount", "campaignFrontierObservationVersion"
ON "CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION "campaign_plan_observation_guard_v1"();

-- The unknown-frontier index is built CONCURRENTLY by the existing
-- analytics-traffic-indexes postflight on an autocommit connection.
COMMIT;
