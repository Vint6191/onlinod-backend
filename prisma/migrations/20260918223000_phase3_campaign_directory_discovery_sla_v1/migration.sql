-- INT5.9A-10: decouple Campaign directory discovery cadence from frontier refresh.
ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN IF NOT EXISTS "campaignDirectoryDiscoveryDueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "campaignDirectoryDiscoveryRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "campaignDirectoryDiscoveryRequestedRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "campaignDirectoryDiscoveryCompletedRevision" INTEGER NOT NULL DEFAULT 0;

UPDATE "CreatorCampaignCollectionState"
SET "campaignDirectoryDiscoveryDueAt" = COALESCE(
  "campaignDirectoryDiscoveryDueAt",
  CASE
    WHEN "campaignDirectoryVerifiedAt" IS NOT NULL THEN "campaignDirectoryVerifiedAt" + INTERVAL '72 hours'
    ELSE CURRENT_TIMESTAMP
  END
);

CREATE INDEX IF NOT EXISTS "CreatorCampaignCollectionState_directory_due_idx"
  ON "CreatorCampaignCollectionState"("campaignDirectoryDiscoveryDueAt", "creatorId");
