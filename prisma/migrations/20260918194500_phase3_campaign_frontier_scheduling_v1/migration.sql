-- INT5.9A-8: revisioned Campaign claimer-frontier scheduling authority.
-- Existing Campaigns are immediately due once so the first capable catch-up
-- establishes a verified frontier under the bounded server-owned budget.
ALTER TABLE "CreatorCampaign"
  ADD COLUMN IF NOT EXISTS "claimerRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "claimerVerifiedRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "claimersVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimersNextDueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimersTargetRunId" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "claimersLastVerifiedRunId" VARCHAR(120);

ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN IF NOT EXISTS "campaignFrontierPlanRunId" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "campaignFrontierFreshnessStatus" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
  ADD COLUMN IF NOT EXISTS "campaignFrontierDueCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "campaignFrontierTargetCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "campaignFrontierCompletedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "campaignFrontierDeferredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "campaignFrontierOldestDueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "campaignFrontierNextDueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "campaignFrontierUpdatedAt" TIMESTAMP(3);

UPDATE "CreatorCampaign"
SET "claimersNextDueAt" = COALESCE("claimersNextDueAt", CURRENT_TIMESTAMP)
WHERE "claimersNextDueAt" IS NULL;

CREATE INDEX IF NOT EXISTS "CreatorCampaign_frontier_due_idx"
  ON "CreatorCampaign" ("creatorId", "claimersNextDueAt", "externalCampaignId");
CREATE INDEX IF NOT EXISTS "CreatorCampaign_frontier_target_idx"
  ON "CreatorCampaign" ("creatorId", "claimersTargetRunId", "externalCampaignId");
