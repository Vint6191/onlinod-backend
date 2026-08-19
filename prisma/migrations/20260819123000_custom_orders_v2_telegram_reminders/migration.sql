CREATE TYPE "CustomOrderType" AS ENUM ('CONTENT', 'CALL', 'PHYSICAL');
CREATE TYPE "CustomOrderContentKind" AS ENUM ('PHOTO', 'VIDEO', 'BOTH');
CREATE TYPE "CustomOrderPhysicalStatus" AS ENUM ('WAITING', 'READY', 'SHIPPED', 'COMPLETED');
ALTER TYPE "CustomOrderStatus" ADD VALUE IF NOT EXISTS 'MISSED' AFTER 'COMPLETED';

ALTER TABLE "CreatorAccount" ADD COLUMN "telegramAccountId" TEXT;
CREATE INDEX "CreatorAccount_agencyId_telegramAccountId_idx" ON "CreatorAccount"("agencyId", "telegramAccountId");

ALTER TABLE "CustomOrder"
  ADD COLUMN "type" "CustomOrderType" NOT NULL DEFAULT 'CONTENT',
  ADD COLUMN "contentKind" "CustomOrderContentKind",
  ADD COLUMN "scheduledAt" TIMESTAMP(3),
  ADD COLUMN "durationMinutes" INTEGER,
  ADD COLUMN "physicalStatus" "CustomOrderPhysicalStatus",
  ADD COLUMN "telegramTaskMessageId" INTEGER,
  ADD COLUMN "telegramReferenceMessageIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "reminderConfig" JSONB,
  ADD COLUMN "nextReminderAt" TIMESTAMP(3),
  ADD COLUMN "lastReminderAt" TIMESTAMP(3),
  ADD COLUMN "lastReminderKey" TEXT,
  ADD COLUMN "reminderClaimToken" TEXT,
  ADD COLUMN "reminderClaimUntil" TIMESTAMP(3);

CREATE INDEX "CustomOrder_agencyId_status_scheduledAt_idx" ON "CustomOrder"("agencyId", "status", "scheduledAt");
CREATE INDEX "CustomOrder_agencyId_status_nextReminderAt_idx" ON "CustomOrder"("agencyId", "status", "nextReminderAt");
CREATE INDEX "CustomOrder_agencyId_creatorId_status_scheduledAt_idx" ON "CustomOrder"("agencyId", "creatorId", "status", "scheduledAt");

-- Existing V1 customs become CONTENT/BOTH. Start the new default reminder clock from deployment
-- instead of immediately flooding models for long-overdue legacy rows.
UPDATE "CustomOrder"
SET "contentKind" = 'BOTH'::"CustomOrderContentKind"
WHERE "type" = 'CONTENT'::"CustomOrderType" AND "contentKind" IS NULL;

UPDATE "CustomOrder"
SET "nextReminderAt" = CURRENT_TIMESTAMP + INTERVAL '30 minutes'
WHERE "status" = 'PENDING' AND "nextReminderAt" IS NULL;
