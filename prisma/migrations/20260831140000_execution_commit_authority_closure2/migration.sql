-- Audit 13 Closure 2: unresolved external-write outcomes retain the creator write lane.
--
-- Existing Audit13 deployments may already contain legacy reconciliation rows
-- encoded as RETRY_SCHEDULED + OUTCOME_UNKNOWN_RECONCILE. Promote one blocker
-- per idle creator before recreating the unique write-lane index. Additional
-- legacy reconciliation rows remain queued as reconciliation backlog; the
-- claim path recognizes their failureCategory and blocks unrelated writes until
-- the backlog is drained.
DROP INDEX IF EXISTS "AutomationDelivery_creator_write_lease_unique";

WITH ranked AS (
  SELECT d."id",
         ROW_NUMBER() OVER (
           PARTITION BY d."creatorId"
           ORDER BY d."notBefore" ASC, d."createdAt" ASC, d."id" ASC
         ) AS rn
  FROM "AutomationDelivery" d
  WHERE d."status" = 'RETRY_SCHEDULED'
    AND (
      d."failureCategory" = 'OUTCOME_UNKNOWN_RECONCILE'
      OR COALESCE(d."result"->>'outcomeState', '') = 'RECONCILE_REQUIRED'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "AutomationDelivery" lane
      WHERE lane."creatorId" = d."creatorId"
        AND lane."status" IN ('CLAIMED', 'RUNNING', 'COMMITTING', 'RECONCILE_REQUIRED')
    )
)
UPDATE "AutomationDelivery" d
SET "status" = 'RECONCILE_REQUIRED'
FROM ranked r
WHERE d."id" = r."id"
  AND r.rn = 1;

CREATE UNIQUE INDEX "AutomationDelivery_creator_write_lease_unique"
  ON "AutomationDelivery"("creatorId")
  WHERE "status" IN ('CLAIMED', 'RUNNING', 'COMMITTING', 'RECONCILE_REQUIRED');
