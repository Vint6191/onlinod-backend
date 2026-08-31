-- Audit 13: external write commit/outcome authority.
ALTER TABLE "AutomationDelivery"
  ADD COLUMN IF NOT EXISTS "failureCategory" TEXT,
  ADD COLUMN IF NOT EXISTS "reportedFailureCategory" TEXT,
  ADD COLUMN IF NOT EXISTS "writeCommitRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "writeCommitAt" TIMESTAMP(3);

-- COMMITTING owns the creator write lane until its outcome is proven/reconciled.
DROP INDEX IF EXISTS "AutomationDelivery_creator_write_lease_unique";
CREATE UNIQUE INDEX "AutomationDelivery_creator_write_lease_unique"
  ON "AutomationDelivery"("creatorId")
  WHERE "status" IN ('CLAIMED', 'RUNNING', 'COMMITTING');

CREATE INDEX IF NOT EXISTS "AutomationDelivery_failureCategory_idx"
  ON "AutomationDelivery"("failureCategory");
