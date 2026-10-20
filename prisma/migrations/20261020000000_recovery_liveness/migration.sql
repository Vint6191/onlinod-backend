BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL TimeZone = 'UTC';

-- Subscriber publication records a durable continuation before committing.
-- The separate planning unit acquires DomainWork locks after source locks end.
ALTER TABLE "SubscriberDirectoryMaintenanceSignal" DROP CONSTRAINT "SubscriberDirectoryMaintenanceSignal_kind_check";
ALTER TABLE "SubscriberDirectoryMaintenanceSignal" ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_kind_check"
  CHECK (kind::text = ANY(ARRAY['RECOVERY'::text,'RETENTION'::text,'DERIVED_PLANNING'::text]));
CREATE INDEX IF NOT EXISTS "SubscriberScanRun_recollection_creator_idx"
  ON "SubscriberScanRun" ("agencyId","creatorId","publicationGeneration" DESC,"id")
  WHERE "publicationStatus"='RECOLLECTING';
CREATE INDEX IF NOT EXISTS "SubscriberDirectoryMaintenanceSignal_structural_retry_idx"
  ON "SubscriberDirectoryMaintenanceSignal" ("dueAt","creatorId","kind")
  WHERE "kind"='RECOVERY' AND "attempts">=100
    AND "lastError" ~ '^Subscriber publication generation [0-9]+ is stale behind allocated generation [0-9]+$';

-- Collection may finish before server publication. Keep the activity projection
-- on the same PUBLISHING state as the authoritative job.
CREATE OR REPLACE FUNCTION public.onlinod_sync_creator_task_activity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."creatorId" IS NULL OR NEW."agencyId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."status" NOT IN ('CLAIMED', 'PUBLISHING', 'SCHEDULED', 'PAUSED', 'DONE', 'FAILED', 'CANCELLED') THEN
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
    COALESCE(NEW."createdAt", (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')),
    (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
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
    "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

  RETURN NEW;
END;
$function$;

-- Recover only current live publication activity, never job status, claims or
-- completion proofs. Lock each source job before replacing its projection so a
-- concurrent DONE transition cannot be overwritten by an older PUBLISHING read.
-- Skip currently mutating jobs: their next status/progress write uses the fixed
-- trigger, and the installer never waits for a job while holding schema locks.
-- Preserve the source timestamp; installation itself is not task progress.
WITH publishing AS MATERIALIZED (
  SELECT j.* FROM "JobInstance" j
  JOIN "CreatorAccount" c ON c.id=j."creatorId" AND c."agencyId"=j."agencyId" AND c."deletedAt" IS NULL
  JOIN "Agency" a ON a.id=j."agencyId" AND a."deletedAt" IS NULL
  WHERE j.status='PUBLISHING'
  ORDER BY j.id FOR UPDATE OF j SKIP LOCKED
)
INSERT INTO "CreatorTaskActivity" AS activity (
  id,"agencyId","creatorId","jobId","jobKey",mode,stage,status,detail,"lastError","startedAt","completedAt","createdAt","updatedAt"
)
SELECT j.id||':activity',j."agencyId",j."creatorId",j.id,j."jobKey",
  COALESCE(j.params->>'analyticsSyncKind',j.params->>'financialMode',j.params->>'campaignMode',j.params->>'notificationMode'),
  j.params->>'analyticsSyncStage',j.status,LEFT(COALESCE(j.progress->>'message',''),500),LEFT(COALESCE(j."lastError",''),2000),
  COALESCE(j."startedAt",j."claimedAt"),j."completedAt",j."createdAt",j."updatedAt"
FROM publishing j
ON CONFLICT ("jobId") DO UPDATE SET
  "jobKey"=EXCLUDED."jobKey",mode=EXCLUDED.mode,stage=EXCLUDED.stage,status=EXCLUDED.status,
  detail=NULLIF(EXCLUDED.detail,''),"lastError"=NULLIF(EXCLUDED."lastError",''),
  "startedAt"=COALESCE(activity."startedAt",EXCLUDED."startedAt"),"completedAt"=EXCLUDED."completedAt","updatedAt"=EXCLUDED."updatedAt"
WHERE (activity."jobKey",activity.mode,activity.stage,activity.status,activity.detail,activity."lastError",activity."completedAt")
  IS DISTINCT FROM (EXCLUDED."jobKey",EXCLUDED.mode,EXCLUDED.stage,EXCLUDED.status,NULLIF(EXCLUDED.detail,''),NULLIF(EXCLUDED."lastError",''),EXCLUDED."completedAt");

-- PUBLISHING is a durable source-completion obligation even when an old
-- generation has no valid canonical publication barrier. Runtime validates
-- those rows and recollects safely rather than acknowledging a missing run.
WITH active_publishers AS (
  SELECT DISTINCT j."agencyId", j."creatorId"
  FROM "JobInstance" j
  WHERE j."jobKey"='subscriber_directory_scan' AND j."status"='PUBLISHING'
)
INSERT INTO "SubscriberDirectoryMaintenanceSignal" (
  "id","agencyId","creatorId","kind","dueAt","reason","revision","attempts","createdAt","updatedAt"
)
SELECT 'submaint_liveness_' || md5(j."creatorId"),j."agencyId",j."creatorId",'RECOVERY',
  (clock_timestamp() AT TIME ZONE 'UTC'),'PUBLISHING_STATE_VALIDATION',1,0,
  (clock_timestamp() AT TIME ZONE 'UTC'),(clock_timestamp() AT TIME ZONE 'UTC')
FROM active_publishers j
JOIN "CreatorAccount" c ON c."id"=j."creatorId" AND c."agencyId"=j."agencyId" AND c."deletedAt" IS NULL
JOIN "Agency" a ON a."id"=j."agencyId" AND a."deletedAt" IS NULL
ON CONFLICT ("creatorId","kind") DO NOTHING;

COMMIT;
