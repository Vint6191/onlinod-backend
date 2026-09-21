-- A31: Subscriber lease/scale authority physical support.
-- Keep every new physical identifier <= PostgreSQL's 63-byte identifier limit.

-- Bounded published-generation lookup used by runtime state repair. The current
-- generation lookup is already covered by SubscriberScanRun_creator_publication_generation_idx.
CREATE INDEX IF NOT EXISTS "SubscriberScanRun_creator_published_generation_idx"
  ON "SubscriberScanRun"("agencyId", "creatorId", "publicationGeneration" DESC, "id" DESC)
  WHERE "status" IN ('PUBLISHED','SUPERSEDED')
    AND "publicationStatus" = 'COMPLETE';

-- Historical frontier indexes were created with logical names >63 bytes and
-- PostgreSQL silently truncated them. Normalize their physical names without
-- rebuilding the indexes or changing uniqueness/column semantics.
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'CreatorCampaignFrontierFan_campaignId_frontierKind_onlyFansUser')) IS NOT NULL
     AND to_regclass(format('%I.%I', current_schema(), 'CampaignFrontierFan_campaign_kind_user_uq')) IS NULL THEN
    EXECUTE format(
      'ALTER INDEX %I.%I RENAME TO %I',
      current_schema(),
      'CreatorCampaignFrontierFan_campaignId_frontierKind_onlyFansUser',
      'CampaignFrontierFan_campaign_kind_user_uq'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'CreatorCampaignFrontierFan_creatorId_campaignId_frontierKind_id')) IS NOT NULL
     AND to_regclass(format('%I.%I', current_schema(), 'CampaignFrontierFan_creator_campaign_kind_idx')) IS NULL THEN
    EXECUTE format(
      'ALTER INDEX %I.%I RENAME TO %I',
      current_schema(),
      'CreatorCampaignFrontierFan_creatorId_campaignId_frontierKind_id',
      'CampaignFrontierFan_creator_campaign_kind_idx'
    );
  END IF;
END $$;
