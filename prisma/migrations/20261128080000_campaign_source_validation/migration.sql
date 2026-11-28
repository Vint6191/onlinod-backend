-- A validation revision records how a source was observed. Existing facts and
-- proofs remain available, but cannot be relabelled as having passed a parser
-- introduced after they were collected. Reverification is planned per creator.
ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN IF NOT EXISTS "campaignDirectorySourceValidationVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "membershipBaselineSourceValidationVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "membershipCatchupSourceValidationVersion" INTEGER NOT NULL DEFAULT 0;
