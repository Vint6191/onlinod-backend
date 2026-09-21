-- Phase 3 A29: repair schema-scoped constraint authority after A26 physical proof.
-- Never infer constraint existence from a globally duplicated conname.

-- Remove only rows that cannot satisfy the intended tenant ownership graph before
-- re-attaching the correctly scoped foreign keys.
DELETE FROM "SubscriberDirectoryMaintenanceSignal" s
WHERE NOT EXISTS (SELECT 1 FROM "Agency" a WHERE a."id" = s."agencyId")
   OR NOT EXISTS (
        SELECT 1 FROM "CreatorAccount" c
        WHERE c."agencyId" = s."agencyId" AND c."id" = s."creatorId"
      );

ALTER TABLE "SubscriberDirectoryMaintenanceSignal"
  DROP CONSTRAINT IF EXISTS "SubscriberDirectoryMaintenanceSignal_agencyId_fkey",
  DROP CONSTRAINT IF EXISTS "SubscriberDirectoryMaintenanceSignal_creator_fkey",
  DROP CONSTRAINT IF EXISTS "SubscriberDirectoryMaintenanceSignal_kind_check",
  DROP CONSTRAINT IF EXISTS "SubscriberDirectoryMaintenanceSignal_revision_positive",
  DROP CONSTRAINT IF EXISTS "SubscriberDirectoryMaintenanceSignal_attempts_nonnegative";

ALTER TABLE "SubscriberDirectoryMaintenanceSignal"
  ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_creator_fkey"
    FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_kind_check"
    CHECK ("kind" IN ('RECOVERY','RETENTION')) NOT VALID,
  ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_revision_positive"
    CHECK ("revision" > 0) NOT VALID,
  ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_attempts_nonnegative"
    CHECK ("attempts" >= 0) NOT VALID;

ALTER TABLE "SubscriberDirectoryMaintenanceSignal"
  VALIDATE CONSTRAINT "SubscriberDirectoryMaintenanceSignal_agencyId_fkey";
ALTER TABLE "SubscriberDirectoryMaintenanceSignal"
  VALIDATE CONSTRAINT "SubscriberDirectoryMaintenanceSignal_creator_fkey";
ALTER TABLE "SubscriberDirectoryMaintenanceSignal"
  VALIDATE CONSTRAINT "SubscriberDirectoryMaintenanceSignal_kind_check";
ALTER TABLE "SubscriberDirectoryMaintenanceSignal"
  VALIDATE CONSTRAINT "SubscriberDirectoryMaintenanceSignal_revision_positive";
ALTER TABLE "SubscriberDirectoryMaintenanceSignal"
  VALIDATE CONSTRAINT "SubscriberDirectoryMaintenanceSignal_attempts_nonnegative";

-- Durable poison/dead-letter visibility for the operator recovery path.
CREATE INDEX IF NOT EXISTS "SubscriberDirectoryMaintenanceSignal_poison_idx"
  ON "SubscriberDirectoryMaintenanceSignal"("attempts" DESC,"dueAt","creatorId","kind")
  WHERE "attempts" >= 100;

-- Older Campaign migrations used conname-only existence checks. Repair those
-- constraints against the actual relation in the current schema as well.
DELETE FROM "CreatorCampaignFrontierFan" f
WHERE NOT EXISTS (
  SELECT 1 FROM "CreatorCampaign" c
  WHERE c."creatorId" = f."creatorId" AND c."id" = f."campaignId"
);
ALTER TABLE "CreatorCampaignFrontierFan"
  DROP CONSTRAINT IF EXISTS "CreatorCampaignFrontierFan_creatorId_campaignId_fkey";
ALTER TABLE "CreatorCampaignFrontierFan"
  ADD CONSTRAINT "CreatorCampaignFrontierFan_creatorId_campaignId_fkey"
  FOREIGN KEY ("creatorId","campaignId")
  REFERENCES "CreatorCampaign"("creatorId","id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CreatorCampaignFrontierFan"
  VALIDATE CONSTRAINT "CreatorCampaignFrontierFan_creatorId_campaignId_fkey";

UPDATE "CreatorCampaignCollectionState"
SET "campaignProofCampaignBatches" = GREATEST("campaignProofCampaignBatches", 0),
    "campaignProofClaimerBatches" = GREATEST("campaignProofClaimerBatches", 0),
    "campaignProofRejectedBatches" = GREATEST("campaignProofRejectedBatches", 0),
    "campaignProofRejectedRows" = GREATEST("campaignProofRejectedRows", 0)
WHERE "campaignProofCampaignBatches" < 0
   OR "campaignProofClaimerBatches" < 0
   OR "campaignProofRejectedBatches" < 0
   OR "campaignProofRejectedRows" < 0;
ALTER TABLE "CreatorCampaignCollectionState"
  DROP CONSTRAINT IF EXISTS "CreatorCampaignCollectionState_completion_proof_nonnegative_check";
ALTER TABLE "CreatorCampaignCollectionState"
  ADD CONSTRAINT "CreatorCampaignCollectionState_completion_proof_nonnegative_check" CHECK (
    "campaignProofCampaignBatches" >= 0
    AND "campaignProofClaimerBatches" >= 0
    AND "campaignProofRejectedBatches" >= 0
    AND "campaignProofRejectedRows" >= 0
  ) NOT VALID;
ALTER TABLE "CreatorCampaignCollectionState"
  VALIDATE CONSTRAINT "CreatorCampaignCollectionState_completion_proof_nonnegative_check";
