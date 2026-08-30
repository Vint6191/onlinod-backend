-- Fan Data Authority semantic closure.
-- Per-field authority versions make partial identity/relationship/value observations
-- monotonic under concurrent writers.
ALTER TABLE "CreatorFan"
  ADD COLUMN "identityAuthorityVersion" TEXT,
  ADD COLUMN "usernameAuthorityVersion" TEXT,
  ADD COLUMN "displayNameAuthorityVersion" TEXT,
  ADD COLUMN "avatarAuthorityVersion" TEXT,
  ADD COLUMN "headerAuthorityVersion" TEXT;

ALTER TABLE "CreatorFanRelationshipCurrent"
  ADD COLUMN "relationshipAuthorityVersion" TEXT,
  ADD COLUMN "fanSubscribesToCreatorAuthorityVersion" TEXT,
  ADD COLUMN "fanSubscriptionActiveAuthorityVersion" TEXT,
  ADD COLUMN "fanSubscriptionTypeAuthorityVersion" TEXT,
  ADD COLUMN "fanSubscriptionExpiresAtAuthorityVersion" TEXT,
  ADD COLUMN "creatorFollowsFanAuthorityVersion" TEXT,
  ADD COLUMN "creatorFollowExpiresAtAuthorityVersion" TEXT,
  ADD COLUMN "canReceiveChatMessageAuthorityVersion" TEXT,
  ADD COLUMN "blockedAuthorityVersion" TEXT,
  ADD COLUMN "restrictedAuthorityVersion" TEXT,
  ADD COLUMN "performerAuthorityVersion" TEXT,
  ADD COLUMN "lastSeenAtAuthorityVersion" TEXT,
  ADD COLUMN "subscribePriceCentsAuthorityVersion" TEXT;

ALTER TABLE "CreatorFanValueCurrent"
  ADD COLUMN "valueAuthorityVersion" TEXT,
  ADD COLUMN "availabilityAuthorityVersion" TEXT,
  ADD COLUMN "platformReportedTotalSpendCentsAuthorityVersion" TEXT,
  ADD COLUMN "messagesSpentCentsAuthorityVersion" TEXT,
  ADD COLUMN "subscriptionsSpentCentsAuthorityVersion" TEXT,
  ADD COLUMN "tipsSpentCentsAuthorityVersion" TEXT,
  ADD COLUMN "postsSpentCentsAuthorityVersion" TEXT,
  ADD COLUMN "streamsSpentCentsAuthorityVersion" TEXT,
  ADD COLUMN "lastActivityAtAuthorityVersion" TEXT;

-- The previous cutover migration could create an ID-only CreatorFan from legacy
-- TrafficFanValueSnapshot and incorrectly stamp a money timestamp as identity freshness.
UPDATE "CreatorFan"
SET
  "identityObservedAt" = NULL,
  "identitySource" = NULL,
  "identityCompleteness" = NULL
WHERE "identitySource" = 'TRAFFIC_LEGACY_MIGRATION'
  AND "username" IS NULL
  AND "displayName" IS NULL
  AND "avatarUrl" IS NULL
  AND "headerUrl" IS NULL;

-- Presence is temporal-only. Older builds could advance aggregate identity metadata
-- from PRESENCE_HINT even when the synthetic value itself was rejected. Preserve
-- the current display fields, but remove the false canonical clock/provenance so
-- the next real identity observation can establish authority.
UPDATE "CreatorFan"
SET
  "identityObservedAt" = NULL,
  "identitySource" = NULL,
  "identityCompleteness" = NULL
WHERE "identitySource" = 'PRESENCE_HINT';

-- Backfill a sortable legacy prefix for existing real current facts. New runtime
-- versions append a deterministic value hash; timestamp is the primary order key.
-- Null fields intentionally get no field version because pre-closure NULL could mean
-- "not observed" rather than an explicit clear.
WITH fan_versions AS (
  SELECT
    "id",
    CASE "identitySource"
      WHEN 'USER_PROFILE' THEN 700
      WHEN 'SUBSCRIBER_DIRECTORY' THEN 600
      WHEN 'LIVE_MESSAGE' THEN 500
      WHEN 'PAGE_OBSERVATION' THEN 450
      WHEN 'LIVE_NOTIFICATION' THEN 400
      WHEN 'FINANCIAL_TRANSACTION' THEN 350
      WHEN 'CAMPAIGN_CLAIMER' THEN 300
      WHEN 'TRAFFIC_ATTRIBUTION' THEN 250
      WHEN 'PRESENCE_HINT' THEN 100
      WHEN 'TRAFFIC_LEGACY_MIGRATION' THEN 50
      ELSE 0
    END AS priority
  FROM "CreatorFan"
)
UPDATE "CreatorFan" AS f
SET
  "identityAuthorityVersion" = CASE WHEN f."identityObservedAt" IS NOT NULL AND (f."username" IS NOT NULL OR f."displayName" IS NOT NULL OR f."avatarUrl" IS NOT NULL OR f."headerUrl" IS NOT NULL)
    THEN to_char(f."identityObservedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || lpad(v.priority::text, 4, '0') || '|' || COALESCE(f."identitySource", 'UNKNOWN') || '|000000000000000000000000' END,
  "usernameAuthorityVersion" = CASE WHEN f."identityObservedAt" IS NOT NULL AND f."username" IS NOT NULL
    THEN to_char(f."identityObservedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || lpad(v.priority::text, 4, '0') || '|' || COALESCE(f."identitySource", 'UNKNOWN') || '|000000000000000000000000' END,
  "displayNameAuthorityVersion" = CASE WHEN f."identityObservedAt" IS NOT NULL AND f."displayName" IS NOT NULL
    THEN to_char(f."identityObservedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || lpad(v.priority::text, 4, '0') || '|' || COALESCE(f."identitySource", 'UNKNOWN') || '|000000000000000000000000' END,
  "avatarAuthorityVersion" = CASE WHEN f."identityObservedAt" IS NOT NULL AND f."avatarUrl" IS NOT NULL
    THEN to_char(f."identityObservedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || lpad(v.priority::text, 4, '0') || '|' || COALESCE(f."identitySource", 'UNKNOWN') || '|000000000000000000000000' END,
  "headerAuthorityVersion" = CASE WHEN f."identityObservedAt" IS NOT NULL AND f."headerUrl" IS NOT NULL
    THEN to_char(f."identityObservedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || lpad(v.priority::text, 4, '0') || '|' || COALESCE(f."identitySource", 'UNKNOWN') || '|000000000000000000000000' END
FROM fan_versions v
WHERE v."id" = f."id";

UPDATE "CreatorFanRelationshipCurrent" AS r
SET
  "relationshipAuthorityVersion" = to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000',
  "fanSubscribesToCreatorAuthorityVersion" = CASE WHEN r."fanSubscribesToCreator" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "fanSubscriptionActiveAuthorityVersion" = CASE WHEN r."fanSubscriptionActive" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "fanSubscriptionTypeAuthorityVersion" = CASE WHEN r."fanSubscriptionType" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "fanSubscriptionExpiresAtAuthorityVersion" = CASE WHEN r."fanSubscriptionExpiresAt" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "creatorFollowsFanAuthorityVersion" = CASE WHEN r."creatorFollowsFan" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "creatorFollowExpiresAtAuthorityVersion" = CASE WHEN r."creatorFollowExpiresAt" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "canReceiveChatMessageAuthorityVersion" = CASE WHEN r."canReceiveChatMessage" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "blockedAuthorityVersion" = CASE WHEN r."blocked" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "restrictedAuthorityVersion" = CASE WHEN r."restricted" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "performerAuthorityVersion" = CASE WHEN r."performer" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "lastSeenAtAuthorityVersion" = CASE WHEN r."lastSeenAt" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END,
  "subscribePriceCentsAuthorityVersion" = CASE WHEN r."subscribePriceCents" IS NOT NULL THEN to_char(r."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(r."source", 'UNKNOWN') || '|000000000000000000000000' END;

UPDATE "CreatorFanValueCurrent" AS v
SET "valueAuthorityVersion" =
  to_char(v."fetchedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|0000|' || COALESCE(v."source", 'UNKNOWN') || '|000000000000000000000000';

UPDATE "CreatorFanValueCurrent"
SET
  "availabilityAuthorityVersion" = COALESCE("availabilityAuthorityVersion", "valueAuthorityVersion"),
  "platformReportedTotalSpendCentsAuthorityVersion" = CASE WHEN "totalNetCents" IS NOT NULL THEN COALESCE("platformReportedTotalSpendCentsAuthorityVersion", "valueAuthorityVersion") ELSE "platformReportedTotalSpendCentsAuthorityVersion" END,
  "messagesSpentCentsAuthorityVersion" = CASE WHEN "messagesNetCents" IS NOT NULL THEN COALESCE("messagesSpentCentsAuthorityVersion", "valueAuthorityVersion") ELSE "messagesSpentCentsAuthorityVersion" END,
  "subscriptionsSpentCentsAuthorityVersion" = CASE WHEN "subscriptionsNetCents" IS NOT NULL THEN COALESCE("subscriptionsSpentCentsAuthorityVersion", "valueAuthorityVersion") ELSE "subscriptionsSpentCentsAuthorityVersion" END,
  "tipsSpentCentsAuthorityVersion" = CASE WHEN "tipsNetCents" IS NOT NULL THEN COALESCE("tipsSpentCentsAuthorityVersion", "valueAuthorityVersion") ELSE "tipsSpentCentsAuthorityVersion" END,
  "postsSpentCentsAuthorityVersion" = CASE WHEN "postsNetCents" IS NOT NULL THEN COALESCE("postsSpentCentsAuthorityVersion", "valueAuthorityVersion") ELSE "postsSpentCentsAuthorityVersion" END,
  "streamsSpentCentsAuthorityVersion" = CASE WHEN "streamsNetCents" IS NOT NULL THEN COALESCE("streamsSpentCentsAuthorityVersion", "valueAuthorityVersion") ELSE "streamsSpentCentsAuthorityVersion" END,
  "lastActivityAtAuthorityVersion" = CASE WHEN "lastActivityAt" IS NOT NULL THEN COALESCE("lastActivityAtAuthorityVersion", "valueAuthorityVersion") ELSE "lastActivityAtAuthorityVersion" END;
