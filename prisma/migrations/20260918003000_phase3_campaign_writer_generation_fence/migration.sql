-- Phase 3 / INT5.8A-1
-- Rolling-safe physical generation fence for Campaign writers.
--
-- The existing Campaign causal barrier may already be active on a deployed
-- Actual66 database. Do NOT turn the physical writer fence on in the migration:
-- the new bridge-capable Backend must be deployed first and old Backend replicas
-- drained. Re-running `phase3:activate-campaign-causal-v1` then activates the
-- writer generation atomically.

UPDATE "SystemSetting"
SET "value" = COALESCE("value", '{}'::jsonb)
  || '{"writerGenerationActive":false}'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'phase3.campaignCausalObservationV1'
  AND COALESCE(("value"->>'writerGenerationActive')::boolean, false) = false;

CREATE OR REPLACE FUNCTION "phase3_campaign_writer_generation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  barrier_value jsonb;
  expected_generation text;
  session_generation text;
  old_row jsonb := '{}'::jsonb;
  guarded_write boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD);
  END IF;

  -- Current and historical Actual64 Campaign chunks normally pass through the
  -- CAMPAIGNS ingest-batch ledger, but its old single/batch fan-value helpers
  -- projected FanData directly. Therefore the physical fence covers both the
  -- ingest-batch commit path and exact canonical authority-version writes whose
  -- incoming source is CAMPAIGN_CLAIMER. Non-Campaign FanData producers remain
  -- unaffected even when the stored row previously came from Campaign.
  IF TG_TABLE_NAME = 'AnalyticsIngestBatch' THEN
    guarded_write := NEW."dataType"::text = 'CAMPAIGNS';
  ELSIF TG_TABLE_NAME = 'CreatorFan' THEN
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_each_text(to_jsonb(NEW)) AS field("key", "value")
      WHERE field."key" = ANY (ARRAY[
        'identityAuthorityVersion',
        'usernameAuthorityVersion',
        'displayNameAuthorityVersion',
        'avatarAuthorityVersion',
        'headerAuthorityVersion'
      ])
        AND field."value" LIKE '%|CAMPAIGN_CLAIMER|%'
        AND (TG_OP = 'INSERT' OR field."value" IS DISTINCT FROM old_row->>field."key")
    ) INTO guarded_write;
  ELSIF TG_TABLE_NAME = 'CreatorFanValueCurrent' THEN
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_each_text(to_jsonb(NEW)) AS field("key", "value")
      WHERE field."key" = ANY (ARRAY[
        'valueAuthorityVersion',
        'availabilityAuthorityVersion',
        'platformReportedTotalSpendCentsAuthorityVersion',
        'messagesSpentCentsAuthorityVersion',
        'subscriptionsSpentCentsAuthorityVersion',
        'tipsSpentCentsAuthorityVersion',
        'postsSpentCentsAuthorityVersion',
        'streamsSpentCentsAuthorityVersion',
        'lastActivityAtAuthorityVersion'
      ])
        AND field."value" LIKE '%|CAMPAIGN_CLAIMER|%'
        AND (TG_OP = 'INSERT' OR field."value" IS DISTINCT FROM old_row->>field."key")
    ) INTO guarded_write;
  END IF;

  IF guarded_write = false THEN
    RETURN NEW;
  END IF;

  -- The share lock is retained to transaction end. Activation locks live
  -- Campaign JobInstance rows first, then this setting row FOR UPDATE. Thus old
  -- progress (JobInstance -> trigger/barrier) and activation use one lock order.
  SELECT "value"
    INTO barrier_value
  FROM "SystemSetting"
  WHERE "key" = 'phase3.campaignCausalObservationV1'
  FOR SHARE;

  IF barrier_value IS NULL THEN
    RAISE EXCEPTION 'CAMPAIGN_CAUSAL_V1_BARRIER_MISSING'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE((barrier_value->>'writerGenerationActive')::boolean, false) = false THEN
    RETURN NEW;
  END IF;

  expected_generation := NULLIF(barrier_value->>'writerGeneration', '');
  session_generation := NULLIF(current_setting('onlinod.campaign_writer_generation', true), '');

  IF expected_generation IS NULL OR session_generation IS DISTINCT FROM expected_generation THEN
    RAISE EXCEPTION 'CAMPAIGN_WRITER_GENERATION_RETIRED'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'expected Campaign writer generation %s, session generation %s',
              COALESCE(expected_generation, '<missing>'),
              COALESCE(session_generation, '<missing>')
            );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "phase3_campaign_writer_generation_ingest_guard_trg" ON "AnalyticsIngestBatch";
CREATE TRIGGER "phase3_campaign_writer_generation_ingest_guard_trg"
BEFORE INSERT OR UPDATE ON "AnalyticsIngestBatch"
FOR EACH ROW
EXECUTE FUNCTION "phase3_campaign_writer_generation_guard"();

DROP TRIGGER IF EXISTS "phase3_campaign_writer_generation_identity_guard_trg" ON "CreatorFan";
CREATE TRIGGER "phase3_campaign_writer_generation_identity_guard_trg"
BEFORE INSERT OR UPDATE ON "CreatorFan"
FOR EACH ROW
EXECUTE FUNCTION "phase3_campaign_writer_generation_guard"();

DROP TRIGGER IF EXISTS "phase3_campaign_writer_generation_value_guard_trg" ON "CreatorFanValueCurrent";
CREATE TRIGGER "phase3_campaign_writer_generation_value_guard_trg"
BEFORE INSERT OR UPDATE ON "CreatorFanValueCurrent"
FOR EACH ROW
EXECUTE FUNCTION "phase3_campaign_writer_generation_guard"();
