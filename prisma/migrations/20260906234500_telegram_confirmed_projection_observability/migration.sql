-- Confirmed Telegram provider facts are canonical; these columns track only rebuildable derived-projection health.
ALTER TABLE "TelegramDeliveryIntent"
  ADD COLUMN IF NOT EXISTS "projectionBlockedCode" TEXT,
  ADD COLUMN IF NOT EXISTS "projectionBlockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "projectionLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "projectionAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "TelegramDeliveryIntent_agencyId_state_projectionBlockedAt_idx"
  ON "TelegramDeliveryIntent"("agencyId", "state", "projectionBlockedAt");
