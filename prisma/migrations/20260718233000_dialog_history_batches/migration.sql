-- Retire the legacy one-JobInstance-per-dialog history executor.
-- Discovery jobs remain untouched. Frozen DialogScanState rows are preserved and
-- returned to PLANNED so Desktop workers can claim them in durable batches.

-- Release exactly the dialog states owned by an active legacy run/job before
-- those audit rows are made terminal. No conversation payload is migrated.
UPDATE "DialogScanState" AS state
SET
  "status" = 'PLANNED',
  "activeRunId" = NULL,
  "activeJobId" = NULL,
  "lastError" = NULL,
  "updatedAt" = NOW()
WHERE
  state."activeRunId" IN (
    SELECT run."id"
    FROM "DialogScanRun" AS run
    WHERE run."dialogId" NOT IN ('__dialog_discovery__', '__dialog_history_batch__')
      AND run."status" IN ('QUEUED', 'RUNNING', 'PAUSED')
  )
  OR state."activeJobId" IN (
    SELECT job."id"
    FROM "JobInstance" AS job
    WHERE job."jobKey" = 'dialog_intelligence_scan'
      AND COALESCE(job."params"->>'dialogId', '') NOT IN ('', '__dialog_discovery__')
      AND job."status" IN ('SCHEDULED', 'CLAIMED')
  );

-- Also repair orphaned legacy state rows whose execution row disappeared.
UPDATE "DialogScanState" AS state
SET
  "status" = 'PLANNED',
  "activeRunId" = NULL,
  "activeJobId" = NULL,
  "lastError" = NULL,
  "updatedAt" = NOW()
WHERE state."dialogId" NOT IN ('__dialog_discovery__', '__dialog_history_batch__')
  AND state."status" IN ('QUEUED', 'RUNNING')
  AND NOT EXISTS (
    SELECT 1
    FROM "DialogScanRun" AS run
    WHERE run."id" = state."activeRunId"
      AND run."dialogId" = '__dialog_history_batch__'
      AND run."status" IN ('QUEUED', 'RUNNING')
  );

UPDATE "JobInstance"
SET
  "status" = 'CANCELLED',
  "completedAt" = NOW(),
  "claimedAt" = NULL,
  "claimedByDeviceId" = NULL,
  "leaseUntil" = NULL,
  "leaseTokenHash" = NULL,
  "workId" = NULL,
  "leaseRevision" = "leaseRevision" + 1,
  "lastError" = 'Legacy per-dialog execution retired in favor of batch CRM scanning',
  "result" = jsonb_build_object(
    'control', jsonb_build_object(
      'kind', 'retired',
      'reason', 'replaced by dialog history batch claims',
      'at', NOW()
    )
  )
WHERE "jobKey" = 'dialog_intelligence_scan'
  AND COALESCE("params"->>'dialogId', '') NOT IN ('', '__dialog_discovery__')
  AND "status" IN ('SCHEDULED', 'CLAIMED');

UPDATE "DialogScanRun"
SET
  "status" = 'CANCELLED',
  "completedAt" = NOW(),
  "lastError" = 'Legacy per-dialog execution retired in favor of batch CRM scanning'
WHERE "dialogId" NOT IN ('__dialog_discovery__', '__dialog_history_batch__')
  AND "status" IN ('QUEUED', 'RUNNING', 'PAUSED');
