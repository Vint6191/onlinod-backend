ALTER TABLE "CreatorEarningsDaily"
  ADD CONSTRAINT "CreatorEarningsDaily_scan_run_check" CHECK ("sourceScanRunId" IS NULL OR length(btrim("sourceScanRunId")) BETWEEN 1 AND 120);

-- Preserve scan identity so concurrent campaign scans cannot overwrite a
-- newer generation. Campaign/fan attribution rows remain historical.
ALTER TABLE "CreatorCampaign"
  ADD COLUMN "sourceScanRunId" TEXT,
  ADD COLUMN "sourceScanStartedAt" TIMESTAMP(3);

ALTER TABLE "CreatorCampaignFan"
  ADD COLUMN "sourceScanRunId" TEXT,
  ADD COLUMN "sourceScanStartedAt" TIMESTAMP(3);

ALTER TABLE "CreatorCampaign"
  ADD CONSTRAINT "CreatorCampaign_sourceScanRunId_length_check"
  CHECK ("sourceScanRunId" IS NULL OR length("sourceScanRunId") BETWEEN 1 AND 120),
  ADD CONSTRAINT "CreatorCampaign_scan_generation_pair_check"
  CHECK (("sourceScanRunId" IS NULL) = ("sourceScanStartedAt" IS NULL));

ALTER TABLE "CreatorCampaignFan"
  ADD CONSTRAINT "CreatorCampaignFan_sourceScanRunId_length_check"
  CHECK ("sourceScanRunId" IS NULL OR length("sourceScanRunId") BETWEEN 1 AND 120),
  ADD CONSTRAINT "CreatorCampaignFan_scan_generation_pair_check"
  CHECK (("sourceScanRunId" IS NULL) = ("sourceScanStartedAt" IS NULL));

CREATE INDEX "CreatorCampaign_creatorId_sourceScanStartedAt_idx"
  ON "CreatorCampaign"("creatorId", "sourceScanStartedAt");

CREATE INDEX "CreatorCampaign_creatorId_sourceScanRunId_idx"
  ON "CreatorCampaign"("creatorId", "sourceScanRunId");

CREATE INDEX "CreatorCampaignFan_creatorId_campaignId_sourceScanStartedAt_idx"
  ON "CreatorCampaignFan"("creatorId", "campaignId", "sourceScanStartedAt");

CREATE INDEX "CreatorCampaignFan_creatorId_campaignId_sourceScanRunId_idx"
  ON "CreatorCampaignFan"("creatorId", "campaignId", "sourceScanRunId");

-- CreatorMessagesDaily already has non-negative and total checks in the
-- table-creation migration. Add only the cross-column fan-count invariant
-- here; do not duplicate an existing PostgreSQL constraint name.
ALTER TABLE "CreatorMessagesDaily"
  ADD CONSTRAINT "CreatorMessagesDaily_unique_fans_check" CHECK (
    "uniqueIncomingFans" <= "uniqueDialogs" AND
    "uniqueOutgoingFans" <= "uniqueDialogs"
  );
