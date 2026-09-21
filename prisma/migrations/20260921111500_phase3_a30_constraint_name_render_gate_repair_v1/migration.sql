-- Phase 3 A30: canonicalize the Campaign completion-proof constraint name.
-- PostgreSQL identifiers are limited to 63 bytes. The historical/A29 name was
-- 65 bytes and PostgreSQL physically truncated it to ..._che. Keep the
-- forward-only migration chain intact and repair the physical name explicitly.

UPDATE "CreatorCampaignCollectionState"
SET "campaignProofCampaignBatches" = GREATEST("campaignProofCampaignBatches", 0),
    "campaignProofClaimerBatches" = GREATEST("campaignProofClaimerBatches", 0),
    "campaignProofRejectedBatches" = GREATEST("campaignProofRejectedBatches", 0),
    "campaignProofRejectedRows" = GREATEST("campaignProofRejectedRows", 0)
WHERE "campaignProofCampaignBatches" < 0
   OR "campaignProofClaimerBatches" < 0
   OR "campaignProofRejectedBatches" < 0
   OR "campaignProofRejectedRows" < 0;

-- This is the exact physical 63-byte identifier created when PostgreSQL
-- truncated CreatorCampaignCollectionState_completion_proof_nonnegative_check.
ALTER TABLE "CreatorCampaignCollectionState"
  DROP CONSTRAINT IF EXISTS "CreatorCampaignCollectionState_completion_proof_nonnegative_che";

ALTER TABLE "CreatorCampaignCollectionState"
  DROP CONSTRAINT IF EXISTS "CreatorCampaignCollectionState_completion_nonnegative_chk";

ALTER TABLE "CreatorCampaignCollectionState"
  ADD CONSTRAINT "CreatorCampaignCollectionState_completion_nonnegative_chk" CHECK (
    "campaignProofCampaignBatches" >= 0
    AND "campaignProofClaimerBatches" >= 0
    AND "campaignProofRejectedBatches" >= 0
    AND "campaignProofRejectedRows" >= 0
  ) NOT VALID;

ALTER TABLE "CreatorCampaignCollectionState"
  VALIDATE CONSTRAINT "CreatorCampaignCollectionState_completion_nonnegative_chk";
