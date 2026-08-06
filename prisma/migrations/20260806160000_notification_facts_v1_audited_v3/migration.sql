-- Notification Facts V1 AUDITED V3 hardening.
-- Earlier migrations remain immutable for databases where they were deployed.

-- Any desktop protocol below schema 3 used notification normalization that is
-- no longer trusted. Facts cannot be separated safely by individual row after
-- ingestion, so invalidate the affected jobs and rebuild them with schema 3.
UPDATE "AnalyticsCoverage" AS coverage
SET
  "status" = CASE
    WHEN coverage."coveredFromAt" IS NOT NULL
      OR coverage."coveredToAt" IS NOT NULL
      OR coverage."sourceCursorStart" IS NOT NULL
      OR coverage."sourceCursorEnd" IS NOT NULL
    THEN 'PARTIAL'::"AnalyticsCoverageStatus"
    ELSE 'FAILED'::"AnalyticsCoverageStatus"
  END,
  "lastErrorCode" = 'NOTIFICATION_SCHEMA_V3_RESCAN_REQUIRED',
  "lastErrorMessage" = 'Notification collector protocol below schema 3 is not authoritative; schema 3 rescan required',
  "retryAfterAt" = timezone('UTC', CURRENT_TIMESTAMP),
  "lastVerifiedAt" = COALESCE(coverage."lastVerifiedAt", timezone('UTC', CURRENT_TIMESTAMP)),
  "updatedAt" = timezone('UTC', CURRENT_TIMESTAMP)
WHERE coverage."ingestBatchId" IN (
  SELECT batch."id"
  FROM "AnalyticsIngestBatch" AS batch
  WHERE batch."dataType" = 'NOTIFICATIONS'
    AND batch."schemaVersion" < 3
);

WITH untrusted_jobs AS (
  SELECT DISTINCT batch."sourceJobId"
  FROM "AnalyticsIngestBatch" AS batch
  WHERE batch."dataType" = 'NOTIFICATIONS'
    AND batch."schemaVersion" < 3
    AND batch."sourceJobId" IS NOT NULL
)
DELETE FROM "CreatorSale" AS fact
USING untrusted_jobs
WHERE fact."sourceJobId" = untrusted_jobs."sourceJobId";

WITH untrusted_jobs AS (
  SELECT DISTINCT batch."sourceJobId"
  FROM "AnalyticsIngestBatch" AS batch
  WHERE batch."dataType" = 'NOTIFICATIONS'
    AND batch."schemaVersion" < 3
    AND batch."sourceJobId" IS NOT NULL
)
DELETE FROM "CreatorTip" AS fact
USING untrusted_jobs
WHERE fact."sourceJobId" = untrusted_jobs."sourceJobId";

WITH untrusted_jobs AS (
  SELECT DISTINCT batch."sourceJobId"
  FROM "AnalyticsIngestBatch" AS batch
  WHERE batch."dataType" = 'NOTIFICATIONS'
    AND batch."schemaVersion" < 3
    AND batch."sourceJobId" IS NOT NULL
)
DELETE FROM "CreatorSubscriptionEvent" AS fact
USING untrusted_jobs
WHERE fact."sourceJobId" = untrusted_jobs."sourceJobId";

DELETE FROM "CreatorFan" AS fan
WHERE NOT EXISTS (SELECT 1 FROM "CreatorSale" AS fact WHERE fact."fanId" = fan."id")
  AND NOT EXISTS (SELECT 1 FROM "CreatorTip" AS fact WHERE fact."fanId" = fan."id")
  AND NOT EXISTS (SELECT 1 FROM "CreatorSubscriptionEvent" AS fact WHERE fact."fanId" = fan."id");

-- Invalid protocol batches no longer carry authoritative facts or coverage.
-- Remove them before adding a database fence so an old schema-1/2 backend
-- cannot race a rolling deploy and recreate untrusted facts after cleanup.
DELETE FROM "AnalyticsIngestBatch"
WHERE "dataType" = 'NOTIFICATIONS'
  AND "schemaVersion" < 3;

ALTER TABLE "AnalyticsIngestBatch"
  DROP CONSTRAINT IF EXISTS "AnalyticsIngestBatch_notification_schema_check",
  ADD CONSTRAINT "AnalyticsIngestBatch_notification_schema_check" CHECK (
    "dataType" <> 'NOTIFICATIONS' OR "schemaVersion" >= 3
  );

-- Subscription lifecycle events are distinct even when an initial payment and
-- a later refund reference the same transaction. Keep the transaction indexed,
-- but do not use it as the unique identity of an event.
DROP INDEX IF EXISTS "CreatorSubscriptionEvent_creatorId_externalTransactionId_key";
CREATE INDEX IF NOT EXISTS "CreatorSubscriptionEvent_creatorId_externalTransactionId_idx"
  ON "CreatorSubscriptionEvent"("creatorId", "externalTransactionId");

-- A fact may only point at a fan belonging to the same creator. Repair impossible
-- legacy links before replacing the single-column foreign keys.
UPDATE "CreatorSale" AS fact
SET "fanId" = NULL
WHERE fact."fanId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "CreatorFan" AS fan
    WHERE fan."id" = fact."fanId" AND fan."creatorId" = fact."creatorId"
  );
UPDATE "CreatorTip" AS fact
SET "fanId" = NULL
WHERE fact."fanId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "CreatorFan" AS fan
    WHERE fan."id" = fact."fanId" AND fan."creatorId" = fact."creatorId"
  );
UPDATE "CreatorSubscriptionEvent" AS fact
SET "fanId" = NULL
WHERE fact."fanId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "CreatorFan" AS fan
    WHERE fan."id" = fact."fanId" AND fan."creatorId" = fact."creatorId"
  );

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorFan_creatorId_id_key"
  ON "CreatorFan"("creatorId", "id");

ALTER TABLE "CreatorSale"
  DROP CONSTRAINT IF EXISTS "CreatorSale_fanId_fkey",
  DROP CONSTRAINT IF EXISTS "CreatorSale_creatorId_fanId_fkey",
  ADD CONSTRAINT "CreatorSale_creatorId_fanId_fkey"
    FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "CreatorTip"
  DROP CONSTRAINT IF EXISTS "CreatorTip_fanId_fkey",
  DROP CONSTRAINT IF EXISTS "CreatorTip_creatorId_fanId_fkey",
  ADD CONSTRAINT "CreatorTip_creatorId_fanId_fkey"
    FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "CreatorSubscriptionEvent"
  DROP CONSTRAINT IF EXISTS "CreatorSubscriptionEvent_fanId_fkey",
  DROP CONSTRAINT IF EXISTS "CreatorSubscriptionEvent_creatorId_fanId_fkey",
  ADD CONSTRAINT "CreatorSubscriptionEvent_creatorId_fanId_fkey"
    FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

-- V2 stored the whole requested range in every UTC-day row. Clip those rows to
-- their own UTC day and require a schema-3 rescan before considering them whole.
UPDATE "AnalyticsCoverage" AS coverage
SET
  "coveredFromAt" = CASE
    WHEN coverage."coveredFromAt" IS NULL THEN NULL
    ELSE GREATEST(
      coverage."coveredFromAt",
      coverage."coverageDate"::timestamp
    )
  END,
  "coveredToAt" = CASE
    WHEN coverage."coveredToAt" IS NULL THEN NULL
    ELSE LEAST(
      coverage."coveredToAt",
      (coverage."coverageDate"::timestamp) + interval '1 day' - interval '1 millisecond'
    )
  END,
  "status" = CASE
    WHEN coverage."coveredFromAt" IS NOT NULL
      OR coverage."coveredToAt" IS NOT NULL
      OR coverage."sourceCursorStart" IS NOT NULL
      OR coverage."sourceCursorEnd" IS NOT NULL
    THEN 'PARTIAL'::"AnalyticsCoverageStatus"
    ELSE 'FAILED'::"AnalyticsCoverageStatus"
  END,
  "lastErrorCode" = 'NOTIFICATION_DAY_COVERAGE_RESCAN_REQUIRED',
  "lastErrorMessage" = 'Notification day coverage predates interval-aware schema 3 semantics; rescan required',
  "retryAfterAt" = timezone('UTC', CURRENT_TIMESTAMP),
  "lastVerifiedAt" = COALESCE(coverage."lastVerifiedAt", timezone('UTC', CURRENT_TIMESTAMP)),
  "updatedAt" = timezone('UTC', CURRENT_TIMESTAMP)
WHERE coverage."dataType" IN ('NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS');

-- If a legacy row did not overlap its declared coverageDate, clipping can
-- produce an inverted interval. Remove that unusable interval before enabling
-- the invariant; a cursor may still preserve PARTIAL evidence, otherwise fail.
UPDATE "AnalyticsCoverage" AS coverage
SET
  "coveredFromAt" = NULL,
  "coveredToAt" = NULL,
  "status" = CASE
    WHEN coverage."sourceCursorStart" IS NOT NULL OR coverage."sourceCursorEnd" IS NOT NULL
    THEN 'PARTIAL'::"AnalyticsCoverageStatus"
    ELSE 'FAILED'::"AnalyticsCoverageStatus"
  END,
  "lastErrorCode" = 'NOTIFICATION_DAY_INTERVAL_INVALIDATED',
  "lastErrorMessage" = 'Legacy notification interval did not overlap its UTC coverage day; rescan required',
  "retryAfterAt" = timezone('UTC', CURRENT_TIMESTAMP),
  "lastVerifiedAt" = COALESCE(coverage."lastVerifiedAt", timezone('UTC', CURRENT_TIMESTAMP)),
  "updatedAt" = timezone('UTC', CURRENT_TIMESTAMP)
WHERE coverage."dataType" IN ('NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS')
  AND coverage."coveredFromAt" IS NOT NULL
  AND coverage."coveredToAt" IS NOT NULL
  AND coverage."coveredFromAt" > coverage."coveredToAt";

ALTER TABLE "AnalyticsCoverage"
  DROP CONSTRAINT IF EXISTS "AnalyticsCoverage_notification_interval_day_check",
  DROP CONSTRAINT IF EXISTS "AnalyticsCoverage_notification_complete_day_check",
  ADD CONSTRAINT "AnalyticsCoverage_notification_interval_day_check" CHECK (
    "dataType" NOT IN ('NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS') OR (
      ("coveredFromAt" IS NULL OR "coveredFromAt" >= ("coverageDate"::timestamp)) AND
      ("coveredToAt" IS NULL OR "coveredToAt" < ("coverageDate"::timestamp) + interval '1 day') AND
      ("coveredFromAt" IS NULL OR "coveredToAt" IS NULL OR "coveredFromAt" <= "coveredToAt")
    )
  ),
  ADD CONSTRAINT "AnalyticsCoverage_notification_complete_day_check" CHECK (
    "dataType" NOT IN ('NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS') OR
    "status" <> 'COMPLETE' OR (
      "sourceTimezone" = 'UTC' AND
      "coveredFromAt" = ("coverageDate"::timestamp) AND
      "coveredToAt" >= ("coverageDate"::timestamp) + interval '1 day' - interval '1 millisecond'
    )
  );
