-- Creator Analytics relational foundation V2.
-- Business analytics stays fully typed/relational. No raw notification/message
-- payloads are added to Postgres. Local message text/media remain desktop-only.

CREATE TYPE "CreatorFactSource" AS ENUM (
  'NOTIFICATION',
  'LOCAL_MESSAGE_LEDGER',
  'ONLYFANS_API',
  'RECONCILIATION'
);
CREATE TYPE "CreatorPaidSubscriptionPaymentType" AS ENUM ('INITIAL', 'RENEWAL', 'RESUBSCRIPTION');
CREATE TYPE "CreatorSubscriptionStateStatus" AS ENUM ('UNKNOWN', 'ACTIVE', 'EXPIRED');
CREATE TYPE "CreatorCampaignAttributionSource" AS ENUM (
  'ONLYFANS_TRACKING', 'NOTIFICATION', 'SUBSCRIPTION_RECORD', 'MANUAL', 'INFERRED'
);
CREATE TYPE "CreatorCampaignAttributionConfidence" AS ENUM ('CONFIRMED', 'PROBABLE', 'WEAK');
CREATE TYPE "CreatorLocalCoverageStatus" AS ENUM ('MISSING', 'PARTIAL', 'COMPLETE', 'FAILED');

ALTER TABLE "CreatorSale"
  ADD COLUMN "source" "CreatorFactSource" NOT NULL DEFAULT 'NOTIFICATION',
  ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "CreatorTip"
  ADD COLUMN "source" "CreatorFactSource" NOT NULL DEFAULT 'NOTIFICATION',
  ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "CreatorSubscriptionEvent"
  ADD COLUMN "source" "CreatorFactSource" NOT NULL DEFAULT 'NOTIFICATION',
  ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3);

-- Existing rows came from the notification collector. Keep that provenance
-- explicit rather than leaving an ambiguous generic source.
UPDATE "CreatorSale" SET "source" = 'NOTIFICATION' WHERE "source" IS NULL;
UPDATE "CreatorTip" SET "source" = 'NOTIFICATION' WHERE "source" IS NULL;
UPDATE "CreatorSubscriptionEvent" SET "source" = 'NOTIFICATION' WHERE "source" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorSubscriptionEvent_creatorId_id_key"
  ON "CreatorSubscriptionEvent"("creatorId", "id");

CREATE TABLE "CreatorSubscriptionState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "status" "CreatorSubscriptionStateStatus" NOT NULL DEFAULT 'UNKNOWN',
  "currentPriceCents" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "startedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "lastRenewedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "autoRenewEnabled" BOOLEAN,
  "lastEventAt" TIMESTAMP(3) NOT NULL,
  "updatedFromEventId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorSubscriptionState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorSubscriptionState_price_check" CHECK ("currentPriceCents" IS NULL OR "currentPriceCents" >= 0),
  CONSTRAINT "CreatorSubscriptionState_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "CreatorSubscriptionState_dates_check" CHECK (
    ("startedAt" IS NULL OR "endedAt" IS NULL OR "startedAt" <= "endedAt") AND
    ("startedAt" IS NULL OR "expiresAt" IS NULL OR "startedAt" <= "expiresAt")
  )
);
CREATE UNIQUE INDEX "CreatorSubscriptionState_creatorId_fanId_key" ON "CreatorSubscriptionState"("creatorId", "fanId");
CREATE UNIQUE INDEX "CreatorSubscriptionState_updatedFromEventId_key" ON "CreatorSubscriptionState"("updatedFromEventId");
CREATE INDEX "CreatorSubscriptionState_agencyId_creatorId_status_idx" ON "CreatorSubscriptionState"("agencyId", "creatorId", "status");
CREATE INDEX "CreatorSubscriptionState_creatorId_lastEventAt_idx" ON "CreatorSubscriptionState"("creatorId", "lastEventAt");
ALTER TABLE "CreatorSubscriptionState"
  ADD CONSTRAINT "CreatorSubscriptionState_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorSubscriptionState_fan_fkey"
    FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorSubscriptionState_updatedFromEvent_fkey"
    FOREIGN KEY ("updatedFromEventId") REFERENCES "CreatorSubscriptionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rebuild current subscription state from the immutable event ledger.
-- The latest lifecycle event decides ACTIVE/EXPIRED; price and auto-renew are
-- taken from their own latest observations so scan order cannot corrupt state.
WITH fans AS (
  SELECT DISTINCT "agencyId", "creatorId", "fanId"
  FROM "CreatorSubscriptionEvent"
  WHERE "fanId" IS NOT NULL
), projected AS (
  SELECT
    fan."agencyId", fan."creatorId", fan."fanId",
    COALESCE((
      SELECT CASE
        WHEN event."eventType" = 'EXPIRED' THEN 'EXPIRED'::"CreatorSubscriptionStateStatus"
        ELSE 'ACTIVE'::"CreatorSubscriptionStateStatus"
      END
      FROM "CreatorSubscriptionEvent" event
      WHERE event."creatorId" = fan."creatorId" AND event."fanId" = fan."fanId"
        AND event."eventType" IN ('SUBSCRIBED_FREE','SUBSCRIBED_PAID','SUBSCRIBED_UNKNOWN','RENEWED','RESUBSCRIBED','EXPIRED')
      ORDER BY event."occurredAt" DESC, event."id" DESC LIMIT 1
    ), 'UNKNOWN'::"CreatorSubscriptionStateStatus") AS status,
    (SELECT event."observedPriceCents" FROM "CreatorSubscriptionEvent" event
      WHERE event."creatorId"=fan."creatorId" AND event."fanId"=fan."fanId" AND event."observedPriceCents" IS NOT NULL
      ORDER BY event."occurredAt" DESC, event."id" DESC LIMIT 1) AS "currentPriceCents",
    COALESCE((SELECT event."currency" FROM "CreatorSubscriptionEvent" event
      WHERE event."creatorId"=fan."creatorId" AND event."fanId"=fan."fanId"
      ORDER BY event."occurredAt" DESC, event."id" DESC LIMIT 1), 'USD') AS currency,
    (SELECT MAX(event."occurredAt") FROM "CreatorSubscriptionEvent" event
      WHERE event."creatorId"=fan."creatorId" AND event."fanId"=fan."fanId"
        AND event."eventType" IN ('SUBSCRIBED_FREE','SUBSCRIBED_PAID','SUBSCRIBED_UNKNOWN','RESUBSCRIBED')) AS "startedAt",
    (SELECT MAX(event."occurredAt") FROM "CreatorSubscriptionEvent" event
      WHERE event."creatorId"=fan."creatorId" AND event."fanId"=fan."fanId" AND event."eventType"='RENEWED') AS "lastRenewedAt",
    (SELECT CASE WHEN event."eventType"='EXPIRED' THEN event."occurredAt" ELSE NULL END
      FROM "CreatorSubscriptionEvent" event
      WHERE event."creatorId"=fan."creatorId" AND event."fanId"=fan."fanId"
        AND event."eventType" IN ('SUBSCRIBED_FREE','SUBSCRIBED_PAID','SUBSCRIBED_UNKNOWN','RENEWED','RESUBSCRIBED','EXPIRED')
      ORDER BY event."occurredAt" DESC, event."id" DESC LIMIT 1) AS "endedAt",
    (SELECT CASE WHEN event."eventType"='AUTO_RENEW_ENABLED' THEN true ELSE false END
      FROM "CreatorSubscriptionEvent" event
      WHERE event."creatorId"=fan."creatorId" AND event."fanId"=fan."fanId"
        AND event."eventType" IN ('AUTO_RENEW_ENABLED','AUTO_RENEW_DISABLED')
      ORDER BY event."occurredAt" DESC, event."id" DESC LIMIT 1) AS "autoRenewEnabled",
    latest."occurredAt" AS "lastEventAt", latest."id" AS "updatedFromEventId"
  FROM fans fan
  JOIN LATERAL (
    SELECT event."id", event."occurredAt"
    FROM "CreatorSubscriptionEvent" event
    WHERE event."creatorId"=fan."creatorId" AND event."fanId"=fan."fanId"
    ORDER BY event."occurredAt" DESC, event."id" DESC LIMIT 1
  ) latest ON TRUE
)
INSERT INTO "CreatorSubscriptionState" (
  "id", "agencyId", "creatorId", "fanId", status, "currentPriceCents", currency,
  "startedAt", "expiresAt", "lastRenewedAt", "endedAt", "autoRenewEnabled",
  "lastEventAt", "updatedFromEventId", "createdAt", "updatedAt"
)
SELECT
  'css_' || md5(projected."creatorId" || ':' || projected."fanId"),
  projected."agencyId", projected."creatorId", projected."fanId", projected.status,
  projected."currentPriceCents", projected.currency, projected."startedAt", NULL,
  projected."lastRenewedAt", projected."endedAt", projected."autoRenewEnabled",
  projected."lastEventAt", projected."updatedFromEventId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM projected
ON CONFLICT ("creatorId", "fanId") DO UPDATE SET
  status=EXCLUDED.status, "currentPriceCents"=EXCLUDED."currentPriceCents", currency=EXCLUDED.currency,
  "startedAt"=EXCLUDED."startedAt", "lastRenewedAt"=EXCLUDED."lastRenewedAt",
  "endedAt"=EXCLUDED."endedAt", "autoRenewEnabled"=EXCLUDED."autoRenewEnabled",
  "lastEventAt"=EXCLUDED."lastEventAt", "updatedFromEventId"=EXCLUDED."updatedFromEventId",
  "updatedAt"=CURRENT_TIMESTAMP;

CREATE TABLE "CreatorPaidSubscription" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT,
  "eventFingerprint" TEXT NOT NULL,
  "externalTransactionId" TEXT,
  "subscriptionEventId" TEXT,
  "paymentType" "CreatorPaidSubscriptionPaymentType" NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "paidAt" TIMESTAMP(3) NOT NULL,
  "periodFrom" TIMESTAMP(3),
  "periodTo" TIMESTAMP(3),
  "source" "CreatorFactSource" NOT NULL DEFAULT 'NOTIFICATION',
  "sourceUpdatedAt" TIMESTAMP(3),
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorPaidSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorPaidSubscription_amount_check" CHECK ("amountCents" > 0),
  CONSTRAINT "CreatorPaidSubscription_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "CreatorPaidSubscription_fingerprint_check" CHECK (length(btrim("eventFingerprint")) BETWEEN 32 AND 64),
  CONSTRAINT "CreatorPaidSubscription_period_check" CHECK ("periodFrom" IS NULL OR "periodTo" IS NULL OR "periodFrom" <= "periodTo")
);
CREATE UNIQUE INDEX "CreatorPaidSubscription_subscriptionEventId_key" ON "CreatorPaidSubscription"("subscriptionEventId");
CREATE UNIQUE INDEX "CreatorPaidSubscription_creatorId_eventFingerprint_key" ON "CreatorPaidSubscription"("creatorId", "eventFingerprint");
CREATE UNIQUE INDEX "CreatorPaidSubscription_creatorId_externalTransactionId_key" ON "CreatorPaidSubscription"("creatorId", "externalTransactionId");
CREATE INDEX "CreatorPaidSubscription_agencyId_creatorId_paidAt_idx" ON "CreatorPaidSubscription"("agencyId", "creatorId", "paidAt");
CREATE INDEX "CreatorPaidSubscription_creatorId_fanId_paidAt_idx" ON "CreatorPaidSubscription"("creatorId", "fanId", "paidAt");
CREATE INDEX "CreatorPaidSubscription_sourceJobId_idx" ON "CreatorPaidSubscription"("sourceJobId");
ALTER TABLE "CreatorPaidSubscription"
  ADD CONSTRAINT "CreatorPaidSubscription_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPaidSubscription_fan_fkey"
    FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPaidSubscription_subscriptionEvent_fkey"
    FOREIGN KEY ("subscriptionEventId") REFERENCES "CreatorSubscriptionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPaidSubscription_sourceDevice_fkey"
    FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorPaidSubscription_sourceJob_fkey"
    FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Materialize already-ingested paid subscription events. The row identity is
-- deterministic and does not depend on a PostgreSQL extension.
INSERT INTO "CreatorPaidSubscription" (
  "id", "agencyId", "creatorId", "fanId", "eventFingerprint", "externalTransactionId",
  "subscriptionEventId", "paymentType", "amountCents", "currency", "paidAt", "periodFrom",
  "source", "sourceUpdatedAt", "collectedAt", "sourceDeviceId", "sourceJobId", "createdAt", "updatedAt"
)
SELECT
  'cps_' || md5(event."creatorId" || ':' || event."id"),
  event."agencyId",
  event."creatorId",
  event."fanId",
  md5('paid-subscription:' || event."creatorId" || ':' || event."eventFingerprint"),
  event."externalTransactionId",
  event."id",
  CASE
    WHEN event."eventType" = 'RENEWED' THEN 'RENEWAL'::"CreatorPaidSubscriptionPaymentType"
    WHEN event."eventType" = 'RESUBSCRIBED' THEN 'RESUBSCRIPTION'::"CreatorPaidSubscriptionPaymentType"
    ELSE 'INITIAL'::"CreatorPaidSubscriptionPaymentType"
  END,
  event."observedPriceCents",
  event."currency",
  event."occurredAt",
  event."occurredAt",
  event."source",
  event."sourceUpdatedAt",
  event."collectedAt",
  event."sourceDeviceId",
  event."sourceJobId",
  event."createdAt",
  event."updatedAt"
FROM "CreatorSubscriptionEvent" AS event
WHERE event."eventType" IN ('SUBSCRIBED_PAID', 'RENEWED', 'RESUBSCRIBED')
  AND event."observedPriceCents" > 0
ON CONFLICT ("subscriptionEventId") DO NOTHING;

ALTER TABLE "CreatorCampaignFan"
  ADD COLUMN "attributionSource" "CreatorCampaignAttributionSource" NOT NULL DEFAULT 'ONLYFANS_TRACKING',
  ADD COLUMN "attributionConfidence" "CreatorCampaignAttributionConfidence" NOT NULL DEFAULT 'CONFIRMED',
  ADD COLUMN "subscriptionEventId" TEXT;
CREATE INDEX "CreatorCampaignFan_subscriptionEventId_idx" ON "CreatorCampaignFan"("subscriptionEventId");
ALTER TABLE "CreatorCampaignFan"
  ADD CONSTRAINT "CreatorCampaignFan_subscriptionEvent_fkey"
    FOREIGN KEY ("subscriptionEventId") REFERENCES "CreatorSubscriptionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CreatorDailyMetrics" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "sourceTimezone" TEXT NOT NULL DEFAULT 'UTC',
  "incomingMessages" INTEGER NOT NULL DEFAULT 0,
  "outgoingMessages" INTEGER NOT NULL DEFAULT 0,
  "uniqueDialogs" INTEGER NOT NULL DEFAULT 0,
  "likes" INTEGER NOT NULL DEFAULT 0,
  "uniqueLikingFans" INTEGER NOT NULL DEFAULT 0,
  "comments" INTEGER NOT NULL DEFAULT 0,
  "uniqueCommentingFans" INTEGER NOT NULL DEFAULT 0,
  "newSubscribers" INTEGER NOT NULL DEFAULT 0,
  "renewals" INTEGER NOT NULL DEFAULT 0,
  "expiredSubscribers" INTEGER NOT NULL DEFAULT 0,
  "autoRenewDisabled" INTEGER NOT NULL DEFAULT 0,
  "messageSales" INTEGER NOT NULL DEFAULT 0,
  "postSales" INTEGER NOT NULL DEFAULT 0,
  "uniqueBuyers" INTEGER NOT NULL DEFAULT 0,
  "tipsCount" INTEGER NOT NULL DEFAULT 0,
  "tipsCents" INTEGER NOT NULL DEFAULT 0,
  "paidSubscriptions" INTEGER NOT NULL DEFAULT 0,
  "paidSubscriptionsCents" INTEGER NOT NULL DEFAULT 0,
  "salesCents" INTEGER NOT NULL DEFAULT 0,
  "totalObservedRevenueCents" INTEGER NOT NULL DEFAULT 0,
  "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dataVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorDailyMetrics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorDailyMetrics_non_negative_check" CHECK (
    "incomingMessages" >= 0 AND "outgoingMessages" >= 0 AND "uniqueDialogs" >= 0 AND
    "likes" >= 0 AND "uniqueLikingFans" >= 0 AND "comments" >= 0 AND "uniqueCommentingFans" >= 0 AND
    "newSubscribers" >= 0 AND "renewals" >= 0 AND "expiredSubscribers" >= 0 AND "autoRenewDisabled" >= 0 AND
    "messageSales" >= 0 AND "postSales" >= 0 AND "uniqueBuyers" >= 0 AND
    "tipsCount" >= 0 AND "tipsCents" >= 0 AND "paidSubscriptions" >= 0 AND
    "paidSubscriptionsCents" >= 0 AND "salesCents" >= 0 AND "totalObservedRevenueCents" >= 0 AND "dataVersion" > 0
  ),
  CONSTRAINT "CreatorDailyMetrics_timezone_check" CHECK ("sourceTimezone" = 'UTC')
);
CREATE UNIQUE INDEX "CreatorDailyMetrics_creatorId_date_sourceTimezone_key" ON "CreatorDailyMetrics"("creatorId", "date", "sourceTimezone");
CREATE INDEX "CreatorDailyMetrics_agencyId_creatorId_date_idx" ON "CreatorDailyMetrics"("agencyId", "creatorId", "date");
CREATE INDEX "CreatorDailyMetrics_creatorId_date_idx" ON "CreatorDailyMetrics"("creatorId", "date");
ALTER TABLE "CreatorDailyMetrics"
  ADD CONSTRAINT "CreatorDailyMetrics_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Materialize the disposable daily read cache from primary relational facts.
WITH days AS (
  SELECT "creatorId", "agencyId", "date" AS day FROM "CreatorMessagesDaily"
  UNION SELECT "creatorId", "agencyId", date_trunc('day', "likedAt")::date FROM "CreatorPostLike"
  UNION SELECT "creatorId", "agencyId", date_trunc('day', "commentedAt")::date FROM "CreatorPostComment"
  UNION SELECT "creatorId", "agencyId", date_trunc('day', "occurredAt")::date FROM "CreatorSubscriptionEvent"
  UNION SELECT "creatorId", "agencyId", date_trunc('day', "purchasedAt")::date FROM "CreatorSale"
  UNION SELECT "creatorId", "agencyId", date_trunc('day', "tippedAt")::date FROM "CreatorTip"
  UNION SELECT "creatorId", "agencyId", date_trunc('day', "paidAt")::date FROM "CreatorPaidSubscription"
), message_agg AS (
  SELECT "creatorId", "date" AS day, SUM("incomingMessages")::bigint incoming, SUM("outgoingMessages")::bigint outgoing, MAX("uniqueDialogs")::bigint dialogs
  FROM "CreatorMessagesDaily" GROUP BY "creatorId", "date"
), like_agg AS (
  SELECT "creatorId", date_trunc('day', "likedAt")::date day, COUNT(*)::bigint count, COUNT(DISTINCT "fanId")::bigint fans
  FROM "CreatorPostLike" GROUP BY "creatorId", day
), comment_agg AS (
  SELECT "creatorId", date_trunc('day', "commentedAt")::date day, COUNT(*)::bigint count, COUNT(DISTINCT "fanId")::bigint fans
  FROM "CreatorPostComment" GROUP BY "creatorId", day
), subscription_agg AS (
  SELECT "creatorId", date_trunc('day', "occurredAt")::date day,
    COUNT(*) FILTER (WHERE "eventType" IN ('SUBSCRIBED_FREE','SUBSCRIBED_PAID','SUBSCRIBED_UNKNOWN'))::bigint subscribed,
    COUNT(*) FILTER (WHERE "eventType"='RENEWED')::bigint renewed,
    COUNT(*) FILTER (WHERE "eventType"='EXPIRED')::bigint expired,
    COUNT(*) FILTER (WHERE "eventType"='AUTO_RENEW_DISABLED')::bigint auto_renew_disabled
  FROM "CreatorSubscriptionEvent" GROUP BY "creatorId", day
), sale_agg AS (
  SELECT "creatorId", date_trunc('day', "purchasedAt")::date day,
    COUNT(*) FILTER (WHERE "saleType"='MESSAGE')::bigint message_sales,
    COUNT(*) FILTER (WHERE "saleType"='POST')::bigint post_sales, COUNT(DISTINCT "fanId")::bigint buyers,
    COALESCE(SUM("amountCents"),0)::bigint cents
  FROM "CreatorSale" GROUP BY "creatorId", day
), tip_agg AS (
  SELECT "creatorId", date_trunc('day', "tippedAt")::date day, COUNT(*)::bigint count, COALESCE(SUM("amountCents"),0)::bigint cents
  FROM "CreatorTip" GROUP BY "creatorId", day
), paid_agg AS (
  SELECT "creatorId", date_trunc('day', "paidAt")::date day, COUNT(*)::bigint count, COALESCE(SUM("amountCents"),0)::bigint cents
  FROM "CreatorPaidSubscription" GROUP BY "creatorId", day
)
INSERT INTO "CreatorDailyMetrics" (
  "id", "agencyId", "creatorId", "date", "sourceTimezone", "incomingMessages", "outgoingMessages", "uniqueDialogs",
  likes, "uniqueLikingFans", comments, "uniqueCommentingFans", "newSubscribers", renewals, "expiredSubscribers", "autoRenewDisabled",
  "messageSales", "postSales", "uniqueBuyers", "tipsCount", "tipsCents", "paidSubscriptions", "paidSubscriptionsCents",
  "salesCents", "totalObservedRevenueCents", "calculatedAt", "dataVersion", "createdAt", "updatedAt"
)
SELECT
  'cdm_' || md5(days."creatorId" || ':' || days.day::text), days."agencyId", days."creatorId", days.day, 'UTC',
  COALESCE(message_agg.incoming,0), COALESCE(message_agg.outgoing,0), COALESCE(message_agg.dialogs,0),
  COALESCE(like_agg.count,0), COALESCE(like_agg.fans,0), COALESCE(comment_agg.count,0), COALESCE(comment_agg.fans,0),
  COALESCE(subscription_agg.subscribed,0), COALESCE(subscription_agg.renewed,0), COALESCE(subscription_agg.expired,0), COALESCE(subscription_agg.auto_renew_disabled,0),
  COALESCE(sale_agg.message_sales,0), COALESCE(sale_agg.post_sales,0), COALESCE(sale_agg.buyers,0),
  COALESCE(tip_agg.count,0), COALESCE(tip_agg.cents,0), COALESCE(paid_agg.count,0), COALESCE(paid_agg.cents,0),
  COALESCE(sale_agg.cents,0), COALESCE(sale_agg.cents,0)+COALESCE(tip_agg.cents,0)+COALESCE(paid_agg.cents,0),
  CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM days
LEFT JOIN message_agg ON message_agg."creatorId"=days."creatorId" AND message_agg.day=days.day
LEFT JOIN like_agg ON like_agg."creatorId"=days."creatorId" AND like_agg.day=days.day
LEFT JOIN comment_agg ON comment_agg."creatorId"=days."creatorId" AND comment_agg.day=days.day
LEFT JOIN subscription_agg ON subscription_agg."creatorId"=days."creatorId" AND subscription_agg.day=days.day
LEFT JOIN sale_agg ON sale_agg."creatorId"=days."creatorId" AND sale_agg.day=days.day
LEFT JOIN tip_agg ON tip_agg."creatorId"=days."creatorId" AND tip_agg.day=days.day
LEFT JOIN paid_agg ON paid_agg."creatorId"=days."creatorId" AND paid_agg.day=days.day
ON CONFLICT ("creatorId", "date", "sourceTimezone") DO UPDATE SET
  "incomingMessages"=EXCLUDED."incomingMessages", "outgoingMessages"=EXCLUDED."outgoingMessages", "uniqueDialogs"=EXCLUDED."uniqueDialogs",
  likes=EXCLUDED.likes, "uniqueLikingFans"=EXCLUDED."uniqueLikingFans", comments=EXCLUDED.comments, "uniqueCommentingFans"=EXCLUDED."uniqueCommentingFans",
  "newSubscribers"=EXCLUDED."newSubscribers", renewals=EXCLUDED.renewals, "expiredSubscribers"=EXCLUDED."expiredSubscribers", "autoRenewDisabled"=EXCLUDED."autoRenewDisabled",
  "messageSales"=EXCLUDED."messageSales", "postSales"=EXCLUDED."postSales", "uniqueBuyers"=EXCLUDED."uniqueBuyers",
  "tipsCount"=EXCLUDED."tipsCount", "tipsCents"=EXCLUDED."tipsCents", "paidSubscriptions"=EXCLUDED."paidSubscriptions",
  "paidSubscriptionsCents"=EXCLUDED."paidSubscriptionsCents", "salesCents"=EXCLUDED."salesCents", "totalObservedRevenueCents"=EXCLUDED."totalObservedRevenueCents",
  "calculatedAt"=CURRENT_TIMESTAMP, "dataVersion"=1, "updatedAt"=CURRENT_TIMESTAMP;

CREATE TABLE "CreatorLocalMessageCoverage" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "oldestMessageAt" TIMESTAMP(3),
  "newestMessageAt" TIMESTAMP(3),
  "dialogsCovered" INTEGER NOT NULL DEFAULT 0,
  "messagesIndexed" INTEGER NOT NULL DEFAULT 0,
  "coverageStatus" "CreatorLocalCoverageStatus" NOT NULL DEFAULT 'MISSING',
  "lastVerifiedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorLocalMessageCoverage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorLocalMessageCoverage_counts_check" CHECK ("dialogsCovered" >= 0 AND "messagesIndexed" >= 0),
  CONSTRAINT "CreatorLocalMessageCoverage_dates_check" CHECK ("oldestMessageAt" IS NULL OR "newestMessageAt" IS NULL OR "oldestMessageAt" <= "newestMessageAt")
);
CREATE UNIQUE INDEX "CreatorLocalMessageCoverage_creatorId_deviceId_key" ON "CreatorLocalMessageCoverage"("creatorId", "deviceId");
CREATE INDEX "CreatorLocalMessageCoverage_agencyId_creatorId_coverageStatus_idx" ON "CreatorLocalMessageCoverage"("agencyId", "creatorId", "coverageStatus");
CREATE INDEX "CreatorLocalMessageCoverage_deviceId_lastVerifiedAt_idx" ON "CreatorLocalMessageCoverage"("deviceId", "lastVerifiedAt");
ALTER TABLE "CreatorLocalMessageCoverage"
  ADD CONSTRAINT "CreatorLocalMessageCoverage_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorLocalMessageCoverage_device_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreatorFanLocalCoverage" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "oldestMessageAt" TIMESTAMP(3),
  "newestMessageAt" TIMESTAMP(3),
  "isComplete" BOOLEAN NOT NULL DEFAULT false,
  "lastVerifiedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorFanLocalCoverage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorFanLocalCoverage_dates_check" CHECK ("oldestMessageAt" IS NULL OR "newestMessageAt" IS NULL OR "oldestMessageAt" <= "newestMessageAt")
);
CREATE UNIQUE INDEX "CreatorFanLocalCoverage_creatorId_fanId_deviceId_key" ON "CreatorFanLocalCoverage"("creatorId", "fanId", "deviceId");
CREATE INDEX "CreatorFanLocalCoverage_agencyId_creatorId_isComplete_idx" ON "CreatorFanLocalCoverage"("agencyId", "creatorId", "isComplete");
CREATE INDEX "CreatorFanLocalCoverage_deviceId_lastVerifiedAt_idx" ON "CreatorFanLocalCoverage"("deviceId", "lastVerifiedAt");
ALTER TABLE "CreatorFanLocalCoverage"
  ADD CONSTRAINT "CreatorFanLocalCoverage_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorFanLocalCoverage_fan_fkey"
    FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorFanLocalCoverage_device_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- V1.9 proved a source boundary, not lifetime availability. Earlier collector
-- builds could mark the whole requested 369-day interval COMPLETE after the
-- source itself ended around the oldest returned notification. Remove those
-- impossible pre-boundary day rows. Retained facts are untouched.
DELETE FROM "AnalyticsCoverage" AS coverage
USING "CreatorNotificationSyncState" AS sync
WHERE coverage."creatorId" = sync."creatorId"
  AND coverage."dataType" IN (
    'NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS',
    'NOTIFICATION_LIKES', 'NOTIFICATION_COMMENTS'
  )
  AND sync."oldestOccurredAt" IS NOT NULL
  AND coverage."coverageDate" < sync."oldestOccurredAt"::date;

UPDATE "AnalyticsCoverage" AS coverage
SET
  "status" = 'PARTIAL',
  "coveredFromAt" = GREATEST(COALESCE(coverage."coveredFromAt", sync."oldestOccurredAt"), sync."oldestOccurredAt"),
  "lastErrorCode" = 'NOTIFICATION_SOURCE_BOUNDARY_DAY',
  "lastErrorMessage" = 'OnlyFans notification history begins inside this UTC day; earlier history is not exposed by this source',
  "updatedAt" = CURRENT_TIMESTAMP
FROM "CreatorNotificationSyncState" AS sync
WHERE coverage."creatorId" = sync."creatorId"
  AND coverage."dataType" IN (
    'NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS',
    'NOTIFICATION_LIKES', 'NOTIFICATION_COMMENTS'
  )
  AND sync."oldestOccurredAt" IS NOT NULL
  AND coverage."coverageDate" = sync."oldestOccurredAt"::date
  AND coverage."coveredFromAt" IS NOT NULL
  AND coverage."coveredFromAt" < sync."oldestOccurredAt";
