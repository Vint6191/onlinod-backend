-- Phase 3 / INT5.8A-5
-- Persist exact bounded head-page fan identities so recurring Campaign catch-up
-- can find the previous boundary after new claimers shift it below page 1.
-- Existing hash-only rows intentionally remain without anchors: inventing fan
-- identities from historical projections would create unsafe skip authority.
ALTER TABLE "CreatorCampaign"
  ADD COLUMN IF NOT EXISTS "catchupFrontierFanIds" JSONB,
  ADD COLUMN IF NOT EXISTS "catchupFrontierRunId" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "catchupFrontierStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "stagedCatchupFrontierFanIds" JSONB;
