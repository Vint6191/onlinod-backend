-- V20.9: bind each CUSTOM Content Library asset to the exact submission/version
-- that produced it. Review/revision state remains owned by CustomContentSubmission;
-- it is intentionally not duplicated onto CreatorMediaAsset.
ALTER TABLE "CreatorMediaAsset"
  ADD COLUMN "customSubmissionId" TEXT;

-- Existing V20.4-V20.8 CUSTOM assets predate this explicit provenance column.
-- Backfill from the stable OF mediaId already recorded on submissions. Keep the
-- same custom-order provenance when available. Current production data has no
-- completed revision loop yet, so this is deterministic in practice; the ORDER
-- BY is a defensive tie-breaker for any manually reused mediaId.
UPDATE "CreatorMediaAsset" AS asset
SET "customSubmissionId" = (
  SELECT submission."id"
  FROM "CustomContentSubmission" AS submission
  WHERE submission."agencyId" = asset."agencyId"
    AND submission."creatorId" = asset."creatorId"
    AND asset."mediaId" = ANY(submission."ofMediaIds")
    AND submission."customOrderId" IS NOT DISTINCT FROM asset."customOrderId"
  ORDER BY submission."receivedAt" DESC, submission."createdAt" DESC, submission."id" DESC
  LIMIT 1
)
WHERE asset."source" = 'CUSTOM'
  AND asset."customSubmissionId" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "CustomContentSubmission" AS submission
    WHERE submission."agencyId" = asset."agencyId"
      AND submission."creatorId" = asset."creatorId"
      AND asset."mediaId" = ANY(submission."ofMediaIds")
      AND submission."customOrderId" IS NOT DISTINCT FROM asset."customOrderId"
  );

CREATE INDEX "CreatorMediaAsset_customSubmissionId_idx"
  ON "CreatorMediaAsset"("customSubmissionId");

ALTER TABLE "CreatorMediaAsset"
  ADD CONSTRAINT "CreatorMediaAsset_customSubmissionId_fkey"
  FOREIGN KEY ("customSubmissionId") REFERENCES "CustomContentSubmission"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Lifecycle invariant for transport-neutral revision intake.
-- If an older build/manual API somehow produced an impossible state, preserve
-- every submission but detach ambiguous WAITING rows into the UNASSIGNED queue
-- instead of deleting content or guessing which version a manager intended.
UPDATE "CustomContentSubmission" AS waiting
SET "customOrderId" = NULL
WHERE waiting."reviewStatus" = 'WAITING_REVIEW'
  AND waiting."customOrderId" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "CustomContentSubmission" AS approved
    WHERE approved."customOrderId" = waiting."customOrderId"
      AND approved."reviewStatus" = 'APPROVED'
  );

WITH ranked_waiting AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "customOrderId"
           ORDER BY "receivedAt" ASC, "createdAt" ASC, "id" ASC
         ) AS position
  FROM "CustomContentSubmission"
  WHERE "customOrderId" IS NOT NULL
    AND "reviewStatus" = 'WAITING_REVIEW'
)
UPDATE "CustomContentSubmission" AS submission
SET "customOrderId" = NULL
FROM ranked_waiting
WHERE submission."id" = ranked_waiting."id"
  AND ranked_waiting.position > 1;

-- Keep only typed Customs provenance synchronized for repaired UNASSIGNED rows.
-- Do not rewrite human-edited description/ideal price/access metadata here.
UPDATE "CreatorMediaAsset" AS asset
SET "customOrderId" = NULL,
    "customFullPriceCents" = NULL
FROM "CustomContentSubmission" AS submission
WHERE asset."source" = 'CUSTOM'
  AND asset."customSubmissionId" = submission."id"
  AND submission."customOrderId" IS NULL
  AND (asset."customOrderId" IS NOT NULL OR asset."customFullPriceCents" IS NOT NULL);

CREATE UNIQUE INDEX "CustomContentSubmission_one_waiting_per_order_key"
  ON "CustomContentSubmission"("customOrderId")
  WHERE "customOrderId" IS NOT NULL
    AND "reviewStatus" = 'WAITING_REVIEW';
