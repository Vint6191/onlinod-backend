ALTER TABLE "CreatorCampaign"
  ADD COLUMN IF NOT EXISTS "stagedCatchupFrontierHash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "stagedCatchupFrontierRunId" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "stagedCatchupFrontierStartedAt" TIMESTAMP(3);
