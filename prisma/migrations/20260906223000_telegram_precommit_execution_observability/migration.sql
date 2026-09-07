-- Precommit execution failures are durable operational work, not invisible retry noise.
-- Historical builds sometimes encoded this state only in outcomeReason while leaving state=PLANNED.
-- That is proven-precommit/no-effect history, so normalize it monotonically without touching any
-- COMMITTING / RECONCILE_REQUIRED / CONFIRMED provider outcome.
UPDATE "TelegramDeliveryIntent"
SET "state" = 'FAILED_PRECOMMIT'
WHERE "state" = 'PLANNED'
  AND "commitStartedAt" IS NULL
  AND "outcomeReason" LIKE 'FAILED_PRECOMMIT:%';

-- Keep the operator read model index-backed as the provider ledger grows.
CREATE INDEX IF NOT EXISTS "TelegramDeliveryIntent_failed_precommit_queue_idx"
  ON "TelegramDeliveryIntent"("agencyId", "updatedAt", "createdAt", "id")
  WHERE "state" = 'FAILED_PRECOMMIT'
    AND "commitStartedAt" IS NULL;
