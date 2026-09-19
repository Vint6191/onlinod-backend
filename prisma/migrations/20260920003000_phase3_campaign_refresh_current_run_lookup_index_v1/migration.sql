-- Phase 3 A20.11
-- Current-generation lookup support for the campaign coverage online backfill.
--
-- Populated installations create/repair this index CONCURRENTLY in
-- phase3-campaign-coverage-generation-online-preflight.js before migrate deploy.
-- Fresh/empty databases remain self-contained: creating the index here is cheap.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "CreatorCampaignFanRefreshWork" LIMIT 1) THEN
    CREATE INDEX IF NOT EXISTS "CreatorCampaignFanRefreshWork_creator_run_id_idx"
      ON "CreatorCampaignFanRefreshWork"("creatorId", "scanRunId", "id");
  END IF;
END $$;
