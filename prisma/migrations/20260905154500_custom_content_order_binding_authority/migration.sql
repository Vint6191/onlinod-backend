BEGIN;

-- Once any CustomContentSubmission has been attached, that CustomOrder is durably
-- bound to the CONTENT lifecycle. This prevents generic type edits from racing the
-- submission/review/delivery authority and turning an already-used CONTENT order
-- into CALL/PHYSICAL.
ALTER TABLE "CustomOrder"
ADD COLUMN "contentBoundAt" TIMESTAMP(3);

-- Backfill both the current FK relation and server-owned audit history. The audit
-- branches matter for an older submission that had previously been assigned and
-- was later unassigned/reassigned before this migration: the product fact is
-- "CONTENT lifecycle was entered", not merely "a submission is attached today".
WITH binding_history AS (
  SELECT
    submission."customOrderId" AS "customOrderId",
    submission."createdAt" AS "boundAt"
  FROM "CustomContentSubmission" AS submission
  WHERE submission."customOrderId" IS NOT NULL

  UNION ALL

  SELECT
    NULLIF(audit."metadata"->>'customOrderId', '') AS "customOrderId",
    audit."createdAt" AS "boundAt"
  FROM "AuditLog" AS audit
  WHERE audit."action" IN (
    'custom_content_submission.create',
    'custom_content_submission.create_from_telegram_inbound'
  )
    AND NULLIF(audit."metadata"->>'customOrderId', '') IS NOT NULL

  UNION ALL

  SELECT
    NULLIF(audit."metadata"->>'toCustomOrderId', '') AS "customOrderId",
    audit."createdAt" AS "boundAt"
  FROM "AuditLog" AS audit
  WHERE audit."action" = 'custom_content_submission.assign'
    AND NULLIF(audit."metadata"->>'toCustomOrderId', '') IS NOT NULL
), earliest_binding AS (
  SELECT "customOrderId", MIN("boundAt") AS "boundAt"
  FROM binding_history
  WHERE "customOrderId" IS NOT NULL
  GROUP BY "customOrderId"
)
UPDATE "CustomOrder" AS custom_order
SET "contentBoundAt" = earliest_binding."boundAt"
FROM earliest_binding
WHERE custom_order."id" = earliest_binding."customOrderId"
  AND custom_order."contentBoundAt" IS NULL;

-- Never silently reinterpret historical business state. Old code allowed type edits
-- that this cutover now forbids, so a pre-existing submission-bound CALL/PHYSICAL row
-- is ambiguous (its Telegram task may already describe the non-CONTENT type). Stop the
-- migration and require explicit operator resolution instead of guessing.
DO $$
DECLARE
  conflict_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO conflict_count
  FROM "CustomOrder"
  WHERE "contentBoundAt" IS NOT NULL
    AND "type" <> 'CONTENT';

  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Custom CONTENT binding cutover blocked: % submission-bound CustomOrder row(s) currently have non-CONTENT type; resolve them explicitly before migration', conflict_count;
  END IF;
END $$;

COMMIT;
