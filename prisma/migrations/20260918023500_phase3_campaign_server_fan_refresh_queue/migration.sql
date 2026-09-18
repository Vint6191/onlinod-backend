-- Phase 3 INT5.8A-4: durable per-run Campaign -> FanData refresh dedupe.
CREATE TABLE IF NOT EXISTS "CreatorCampaignFanRefreshWork" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "scanRunId" VARCHAR(120) NOT NULL,
  "scanStartedAt" TIMESTAMP(3) NOT NULL,
  "onlyFansUserId" VARCHAR(180) NOT NULL,
  "campaignJobId" TEXT NOT NULL,
  "refreshJobId" TEXT,
  "freshnessCutoffAt" TIMESTAMP(3) NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorCampaignFanRefreshWork_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorCampaignFanRefreshWork_creator_run_fan_key"
  ON "CreatorCampaignFanRefreshWork"("creatorId", "scanRunId", "onlyFansUserId");
CREATE INDEX IF NOT EXISTS "CreatorCampaignFanRefreshWork_creator_run_idx"
  ON "CreatorCampaignFanRefreshWork"("creatorId", "scanRunId");
CREATE INDEX IF NOT EXISTS "CreatorCampaignFanRefreshWork_refreshJob_idx"
  ON "CreatorCampaignFanRefreshWork"("refreshJobId");
CREATE INDEX IF NOT EXISTS "CreatorCampaignFanRefreshWork_campaignJob_idx"
  ON "CreatorCampaignFanRefreshWork"("campaignJobId");

DO $$ BEGIN
  ALTER TABLE "CreatorCampaignFanRefreshWork"
    ADD CONSTRAINT "CreatorCampaignFanRefreshWork_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CreatorCampaignFanRefreshWork"
    ADD CONSTRAINT "CreatorCampaignFanRefreshWork_campaignJob_fkey"
    FOREIGN KEY ("campaignJobId") REFERENCES "JobInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CreatorCampaignFanRefreshWork"
    ADD CONSTRAINT "CreatorCampaignFanRefreshWork_refreshJob_fkey"
    FOREIGN KEY ("refreshJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
