-- Separate period-rollover readiness from expiring FanData observations.
-- The read must seek the two period-bearing kinds, not walk an arbitrary
-- number of expired VALUE receipts on every screen refresh.
CREATE INDEX "CampaignReadReceipt_kind_due177_idx"
  ON "CampaignReadReceipt" ("creatorId", "kind", "nextDueAt")
  WHERE "nextDueAt" IS NOT NULL;

-- MEMBER receipts have both a FanData TTL and a calendar-window deadline.
-- Keep the calendar deadline separately; legacy receipts are repaired by a
-- bounded, durable membership pass before their period values are certified.
ALTER TABLE "CampaignReadReceipt" ADD COLUMN "windowDueAt" timestamp(3);
ALTER TABLE "CampaignReadReceipt" ADD COLUMN "windowVersion" integer NOT NULL DEFAULT 0;
CREATE INDEX "CampaignReadReceipt_window_due177_idx"
  ON "CampaignReadReceipt" ("creatorId", "windowDueAt")
  WHERE kind = 'MEMBER' AND "windowDueAt" IS NOT NULL;
CREATE INDEX "CampaignReadReceipt_window_repair177_idx"
  ON "CampaignReadReceipt" ("creatorId")
  WHERE kind = 'MEMBER' AND "windowVersion" = 0;
