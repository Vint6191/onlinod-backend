ALTER TABLE "CreatorFanRefreshDemand"
  ADD COLUMN "retryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextRetryAt" TIMESTAMP(3),
  ADD COLUMN "lastRetryAt" TIMESTAMP(3),
  ADD COLUMN "quarantinedAt" TIMESTAMP(3);

-- Existing Actual68 FAILED demand rows predate the bounded retry authority.
-- Make non-active legacy failures immediately due so deployment cannot leave
-- pre-existing Campaign freshness debt permanently stuck until manual repair.
UPDATE "CreatorFanRefreshDemand"
SET "nextRetryAt" = CURRENT_TIMESTAMP
WHERE "status" = 'FAILED'
  AND "activeRefreshJobId" IS NULL
  AND "nextRetryAt" IS NULL;

CREATE INDEX "CreatorFanRefreshDemand_retry_due_idx"
  ON "CreatorFanRefreshDemand"("status", "nextRetryAt", "creatorId");

CREATE INDEX "CreatorFanRefreshDemand_quarantine_idx"
  ON "CreatorFanRefreshDemand"("creatorId", "quarantinedAt");
