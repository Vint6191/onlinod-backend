-- Operator exception queues are durable production workflows, not debug scans.
-- Keep their oldest-first read models index-backed as the provider ledger grows.
CREATE INDEX IF NOT EXISTS "TelegramDeliveryIntent_precommit_provider_blocked_queue_idx"
  ON "TelegramDeliveryIntent"("agencyId", "updatedAt", "createdAt", "id")
  WHERE "state" = 'PLANNED'
    AND "commitStartedAt" IS NULL
    AND "outcomeReason" LIKE 'PRECOMMIT_PROVIDER_UNAVAILABLE:%';

CREATE INDEX IF NOT EXISTS "TelegramDeliveryIntent_reconciliation_queue_idx"
  ON "TelegramDeliveryIntent"("agencyId", "commitStartedAt", "createdAt", "id")
  WHERE "state" = 'RECONCILE_REQUIRED';
