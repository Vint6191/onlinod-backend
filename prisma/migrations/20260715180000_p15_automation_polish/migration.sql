-- P15: compact Automation history aggregates and legacy queue shutdown.
CREATE TABLE "AutomationMonthlyAggregate" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "moduleKey" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "total" INTEGER NOT NULL DEFAULT 0,
  "completed" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "canceled" INTEGER NOT NULL DEFAULT 0,
  "sent" INTEGER NOT NULL DEFAULT 0,
  "replied" INTEGER NOT NULL DEFAULT 0,
  "followed" INTEGER NOT NULL DEFAULT 0,
  "unfollowed" INTEGER NOT NULL DEFAULT 0,
  "liked" INTEGER NOT NULL DEFAULT 0,
  "commented" INTEGER NOT NULL DEFAULT 0,
  "firstAt" TIMESTAMP(3),
  "lastAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationMonthlyAggregate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutomationMonthlyAggregate_creatorId_moduleKey_actionType_periodStart_key"
  ON "AutomationMonthlyAggregate"("creatorId", "moduleKey", "actionType", "periodStart");
CREATE INDEX "AutomationMonthlyAggregate_agencyId_periodStart_idx"
  ON "AutomationMonthlyAggregate"("agencyId", "periodStart");
CREATE INDEX "AutomationMonthlyAggregate_creatorId_periodStart_idx"
  ON "AutomationMonthlyAggregate"("creatorId", "periodStart");
CREATE INDEX "AutomationMonthlyAggregate_creatorId_moduleKey_periodStart_idx"
  ON "AutomationMonthlyAggregate"("creatorId", "moduleKey", "periodStart");

ALTER TABLE "AutomationMonthlyAggregate"
  ADD CONSTRAINT "AutomationMonthlyAggregate_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationMonthlyAggregate"
  ADD CONSTRAINT "AutomationMonthlyAggregate_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "AuditLog_agencyId_createdAt_idx"
  ON "AuditLog"("agencyId", "createdAt");

-- Old Alpha work must not become claimable after P15. Keep rows for the
-- configured retention window, but make all non-terminal rows terminal.
UPDATE "AutomationJob"
SET "status" = 'canceled',
    "error" = COALESCE("error", 'p15_legacy_scheduler_disabled'),
    "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('scheduled', 'claimed', 'running', 'retry_wait', 'pending');

UPDATE "AutomationDelivery"
SET "status" = 'CANCELED',
    "failureCode" = 'p15_legacy_delivery_disabled',
    "lastError" = COALESCE("lastError", "error", 'Legacy Alpha delivery disabled by P15'),
    "finishedAt" = COALESCE("finishedAt", CURRENT_TIMESTAMP),
    "claimedByDeviceId" = NULL,
    "claimedAt" = NULL,
    "claimUntil" = NULL,
    "leaseTokenHash" = NULL,
    "leaseRevision" = "leaseRevision" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN (
  'scheduled', 'online_queued', 'retry_wait', 'send_unknown', 'sending',
  'sent', 'pending_reply', 'checking_reply', 'cancel_due', 'canceling'
);
