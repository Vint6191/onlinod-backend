-- Fan Data Authority Cutover
-- One clock per fact domain: platform identity, relationship, value.

ALTER TABLE "CreatorFan"
  ADD COLUMN "avatarUrl" TEXT,
  ADD COLUMN "headerUrl" TEXT,
  ADD COLUMN "identityObservedAt" TIMESTAMP(3),
  ADD COLUMN "identitySource" TEXT,
  ADD COLUMN "identityCompleteness" TEXT,
  ADD COLUMN "lastActivityObservedAt" TIMESTAMP(3);

UPDATE "CreatorFan"
SET
  -- Legacy CreatorFan never had an identity-specific clock. lastSeenAt is an
  -- activity/event clock and may have advanced independently of the username
  -- currently stored on the row. Do not invent identity freshness from it.
  "identityObservedAt" = NULL,
  "identitySource" = COALESCE("identitySource", 'LEGACY_UNCLASSIFIED'),
  "identityCompleteness" = COALESCE(
    "identityCompleteness",
    CASE
      WHEN "username" IS NOT NULL AND "displayName" IS NOT NULL THEN 'PARTIAL'
      WHEN "username" IS NOT NULL OR "displayName" IS NOT NULL THEN 'PARTIAL'
      ELSE 'ID_ONLY'
    END
  ),
  "lastActivityObservedAt" = COALESCE("lastActivityObservedAt", "lastSeenAt");

CREATE INDEX "CreatorFan_creatorId_identityObservedAt_idx"
ON "CreatorFan"("creatorId", "identityObservedAt");

CREATE TABLE "CreatorFanRelationshipCurrent" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanRecordId" TEXT NOT NULL,
  "onlyFansUserId" TEXT NOT NULL,
  "fanSubscribesToCreator" BOOLEAN,
  "fanSubscriptionActive" BOOLEAN,
  "fanSubscriptionType" TEXT,
  "fanSubscriptionExpiresAt" TIMESTAMP(3),
  "creatorFollowsFan" BOOLEAN,
  "creatorFollowExpiresAt" TIMESTAMP(3),
  "canReceiveChatMessage" BOOLEAN,
  "blocked" BOOLEAN,
  "restricted" BOOLEAN,
  "performer" BOOLEAN,
  "lastSeenAt" TIMESTAMP(3),
  "subscribePriceCents" INTEGER,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "source" TEXT NOT NULL,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "scanRunId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorFanRelationshipCurrent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorFanRelationshipCurrent_creatorId_onlyFansUserId_key"
ON "CreatorFanRelationshipCurrent"("creatorId", "onlyFansUserId");
CREATE INDEX "CreatorFanRelationshipCurrent_agencyId_creatorId_observedAt_idx"
ON "CreatorFanRelationshipCurrent"("agencyId", "creatorId", "observedAt");
CREATE UNIQUE INDEX "CreatorFanRelationshipCurrent_creatorId_fanRecordId_key"
ON "CreatorFanRelationshipCurrent"("creatorId", "fanRecordId");
CREATE INDEX "CreatorFanRelationshipCurrent_sourceDeviceId_idx"
ON "CreatorFanRelationshipCurrent"("sourceDeviceId");
CREATE INDEX "CreatorFanRelationshipCurrent_sourceJobId_idx"
ON "CreatorFanRelationshipCurrent"("sourceJobId");

ALTER TABLE "CreatorFanRelationshipCurrent"
ADD CONSTRAINT "CreatorFanRelationshipCurrent_agencyId_creatorId_fkey"
FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorFanRelationshipCurrent"
ADD CONSTRAINT "CreatorFanRelationshipCurrent_creatorId_fanRecordId_fkey"
FOREIGN KEY ("creatorId", "fanRecordId") REFERENCES "CreatorFan"("creatorId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorFanRelationshipCurrent"
ADD CONSTRAINT "CreatorFanRelationshipCurrent_sourceDeviceId_fkey"
FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreatorFanRelationshipCurrent"
ADD CONSTRAINT "CreatorFanRelationshipCurrent_sourceJobId_fkey"
FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorFanValueCurrent"
  ALTER COLUMN "totalNetCents" DROP DEFAULT,
  ALTER COLUMN "totalNetCents" DROP NOT NULL,
  ALTER COLUMN "messagesNetCents" DROP DEFAULT,
  ALTER COLUMN "messagesNetCents" DROP NOT NULL,
  ALTER COLUMN "subscriptionsNetCents" DROP DEFAULT,
  ALTER COLUMN "subscriptionsNetCents" DROP NOT NULL,
  ALTER COLUMN "tipsNetCents" DROP DEFAULT,
  ALTER COLUMN "tipsNetCents" DROP NOT NULL,
  ALTER COLUMN "postsNetCents" DROP DEFAULT,
  ALTER COLUMN "postsNetCents" DROP NOT NULL,
  ALTER COLUMN "streamsNetCents" DROP DEFAULT,
  ALTER COLUMN "streamsNetCents" DROP NOT NULL,
  ADD COLUMN "availability" TEXT NOT NULL DEFAULT 'AVAILABLE',
  ALTER COLUMN "source" SET DEFAULT 'UNKNOWN';

ALTER TABLE "HiddenOnlineUser" ALTER COLUMN "totalSpentCents" DROP DEFAULT, ALTER COLUMN "totalSpentCents" DROP NOT NULL;
ALTER TABLE "CreatorPresenceUser" ALTER COLUMN "totalSpentCents" DROP DEFAULT, ALTER COLUMN "totalSpentCents" DROP NOT NULL;

ALTER TABLE "SubscriberScanItem"
  ALTER COLUMN "totalSpentCents" DROP DEFAULT,
  ALTER COLUMN "totalSpentCents" DROP NOT NULL,
  ADD COLUMN "messagesSpentCents" INTEGER,
  ADD COLUMN "tipsSpentCents" INTEGER,
  ADD COLUMN "subscriptionsSpentCents" INTEGER,
  ADD COLUMN "postsSpentCents" INTEGER,
  ADD COLUMN "streamsSpentCents" INTEGER,
  ADD COLUMN "valueAvailability" TEXT NOT NULL DEFAULT 'NOT_FETCHED',
  ADD COLUMN "fanSubscribesToCreator" BOOLEAN,
  ADD COLUMN "fanSubscriptionActive" BOOLEAN,
  ADD COLUMN "fanSubscriptionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "creatorFollowsFan" BOOLEAN,
  ADD COLUMN "creatorFollowExpiresAt" TIMESTAMP(3),
  ADD COLUMN "blocked" BOOLEAN,
  ADD COLUMN "restricted" BOOLEAN,
  ADD COLUMN "performer" BOOLEAN,
  ADD COLUMN "subscribePriceCents" INTEGER;


-- Immutable event-time actor snapshots. Current identity is projected separately;
-- these columns preserve how the actor was observed when the event happened.
ALTER TABLE "CreatorNotificationScanItem"
  ADD COLUMN "fanUsernameAtEvent" TEXT,
  ADD COLUMN "fanDisplayNameAtEvent" TEXT,
  ADD COLUMN "fanAvatarUrlAtEvent" TEXT;

ALTER TABLE "CreatorFinancialTransaction"
  ADD COLUMN "fanUsernameAtEvent" TEXT,
  ADD COLUMN "fanDisplayNameAtEvent" TEXT,
  ADD COLUMN "fanAvatarUrlAtEvent" TEXT;

ALTER TABLE "CreatorSale"
  ADD COLUMN "fanOnlyFansUserIdAtEvent" TEXT,
  ADD COLUMN "fanUsernameAtEvent" TEXT,
  ADD COLUMN "fanDisplayNameAtEvent" TEXT,
  ADD COLUMN "fanAvatarUrlAtEvent" TEXT;
ALTER TABLE "CreatorTip"
  ADD COLUMN "fanOnlyFansUserIdAtEvent" TEXT,
  ADD COLUMN "fanUsernameAtEvent" TEXT,
  ADD COLUMN "fanDisplayNameAtEvent" TEXT,
  ADD COLUMN "fanAvatarUrlAtEvent" TEXT;
ALTER TABLE "CreatorSubscriptionEvent"
  ADD COLUMN "fanOnlyFansUserIdAtEvent" TEXT,
  ADD COLUMN "fanUsernameAtEvent" TEXT,
  ADD COLUMN "fanDisplayNameAtEvent" TEXT,
  ADD COLUMN "fanAvatarUrlAtEvent" TEXT;
ALTER TABLE "CreatorPaidSubscription"
  ADD COLUMN "fanOnlyFansUserIdAtEvent" TEXT,
  ADD COLUMN "fanUsernameAtEvent" TEXT,
  ADD COLUMN "fanDisplayNameAtEvent" TEXT,
  ADD COLUMN "fanAvatarUrlAtEvent" TEXT;
ALTER TABLE "CreatorPostLike"
  ADD COLUMN "fanOnlyFansUserIdAtEvent" TEXT,
  ADD COLUMN "fanUsernameAtEvent" TEXT,
  ADD COLUMN "fanDisplayNameAtEvent" TEXT,
  ADD COLUMN "fanAvatarUrlAtEvent" TEXT;
ALTER TABLE "CreatorPostComment"
  ADD COLUMN "fanOnlyFansUserIdAtEvent" TEXT,
  ADD COLUMN "fanUsernameAtEvent" TEXT,
  ADD COLUMN "fanDisplayNameAtEvent" TEXT,
  ADD COLUMN "fanAvatarUrlAtEvent" TEXT;
ALTER TABLE "CreatorCampaignFan"
  ADD COLUMN "claimerUsernameAtEvent" TEXT,
  ADD COLUMN "claimerDisplayNameAtEvent" TEXT,
  ADD COLUMN "claimerAvatarUrlAtEvent" TEXT;

-- Preserve the latest independent Traffic value observation before retiring
-- the duplicate current-value table.
INSERT INTO "CreatorFan" (
  "id", "agencyId", "creatorId", "onlyFansUserId", "identityObservedAt",
  "identitySource", "identityCompleteness", "firstSeenAt", "lastSeenAt",
  "lastActivityObservedAt", "createdAt", "updatedAt"
)
SELECT
  'fan_' || md5(v."creatorId" || ':' || v."fanId"),
  v."agencyId", v."creatorId", v."fanId", v."fetchedAt",
  'TRAFFIC_LEGACY_MIGRATION', 'ID_ONLY', v."fetchedAt", v."fetchedAt",
  v."lastActivity", NOW(), NOW()
FROM "TrafficFanValueSnapshot" v
ON CONFLICT ("creatorId", "onlyFansUserId") DO NOTHING;

INSERT INTO "CreatorFanValueCurrent" (
  "id", "agencyId", "creatorId", "fanId", "totalNetCents", "messagesNetCents",
  "subscriptionsNetCents", "tipsNetCents", "postsNetCents", "streamsNetCents",
  "lastActivityAt", "fetchedAt", "availability", "source", "createdAt", "updatedAt"
)
SELECT
  'fan_value_' || md5(v."creatorId" || ':' || v."fanId"),
  v."agencyId", v."creatorId", f."id",
  v."totalSummCents"::bigint, v."messagesSummCents"::bigint,
  v."subscribesSummCents"::bigint, v."tipsSummCents"::bigint,
  v."postsSummCents"::bigint, v."streamsSummCents"::bigint,
  v."lastActivity", v."fetchedAt", 'UNAVAILABLE', 'TRAFFIC_LEGACY_MIGRATION', NOW(), NOW()
FROM "TrafficFanValueSnapshot" v
JOIN "CreatorFan" f ON f."creatorId" = v."creatorId" AND f."onlyFansUserId" = v."fanId"
-- A legacy Traffic row did not carry explicit parser availability/provenance.
-- Never let it override a canonical value that already exists.
ON CONFLICT ("creatorId", "fanId") DO NOTHING;

-- Every Traffic member that relied on the retired current-value table must be
-- refreshed through the canonical /users/:id point-refresh pipeline.
UPDATE "TrafficSourceMember"
SET "needsValueRefresh" = TRUE;

DROP TABLE "TrafficFanValueSnapshot";
