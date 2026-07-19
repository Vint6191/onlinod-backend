-- Media Library v1
--
-- CreatorMediaAsset becomes the one canonical media record. The old Messages
-- catalog and sales projection are folded into it before their redundant
-- tables are removed. User-authored metadata is deliberately never replaced
-- by catalog scans.

ALTER TABLE "CreatorMediaAsset" RENAME COLUMN "type" TO "mediaType";
ALTER TABLE "CreatorMediaAsset" RENAME COLUMN "tags" TO "manualTags";
ALTER TABLE "CreatorMediaAsset" RENAME COLUMN "targetPriceCents" TO "idealPriceCents";

ALTER TABLE "CreatorMediaAsset"
  DROP COLUMN "costCents",
  ADD COLUMN "catalogActive" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sortingStatus" TEXT NOT NULL DEFAULT 'UNSORTED',
  ADD COLUMN "thumbUrl" TEXT,
  ADD COLUMN "previewUrl" TEXT,
  ADD COLUMN "fullUrl" TEXT,
  ADD COLUMN "folderIds" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "description" TEXT,
  ADD COLUMN "visibleBodyParts" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "accessType" TEXT NOT NULL DEFAULT 'paid',
  ADD COLUMN "minPriceCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "storylineName" TEXT,
  ADD COLUMN "storylineOrder" INTEGER,
  ADD COLUMN "storylineRole" TEXT,
  ADD COLUMN "metadataUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "metadataUpdatedByUserId" TEXT,
  ADD COLUMN "sentCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "soldCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "notOpenedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "freeCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "revenueCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "averagePriceCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "uniqueBuyers" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSoldAt" TIMESTAMP(3),
  ADD COLUMN "usageUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastSeenJobId" TEXT;

UPDATE "CreatorMediaAsset"
SET
  "catalogActive" = false,
  "mediaType" = COALESCE(NULLIF("mediaType", ''), 'unknown'),
  "durationSec" = COALESCE("durationSec", 0),
  "idealPriceCents" = COALESCE("idealPriceCents", 0);

ALTER TABLE "CreatorMediaAsset"
  ALTER COLUMN "mediaType" SET DEFAULT 'unknown',
  ALTER COLUMN "mediaType" SET NOT NULL,
  ALTER COLUMN "durationSec" SET DEFAULT 0,
  ALTER COLUMN "durationSec" SET NOT NULL,
  ALTER COLUMN "idealPriceCents" SET DEFAULT 0,
  ALTER COLUMN "idealPriceCents" SET NOT NULL;

-- The original three single-column indexes are superseded by the catalog
-- access patterns declared below. Drop them explicitly so Prisma sees no
-- avoidable schema drift after deployment.
DROP INDEX "CreatorMediaAsset_agencyId_idx";
DROP INDEX "CreatorMediaAsset_creatorId_idx";
DROP INDEX "CreatorMediaAsset_mediaId_idx";

-- Adopt the complete Messages catalog. On conflicts only machine-owned fields
-- are updated, so old CreatorMediaAsset metadata survives the merge.
INSERT INTO "CreatorMediaAsset" (
  "id", "agencyId", "creatorId", "mediaId", "catalogActive",
  "sortingStatus", "mediaType", "durationSec", "thumbUrl", "previewUrl",
  "fullUrl", "folderIds", "firstSeenAt", "lastSeenAt", "lastSeenJobId",
  "createdAt", "updatedAt"
)
SELECT
  vui."id", vui."agencyId", vui."creatorId", vui."mediaId", true,
  CASE WHEN vui."status" = 'SORTED' THEN 'SORTED' ELSE 'UNSORTED' END,
  COALESCE(NULLIF(vui."mediaType", ''), 'unknown'), COALESCE(vui."duration", 0),
  vui."thumbUrl", vui."thumbUrl", vui."thumbUrl", vui."folderIds",
  vui."firstSeenAt", vui."lastSeenAt", vui."lastSeenJobId",
  vui."createdAt", vui."updatedAt"
FROM "VaultUnsortedItem" vui
WHERE vui."status" <> 'HIDDEN'
ON CONFLICT ("creatorId", "mediaId") DO UPDATE SET
  "agencyId" = EXCLUDED."agencyId",
  "catalogActive" = true,
  "sortingStatus" = EXCLUDED."sortingStatus",
  "mediaType" = EXCLUDED."mediaType",
  "durationSec" = EXCLUDED."durationSec",
  "thumbUrl" = EXCLUDED."thumbUrl",
  "previewUrl" = EXCLUDED."previewUrl",
  "fullUrl" = EXCLUDED."fullUrl",
  "folderIds" = EXCLUDED."folderIds",
  "firstSeenAt" = LEAST("CreatorMediaAsset"."firstSeenAt", EXCLUDED."firstSeenAt"),
  "lastSeenAt" = EXCLUDED."lastSeenAt",
  "lastSeenJobId" = EXCLUDED."lastSeenJobId",
  "updatedAt" = GREATEST("CreatorMediaAsset"."updatedAt", EXCLUDED."updatedAt");

-- Preserve any useful totals from the oldest delivery projection until the
-- local dialog ledger publishes fresh idempotent source snapshots.
UPDATE "CreatorMediaAsset" asset
SET
  "sentCount" = GREATEST(asset."sentCount", legacy."sentCount"),
  "soldCount" = GREATEST(asset."soldCount", legacy."soldCount"),
  "notOpenedCount" = GREATEST(asset."notOpenedCount", legacy."notOpenedCount"),
  "freeCount" = GREATEST(asset."freeCount", legacy."freeCount"),
  "revenueCents" = GREATEST(asset."revenueCents", legacy."revenueCents"),
  "averagePriceCents" = CASE
    WHEN legacy."soldCount" > 0 THEN ROUND(legacy."revenueCents"::numeric / legacy."soldCount")::integer
    ELSE asset."averagePriceCents"
  END,
  "usageUpdatedAt" = CASE
    WHEN asset."usageUpdatedAt" IS NULL THEN legacy."updatedAt"
    ELSE GREATEST(asset."usageUpdatedAt", legacy."updatedAt")
  END
FROM (
  SELECT
    "creatorId",
    "mediaId",
    COUNT(*)::integer AS "sentCount",
    COUNT(*) FILTER (WHERE "status" = 'sold')::integer AS "soldCount",
    COUNT(*) FILTER (WHERE "status" = 'not_opened')::integer AS "notOpenedCount",
    COUNT(*) FILTER (WHERE "status" = 'free')::integer AS "freeCount",
    COALESCE(SUM("allocatedAmountCents") FILTER (WHERE "status" = 'sold'), 0)::integer AS "revenueCents",
    MAX("updatedAt") AS "updatedAt"
  FROM "CreatorMediaDeliveryEvent"
  GROUP BY "creatorId", "mediaId"
) legacy
WHERE asset."creatorId" = legacy."creatorId"
  AND asset."mediaId" = legacy."mediaId";

UPDATE "CreatorMediaAsset" asset
SET
  "soldCount" = GREATEST(asset."soldCount", legacy."soldCount"),
  "notOpenedCount" = GREATEST(asset."notOpenedCount", legacy."notOpenedCount"),
  "freeCount" = GREATEST(asset."freeCount", legacy."freeCount"),
  "revenueCents" = GREATEST(asset."revenueCents", legacy."revenueCents"),
  "averagePriceCents" = GREATEST(asset."averagePriceCents", legacy."averagePriceCents"),
  "uniqueBuyers" = GREATEST(asset."uniqueBuyers", legacy."uniqueBuyers"),
  "lastSoldAt" = CASE
    WHEN asset."lastSoldAt" IS NULL THEN legacy."lastSoldAt"
    WHEN legacy."lastSoldAt" IS NULL THEN asset."lastSoldAt"
    ELSE GREATEST(asset."lastSoldAt", legacy."lastSoldAt")
  END,
  "usageUpdatedAt" = CASE
    WHEN asset."usageUpdatedAt" IS NULL THEN legacy."updatedAt"
    ELSE GREATEST(asset."usageUpdatedAt", legacy."updatedAt")
  END
FROM (
  SELECT DISTINCT ON ("creatorId", COALESCE("mediaId", "assetId"))
    "creatorId",
    COALESCE("mediaId", "assetId") AS "resolvedMediaId",
    "soldCount",
    "notOpenedCount",
    "freeCount",
    "totalRevenueCents" AS "revenueCents",
    "averagePriceCents",
    "uniqueBuyers",
    "lastSoldAt",
    "updatedAt"
  FROM "VaultAssetSalesAggregate"
  WHERE COALESCE("mediaId", "assetId") IS NOT NULL
  ORDER BY "creatorId", COALESCE("mediaId", "assetId"), "updatedAt" DESC
) legacy
WHERE asset."creatorId" = legacy."creatorId"
  AND asset."mediaId" = legacy."resolvedMediaId";

CREATE TABLE "CreatorMediaUsageContribution" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "sourceRevision" TEXT NOT NULL,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "soldCount" INTEGER NOT NULL DEFAULT 0,
  "notOpenedCount" INTEGER NOT NULL DEFAULT 0,
  "freeCount" INTEGER NOT NULL DEFAULT 0,
  "revenueCents" INTEGER NOT NULL DEFAULT 0,
  "uniqueBuyers" INTEGER NOT NULL DEFAULT 0,
  "lastSoldAt" TIMESTAMP(3),
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorMediaUsageContribution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MediaLibraryScanItem" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "sortingStatus" TEXT NOT NULL DEFAULT 'UNSORTED',
  "mediaType" TEXT NOT NULL DEFAULT 'unknown',
  "durationSec" INTEGER NOT NULL DEFAULT 0,
  "thumbUrl" TEXT,
  "previewUrl" TEXT,
  "fullUrl" TEXT,
  "folderIds" JSONB NOT NULL DEFAULT '[]',
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaLibraryScanItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorMediaUsageSourceState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "sourceRevision" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorMediaUsageSourceState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorMediaUsageContribution_creatorId_sourceKey_mediaId_key"
  ON "CreatorMediaUsageContribution"("creatorId", "sourceKey", "mediaId");
CREATE INDEX "CreatorMediaUsageContribution_creatorId_sourceKey_idx"
  ON "CreatorMediaUsageContribution"("creatorId", "sourceKey");
CREATE INDEX "CreatorMediaUsageContribution_creatorId_mediaId_idx"
  ON "CreatorMediaUsageContribution"("creatorId", "mediaId");
CREATE INDEX "CreatorMediaUsageContribution_assetId_idx"
  ON "CreatorMediaUsageContribution"("assetId");

CREATE UNIQUE INDEX "CreatorMediaUsageSourceState_creatorId_sourceKey_key"
  ON "CreatorMediaUsageSourceState"("creatorId", "sourceKey");
CREATE INDEX "CreatorMediaUsageSourceState_agencyId_creatorId_updatedAt_idx"
  ON "CreatorMediaUsageSourceState"("agencyId", "creatorId", "updatedAt");

CREATE UNIQUE INDEX "MediaLibraryScanItem_jobId_mediaId_key"
  ON "MediaLibraryScanItem"("jobId", "mediaId");
CREATE INDEX "MediaLibraryScanItem_agencyId_creatorId_jobId_idx"
  ON "MediaLibraryScanItem"("agencyId", "creatorId", "jobId");

CREATE INDEX "CreatorMediaAsset_agencyId_creatorId_catalogActive_sortingStatus_lastSeenAt_idx"
  ON "CreatorMediaAsset"("agencyId", "creatorId", "catalogActive", "sortingStatus", "lastSeenAt");
CREATE INDEX "CreatorMediaAsset_creatorId_catalogActive_sentCount_lastSeenAt_idx"
  ON "CreatorMediaAsset"("creatorId", "catalogActive", "sentCount", "lastSeenAt");
CREATE INDEX "CreatorMediaAsset_creatorId_catalogActive_revenueCents_idx"
  ON "CreatorMediaAsset"("creatorId", "catalogActive", "revenueCents");
CREATE INDEX "CreatorMediaAsset_lastSeenJobId_idx"
  ON "CreatorMediaAsset"("lastSeenJobId");

ALTER TABLE "CreatorMediaUsageContribution"
  ADD CONSTRAINT "CreatorMediaUsageContribution_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorMediaUsageContribution_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorMediaUsageContribution_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "CreatorMediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MediaLibraryScanItem"
  ADD CONSTRAINT "MediaLibraryScanItem_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MediaLibraryScanItem_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorMediaUsageSourceState"
  ADD CONSTRAINT "CreatorMediaUsageSourceState_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorMediaUsageSourceState_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "CreatorMediaDeliveryEvent";
DROP TABLE "VaultAssetSalesAggregate";
DROP TABLE "VaultUnsortedItem";
