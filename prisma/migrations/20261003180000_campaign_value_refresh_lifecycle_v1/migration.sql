BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL TimeZone='UTC';

ALTER TABLE "CampaignFanRefreshPromotionSignal" ADD COLUMN "healAfterId" VARCHAR(180) NOT NULL DEFAULT '';

-- The cache now carries current value freshness and owns expiry demand. Older
-- projection workers must not acknowledge expiry while omitting that demand.
CREATE OR REPLACE FUNCTION "onlinod_campaign_projection_assert_v2"() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('onlinod.campaign_projection_writer',true) IS DISTINCT FROM 'campaign_projection_v2'
    OR current_setting('onlinod.campaign_value_refresh_version',true) IS DISTINCT FROM '1'
    OR NOT EXISTS(SELECT 1 FROM "CampaignProjectionPolicy" WHERE "id"='active'
      AND "generation"::text=current_setting('onlinod.campaign_projection_generation',true)) THEN
    RAISE EXCEPTION 'CAMPAIGN_PROJECTION_WRITER_RETIRED_OR_POLICY_CHANGED';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "onlinod_campaign_projection_policy_v2"(expected INTEGER,ttl INTEGER) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE p "CampaignProjectionPolicy";
BEGIN
  SELECT * INTO p FROM "CampaignProjectionPolicy" WHERE "id"='active' FOR UPDATE;
  IF p."generation"<>expected THEN RAISE EXCEPTION 'CAMPAIGN_POLICY_GENERATION_CONFLICT'; END IF;
  IF ttl<60000 THEN RAISE EXCEPTION 'CAMPAIGN_POLICY_TTL_INVALID'; END IF;
  IF p."valueFreshnessMs"=ttl THEN RETURN p."generation"; END IF;
  UPDATE "CampaignProjectionPolicy" SET "generation"="generation"+1,"valueFreshnessMs"=ttl WHERE "id"='active' RETURNING * INTO p;
  PERFORM set_config('onlinod.campaign_projection_writer','campaign_projection_v2',true);
  PERFORM set_config('onlinod.campaign_projection_generation',p."generation"::text,true);
  PERFORM set_config('onlinod.campaign_value_refresh_version','1',true);
  UPDATE "CampaignReadSeed" SET "generation"=p."generation","valueFreshnessMs"=ttl,"cursor"='',"complete"=false WHERE "id"='v1';
  RETURN p."generation";
END $$;

-- O(1) policy cutover; existing durable, bounded seed/backfill machinery rebuilds
-- receipts and enrolls all previously known campaign fans. No history rewrite.
UPDATE "CampaignProjectionPolicy" SET "generation"="generation"+1 WHERE "id"='active';
COMMIT;
