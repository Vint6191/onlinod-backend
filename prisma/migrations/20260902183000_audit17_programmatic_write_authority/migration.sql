-- Audit17: generalize the existing AutomationDelivery external-write authority
-- for non-automation product commits. No second execution table is introduced.
ALTER TABLE "AutomationDelivery"
  ALTER COLUMN "fanId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "originKind" TEXT NOT NULL DEFAULT 'AUTOMATION',
  ADD COLUMN IF NOT EXISTS "sourceDeviceId" TEXT,
  ADD COLUMN IF NOT EXISTS "payloadFingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "executionKind" TEXT,
  ADD COLUMN IF NOT EXISTS "reconciliationKind" TEXT;

CREATE INDEX IF NOT EXISTS "AutomationDelivery_agencyId_originKind_status_idx"
  ON "AutomationDelivery"("agencyId", "originKind", "status");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_sourceDeviceId_status_idx"
  ON "AutomationDelivery"("sourceDeviceId", "status");
