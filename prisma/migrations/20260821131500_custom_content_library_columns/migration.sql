-- V20.4 Custom Content Library provenance.
-- Durable Customs business facts are stored as typed relational columns.
CREATE TYPE "CreatorMediaAssetSource" AS ENUM ('GENERAL', 'CUSTOM');

ALTER TABLE "CreatorMediaAsset"
  ADD COLUMN "source" "CreatorMediaAssetSource" NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN "customOrderId" TEXT,
  ADD COLUMN "customFullPriceCents" INTEGER;

CREATE INDEX "CreatorMediaAsset_customOrderId_idx" ON "CreatorMediaAsset"("customOrderId");

ALTER TABLE "CreatorMediaAsset"
  ADD CONSTRAINT "CreatorMediaAsset_customOrderId_fkey"
  FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
