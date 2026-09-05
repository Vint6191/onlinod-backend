-- F25 closure: provider observation durability is independent from derived Custom projection.
ALTER TABLE "TelegramInboundEvent" ADD COLUMN IF NOT EXISTS "projectionState" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "TelegramInboundEvent" ADD COLUMN IF NOT EXISTS "projectionReason" TEXT;
ALTER TABLE "TelegramInboundEvent" ADD COLUMN IF NOT EXISTS "projectionAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TelegramInboundEvent" ADD COLUMN IF NOT EXISTS "projectedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TelegramInboundEvent_agencyId_projectionState_observedAt_idx"
ON "TelegramInboundEvent"("agencyId", "projectionState", "observedAt");

-- Existing rows already linked to a submission are proven applied. Events without media are terminal non-content observations.
UPDATE "TelegramInboundEvent"
SET "projectionState" = 'APPLIED', "projectionReason" = 'SUBMISSION_ALREADY_LINKED', "projectedAt" = COALESCE("projectedAt", "updatedAt")
WHERE "submissionId" IS NOT NULL;

UPDATE "TelegramInboundEvent"
SET "projectionState" = 'SKIPPED', "projectionReason" = 'NO_MEDIA', "projectedAt" = COALESCE("projectedAt", "updatedAt")
WHERE "submissionId" IS NULL AND "hasMedia" = false;
