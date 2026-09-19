-- Phase 3 / INT5.9A-2
-- Physical Campaign claim-generation fence. This migration is rolling-safe:
-- it installs the trigger and durable inactive flag, but does NOT activate the
-- fence. `phase3:activate-campaign-causal-v1` performs pg_catalog preflight,
-- revokes live Campaign owners, and only then publishes claimGenerationActive.

UPDATE "SystemSetting"
SET "value" = COALESCE("value", '{}'::jsonb) || '{"claimGenerationActive":false}'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'phase3.campaignCausalObservationV1'
  AND NOT COALESCE("value", '{}'::jsonb) ? 'claimGenerationActive';

CREATE OR REPLACE FUNCTION "phase3_campaign_claim_generation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  barrier_value jsonb;
  expected_generation text;
  session_generation text;
BEGIN
  -- The trigger is intentionally narrow: only a fresh transition into CLAIMED
  -- for fetch_campaigns is physically fenced. Renew/progress/release paths keep
  -- their normal lease semantics and are fenced separately by leaseRevision.
  IF NEW."jobKey" IS DISTINCT FROM 'fetch_campaigns'
     OR NEW."status" IS DISTINCT FROM 'CLAIMED'
     OR OLD."status" IS NOT DISTINCT FROM 'CLAIMED' THEN
    RETURN NEW;
  END IF;

  SELECT "value"
  INTO barrier_value
  FROM "SystemSetting"
  WHERE "key" = 'phase3.campaignCausalObservationV1'
  FOR SHARE;

  IF barrier_value IS NULL THEN
    RAISE EXCEPTION 'CAMPAIGN_CLAIM_GENERATION_BARRIER_MISSING'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE((barrier_value->>'claimGenerationActive')::boolean, false) = false THEN
    RETURN NEW;
  END IF;

  expected_generation := NULLIF(barrier_value->>'writerGeneration', '');
  session_generation := NULLIF(current_setting('onlinod.campaign_claim_generation', true), '');

  IF expected_generation IS NULL
     OR session_generation IS NULL
     OR session_generation IS DISTINCT FROM expected_generation THEN
    RAISE EXCEPTION 'CAMPAIGN_CLAIM_GENERATION_RETIRED'
      USING ERRCODE = 'P0001',
            DETAIL = format('expected generation %s, session generation %s', expected_generation, session_generation);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "phase3_campaign_claim_generation_guard_trg" ON "JobInstance";
CREATE TRIGGER "phase3_campaign_claim_generation_guard_trg"
BEFORE UPDATE OF "status" ON "JobInstance"
FOR EACH ROW
WHEN (
  NEW."jobKey" = 'fetch_campaigns'
  AND NEW."status" = 'CLAIMED'
  AND OLD."status" IS DISTINCT FROM 'CLAIMED'
)
EXECUTE FUNCTION "phase3_campaign_claim_generation_guard"();
