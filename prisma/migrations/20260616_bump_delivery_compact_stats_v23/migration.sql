-- ONLINOD bump deliveries compact stats v23
-- Bump deliveries are pending-only rows. Completed/replied/canceled/failed states
-- are compacted into BumpDeliveryStat so thousands of daily bumps do not bloat DB.

CREATE TABLE IF NOT EXISTS "BumpDeliveryStat" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL DEFAULT '',
  "day" TEXT NOT NULL,
  "sent" INTEGER NOT NULL DEFAULT 0,
  "replied" INTEGER NOT NULL DEFAULT 0,
  "canceled" INTEGER NOT NULL DEFAULT 0,
  "expired" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "BumpDeliveryStat_creatorId_templateId_day_key"
  ON "BumpDeliveryStat"("creatorId", "templateId", "day");

CREATE INDEX IF NOT EXISTS "BumpDeliveryStat_agencyId_day_idx"
  ON "BumpDeliveryStat"("agencyId", "day");

CREATE INDEX IF NOT EXISTS "BumpDeliveryStat_creatorId_day_idx"
  ON "BumpDeliveryStat"("creatorId", "day");

CREATE INDEX IF NOT EXISTS "AutomationDelivery_creatorId_messageId_idx"
  ON "AutomationDelivery"("creatorId", "messageId");

CREATE INDEX IF NOT EXISTS "AutomationTask_status_deletedAt_idx"
  ON "AutomationTask"("status", "deletedAt");
