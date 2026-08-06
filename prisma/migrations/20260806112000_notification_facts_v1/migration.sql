-- Notification Facts V1
-- Relational, idempotent notification facts. Message text/media remain local.

CREATE TYPE "CreatorSaleType" AS ENUM ('MESSAGE', 'POST', 'STREAM', 'OTHER');
CREATE TYPE "CreatorSubscriptionEventType" AS ENUM (
  'SUBSCRIBED_FREE',
  'SUBSCRIBED_PAID',
  'RENEWED',
  'RESUBSCRIBED',
  'EXPIRED',
  'AUTO_RENEW_ENABLED',
  'AUTO_RENEW_DISABLED',
  'REFUNDED'
);

CREATE TABLE "CreatorSale" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT,
  "eventFingerprint" TEXT NOT NULL,
  "externalNotificationId" TEXT,
  "externalTransactionId" TEXT,
  "saleType" "CreatorSaleType" NOT NULL DEFAULT 'MESSAGE',
  "messageId" TEXT,
  "postId" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "purchasedAt" TIMESTAMP(3) NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorSale_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorSale_amount_check" CHECK ("amountCents" >= 0),
  CONSTRAINT "CreatorSale_identity_length_check" CHECK (
    length(btrim("eventFingerprint")) BETWEEN 32 AND 64 AND
    ("externalNotificationId" IS NULL OR length("externalNotificationId") <= 220) AND
    ("externalTransactionId" IS NULL OR length("externalTransactionId") <= 220) AND
    ("messageId" IS NULL OR length("messageId") <= 220) AND
    ("postId" IS NULL OR length("postId") <= 220) AND
    length(btrim("currency")) BETWEEN 3 AND 8
  )
);

CREATE TABLE "CreatorTip" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT,
  "eventFingerprint" TEXT NOT NULL,
  "externalNotificationId" TEXT,
  "externalTransactionId" TEXT,
  "messageId" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "tippedAt" TIMESTAMP(3) NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorTip_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorTip_amount_check" CHECK ("amountCents" >= 0),
  CONSTRAINT "CreatorTip_identity_length_check" CHECK (
    length(btrim("eventFingerprint")) BETWEEN 32 AND 64 AND
    ("externalNotificationId" IS NULL OR length("externalNotificationId") <= 220) AND
    ("externalTransactionId" IS NULL OR length("externalTransactionId") <= 220) AND
    ("messageId" IS NULL OR length("messageId") <= 220) AND
    length(btrim("currency")) BETWEEN 3 AND 8
  )
);

CREATE TABLE "CreatorSubscriptionEvent" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT,
  "eventFingerprint" TEXT NOT NULL,
  "externalNotificationId" TEXT,
  "externalTransactionId" TEXT,
  "eventType" "CreatorSubscriptionEventType" NOT NULL,
  "observedPriceCents" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorSubscriptionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorSubscriptionEvent_price_check" CHECK ("observedPriceCents" IS NULL OR "observedPriceCents" >= 0),
  CONSTRAINT "CreatorSubscriptionEvent_identity_length_check" CHECK (
    length(btrim("eventFingerprint")) BETWEEN 32 AND 64 AND
    ("externalNotificationId" IS NULL OR length("externalNotificationId") <= 220) AND
    ("externalTransactionId" IS NULL OR length("externalTransactionId") <= 220) AND
    length(btrim("currency")) BETWEEN 3 AND 8
  )
);

CREATE UNIQUE INDEX "CreatorSale_creatorId_eventFingerprint_key" ON "CreatorSale"("creatorId", "eventFingerprint");
CREATE UNIQUE INDEX "CreatorSale_creatorId_externalNotificationId_key" ON "CreatorSale"("creatorId", "externalNotificationId");
CREATE UNIQUE INDEX "CreatorSale_creatorId_externalTransactionId_key" ON "CreatorSale"("creatorId", "externalTransactionId");
CREATE INDEX "CreatorSale_agencyId_creatorId_purchasedAt_idx" ON "CreatorSale"("agencyId", "creatorId", "purchasedAt");
CREATE INDEX "CreatorSale_creatorId_fanId_purchasedAt_idx" ON "CreatorSale"("creatorId", "fanId", "purchasedAt");
CREATE INDEX "CreatorSale_creatorId_messageId_idx" ON "CreatorSale"("creatorId", "messageId");
CREATE INDEX "CreatorSale_creatorId_postId_idx" ON "CreatorSale"("creatorId", "postId");
CREATE INDEX "CreatorSale_sourceJobId_idx" ON "CreatorSale"("sourceJobId");

CREATE UNIQUE INDEX "CreatorTip_creatorId_eventFingerprint_key" ON "CreatorTip"("creatorId", "eventFingerprint");
CREATE UNIQUE INDEX "CreatorTip_creatorId_externalNotificationId_key" ON "CreatorTip"("creatorId", "externalNotificationId");
CREATE UNIQUE INDEX "CreatorTip_creatorId_externalTransactionId_key" ON "CreatorTip"("creatorId", "externalTransactionId");
CREATE INDEX "CreatorTip_agencyId_creatorId_tippedAt_idx" ON "CreatorTip"("agencyId", "creatorId", "tippedAt");
CREATE INDEX "CreatorTip_creatorId_fanId_tippedAt_idx" ON "CreatorTip"("creatorId", "fanId", "tippedAt");
CREATE INDEX "CreatorTip_sourceJobId_idx" ON "CreatorTip"("sourceJobId");

CREATE UNIQUE INDEX "CreatorSubscriptionEvent_creatorId_eventFingerprint_key" ON "CreatorSubscriptionEvent"("creatorId", "eventFingerprint");
CREATE UNIQUE INDEX "CreatorSubscriptionEvent_creatorId_externalNotificationId_key" ON "CreatorSubscriptionEvent"("creatorId", "externalNotificationId");
CREATE UNIQUE INDEX "CreatorSubscriptionEvent_creatorId_externalTransactionId_key" ON "CreatorSubscriptionEvent"("creatorId", "externalTransactionId");
CREATE INDEX "CreatorSubscriptionEvent_agency_creator_occurred_idx" ON "CreatorSubscriptionEvent"("agencyId", "creatorId", "occurredAt");
CREATE INDEX "CreatorSubscriptionEvent_creator_fan_occurred_idx" ON "CreatorSubscriptionEvent"("creatorId", "fanId", "occurredAt");
CREATE INDEX "CreatorSubscriptionEvent_creator_type_occurred_idx" ON "CreatorSubscriptionEvent"("creatorId", "eventType", "occurredAt");
CREATE INDEX "CreatorSubscriptionEvent_sourceJobId_idx" ON "CreatorSubscriptionEvent"("sourceJobId");

ALTER TABLE "CreatorSale"
  ADD CONSTRAINT "CreatorSale_agencyId_creatorId_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorSale_fanId_fkey"
    FOREIGN KEY ("fanId") REFERENCES "CreatorFan"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorSale_sourceDeviceId_fkey"
    FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorSale_sourceJobId_fkey"
    FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorTip"
  ADD CONSTRAINT "CreatorTip_agencyId_creatorId_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorTip_fanId_fkey"
    FOREIGN KEY ("fanId") REFERENCES "CreatorFan"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorTip_sourceDeviceId_fkey"
    FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorTip_sourceJobId_fkey"
    FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorSubscriptionEvent"
  ADD CONSTRAINT "CreatorSubscriptionEvent_agency_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorSubscriptionEvent_fanId_fkey"
    FOREIGN KEY ("fanId") REFERENCES "CreatorFan"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorSubscriptionEvent_sourceDeviceId_fkey"
    FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorSubscriptionEvent_sourceJobId_fkey"
    FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
