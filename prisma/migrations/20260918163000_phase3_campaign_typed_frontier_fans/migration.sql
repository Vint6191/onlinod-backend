-- Phase 3: replace CreatorCampaign business JSON frontier fan arrays with a
-- typed relational operational authority. Existing bounded JSON arrays are
-- migrated losslessly before the legacy columns are removed.
DO $$
BEGIN
  CREATE TYPE "CreatorCampaignFrontierKind" AS ENUM ('CANONICAL', 'STAGED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CreatorCampaignFrontierFan" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "frontierKind" "CreatorCampaignFrontierKind" NOT NULL,
  "onlyFansUserId" VARCHAR(180) NOT NULL,
  "sourceScanRunId" VARCHAR(120),
  "sourceScanStartedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorCampaignFrontierFan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorCampaignFrontierFan_campaignId_frontierKind_onlyFansUserId_key"
  ON "CreatorCampaignFrontierFan"("campaignId", "frontierKind", "onlyFansUserId");
CREATE INDEX IF NOT EXISTS "CreatorCampaignFrontierFan_creatorId_campaignId_frontierKind_idx"
  ON "CreatorCampaignFrontierFan"("creatorId", "campaignId", "frontierKind");
CREATE INDEX IF NOT EXISTS "CreatorCampaignFrontierFan_creatorId_onlyFansUserId_idx"
  ON "CreatorCampaignFrontierFan"("creatorId", "onlyFansUserId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'CreatorCampaignFrontierFan_creatorId_campaignId_fkey'
  ) THEN
    ALTER TABLE "CreatorCampaignFrontierFan"
      ADD CONSTRAINT "CreatorCampaignFrontierFan_creatorId_campaignId_fkey"
      FOREIGN KEY ("creatorId", "campaignId")
      REFERENCES "CreatorCampaign"("creatorId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Canonical exact anchors. Normalize to the same bounded, unique, sorted
-- semantics used by the application and retain the canonical generation.
WITH expanded AS (
  SELECT
    c."id" AS "campaignId",
    c."agencyId",
    c."creatorId",
    c."catchupFrontierRunId" AS "sourceScanRunId",
    c."catchupFrontierStartedAt" AS "sourceScanStartedAt",
    trim(f.value) AS "onlyFansUserId"
  FROM "CreatorCampaign" c
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(c."catchupFrontierFanIds") = 'array' THEN c."catchupFrontierFanIds"
      ELSE '[]'::jsonb
    END
  ) AS f(value)
), bounded AS (
  SELECT *, row_number() OVER (
    PARTITION BY "campaignId" ORDER BY "onlyFansUserId"
  ) AS rn
  FROM (
    SELECT DISTINCT ON ("campaignId", "onlyFansUserId") *
    FROM expanded
    WHERE "onlyFansUserId" <> '' AND length("onlyFansUserId") <= 180
    ORDER BY "campaignId", "onlyFansUserId"
  ) d
)
INSERT INTO "CreatorCampaignFrontierFan" (
  "id", "agencyId", "creatorId", "campaignId", "frontierKind",
  "onlyFansUserId", "sourceScanRunId", "sourceScanStartedAt"
)
SELECT
  'cff_c_' || md5("campaignId" || ':' || "onlyFansUserId"),
  "agencyId", "creatorId", "campaignId", 'CANONICAL'::"CreatorCampaignFrontierKind",
  "onlyFansUserId", "sourceScanRunId", "sourceScanStartedAt"
FROM bounded
WHERE rn <= 50
ON CONFLICT ("campaignId", "frontierKind", "onlyFansUserId") DO NOTHING;

-- Staged exact anchors. These rows remain tied to their staged generation and
-- therefore cannot become canonical proof after a replacement generation.
WITH expanded AS (
  SELECT
    c."id" AS "campaignId",
    c."agencyId",
    c."creatorId",
    c."stagedCatchupFrontierRunId" AS "sourceScanRunId",
    c."stagedCatchupFrontierStartedAt" AS "sourceScanStartedAt",
    trim(f.value) AS "onlyFansUserId"
  FROM "CreatorCampaign" c
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(c."stagedCatchupFrontierFanIds") = 'array' THEN c."stagedCatchupFrontierFanIds"
      ELSE '[]'::jsonb
    END
  ) AS f(value)
), bounded AS (
  SELECT *, row_number() OVER (
    PARTITION BY "campaignId" ORDER BY "onlyFansUserId"
  ) AS rn
  FROM (
    SELECT DISTINCT ON ("campaignId", "onlyFansUserId") *
    FROM expanded
    WHERE "onlyFansUserId" <> '' AND length("onlyFansUserId") <= 180
    ORDER BY "campaignId", "onlyFansUserId"
  ) d
)
INSERT INTO "CreatorCampaignFrontierFan" (
  "id", "agencyId", "creatorId", "campaignId", "frontierKind",
  "onlyFansUserId", "sourceScanRunId", "sourceScanStartedAt"
)
SELECT
  'cff_s_' || md5("campaignId" || ':' || "onlyFansUserId"),
  "agencyId", "creatorId", "campaignId", 'STAGED'::"CreatorCampaignFrontierKind",
  "onlyFansUserId", "sourceScanRunId", "sourceScanStartedAt"
FROM bounded
WHERE rn <= 50
ON CONFLICT ("campaignId", "frontierKind", "onlyFansUserId") DO NOTHING;

ALTER TABLE "CreatorCampaign"
  DROP COLUMN IF EXISTS "catchupFrontierFanIds",
  DROP COLUMN IF EXISTS "stagedCatchupFrontierFanIds";
