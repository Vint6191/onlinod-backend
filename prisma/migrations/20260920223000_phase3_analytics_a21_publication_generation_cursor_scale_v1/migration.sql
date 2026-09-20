-- Analytics A21: explicit Subscriber publication generation + cursor scale.
-- This is a forward-only repair/closure migration.  Historical migrations are
-- not rewritten or renamed.

ALTER TABLE "SubscriberScanRun"
  ADD COLUMN IF NOT EXISTS "publicationGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SubscriberDirectoryState"
  ADD COLUMN IF NOT EXISTS "publicationGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "publishedGeneration" INTEGER NOT NULL DEFAULT 0;

-- Give every historical run a deterministic creator-local monotonic generation.
-- Existing production histories are bounded per creator; the row-number pass is
-- one-time migration work, not a runtime hot path.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "creatorId"
      ORDER BY "createdAt" ASC, "id" ASC
    )::integer AS generation
  FROM "SubscriberScanRun"
)
UPDATE "SubscriberScanRun" r
SET "publicationGeneration" = ranked.generation
FROM ranked
WHERE r."id" = ranked."id"
  AND r."publicationGeneration" = 0;

-- The state row owns allocation of the latest generation while
-- publishedGeneration records the monotonic generation currently exposed via
-- currentRunId.  This makes FINALIZE a generation CAS rather than an unconditional
-- currentRunId writer.
UPDATE "SubscriberDirectoryState" s
SET
  "publicationGeneration" = COALESCE((
    SELECT MAX(r."publicationGeneration")
    FROM "SubscriberScanRun" r
    WHERE r."creatorId" = s."creatorId"
  ), 0),
  "publishedGeneration" = COALESCE((
    SELECT r."publicationGeneration"
    FROM "SubscriberScanRun" r
    WHERE r."id" = s."currentRunId"
    LIMIT 1
  ), 0);

CREATE INDEX IF NOT EXISTS "SubscriberScanRun_creator_publication_generation_idx"
  ON "SubscriberScanRun"("creatorId", "publicationGeneration");

-- CURRENT/PREVIOUS publication both page by runId + id.
CREATE INDEX IF NOT EXISTS "SubscriberScanItem_run_id_cursor_idx"
  ON "SubscriberScanItem"("runId", "id");

-- Recovery/fence debt is publication-lifecycle debt, not Job/Run status debt.
CREATE INDEX IF NOT EXISTS "SubscriberScanRun_publication_debt_idx"
  ON "SubscriberScanRun"("agencyId", "creatorId", "updatedAt", "id")
  WHERE "fanProjectionStatus" = 'COMPLETE'
    AND "hasMore" = false
    AND "publicationStatus" IN ('PENDING','CURRENT','PREVIOUS','FINALIZE');
