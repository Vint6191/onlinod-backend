-- Phase 3 INT5.7A-4: compact Campaign catch-up frontier.
-- Nullable/no-default ADD COLUMN is metadata-only on supported PostgreSQL and does
-- not rewrite populated CreatorCampaign rows. Missing hashes fail safe to a scan.
ALTER TABLE "CreatorCampaign"
  ADD COLUMN IF NOT EXISTS "catchupFrontierHash" VARCHAR(64);
