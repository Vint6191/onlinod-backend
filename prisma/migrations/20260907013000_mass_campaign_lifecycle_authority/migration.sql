-- MASS / Campaigns lifecycle authority.
-- AutomationDelivery remains the external-write row; these columns add the two
-- facts that were previously only local/inferred: logical intent acknowledgement
-- and the provider-side lifecycle of a created native OF queue.
ALTER TABLE "AutomationDelivery"
  ADD COLUMN IF NOT EXISTS "intentAcknowledgedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "remoteLifecycleState" TEXT,
  ADD COLUMN IF NOT EXISTS "remoteTargetId" TEXT,
  ADD COLUMN IF NOT EXISTS "remoteLifecycleObservedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "remoteSettledAt" TIMESTAMP(3);

-- Historical MASS rows predate server logical-intent acknowledgement. Mark all
-- acknowledged first, then conservatively expose the latest row per creator as
-- the one migration barrier that must be explicitly acknowledged/adopted.
UPDATE "AutomationDelivery"
SET "intentAcknowledgedAt" = COALESCE("finishedAt", "updatedAt", "createdAt")
WHERE "actionType" = 'MASS_QUEUE_CREATE'
  AND "intentAcknowledgedAt" IS NULL;

-- Historical exact queueIds are durable facts, but whether those queues are
-- still pending on OnlyFans is unknown at migration time. Never guess: a live
-- complete queue snapshot must reconcile them before creator/agency retirement.
-- COMMITTING has already crossed the durable external-write permit boundary and
-- therefore migrates to UNKNOWN, never PRECOMMIT, even if the old Desktop lost
-- the provider response during the rolling cutover.
UPDATE "AutomationDelivery"
SET "remoteTargetId" = NULLIF(COALESCE("result"->>'queueId', ''), ''),
    "remoteLifecycleState" = CASE
      WHEN "status" = 'COMPLETED' AND NULLIF(COALESCE("result"->>'queueId', ''), '') IS NOT NULL
        THEN 'MIGRATION_RECONCILE_REQUIRED'
      WHEN "status" IN ('COMMITTING','RECONCILE_REQUIRED')
        OR ("status" = 'FAILED' AND "failureCode" = 'outcome_unresolved_do_not_retry')
        THEN 'UNKNOWN'
      WHEN "status" IN ('COMPLETED','FAILED','SKIPPED','CANCELED')
        THEN 'SETTLED'
      ELSE 'PRECOMMIT'
    END,
    "remoteLifecycleObservedAt" = COALESCE("finishedAt", "updatedAt", "createdAt"),
    "remoteSettledAt" = CASE
      WHEN "status" IN ('FAILED','SKIPPED','CANCELED') AND NOT ("status" = 'FAILED' AND "failureCode" = 'outcome_unresolved_do_not_retry')
        THEN COALESCE("finishedAt", "updatedAt", "createdAt")
      ELSE NULL
    END
WHERE "actionType" = 'MASS_QUEUE_CREATE';

WITH latest AS (
  SELECT DISTINCT ON ("creatorId") "id"
  FROM "AutomationDelivery"
  WHERE "actionType" = 'MASS_QUEUE_CREATE'
  ORDER BY "creatorId", "createdAt" DESC, "id" DESC
)
UPDATE "AutomationDelivery" AS d
SET "intentAcknowledgedAt" = NULL
FROM latest
WHERE d."id" = latest."id";

DROP INDEX IF EXISTS "AutomationDelivery_mass_unack_intent_unique";
CREATE UNIQUE INDEX "AutomationDelivery_mass_unack_intent_unique"
  ON "AutomationDelivery"("creatorId")
  WHERE "actionType" = 'MASS_QUEUE_CREATE' AND "intentAcknowledgedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "AutomationDelivery_creator_action_remote_state_idx"
  ON "AutomationDelivery"("creatorId", "actionType", "remoteLifecycleState");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_creator_action_remote_target_idx"
  ON "AutomationDelivery"("creatorId", "actionType", "remoteTargetId");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_agency_action_remote_state_idx"
  ON "AutomationDelivery"("agencyId", "actionType", "remoteLifecycleState");
