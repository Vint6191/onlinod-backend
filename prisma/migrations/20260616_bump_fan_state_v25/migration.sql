-- Compact per-fan bump memory.
-- This is NOT an event log: one mutable row per creator+fan, used for
-- distributed rotation/cooldown so workers do not repeat the same bump template.

CREATE TABLE IF NOT EXISTS "AutomationBumpFanState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "dialogId" TEXT,
  "lastTemplateId" TEXT,
  "lastStatus" TEXT,
  "lastSentAt" TIMESTAMP(3),
  "lastFinalizedAt" TIMESTAMP(3),
  "lastMessageId" TEXT,
  "templateIds" JSONB NOT NULL DEFAULT '[]',
  "counters" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationBumpFanState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AutomationBumpFanState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutomationBumpFanState_creatorId_fanId_key" ON "AutomationBumpFanState"("creatorId", "fanId");
CREATE INDEX IF NOT EXISTS "AutomationBumpFanState_agencyId_idx" ON "AutomationBumpFanState"("agencyId");
CREATE INDEX IF NOT EXISTS "AutomationBumpFanState_creatorId_updatedAt_idx" ON "AutomationBumpFanState"("creatorId", "updatedAt");
CREATE INDEX IF NOT EXISTS "AutomationBumpFanState_lastSentAt_idx" ON "AutomationBumpFanState"("lastSentAt");
