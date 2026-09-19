-- INT5.9A-7: bounded relational Campaign-directory segments for campaigns-v13.
-- The provider directory is staged to CreatorCampaign first; claimer traversal
-- then walks this exact generation in stable externalCampaignId order.
CREATE INDEX IF NOT EXISTS "CreatorCampaign_run_segment_idx"
  ON "CreatorCampaign" ("creatorId", "sourceScanRunId", "externalCampaignId");
