
-- Vault Intelligence V1: media-id only analytics bridge.
-- Stores IDs, numbers, statuses and timestamps only from DB metadata.
-- No OF preview URLs, no signed file URLs, no sentAt/purchasedAt payload fields.

CREATE TABLE "CreatorMediaAsset" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "type" TEXT,
  "durationSec" INTEGER,
  "costCents" INTEGER,
  "targetPriceCents" INTEGER,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorMediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorMediaDeliveryEvent" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "packSize" INTEGER NOT NULL DEFAULT 1,
  "packagePriceCents" INTEGER NOT NULL DEFAULT 0,
  "allocatedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'not_opened',
  "source" TEXT NOT NULL DEFAULT 'electron',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorMediaDeliveryEvent_pkey" PRIMARY KEY ("id")
);


CREATE UNIQUE INDEX "CreatorMediaAsset_creatorId_mediaId_key" ON "CreatorMediaAsset"("creatorId", "mediaId");
CREATE INDEX "CreatorMediaAsset_agencyId_idx" ON "CreatorMediaAsset"("agencyId");
CREATE INDEX "CreatorMediaAsset_creatorId_idx" ON "CreatorMediaAsset"("creatorId");
CREATE INDEX "CreatorMediaAsset_mediaId_idx" ON "CreatorMediaAsset"("mediaId");

CREATE UNIQUE INDEX "CreatorMediaDeliveryEvent_creatorId_messageId_mediaId_key" ON "CreatorMediaDeliveryEvent"("creatorId", "messageId", "mediaId");
CREATE INDEX "CreatorMediaDeliveryEvent_agencyId_idx" ON "CreatorMediaDeliveryEvent"("agencyId");
CREATE INDEX "CreatorMediaDeliveryEvent_creatorId_mediaId_idx" ON "CreatorMediaDeliveryEvent"("creatorId", "mediaId");
CREATE INDEX "CreatorMediaDeliveryEvent_creatorId_status_idx" ON "CreatorMediaDeliveryEvent"("creatorId", "status");


ALTER TABLE "CreatorMediaAsset" ADD CONSTRAINT "CreatorMediaAsset_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorMediaAsset" ADD CONSTRAINT "CreatorMediaAsset_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorMediaDeliveryEvent" ADD CONSTRAINT "CreatorMediaDeliveryEvent_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorMediaDeliveryEvent" ADD CONSTRAINT "CreatorMediaDeliveryEvent_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
