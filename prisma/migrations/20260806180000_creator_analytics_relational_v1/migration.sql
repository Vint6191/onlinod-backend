-- Creator Analytics Relational V1
-- Likes/comments, daily earnings, tracking campaigns/fans and local message-day aggregates.
-- Business facts are typed relational rows; message text/media remain local-only.


CREATE TABLE "CreatorPostLike" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT,
  "eventFingerprint" TEXT NOT NULL,
  "externalNotificationId" TEXT,
  "onlyFansLikeId" TEXT,
  "onlyFansPostId" TEXT NOT NULL,
  "likedAt" TIMESTAMP(3) NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorPostLike_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorPostLike_identity_check" CHECK (
    length(btrim("eventFingerprint")) BETWEEN 32 AND 64 AND
    length(btrim("onlyFansPostId")) BETWEEN 1 AND 220 AND
    ("externalNotificationId" IS NULL OR length(btrim("externalNotificationId")) BETWEEN 1 AND 220) AND
    ("onlyFansLikeId" IS NULL OR length(btrim("onlyFansLikeId")) BETWEEN 1 AND 220) AND
    ("externalNotificationId" IS NOT NULL OR "onlyFansLikeId" IS NOT NULL)
  )
);

CREATE TABLE "CreatorPostComment" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT,
  "eventFingerprint" TEXT NOT NULL,
  "externalNotificationId" TEXT,
  "onlyFansCommentId" TEXT,
  "onlyFansPostId" TEXT NOT NULL,
  "commentedAt" TIMESTAMP(3) NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorPostComment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorPostComment_identity_check" CHECK (
    length(btrim("eventFingerprint")) BETWEEN 32 AND 64 AND
    length(btrim("onlyFansPostId")) BETWEEN 1 AND 220 AND
    ("onlyFansCommentId" IS NULL OR length(btrim("onlyFansCommentId")) BETWEEN 1 AND 220) AND
    ("externalNotificationId" IS NULL OR length(btrim("externalNotificationId")) BETWEEN 1 AND 220) AND
    ("externalNotificationId" IS NOT NULL OR "onlyFansCommentId" IS NOT NULL)
  )
);

CREATE TABLE "CreatorEarningsDaily" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "sourceTimezone" TEXT NOT NULL DEFAULT 'UTC',
  "subscriptionsCents" INTEGER,
  "messagesCents" INTEGER,
  "tipsCents" INTEGER,
  "postsCents" INTEGER,
  "streamsCents" INTEGER,
  "referralsCents" INTEGER,
  "totalCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "sourceUpdatedAt" TIMESTAMP(3),
  "sourceScanRunId" TEXT,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorEarningsDaily_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorEarningsDaily_non_negative_check" CHECK (
    ("subscriptionsCents" IS NULL OR "subscriptionsCents" >= 0) AND
    ("messagesCents" IS NULL OR "messagesCents" >= 0) AND
    ("tipsCents" IS NULL OR "tipsCents" >= 0) AND
    ("postsCents" IS NULL OR "postsCents" >= 0) AND
    ("streamsCents" IS NULL OR "streamsCents" >= 0) AND
    ("referralsCents" IS NULL OR "referralsCents" >= 0) AND
    "totalCents" >= 0
  ),
  CONSTRAINT "CreatorEarningsDaily_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "CreatorEarningsDaily_timezone_check" CHECK ("sourceTimezone" = 'UTC')
);

CREATE TABLE "CreatorCampaign" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "externalCampaignId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "campaignType" TEXT,
  "trackingCode" TEXT,
  "trackingUrl" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "claimersCount" INTEGER,
  "clicksCount" INTEGER,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorCampaign_counts_check" CHECK (("claimersCount" IS NULL OR "claimersCount" >= 0) AND ("clicksCount" IS NULL OR "clicksCount" >= 0)),
  CONSTRAINT "CreatorCampaign_identity_check" CHECK (
    length(btrim("externalCampaignId")) BETWEEN 1 AND 220 AND
    length(btrim("name")) BETWEEN 1 AND 500 AND
    ("campaignType" IS NULL OR length("campaignType") <= 80) AND
    ("trackingCode" IS NULL OR length("trackingCode") <= 220) AND
    ("trackingUrl" IS NULL OR length("trackingUrl") <= 4000)
  )
);

CREATE TABLE "CreatorCampaignFan" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "externalClaimerId" TEXT,
  "attributedAt" TIMESTAMP(3),
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorCampaignFan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorCampaignFan_identity_check" CHECK (
    "externalClaimerId" IS NULL OR length(btrim("externalClaimerId")) BETWEEN 1 AND 220
  )
);

CREATE TABLE "CreatorMessagesDaily" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "sourceTimezone" TEXT NOT NULL DEFAULT 'UTC',
  "incomingMessages" INTEGER NOT NULL DEFAULT 0,
  "outgoingMessages" INTEGER NOT NULL DEFAULT 0,
  "totalMessages" INTEGER NOT NULL DEFAULT 0,
  "uniqueDialogs" INTEGER NOT NULL DEFAULT 0,
  "uniqueIncomingFans" INTEGER NOT NULL DEFAULT 0,
  "uniqueOutgoingFans" INTEGER NOT NULL DEFAULT 0,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorMessagesDaily_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorMessagesDaily_counts_check" CHECK (
    "incomingMessages" >= 0 AND "outgoingMessages" >= 0 AND "totalMessages" >= 0 AND
    "uniqueDialogs" >= 0 AND "uniqueIncomingFans" >= 0 AND "uniqueOutgoingFans" >= 0 AND
    "totalMessages" = "incomingMessages" + "outgoingMessages"
  ),
  CONSTRAINT "CreatorMessagesDaily_timezone_check" CHECK ("sourceTimezone" = 'UTC')
);

CREATE UNIQUE INDEX "CreatorPostLike_creatorId_eventFingerprint_key" ON "CreatorPostLike"("creatorId", "eventFingerprint");
CREATE UNIQUE INDEX "CreatorPostLike_creatorId_externalNotificationId_key" ON "CreatorPostLike"("creatorId", "externalNotificationId");
CREATE UNIQUE INDEX "CreatorPostLike_creatorId_onlyFansLikeId_key" ON "CreatorPostLike"("creatorId", "onlyFansLikeId");
CREATE INDEX "CreatorPostLike_agencyId_creatorId_likedAt_idx" ON "CreatorPostLike"("agencyId", "creatorId", "likedAt");
CREATE INDEX "CreatorPostLike_creatorId_fanId_likedAt_idx" ON "CreatorPostLike"("creatorId", "fanId", "likedAt");
CREATE INDEX "CreatorPostLike_creatorId_onlyFansPostId_likedAt_idx" ON "CreatorPostLike"("creatorId", "onlyFansPostId", "likedAt");
CREATE INDEX "CreatorPostLike_sourceJobId_idx" ON "CreatorPostLike"("sourceJobId");

CREATE UNIQUE INDEX "CreatorPostComment_creatorId_eventFingerprint_key" ON "CreatorPostComment"("creatorId", "eventFingerprint");
CREATE UNIQUE INDEX "CreatorPostComment_creatorId_externalNotificationId_key" ON "CreatorPostComment"("creatorId", "externalNotificationId");
CREATE UNIQUE INDEX "CreatorPostComment_creatorId_onlyFansCommentId_key" ON "CreatorPostComment"("creatorId", "onlyFansCommentId");
CREATE INDEX "CreatorPostComment_agencyId_creatorId_commentedAt_idx" ON "CreatorPostComment"("agencyId", "creatorId", "commentedAt");
CREATE INDEX "CreatorPostComment_creatorId_fanId_commentedAt_idx" ON "CreatorPostComment"("creatorId", "fanId", "commentedAt");
CREATE INDEX "CreatorPostComment_creatorId_onlyFansPostId_commentedAt_idx" ON "CreatorPostComment"("creatorId", "onlyFansPostId", "commentedAt");
CREATE INDEX "CreatorPostComment_sourceJobId_idx" ON "CreatorPostComment"("sourceJobId");

CREATE UNIQUE INDEX "CreatorEarningsDaily_creatorId_date_sourceTimezone_key" ON "CreatorEarningsDaily"("creatorId", "date", "sourceTimezone");
CREATE INDEX "CreatorEarningsDaily_agencyId_creatorId_date_idx" ON "CreatorEarningsDaily"("agencyId", "creatorId", "date");
CREATE INDEX "CreatorEarningsDaily_creatorId_date_idx" ON "CreatorEarningsDaily"("creatorId", "date");
CREATE INDEX "CreatorEarningsDaily_creatorId_sourceScanRunId_idx" ON "CreatorEarningsDaily"("creatorId", "sourceScanRunId");
CREATE INDEX "CreatorEarningsDaily_sourceJobId_idx" ON "CreatorEarningsDaily"("sourceJobId");

CREATE UNIQUE INDEX "CreatorCampaign_creatorId_externalCampaignId_key" ON "CreatorCampaign"("creatorId", "externalCampaignId");
CREATE UNIQUE INDEX "CreatorCampaign_creatorId_id_key" ON "CreatorCampaign"("creatorId", "id");
CREATE INDEX "CreatorCampaign_agencyId_creatorId_isActive_idx" ON "CreatorCampaign"("agencyId", "creatorId", "isActive");
CREATE INDEX "CreatorCampaign_creatorId_collectedAt_idx" ON "CreatorCampaign"("creatorId", "collectedAt");
CREATE INDEX "CreatorCampaign_sourceJobId_idx" ON "CreatorCampaign"("sourceJobId");

CREATE UNIQUE INDEX "CreatorCampaignFan_campaignId_fanId_key" ON "CreatorCampaignFan"("campaignId", "fanId");
CREATE INDEX "CreatorCampaignFan_agencyId_creatorId_campaignId_idx" ON "CreatorCampaignFan"("agencyId", "creatorId", "campaignId");
CREATE INDEX "CreatorCampaignFan_creatorId_fanId_idx" ON "CreatorCampaignFan"("creatorId", "fanId");
CREATE INDEX "CreatorCampaignFan_sourceJobId_idx" ON "CreatorCampaignFan"("sourceJobId");

CREATE UNIQUE INDEX "CreatorMessagesDaily_creatorId_date_sourceTimezone_key" ON "CreatorMessagesDaily"("creatorId", "date", "sourceTimezone");
CREATE INDEX "CreatorMessagesDaily_agencyId_creatorId_date_idx" ON "CreatorMessagesDaily"("agencyId", "creatorId", "date");
CREATE INDEX "CreatorMessagesDaily_creatorId_date_idx" ON "CreatorMessagesDaily"("creatorId", "date");
CREATE INDEX "CreatorMessagesDaily_sourceJobId_idx" ON "CreatorMessagesDaily"("sourceJobId");

ALTER TABLE "CreatorPostLike"
  ADD CONSTRAINT "CreatorPostLike_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPostLike_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPostLike_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPostLike_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorPostComment"
  ADD CONSTRAINT "CreatorPostComment_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPostComment_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPostComment_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPostComment_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorEarningsDaily"
  ADD CONSTRAINT "CreatorEarningsDaily_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorEarningsDaily_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorEarningsDaily_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorCampaign"
  ADD CONSTRAINT "CreatorCampaign_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorCampaign_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorCampaign_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorCampaignFan"
  ADD CONSTRAINT "CreatorCampaignFan_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorCampaignFan_creatorId_campaignId_fkey" FOREIGN KEY ("creatorId", "campaignId") REFERENCES "CreatorCampaign"("creatorId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorCampaignFan_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorCampaignFan_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorCampaignFan_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorMessagesDaily"
  ADD CONSTRAINT "CreatorMessagesDaily_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorMessagesDaily_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorMessagesDaily_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Notification day invariants now cover engagement facts too.
ALTER TABLE "AnalyticsCoverage"
  DROP CONSTRAINT IF EXISTS "AnalyticsCoverage_notification_interval_day_check",
  DROP CONSTRAINT IF EXISTS "AnalyticsCoverage_notification_complete_day_check",
  ADD CONSTRAINT "AnalyticsCoverage_notification_interval_day_check" CHECK (
    "dataType" NOT IN ('NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS', 'NOTIFICATION_LIKES', 'NOTIFICATION_COMMENTS') OR (
      ("coveredFromAt" IS NULL OR "coveredFromAt" >= ("coverageDate"::timestamp)) AND
      ("coveredToAt" IS NULL OR "coveredToAt" < ("coverageDate"::timestamp) + interval '1 day') AND
      ("coveredFromAt" IS NULL OR "coveredToAt" IS NULL OR "coveredFromAt" <= "coveredToAt")
    )
  ),
  ADD CONSTRAINT "AnalyticsCoverage_notification_complete_day_check" CHECK (
    "dataType" NOT IN ('NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS', 'NOTIFICATION_LIKES', 'NOTIFICATION_COMMENTS') OR
    "status" <> 'COMPLETE' OR (
      "sourceTimezone" = 'UTC' AND
      "coveredFromAt" = ("coverageDate"::timestamp) AND
      "coveredToAt" >= ("coverageDate"::timestamp) + interval '1 day' - interval '1 millisecond'
    )
  );
