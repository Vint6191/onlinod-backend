ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN IF NOT EXISTS "campaignDirectoryGeneration" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "campaignDirectoryRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "campaignDirectoryVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "campaignDirectoryRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "campaignDirectoryCampaignCount" INTEGER NOT NULL DEFAULT 0;
