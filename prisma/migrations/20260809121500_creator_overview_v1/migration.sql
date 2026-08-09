-- Creator Overview v1: compact 30-day backend task history.
CREATE TABLE "CreatorTaskActivity" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "jobKey" TEXT NOT NULL,
  "mode" TEXT,
  "stage" TEXT,
  "status" TEXT NOT NULL,
  "detail" TEXT,
  "lastError" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorTaskActivity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorTaskActivity_jobId_key" ON "CreatorTaskActivity"("jobId");
CREATE INDEX "CreatorTaskActivity_agencyId_creatorId_updatedAt_idx" ON "CreatorTaskActivity"("agencyId", "creatorId", "updatedAt");
CREATE INDEX "CreatorTaskActivity_creatorId_updatedAt_idx" ON "CreatorTaskActivity"("creatorId", "updatedAt");
CREATE INDEX "CreatorTaskActivity_status_updatedAt_idx" ON "CreatorTaskActivity"("status", "updatedAt");
ALTER TABLE "CreatorTaskActivity" ADD CONSTRAINT "CreatorTaskActivity_creator_fkey"
  FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Keep the compact activity projection in sync with JobInstance without making
-- every scheduler/worker branch remember to write a second log row.
CREATE OR REPLACE FUNCTION onlinod_sync_creator_task_activity()
RETURNS trigger AS $$
BEGIN
  IF NEW."creatorId" IS NULL OR NEW."agencyId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."status" NOT IN ('CLAIMED', 'SCHEDULED', 'PAUSED', 'DONE', 'FAILED', 'CANCELLED') THEN
    RETURN NEW;
  END IF;

  -- A future SCHEDULED job is not activity yet. If a previously-started job is
  -- requeued, startedAt/claimedAt remains populated and the same activity row
  -- is updated instead of disappearing from the 30-day history.
  IF NEW."status" = 'SCHEDULED' AND NEW."startedAt" IS NULL AND NEW."claimedAt" IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "CreatorTaskActivity" (
    "id", "agencyId", "creatorId", "jobId", "jobKey", "mode", "stage", "status",
    "detail", "lastError", "startedAt", "completedAt", "createdAt", "updatedAt"
  ) VALUES (
    NEW."id" || ':activity',
    NEW."agencyId",
    NEW."creatorId",
    NEW."id",
    NEW."jobKey",
    COALESCE(NEW."params"->>'analyticsSyncKind', NEW."params"->>'financialMode', NEW."params"->>'campaignMode', NEW."params"->>'notificationMode'),
    NEW."params"->>'analyticsSyncStage',
    NEW."status",
    LEFT(COALESCE(NEW."progress"->>'message', ''), 500),
    LEFT(COALESCE(NEW."lastError", ''), 2000),
    COALESCE(NEW."startedAt", NEW."claimedAt"),
    NEW."completedAt",
    COALESCE(NEW."createdAt", CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("jobId") DO UPDATE SET
    "jobKey" = EXCLUDED."jobKey",
    "mode" = EXCLUDED."mode",
    "stage" = EXCLUDED."stage",
    "status" = EXCLUDED."status",
    "detail" = NULLIF(EXCLUDED."detail", ''),
    "lastError" = NULLIF(EXCLUDED."lastError", ''),
    "startedAt" = COALESCE("CreatorTaskActivity"."startedAt", EXCLUDED."startedAt"),
    "completedAt" = EXCLUDED."completedAt",
    "updatedAt" = CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "JobInstance_creator_task_activity_trg" ON "JobInstance";
CREATE TRIGGER "JobInstance_creator_task_activity_trg"
AFTER INSERT OR UPDATE OF "status", "startedAt", "claimedAt", "completedAt", "lastError", "progress"
ON "JobInstance"
FOR EACH ROW
EXECUTE FUNCTION onlinod_sync_creator_task_activity();

-- Backfill the still-retained execution history so the Overview does not start
-- with an empty 30-day log on the day this migration is deployed.
INSERT INTO "CreatorTaskActivity" (
  "id", "agencyId", "creatorId", "jobId", "jobKey", "mode", "stage", "status",
  "detail", "lastError", "startedAt", "completedAt", "createdAt", "updatedAt"
)
SELECT
  j."id" || ':activity',
  j."agencyId",
  j."creatorId",
  j."id",
  j."jobKey",
  COALESCE(j."params"->>'analyticsSyncKind', j."params"->>'financialMode', j."params"->>'campaignMode', j."params"->>'notificationMode'),
  j."params"->>'analyticsSyncStage',
  j."status",
  NULLIF(LEFT(COALESCE(j."progress"->>'message', ''), 500), ''),
  NULLIF(LEFT(COALESCE(j."lastError", ''), 2000), ''),
  COALESCE(j."startedAt", j."claimedAt"),
  j."completedAt",
  j."createdAt",
  j."updatedAt"
FROM "JobInstance" j
WHERE j."agencyId" IS NOT NULL
  AND j."creatorId" IS NOT NULL
  AND j."updatedAt" >= CURRENT_TIMESTAMP - INTERVAL '30 days'
  AND j."status" IN ('CLAIMED', 'SCHEDULED', 'PAUSED', 'DONE', 'FAILED', 'CANCELLED')
  AND NOT (j."status" = 'SCHEDULED' AND j."startedAt" IS NULL AND j."claimedAt" IS NULL)
ON CONFLICT ("jobId") DO NOTHING;
